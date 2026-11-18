import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { ensureRuleVersion } from '../src/engine/rules.js';
import { materialize, revision } from '../src/service/resolution.js';
import { importBatch } from '../src/service/import.js';
import { createHandler } from '../src/server.js';
import { createServer } from 'node:http';

let server;
let db;
let base;

function rows() {
  return [
    { source: 'crm', external_id: 'A1', name: 'Alice Johnson', email: 'alice@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main St', postal_code: '11111', country: 'US' },
    { source: 'shop', external_id: 'A2', name: 'Alice Johnson', email: 'alice@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main Street', postal_code: '11111', country: 'US' },
    { source: 'crm', external_id: 'Q1', name: 'Jonathan Smith', email: 'jon.smith@a.com', phone: '+15552000', dob: '1980-01-01', address_line: '10 Oak Street', postal_code: '22222', country: 'US' },
    { source: 'shop', external_id: 'Q2', name: 'Jon Smith', email: 'jon.smith@b.com', phone: '+15553000', dob: null, address_line: '10 Oak St', postal_code: '22222', country: 'US' },
  ];
}

before(async () => {
  db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule });
  importBatch(db, { label: 'api seed', idempotencyKey: 'api-seed', rows: rows(), actor: 'test' });
  server = createServer(createHandler(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/state reports counts and revision', async () => {
  const { status, body } = await api('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(body.counts.customers, 4);
  assert.ok(body.revision > 0);
});

test('GET /api/pairs returns review candidates with reasons and conflicts', async () => {
  const { status, body } = await api('GET', '/api/pairs?band=review');
  assert.equal(status, 200);
  const smith = body.pairs.find((p) => p.left.name === 'Jonathan Smith');
  assert.ok(smith);
  assert.ok(smith.reasons.length > 0);
  assert.ok(smith.conflicts.length > 0);
  assert.ok(smith.score > 0);
});

test('POST decision with stale revision returns 409 and current revision', async () => {
  const state = (await api('GET', '/api/state')).body;
  const pairs = (await api('GET', '/api/pairs?band=review')).body;
  const smith = pairs.pairs.find((p) => p.left.name === 'Jonathan Smith');
  const first = await api('POST', `/api/pairs/${smith.pairKey}/decisions`, {
    action: 'approve',
    actor: 'api.analyst',
    reason: 'confirmed',
    expectedRevision: state.revision,
  });
  assert.equal(first.status, 200);

  const second = await api('POST', `/api/pairs/${smith.pairKey}/decisions`, {
    action: 'reject',
    actor: 'other.analyst',
    reason: 'nope',
    expectedRevision: state.revision,
  });
  assert.equal(second.status, 409);
  assert.ok(second.body.details.current > state.revision);
});

test('POST decision without actor returns 400', async () => {
  const pairs = (await api('GET', '/api/pairs?band=review&status=all')).body;
  const target = pairs.pairs[0];
  const r = await api('POST', `/api/pairs/${target.pairKey}/decisions`, { action: 'approve' });
  assert.equal(r.status, 400);
});

test('POST /api/rules creates a version and re-materializes', async () => {
  const before = (await api('GET', '/api/state')).body;
  const rule = (await api('GET', '/api/rules')).body.current;
  const { status, body } = await api('POST', '/api/rules', {
    config: { thresholds: { ...rule.thresholds, autoLink: 0.93 } },
    actor: 'api.admin',
    note: 'raise auto-link bar',
  });
  assert.equal(status, 200);
  assert.equal(body.rule.versionNo, rule.versionNo + 1);
  assert.ok(body.revision > before.revision);
});

test('POST /api/rules rejects invalid thresholds', async () => {
  const r = await api('POST', '/api/rules', { config: { thresholds: { autoLink: 2 } } });
  assert.equal(r.status, 400);
  const r2 = await api('POST', '/api/rules', { config: { thresholds: { review: 0.9, autoLink: 0.5 } } });
  assert.equal(r2.status, 400);
});

test('POST /api/imports is idempotent over HTTP', async () => {
  const payload = {
    label: 'http batch',
    idempotencyKey: 'http-import-1',
    rows: [{ source: 'crm', external_id: 'H1', name: 'Hana Park', email: 'hana@example.com' }],
    actor: 'api.importer',
  };
  const a = await api('POST', '/api/imports', payload);
  assert.equal(a.status, 200);
  assert.equal(a.body.replayed, false);
  const b = await api('POST', '/api/imports', payload);
  assert.equal(b.status, 200);
  assert.equal(b.body.replayed, true);
  assert.equal(b.body.batch.id, a.body.batch.id);
  const conflict = await api('POST', '/api/imports', {
    ...payload,
    rows: [{ source: 'crm', external_id: 'H1', name: 'Hana P.' }],
  });
  assert.equal(conflict.status, 409);
});

test('lineage endpoint returns immutable version history', async () => {
  const clusters = (await api('GET', '/api/clusters')).body;
  const alice = clusters.find((c) => c.customers.some((x) => x.name === 'Alice Johnson'));
  const { status, body } = await api('GET', `/api/lineages/${alice.lineageId}`);
  assert.equal(status, 200);
  assert.ok(body.versions.length >= 1);
  const superseded = body.versions.filter((v) => v.status === 'superseded');
  for (const v of superseded) assert.ok(v.supersededAt);
});

test('impact endpoint lists recent runs and open alerts', async () => {
  const { status, body } = await api('GET', '/api/impact');
  assert.equal(status, 200);
  assert.ok(body.recentRuns.length > 0);
  assert.ok(Array.isArray(body.openAlerts));
});

test('unknown route returns 404 JSON', async () => {
  const r = await api('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /no route/);
});

// --- true multi-process concurrency against a shared file database ---------

test('two OS processes confirming at the same revision: one wins, one gets a conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erw-'));
  const dbPath = join(dir, 'race.db');
  const seedDb = openDb(dbPath);
  const rule = ensureRuleVersion(seedDb, undefined, 'baseline');
  materialize(seedDb, { rule });
  importBatch(seedDb, { label: 'race', idempotencyKey: 'race-seed', rows: rows(), actor: 'test' });
  const pair = seedDb.prepare("SELECT pair_key FROM candidate_pairs WHERE band = 'review' LIMIT 1").get().pair_key;
  const rev = revision(seedDb);
  seedDb.close();

  const script = join(dir, 'worker.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    script,
    `import { openDb, tx } from '/workspace/src/db/index.js';
import { recordDecision, revision } from '/workspace/src/service/resolution.js';
const db = openDb(process.env.DB);
const actor = process.env.ACTOR;
const out = [];
await new Promise((r) => setTimeout(r, Number(process.env.DELAY)));
try {
  const res = recordDecision(db, { pairKey: process.env.PAIR, action: 'approve', actor, reason: 'race', expectedRevision: Number(process.env.REV) });
  out.push({ ok: true, revision: res.revision });
} catch (err) {
  out.push({ ok: false, status: err.status, message: err.message, current: err.details?.current });
}
console.log(JSON.stringify(out[0]));
db.close();
`,
  );

  async function runWorker(actor, delay) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, DB: dbPath, ACTOR: actor, PAIR: pair, REV: String(rev), DELAY: String(delay) },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(err || `exit ${code}`));
        else resolve(JSON.parse(out.trim().split('\n').pop()));
      });
    });
  }

  const results = await Promise.all([runWorker('proc-a', 0), runWorker('proc-b', 30)]);
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assert.equal(wins.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);
  assert.equal(losses.length, 1);
  assert.ok(losses[0].status === 409);

  const check = openDb(dbPath);
  const active = check.prepare('SELECT COUNT(*) AS n FROM pair_decisions WHERE active = 1').get().n;
  assert.equal(active, 1);
  check.close();
  rmSync(dir, { recursive: true, force: true });
});

test('two OS processes importing the same idempotency key: exactly one batch row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erw-imp-'));
  const dbPath = join(dir, 'imp.db');
  const seedDb = openDb(dbPath);
  const rule = ensureRuleVersion(seedDb, undefined, 'baseline');
  materialize(seedDb, { rule });
  seedDb.close();

  const script = join(dir, 'worker.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    script,
    `import { openDb } from '/workspace/src/db/index.js';
import { importBatch } from '/workspace/src/service/import.js';
const db = openDb(process.env.DB);
await new Promise((r) => setTimeout(r, Number(process.env.DELAY)));
try {
  const res = importBatch(db, {
    label: 'race import',
    idempotencyKey: 'shared-key',
    rows: [{ source: 'crm', external_id: 'RACE1', name: 'Race Person', email: 'race@example.com' }],
    actor: process.env.ACTOR,
  });
  console.log(JSON.stringify({ ok: true, replayed: res.replayed, batchId: res.batch.id }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, status: err.status, message: err.message }));
}
db.close();
`,
  );
  async function runWorker(actor, delay) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, DB: dbPath, ACTOR: actor, DELAY: String(delay) },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(err || `exit ${code}`));
        else resolve(JSON.parse(out.trim().split('\n').pop()));
      });
    });
  }

  const results = await Promise.all([runWorker('imp-a', 0), runWorker('imp-b', 20)]);
  assert.equal(results.filter((r) => r.ok && !r.replayed).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.ok && r.replayed).length, 1, JSON.stringify(results));

  const check = openDb(dbPath);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n, 1);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  const ids = new Set(results.map((r) => r.batchId));
  assert.equal(ids.size, 1);
  check.close();
  rmSync(dir, { recursive: true, force: true });
});

test('posting an identical rule config is reported as unchanged', async () => {
  const rule = (await api('GET', '/api/rules')).body.current;
  const same = await api('POST', '/api/rules', {
    config: {
      thresholds: rule.thresholds,
      fuzzy: rule.fuzzy,
      deterministic: rule.deterministic,
    },
    actor: 'api.admin',
  });
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.rule.id, rule.id);
  assert.equal(same.body.materialization, null);
});
