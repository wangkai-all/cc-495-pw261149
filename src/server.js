import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDb, tx } from './db/index.js';
import {
  httpError,
  normalizeRuleConfig,
  ensureRuleVersion,
  listRules,
  getRule,
  latestRule,
  hydrateRule,
} from './engine/rules.js';
import * as res from './service/resolution.js';
import { revision } from './service/resolution.js';
import * as importer from './service/import.js';
import { materialize } from './service/resolution.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res_, status, body) {
  const payload = JSON.stringify(body);
  res_.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res_.end(payload);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'request body must be valid JSON');
  }
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([A-Za-z]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, regex, keys, handler });
}

// --- state / meta -----------------------------------------------------------

route('GET', '/api/state', ({ db }) => res.workbenchState(db));

route('GET', '/api/rules', ({ db }) => ({ current: latestRule(db), versions: listRules(db) }));

route('POST', '/api/rules', ({ db }, body) => {
  return tx(db, () => {
    const base = latestRule(db) ?? ensureRuleVersion(db, undefined, 'bootstrap');
    const config = normalizeRuleConfig(body.config ?? body, base);
    const rule = ensureRuleVersion(db, config, body.note ?? 'rule change');
    if (!rule.created) {
      // Identical config already has a version; re-materializing is harmless
      // but the caller should know nothing new was recorded.
      return { rule, unchanged: true, materialization: null, revision: revision(db) };
    }
    const run = materialize(db, { rule, origin: 'rule-change', actor: body.actor ?? 'admin' });
    return { rule, unchanged: false, materialization: run, revision: run.revision };
  });
});

route('GET', '/api/rules/:id', ({ db, params }) => {
  const rule = getRule(db, Number(params.id));
  if (!rule) throw httpError(404, `rule version ${params.id} not found`);
  return rule;
});

// --- customers --------------------------------------------------------------

route('GET', '/api/customers', ({ db }) => res.listCustomers(db));
route('GET', '/api/customers/:id', ({ db, params }) => {
  const c = res.getCustomer(db, Number(params.id));
  if (!c) throw httpError(404, `customer ${params.id} not found`);
  return c;
});
route('GET', '/api/customers/:id/timeline', ({ db, params }) =>
  res.customerTimeline(db, Number(params.id)),
);

// --- candidate review -------------------------------------------------------

route('GET', '/api/pairs', ({ db, query }) =>
  res.reviewQueue(db, {
    ruleVersionId: query.ruleVersionId ? Number(query.ruleVersionId) : undefined,
    band: query.band || undefined,
    status: query.status === 'all' ? null : query.status || 'open',
    limit: query.limit ? Math.min(Number(query.limit), 1000) : 200,
    offset: query.offset ? Number(query.offset) : 0,
  }),
);

route('GET', '/api/pairs/:pairKey', ({ db, params }) => {
  const pk = params.pairKey;
  const row = db.prepare('SELECT * FROM candidate_pairs WHERE pair_key = ? ORDER BY rule_version_id DESC LIMIT 1').get(pk);
  if (!row) throw httpError(404, `no evidence for pair ${pk}`);
  const left = res.getCustomer(db, row.left_customer_id);
  const right = res.getCustomer(db, row.right_customer_id);
  return {
    pairKey: pk,
    score: row.score,
    band: row.band,
    reasons: JSON.parse(row.reasons),
    conflicts: JSON.parse(row.conflicts),
    deterministicKeys: JSON.parse(row.deterministic_keys),
    status: row.status,
    ruleVersionId: row.rule_version_id,
    left,
    right,
    decisions: res.allDecisionsForPair(db, pk),
    evidenceHistory: db.prepare(
      'SELECT id, rule_version_id, score, band, status, created_at FROM candidate_pairs WHERE pair_key = ? ORDER BY rule_version_id',
    ).all(pk).map((r) => ({
      id: r.id,
      ruleVersionId: r.rule_version_id,
      score: r.score,
      band: r.band,
      status: r.status,
      createdAt: r.created_at,
    })),
    affectedClusters: db.prepare(
      `SELECT DISTINCT cv.id, cv.lineage_id, cv.status FROM cluster_members cm
       JOIN cluster_versions cv ON cv.id = cm.cluster_version_id
       WHERE cm.customer_id IN (?, ?) ORDER BY cv.id`,
    ).all(row.left_customer_id, row.right_customer_id).map((r) => ({
      clusterVersionId: r.id,
      lineageId: r.lineage_id,
      status: r.status,
    })),
  };
});

route('POST', '/api/pairs/:pairKey/decisions', ({ db, params }, body) =>
  res.recordDecision(db, {
    pairKey: params.pairKey,
    action: body.action,
    actor: body.actor,
    reason: body.reason,
    expectedRevision: body.expectedRevision,
  }),
);

route('POST', '/api/decisions/:id/revoke', ({ db, params }, body) =>
  res.revokeDecision(db, {
    decisionId: Number(params.id),
    actor: body.actor,
    reason: body.reason,
    expectedRevision: body.expectedRevision,
  }),
);

// --- manual merge / split ---------------------------------------------------

route('POST', '/api/manual-ops', ({ db }, body) =>
  res.recordManualOp(db, {
    kind: body.kind,
    groups: body.groups,
    actor: body.actor,
    reason: body.reason,
    expectedRevision: body.expectedRevision,
  }),
);

route('POST', '/api/manual-ops/:id/revoke', ({ db, params }, body) =>
  res.revokeManualOp(db, {
    opId: Number(params.id),
    actor: body.actor,
    reason: body.reason,
    expectedRevision: body.expectedRevision,
  }),
);

route('GET', '/api/manual-ops', ({ db }) => ({ active: res.activeManualOps(db) }));

// --- clusters ---------------------------------------------------------------

route('GET', '/api/clusters', ({ db }) => res.currentClusters(db));
route('GET', '/api/lineages/:id', ({ db, params }) =>
  res.clusterVersionsForLineage(db, Number(params.id)),
);

// --- impact / history -------------------------------------------------------

route('GET', '/api/impact', ({ db, query }) =>
  res.impactReport(db, query.runId ? Number(query.runId) : null),
);

route('POST', '/api/alerts/resolve', ({ db }, body) => res.resolveAlerts(db, body.ids ?? null));

// --- imports ----------------------------------------------------------------

route('POST', '/api/imports', ({ db }, body) =>
  importer.importBatch(db, {
    label: body.label,
    idempotencyKey: body.idempotencyKey,
    rows: body.rows,
    actor: body.actor ?? 'importer',
    ruleVersionId: body.ruleVersionId ?? null,
  }),
);

route('GET', '/api/imports', ({ db }) => ({ batches: importer.listBatches(db) }));

// ---------------------------------------------------------------------------

async function serveStatic(req, res_, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = normalize(rel).replace(/^([.][.][/\\])+/, '');
  const full = join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) throw httpError(403, 'forbidden');
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(full);
    res_.writeHead(200, {
      'content-type': MIME[extname(full)] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res_.end(data);
  } catch {
    res_.writeHead(404, { 'content-type': 'text/plain' });
    res_.end('not found');
  }
}

export function createHandler(db) {
  return async (req, res_) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      try {
        await serveStatic(req, res_, pathname);
      } catch (err) {
        res_.writeHead(err.status ?? 500, { 'content-type': 'text/plain' });
        res_.end(err.message);
      }
      return;
    }
    try {
      const ctx = { db, query: Object.fromEntries(url.searchParams), params: {} };
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.regex.exec(pathname);
        if (!m) continue;
        r.keys.forEach((key, i) => {
          ctx.params[key] = decodeURIComponent(m[i + 1]);
        });
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const result = await r.handler(ctx, body);
        json(res_, 200, result);
        return;
      }
      throw httpError(404, `no route for ${req.method} ${pathname}`);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      json(res_, status, { error: err.message, details: err.details ?? null });
    }
  };
}

export function startServer({ dbPath, port = 8787 } = {}) {
  const db = openDb(dbPath ?? ':memory:');
  const handler = createHandler(db);
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, db, port: server.address().port }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.DB_PATH ?? join(here, '..', 'data', 'workbench.db');
  const port = Number(process.env.PORT ?? 8787);
  openAndSeed(dbPath).then((db) => {
    const server = createServer(createHandler(db));
    server.listen(port, () => {
      console.log(`entity-resolution workbench: http://localhost:${port}`);
    });
  });
}

async function openAndSeed(dbPath) {
  const { seedIfEmpty } = await import('../scripts/seed.js');
  const db = openDb(dbPath);
  seedIfEmpty(db);
  return db;
}
