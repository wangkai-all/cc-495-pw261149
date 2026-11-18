import { createHash } from 'node:crypto';
import { nowIso, tx } from '../db/index.js';
import { httpError } from '../engine/rules.js';
import { computeMatch, blockingTokens } from '../engine/matching.js';
import { buildClusters, pairKey } from '../engine/clustering.js';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export function mapCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    dob: row.dob,
    addressLine: row.address_line,
    postalCode: row.postal_code,
    country: row.country,
    vatId: row.vat_id,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  };
}

function mapPair(row) {
  return {
    id: row.id,
    pairKey: row.pair_key,
    leftCustomerId: row.left_customer_id,
    rightCustomerId: row.right_customer_id,
    ruleVersionId: row.rule_version_id,
    score: row.score,
    band: row.band,
    reasons: JSON.parse(row.reasons),
    conflicts: JSON.parse(row.conflicts),
    deterministicKeys: JSON.parse(row.deterministic_keys),
    status: row.status,
    supersededById: row.superseded_by_id,
    createdAt: row.created_at,
  };
}

function mapDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    pairId: row.pair_id,
    pairKey: row.pair_key,
    action: row.action,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
    active: row.active === 1,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
  };
}

function mapClusterVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    lineageId: row.lineage_id,
    ruleVersionId: row.rule_version_id,
    versionNo: row.version_no,
    status: row.status,
    origin: row.origin,
    supportHash: row.support_hash,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
    supersededById: row.superseded_by_id,
  };
}

function mapManualOp(row) {
  return {
    id: row.id,
    kind: row.kind,
    groups: JSON.parse(row.groups),
    actor: row.actor,
    reason: row.reason,
    active: row.active === 1,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
  };
}

// ---------------------------------------------------------------------------
// Meta / revision counter
// ---------------------------------------------------------------------------

export function revision(db) {
  const row = db.prepare('SELECT value FROM workbench_meta WHERE key = ?').get('revision');
  return row ? Number(row.value) : 0;
}

function bumpRevision(db) {
  db.prepare(
    `INSERT INTO workbench_meta (key, value) VALUES ('revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run();
  return revision(db);
}

export function checkRevision(db, expected) {
  if (expected == null) return;
  const current = revision(db);
  if (Number(expected) !== current) {
    throw httpError(409, 'stale revision: workbench changed since this screen was loaded', {
      expected: Number(expected),
      current,
    });
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export function listCustomers(db) {
  return db.prepare('SELECT * FROM customers ORDER BY id').all().map(mapCustomer);
}

export function getCustomer(db, id) {
  return mapCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
}

export function insertCustomer(db, raw, ts = nowIso()) {
  const info = db.prepare(
    `INSERT INTO customers (source, external_id, name, email, phone, dob, address_line, postal_code, country, vat_id, imported_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    raw.source,
    raw.external_id,
    raw.name,
    raw.email ?? null,
    raw.phone ?? null,
    raw.dob ?? null,
    raw.address_line ?? null,
    raw.postal_code ?? null,
    raw.country ?? null,
    raw.vat_id ?? null,
    ts,
    ts,
  );
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Scoring pass
// ---------------------------------------------------------------------------

function loadCustomers(db) {
  return db.prepare('SELECT * FROM customers ORDER BY id').all();
}

function byCustomerId(db, id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

export function scorePairs(db, rule) {
  const customers = loadCustomers(db);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const blockers = new Map();
  for (const c of customers) {
    for (const t of blockingTokens(c)) {
      if (!blockers.has(t)) blockers.set(t, []);
      blockers.get(t).push(c.id);
    }
  }
  const seen = new Set();
  const pairs = [];
  for (const ids of blockers.values()) {
    if (ids.length > 500) continue; // pathological blocking key
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = Math.min(ids[i], ids[j]);
        const b = Math.max(ids[i], ids[j]);
        const pk = pairKey(a, b);
        if (seen.has(pk)) continue;
        seen.add(pk);
        const match = computeMatch(byId.get(a), byId.get(b), rule.fuzzy, rule.thresholds);
        // Keep anything with visible evidence. Pairs with no shared key and no
        // fuzzy signal at all are not "candidate evidence" worth storing.
        if (match.band === 'reject' && match.reasons.length === 0) continue;
        pairs.push({
          pairKey: pk,
          leftCustomerId: a,
          rightCustomerId: b,
          score: match.score,
          band: match.band,
          reasons: match.reasons,
          conflicts: match.conflicts,
          deterministicKeys: match.deterministicKeys,
        });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.pairKey.localeCompare(y.pairKey));
  return pairs;
}

// ---------------------------------------------------------------------------
// Decisions + manual ops
// ---------------------------------------------------------------------------

export function activeDecisions(db) {
  const rows = db.prepare('SELECT * FROM pair_decisions WHERE active = 1').all();
  return new Map(rows.map((r) => [r.pair_key, mapDecision(r)]));
}

export function allDecisionsForPair(db, pk) {
  return db.prepare('SELECT * FROM pair_decisions WHERE pair_key = ? ORDER BY id').all().map(mapDecision);
}

export function activeManualOps(db) {
  return db.prepare('SELECT * FROM manual_ops WHERE active = 1 ORDER BY id').all().map(mapManualOp);
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

function ltvFor(db, customerIds) {
  if (customerIds.length === 0) return { ltv: 0, orders: 0 };
  const placeholders = customerIds.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COALESCE(SUM(ltv_cents), 0) AS ltv, COALESCE(SUM(orders), 0) AS orders
     FROM customer_metrics WHERE customer_id IN (${placeholders})`,
  ).get(...customerIds);
  return { ltv: Number(row.ltv), orders: Number(row.orders) };
}

export function segmentFor(ltvCents, orders) {
  if (orders === 0) return 'prospect';
  if (ltvCents >= 500_000) return 'platinum';
  if (ltvCents >= 150_000) return 'gold';
  if (ltvCents >= 50_000) return 'silver';
  return 'bronze';
}

function loadActiveClusters(db) {
  const clusters = db.prepare(
    `SELECT cv.* FROM cluster_versions cv WHERE cv.status = 'active' ORDER BY cv.id`,
  ).all();
  const members = db.prepare('SELECT * FROM cluster_members ORDER BY customer_id').all();
  const byCluster = new Map();
  for (const m of members) {
    if (!byCluster.has(m.cluster_version_id)) byCluster.set(m.cluster_version_id, []);
    byCluster.get(m.cluster_version_id).push(m);
  }
  return clusters.map((c) => ({
    ...mapClusterVersion(c),
    members: (byCluster.get(c.id) ?? []).map((m) => ({
      customerId: m.customer_id,
      joinReason: JSON.parse(m.join_reason),
      confidence: m.confidence,
    })),
  }));
}

export function latestRun(db) {
  const row = db.prepare('SELECT * FROM rebuild_runs ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return {
    id: row.id,
    revision: row.revision,
    origin: row.origin,
    ruleVersionId: row.rule_version_id,
    actor: row.actor,
    detail: JSON.parse(row.detail),
    createdAt: row.created_at,
  };
}

/**
 * Evidence identity of a cluster: members, human inputs, and the actual link
 * that joined each member — including its score. If a re-run would leave the
 * same members in the same cluster but with weaker (or different) evidence
 * behind a membership, the cluster version is rewritten rather than reported as
 * "unchanged": cluster versions are immutable, so reusing one would leave its
 * stored join confidence contradicting the current evidence.
 */
function supportHash(group) {
  const decisions = group.links
    .map((l) => l.decision?.id)
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  const manual = [...new Set(group.manualOpIds ?? [])].sort((a, b) => a - b);
  const joins = group.members
    .map((id) => {
      const j = group.joinOf?.get(id);
      if (!j) return `${id}:root`;
      return `${id}:${j.pairKey}:${j.edgeKind ?? '-'}:${j.score ?? '-'}:${j.decision?.id ?? '-'}`;
    })
    .sort();
  return createHash('sha256')
    .update(JSON.stringify({ members: group.members, decisions, manual, joins }))
    .digest('hex');
}

/**
 * Everything inside a single transaction. Callers may compose this with a
 * decision write so the aggregate update is atomic with the adjudication.
 */
export function materialize(db, { rule, origin = 'auto', actor = null, previousRunId = null } = {}) {
  if (!rule) throw httpError(500, 'materialize requires a rule version');
  const customers = loadCustomers(db);
  const customerIds = customers.map((c) => c.id);
  const ts = nowIso();

  const scoredPairs = scorePairs(db, rule);
  const decisionsByPair = activeDecisions(db);
  const manualOps = activeManualOps(db);

  // Human decisions outlive the rules they were made under. If current rules
  // no longer surface a pair that carries an active decision, keep a decision-
  // only evidence row so the decision is still applied during clustering. This
  // is the difference between "rules changed" and "a human's call was erased".
  const rawPairs = [...scoredPairs];
  const scoredByKey = new Map(scoredPairs.map((p) => [p.pairKey, p]));
  const carriedDecisions = [];
  for (const [pk, decision] of decisionsByPair) {
    const scored = scoredByKey.get(pk);
    // A decision is "carried" when the current rules would not have produced
    // it on their own: either the pair is not even generated, or it lands
    // outside the auto band. The decision is what holds this link together.
    if (scored && scored.band === 'auto') continue;
    carriedDecisions.push(pk);
    if (scored) {
      // Annotate the existing evidence row so the review screen explains why
      // a below-auto pair is still linked: a human confirmed or rejected it.
      scored.reasons = [
        {
          field: '*',
          kind: 'carried-decision',
          detail:
            `pair sits outside the current auto band, but an active ` +
            `${decision.action} by ${decision.actor} from ${decision.createdAt} still applies`,
        },
        ...scored.reasons,
      ];
      continue;
    }
    const [leftId, rightId] = pk.split(':').map(Number);
    const left = byCustomerId(db, leftId);
    const right = byCustomerId(db, rightId);
    if (!left || !right) continue; // customer removed from the warehouse
    const match = computeMatch(left, right, rule.fuzzy, rule.thresholds);
    rawPairs.push({
      pairKey: pk,
      leftCustomerId: leftId,
      rightCustomerId: rightId,
      score: match.score,
      band: match.band === 'auto' ? 'review' : match.band,
      reasons: [
        {
          field: '*',
          kind: 'carried-decision',
          detail:
            `pair is below the current rule version's evidence, but an active ` +
            `${decision.action} by ${decision.actor} from ${decision.createdAt} still applies`,
        },
        ...match.reasons,
      ],
      conflicts: match.conflicts,
      deterministicKeys: match.deterministicKeys,
      carriedFrom: decision.id,
    });
  }

  // --- Persist evidence for this rule version (never delete older rows) ---
  const activeDecisionByKey = decisionsByPair;
  const statusFor = (pk, fallback = 'open') => {
    const d = activeDecisionByKey.get(pk);
    if (!d) return fallback;
    return d.action === 'approve' ? 'approved' : 'rejected';
  };
  const pairs = rawPairs.map((p) => {
    const existing = db.prepare(
      'SELECT * FROM candidate_pairs WHERE pair_key = ? AND rule_version_id = ?',
    ).get(p.pairKey, rule.id);
    if (existing) {
      const nextStatus = statusFor(p.pairKey, existing.status === 'superseded' ? 'open' : existing.status);
      db.prepare(
        `UPDATE candidate_pairs SET score=?, band=?, reasons=?, conflicts=?, deterministic_keys=?, status=?,
           superseded_by_id = CASE WHEN ? = 'superseded' THEN superseded_by_id ELSE NULL END
         WHERE id=?`,
      ).run(
        p.score,
        p.band,
        JSON.stringify(p.reasons),
        JSON.stringify(p.conflicts),
        JSON.stringify(p.deterministicKeys),
        nextStatus,
        nextStatus,
        existing.id,
      );
      return mapPair(db.prepare('SELECT * FROM candidate_pairs WHERE id = ?').get(existing.id));
    }
    const info = db.prepare(
      `INSERT INTO candidate_pairs
         (pair_key, left_customer_id, right_customer_id, rule_version_id, score, band, reasons, conflicts, deterministic_keys, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?, ?, ?)`,
    ).run(
      p.pairKey,
      p.leftCustomerId,
      p.rightCustomerId,
      rule.id,
      p.score,
      p.band,
      JSON.stringify(p.reasons),
      JSON.stringify(p.conflicts),
      JSON.stringify(p.deterministicKeys),
      statusFor(p.pairKey),
      ts,
    );
    return mapPair(db.prepare('SELECT * FROM candidate_pairs WHERE id = ?').get(info.lastInsertRowid));
  });

  // Candidate rows for other rule versions are superseded (not deleted) once a
  // newer evidence row exists for the same pair. Direction matters: only rows
  // from an older rule version may be superseded, and only by a row from a
  // newer one; this keeps `superseded_by_id` a forward-only chain even if a
  // materialization runs under a non-latest rule (e.g. a pinned import).
  const supersededPairs = [];
  const older = db.prepare(
    `SELECT cp.id, cp.pair_key FROM candidate_pairs cp
     WHERE cp.rule_version_id <> ?
       AND cp.status <> 'superseded'
       AND cp.rule_version_id < ?
       AND cp.pair_key IN (SELECT pair_key FROM candidate_pairs WHERE rule_version_id = ?)`,
  ).all(rule.id, rule.id, rule.id);
  for (const row of older) {
    const newer = pairs.find((p) => p.pairKey === row.pair_key);
    // A superseding row must be newer than the row it supersedes.
    if (!newer || newer.ruleVersionId <= rule.id) continue;
    db.prepare(
      `UPDATE candidate_pairs SET status='superseded', superseded_by_id=? WHERE id=?`,
    ).run(newer.id, row.id);
    supersededPairs.push(row.id);
  }
  // Evidence rows for this rule version that no longer score: mark superseded.
  // `superseded_by_id` is null here — there is no successor row to point at, so
  // a stale pointer must be cleared rather than left behind.
  const currentKeys = new Set(rawPairs.map((p) => p.pairKey));
  for (const row of db.prepare(
    `SELECT id, pair_key FROM candidate_pairs WHERE rule_version_id = ? AND status='open'`,
  ).all(rule.id)) {
    if (!currentKeys.has(row.pair_key)) {
      db.prepare(`UPDATE candidate_pairs SET status='superseded', superseded_by_id=NULL WHERE id = ?`).run(row.id);
    }
  }

  // --- Cluster ---
  const manualOpIdsByCustomer = new Map();
  for (const op of manualOps) {
    for (const group of op.groups) {
      for (const id of group) {
        if (!manualOpIdsByCustomer.has(id)) manualOpIdsByCustomer.set(id, []);
        manualOpIdsByCustomer.get(id).push(op.id);
      }
    }
  }
  const { groups, conflicts } = buildClusters({ customerIds, pairs, decisionsByPair, manualOps });
  for (const g of groups) {
    g.manualOpIds = [...new Set(g.members.flatMap((id) => manualOpIdsByCustomer.get(id) ?? []))];
    g.supportHash = supportHash(g);
  }

  const existing = loadActiveClusters(db);

  // Lineage inheritance: a new group continues the lineage of the old cluster
  // with the largest member overlap. Assignment is global — candidate pairs
  // are ranked by overlap before any claim — so an incidental one-member
  // overlap cannot steal the lineage of a group that clearly continues it.
  const candidatePairs = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    for (const old of existing) {
      const oldIds = new Set(old.members.map((m) => m.customerId));
      const overlap = group.members.filter((id) => oldIds.has(id)).length;
      if (overlap > 0) {
        candidatePairs.push({ gi, lineageId: old.lineageId, overlap });
      }
    }
  }
  // Largest overlap first; on a tie the larger resulting cluster continues the
  // lineage (an even split of {A,B} keeps the lineage on whichever side is the
  // bigger remainder), then oldest lineage, then group order.
  candidatePairs.sort(
    (x, y) =>
      y.overlap - x.overlap ||
      groups[y.gi].members.length - groups[x.gi].members.length ||
      x.lineageId - y.lineageId ||
      x.gi - y.gi,
  );
  const claimedLineages = new Set();
  const claimedGroups = new Set();
  const previousByGroup = new Map();
  for (const cand of candidatePairs) {
    if (claimedGroups.has(cand.gi) || claimedLineages.has(cand.lineageId)) continue;
    claimedGroups.add(cand.gi);
    claimedLineages.add(cand.lineageId);
    previousByGroup.set(cand.gi, existing.find((c) => c.lineageId === cand.lineageId));
  }
  const assignments = groups.map((group, gi) => ({
    group,
    previous: previousByGroup.get(gi) ?? null,
  }));

  const created = [];
  // Edges are emitted once, from the movement of members between runs. The
  // lineage continuation edge (previous version -> this version) is written
  // here too, and `emitMovementEdges` skips pairs already described, so a
  // single merge/split is never recorded twice with contradicting kinds.
  const emittedEdges = new Set();
  const edgeKey = (from, to) => `${from}->${to}`;
  const writeEdge = (from, to, kind, detail, at) => {
    const key = edgeKey(from, to);
    if (emittedEdges.has(key)) return false;
    emittedEdges.add(key);
    db.prepare(
      `INSERT INTO cluster_edges (from_cluster_version_id, to_cluster_version_id, kind, detail, created_at)
       VALUES (?,?,?,?,?)`,
    ).run(from, to, kind, JSON.stringify(detail), at);
    return true;
  };
  const changeReport = {
    newClusters: [],
    merges: [],
    splits: [],
    rekeys: [],
    dissolved: [],
    unchanged: 0,
    conflicts,
    supersededPairs,
    carriedDecisions,
  };
  const runOriginFor = assignments.map((a) => {
    if (!a.previous) return 'new';
    // Reuse only when the very same rule version produces the very same
    // evidence. A new rule version always writes a new cluster version (a
    // `rekey` when membership happens to be unchanged), so the lineage keeps a
    // record of every rule it was materialized under.
    if (a.previous.supportHash === a.group.supportHash && a.previous.ruleVersionId === rule.id) {
      return 'unchanged';
    }
    return 'changed';
  });

  assignments.forEach(({ group, previous }, idx) => {
    if (runOriginFor[idx] === 'unchanged') {
      created.push({ ...previous, group, reused: true });
      changeReport.unchanged++;
      return;
    }
    const tsNow = nowIso();
    let lineageId;
    let versionNo;
    let originKind;
    if (previous) {
      lineageId = previous.lineageId;
      versionNo = db.prepare(
        'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM cluster_versions WHERE lineage_id = ?',
      ).get(lineageId).n;
      originKind = 'rekey';
    } else {
      const lineage = db.prepare(
        `INSERT INTO cluster_lineage (created_at, origin) VALUES (?, 'auto')`,
      ).run(tsNow);
      lineageId = Number(lineage.lastInsertRowid);
      versionNo = 1;
      originKind = 'auto';
    }
    const info = db.prepare(
      `INSERT INTO cluster_versions
         (lineage_id, rule_version_id, version_no, status, origin, support_hash, created_at)
       VALUES (?,?,?, 'active', ?, ?, ?)`,
    ).run(lineageId, rule.id, versionNo, originKind, group.supportHash, tsNow);
    const id = Number(info.lastInsertRowid);
    if (previous) {
      db.prepare(
        `UPDATE cluster_versions SET status='superseded', superseded_at=?, superseded_by_id=? WHERE id=?`,
      ).run(tsNow, id, previous.id);
      const kind = classifyVersionChange(previous, group);
      writeEdge(
        previous.id,
        id,
        kind,
        {
          fromRuleVersion: previous.ruleVersionId,
          toRuleVersion: rule.id,
          added: group.members.filter((m) => !previous.members.some((x) => x.customerId === m)),
          removed: previous.members
            .map((m) => m.customerId)
            .filter((m) => !group.members.includes(m)),
        },
        tsNow,
      );
      if (kind === 'rekey') changeReport.rekeys.push({ from: previous.id, to: id });
    } else {
      changeReport.newClusters.push({ id, members: group.members });
    }
    for (const customerId of group.members) {
      // The join reason is the union that actually pulled this customer in, not
      // merely the first pair mentioning it: a review-band pair that was never
      // linked must not appear as the reason a member is in the cluster.
      const link = group.joinOf?.get(customerId) ?? null;
      const joinReason = link
        ? {
            edgeKind: link.edgeKind,
            pairKey: link.pairKey,
            pairId: link.pairId ?? null,
            score: link.score,
            band: link.band,
            decisionId: link.decision?.id ?? null,
            decisionAction: link.decision?.action ?? null,
          }
        : { edgeKind: 'root' };
      db.prepare(
        `INSERT INTO cluster_members (cluster_version_id, customer_id, join_reason, confidence)
         VALUES (?,?,?,?)`,
      ).run(id, customerId, JSON.stringify(joinReason), link?.score ?? 1);
    }
    created.push({
      id,
      lineageId,
      ruleVersionId: rule.id,
      versionNo,
      status: 'active',
      supportHash: group.supportHash,
      createdAt: tsNow,
      group,
    });
  });

  // --- Dissolved lineages + merge/split edges from member movement ---
  for (const old of existing) {
    if (claimedLineages.has(old.lineageId)) continue;
    db.prepare(
      `UPDATE cluster_versions SET status='superseded', superseded_at=? WHERE id=?`,
    ).run(ts, old.id);
    changeReport.dissolved.push({ id: old.id, members: old.members.map((m) => m.customerId) });
  }
  emitMovementEdges(existing, created, changeReport, ts, writeEdge);

  // --- Aggregates: rebuilt from active clusters each run ---
  const revisionNo = revision(db) + 1;
  const runKey = `run-${revisionNo}-${Date.now()}`;
  const aggregateRows = [];
  for (const cluster of created) {
    const ids = cluster.group.members;
    const { ltv, orders } = ltvFor(db, ids);
    const segment = segmentFor(ltv, orders);
    db.prepare(
      `INSERT INTO aggregates (run_key, rule_version_id, cluster_version_id, customer_count, ltv_cents, segment, computed_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(runKey, rule.id, cluster.id, ids.length, ltv, segment, ts);
    aggregateRows.push({
      clusterVersionId: cluster.id,
      lineageId: cluster.lineageId,
      customerCount: ids.length,
      ltvCents: ltv,
      segment,
      members: ids,
    });
  }

  // Default to comparing against the previous run so every materialization
  // carries an honest downstream delta, even when triggered by an import.
  const prevRunRow = previousRunId
    ? { id: previousRunId }
    : db.prepare('SELECT id FROM rebuild_runs ORDER BY id DESC LIMIT 1').get();
  const aggregateDiff = diffAggregates(db, prevRunRow?.id ?? null, runKey);
  const newRevision = bumpRevision(db);
  const detail = {
    ...changeReport,
    ruleVersionId: rule.id,
    runKey,
    aggregateDiff,
  };
  db.prepare(
    `INSERT INTO rebuild_runs (revision, origin, rule_version_id, actor, detail, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(newRevision, origin, rule.id, actor, JSON.stringify(detail), ts);

  return {
    revision: newRevision,
    runKey,
    ruleVersionId: rule.id,
    changes: changeReport,
    aggregates: aggregateRows,
    clusterCount: created.length,
  };
}

function classifyVersionChange(previous, group) {
  const oldIds = previous.members.map((m) => m.customerId);
  const added = group.members.some((m) => !oldIds.includes(m));
  const removed = oldIds.some((m) => !group.members.includes(m));
  if (!added && !removed) return 'rekey';
  if (!removed) return 'merge';
  if (!added) return 'split';
  return 'rekey';
}

function diffAggregates(db, previousRunId, runKey) {
  if (!previousRunId) return { previousRunId: null, changed: [] };
  const prevRun = db.prepare('SELECT detail FROM rebuild_runs WHERE id = ?').get(previousRunId);
  if (!prevRun) return { previousRunId, changed: [] };
  const prevRunKey = JSON.parse(prevRun.detail).runKey;
  const before = db.prepare('SELECT * FROM aggregates WHERE run_key = ?').all(prevRunKey);
  const after = db.prepare('SELECT * FROM aggregates WHERE run_key = ?').all(runKey);
  const beforeByLineage = new Map(
    before.map((a) => {
      const cv = db.prepare('SELECT lineage_id FROM cluster_versions WHERE id = ?').get(a.cluster_version_id);
      return [cv?.lineage_id, a];
    }),
  );
  const changed = [];
  for (const a of after) {
    const cv = db.prepare('SELECT lineage_id FROM cluster_versions WHERE id = ?').get(a.cluster_version_id);
    const prev = beforeByLineage.get(cv?.lineage_id);
    if (
      !prev ||
      prev.ltv_cents !== a.ltv_cents ||
      prev.customer_count !== a.customer_count ||
      prev.segment !== a.segment
    ) {
      changed.push({
        lineageId: cv?.lineage_id ?? null,
        before: prev
          ? { customerCount: prev.customer_count, ltvCents: prev.ltv_cents, segment: prev.segment }
          : null,
        after: { customerCount: a.customer_count, ltvCents: a.ltv_cents, segment: a.segment },
      });
    }
    beforeByLineage.delete(cv?.lineage_id);
  }
  for (const [lineageId, prev] of beforeByLineage) {
    changed.push({
      lineageId,
      before: {
        customerCount: prev.customer_count,
        ltvCents: prev.ltv_cents,
        segment: prev.segment,
      },
      after: null,
    });
  }
  return { previousRunId, changed };
}

function emitMovementEdges(existingClusters, created, report, ts, writeEdge) {
  const oldOf = new Map(); // customer -> old cluster id
  for (const c of existingClusters) for (const m of c.members) oldOf.set(m.customerId, c.id);
  const newOf = new Map(); // customer -> new cluster id
  for (const c of created) for (const m of c.group.members) newOf.set(m, c.id);

  const oldToNew = new Map();
  for (const [customerId, oldId] of oldOf) {
    const newId = newOf.get(customerId);
    if (!newId || newId === oldId) continue;
    if (!oldToNew.has(oldId)) oldToNew.set(oldId, new Set());
    oldToNew.get(oldId).add(newId);
  }
  // `writeEdge` refuses a duplicate (from -> to) pair, so a lineage continuation
  // already described as merge/split/rekey by the caller is never re-emitted
  // here with a second kind.
  for (const [oldId, targets] of oldToNew) {
    if (targets.size > 1) {
      for (const newId of targets) {
        writeEdge(oldId, newId, 'split', { into: [...targets] }, ts);
      }
      report.splits.push({ from: oldId, into: [...targets] });
    }
  }
  const newToOld = new Map();
  for (const [oldId, targets] of oldToNew) {
    for (const newId of targets) {
      if (!newToOld.has(newId)) newToOld.set(newId, new Set());
      newToOld.get(newId).add(oldId);
    }
  }
  for (const [newId, olds] of newToOld) {
    if (olds.size > 1) {
      for (const oldId of olds) {
        writeEdge(oldId, newId, 'merge', { sources: [...olds] }, ts);
      }
      report.merges.push({ into: newId, from: [...olds] });
    }
  }
}

// ---------------------------------------------------------------------------
// Adjudication (each writes a decision + re-materializes atomically)
// ---------------------------------------------------------------------------

export function recordDecision(db, { pairKey: pk, action, actor, reason, expectedRevision }) {
  if (!['approve', 'reject'].includes(action)) throw httpError(400, 'action must be approve or reject');
  if (!actor || String(actor).trim() === '') throw httpError(400, 'actor is required');
  return tx(db, () => {
    checkRevision(db, expectedRevision);
    const pair = db.prepare(
      `SELECT * FROM candidate_pairs WHERE pair_key = ? ORDER BY rule_version_id DESC LIMIT 1`,
    ).get(pk);
    if (!pair) throw httpError(404, `no candidate evidence for pair ${pk}`);
    const current = db.prepare('SELECT * FROM pair_decisions WHERE pair_key = ? AND active = 1').get(pk);
    if (current) {
      throw httpError(409, `pair ${pk} already has an active ${current.action} decision`, {
        decision: mapDecision(current),
      });
    }
    const ts = nowIso();
    const info = db.prepare(
      `INSERT INTO pair_decisions (pair_id, pair_key, action, actor, reason, created_at, active)
       VALUES (?,?,?,?,?,?,1)`,
    ).run(pair.id, pk, action, actor, reason ?? null, ts);
    // Only the newest evidence row carries the live status; older rows keep
    // the status they had under their own rule version so the evidence history
    // is not rewritten by a later decision.
    db.prepare(
      `UPDATE candidate_pairs SET status = ?
       WHERE pair_key = ? AND rule_version_id = (SELECT MAX(rule_version_id) FROM candidate_pairs WHERE pair_key = ?)`,
    ).run(action === 'approve' ? 'approved' : 'rejected', pk, pk);    const rule = hydrateRuleRow(db.prepare('SELECT * FROM rule_versions ORDER BY version_no DESC LIMIT 1').get());
    const run = materialize(db, { rule, origin: `decision:${action}`, actor });
    return {
      decision: {
        id: Number(info.lastInsertRowid),
        pairKey: pk,
        action,
        actor,
        reason: reason ?? null,
        createdAt: ts,
      },
      revision: run.revision,
      materialization: run,
    };
  });
}

function hydrateRuleRow(row) {
  return {
    id: row.id,
    versionNo: row.version_no,
    configHash: row.config_hash,
    thresholds: JSON.parse(row.thresholds),
    deterministic: JSON.parse(row.deterministic),
    fuzzy: JSON.parse(row.fuzzy),
    note: row.note,
    createdAt: row.created_at,
  };
}

export function revokeDecision(db, { decisionId, actor, reason, expectedRevision }) {
  if (!actor || String(actor).trim() === '') throw httpError(400, 'actor is required');
  if (!reason || String(reason).trim() === '') throw httpError(400, 'a revocation reason is required');
  return tx(db, () => {
    checkRevision(db, expectedRevision);
    const row = db.prepare('SELECT * FROM pair_decisions WHERE id = ?').get(decisionId);
    if (!row) throw httpError(404, `decision ${decisionId} not found`);
    if (row.active !== 1) throw httpError(409, `decision ${decisionId} is already revoked`);
    const ts = nowIso();
    db.prepare(
      `UPDATE pair_decisions SET active = 0, revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?`,
    ).run(ts, actor, reason, decisionId);
    // Evidence returns to the review queue; it is never deleted. Only the
    // newest evidence row is reopened: superseded rows stay superseded so the
    // history of what was compared under which rules remains intact. Clearing
    // `superseded_by_id` keeps the row internally consistent (an open row is
    // not the superseded predecessor of anything).
    db.prepare(
      `UPDATE candidate_pairs SET status = 'open', superseded_by_id = NULL
       WHERE pair_key = ? AND rule_version_id = (SELECT MAX(rule_version_id) FROM candidate_pairs WHERE pair_key = ?)`,
    ).run(row.pair_key, row.pair_key);
    db.prepare(
      `INSERT INTO impact_alerts (kind, subject, detail, created_at) VALUES ('revocation', ?, ?, ?)`,
    ).run(row.pair_key, JSON.stringify({ decisionId, action: row.action, actor, reason }), ts);
    const rule = hydrateRuleRow(db.prepare('SELECT * FROM rule_versions ORDER BY version_no DESC LIMIT 1').get());
    const run = materialize(db, { rule, origin: 'revocation', actor });
    return {
      revoked: {
        id: decisionId,
        pairKey: row.pair_key,
        action: row.action,
        revokedAt: ts,
        revokedBy: actor,
        reason,
        evidenceRetained: true,
      },
      revision: run.revision,
      materialization: run,
    };
  });
}

export function recordManualOp(db, { kind, groups, actor, reason, expectedRevision }) {
  if (!['merge', 'split'].includes(kind)) throw httpError(400, 'kind must be merge or split');
  if (!actor || String(actor).trim() === '') throw httpError(400, 'actor is required');
  if (!Array.isArray(groups) || groups.length === 0) throw httpError(400, 'groups is required');
  if (kind === 'split' && groups.length < 2) {
    throw httpError(400, 'a split needs at least two groups');
  }
  if (kind === 'merge' && groups.length !== 1) {
    // A merge is one assertion: "all of these belong together". Two groups in
    // one merge row would silently express two independent merges, which makes
    // the audit trail (and its revocation) ambiguous. Callers issue one op per
    // merge.
    throw httpError(400, 'a merge must contain exactly one group of customer ids', {
      groups: groups.length,
    });
  }
  const cleanGroups = groups.map((g) => {
    if (!Array.isArray(g) || g.length === 0) throw httpError(400, 'each group must be a non-empty array');
    const ids = g.map((x) => Number(x));
    if (ids.some((x) => !Number.isInteger(x) || x <= 0)) {
      throw httpError(400, 'customer ids must be positive integers');
    }
    return [...new Set(ids)].sort((a, b) => a - b);
  });
  const all = cleanGroups.flat();
  if (new Set(all).size !== all.length) {
    throw httpError(400, 'a customer may appear in only one group of an operation');
  }
  return tx(db, () => {
    checkRevision(db, expectedRevision);
    const placeholders = all.map(() => '?').join(',');
    const found = db.prepare(`SELECT id FROM customers WHERE id IN (${placeholders})`).all(...all);
    if (found.length !== all.length) {
      throw httpError(400, 'one or more customer ids do not exist', { missing: all.length - found.length });
    }
    if (kind === 'split') {
      // A split is a partition of the clusters it names. Groups may deliberately
      // mix members of different current clusters (that is how a customer is
      // moved from one entity into another), but any customer left out of every
      // named group stays attached to whichever group the automatic links happen
      // to favour, and the operator silently gets neither the old cluster nor
      // the partition they asked for. Require full coverage of every cluster the
      // operation touches. (The UI selects whole clusters, so this only rejects
      // hand-built or stale payloads.)
      const clusterOf = new Map();
      for (const c of loadActiveClusters(db)) {
        for (const m of c.members) clusterOf.set(m.customerId, c);
      }
      const touched = new Map(); // cluster version id -> { cluster, named:Set }
      for (const group of cleanGroups) {
        for (const id of group) {
          const cluster = clusterOf.get(id);
          if (!cluster) continue;
          if (!touched.has(cluster.id)) {
            touched.set(cluster.id, { cluster, named: new Set() });
          }
          touched.get(cluster.id).named.add(id);
        }
      }
      for (const { cluster, named } of touched.values()) {
        const missing = cluster.members
          .map((m) => m.customerId)
          .filter((id) => !named.has(id));
        if (missing.length > 0) {
          throw httpError(400, 'a split must account for every member of the clusters it touches', {
            clusterVersionId: cluster.id,
            members: cluster.members.map((m) => m.customerId),
            uncovered: missing,
          });
        }
      }
    }
    const ts = nowIso();
    const info = db.prepare(
      `INSERT INTO manual_ops (kind, groups, actor, reason, created_at, active) VALUES (?,?,?,?,?,1)`,
    ).run(kind, JSON.stringify(cleanGroups), actor, reason ?? null, ts);
    const rule = hydrateRuleRow(db.prepare('SELECT * FROM rule_versions ORDER BY version_no DESC LIMIT 1').get());
    const run = materialize(db, { rule, origin: kind, actor });
    return {
      op: {
        id: Number(info.lastInsertRowid),
        kind,
        groups: cleanGroups,
        actor,
        reason: reason ?? null,
        createdAt: ts,
      },
      revision: run.revision,
      materialization: run,
    };
  });
}

export function revokeManualOp(db, { opId, actor, reason, expectedRevision }) {
  if (!actor || String(actor).trim() === '') throw httpError(400, 'actor is required');
  if (!reason || String(reason).trim() === '') throw httpError(400, 'a revocation reason is required');
  return tx(db, () => {
    checkRevision(db, expectedRevision);
    const row = db.prepare('SELECT * FROM manual_ops WHERE id = ?').get(opId);
    if (!row) throw httpError(404, `manual op ${opId} not found`);
    if (row.active !== 1) throw httpError(409, `manual op ${opId} is already revoked`);
    const ts = nowIso();
    db.prepare(
      `UPDATE manual_ops SET active = 0, revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?`,
    ).run(ts, actor, reason, opId);
    db.prepare(
      `INSERT INTO impact_alerts (kind, subject, detail, created_at) VALUES ('revocation', ?, ?, ?)`,
    ).run(`manual-op:${opId}`, JSON.stringify({ opId, kind: row.kind, actor, reason }), ts);
    const rule = hydrateRuleRow(db.prepare('SELECT * FROM rule_versions ORDER BY version_no DESC LIMIT 1').get());
    const run = materialize(db, { rule, origin: 'revocation', actor });
    return {
      op: mapManualOp(db.prepare('SELECT * FROM manual_ops WHERE id = ?').get(opId)),
      revision: run.revision,
      materialization: run,
    };
  });
}

// ---------------------------------------------------------------------------
// Query surfaces
// ---------------------------------------------------------------------------

export function currentClusters(db) {
  const rows = loadActiveClusters(db);
  const customers = new Map(loadCustomers(db).map((c) => [c.id, mapCustomer(c)]));
  return rows.map((c) => {
    const ids = c.members.map((m) => m.customerId);
    const { ltv, orders } = ltvFor(db, ids);
    return {
      ...c,
      customers: c.members.map((m) => ({
        ...customers.get(m.customerId),
        joinReason: m.joinReason,
        confidence: m.confidence,
      })),
      metrics: { ltvCents: ltv, orders, segment: segmentFor(ltv, orders) },
    };
  });
}

export function clusterVersionsForLineage(db, lineageId) {
  const lineage = db.prepare('SELECT * FROM cluster_lineage WHERE id = ?').get(lineageId);
  if (!lineage) throw httpError(404, `lineage ${lineageId} not found`);
  const versions = db.prepare(
    'SELECT * FROM cluster_versions WHERE lineage_id = ? ORDER BY version_no',
  ).all(lineageId);
  return {
    lineage: { id: lineage.id, createdAt: lineage.created_at, origin: lineage.origin },
    versions: versions.map((row) => {
      const members = db.prepare(
        `SELECT cm.*, c.name, c.email FROM cluster_members cm JOIN customers c ON c.id = cm.customer_id
         WHERE cm.cluster_version_id = ? ORDER BY cm.customer_id`,
      ).all(row.id);
      const edges = db.prepare(
        `SELECT * FROM cluster_edges WHERE from_cluster_version_id = ? OR to_cluster_version_id = ?
         ORDER BY id`,
      ).all(row.id, row.id);
      return {
        ...mapClusterVersion(row),
        members: members.map((m) => ({
          customerId: m.customer_id,
          name: m.name,
          email: m.email,
          joinReason: JSON.parse(m.join_reason),
          confidence: m.confidence,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          from: e.from_cluster_version_id,
          to: e.to_cluster_version_id,
          kind: e.kind,
          detail: JSON.parse(e.detail),
          createdAt: e.created_at,
        })),
      };
    }),
  };
}

export function reviewQueue(db, { ruleVersionId, band, status = 'open', limit = 200, offset = 0 } = {}) {
  const rule = ruleVersionId
    ? db.prepare('SELECT id FROM rule_versions WHERE id = ?').get(ruleVersionId)
    : db.prepare('SELECT id FROM rule_versions ORDER BY version_no DESC LIMIT 1').get();
  if (!rule) return { pairs: [], total: 0, ruleVersionId: null };
  const params = [rule.id];
  let where = 'cp.rule_version_id = ?';
  if (band) {
    where += ' AND cp.band = ?';
    params.push(band);
  }
  if (status) {
    where += ' AND cp.status = ?';
    params.push(status);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM candidate_pairs cp WHERE ${where}`).get(...params).n;
  const rows = db.prepare(
    `SELECT cp.*, l.name AS left_name, l.email AS left_email, l.phone AS left_phone, l.country AS left_country,
            r.name AS right_name, r.email AS right_email, r.phone AS right_phone, r.country AS right_country
     FROM candidate_pairs cp
     JOIN customers l ON l.id = cp.left_customer_id
     JOIN customers r ON r.id = cp.right_customer_id
     WHERE ${where}
     ORDER BY cp.score DESC, cp.pair_key LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  const decisions = activeDecisions(db);
  return {
    ruleVersionId: rule.id,
    total,
    pairs: rows.map((row) => ({
      ...mapPair(row),
      decision: decisions.get(row.pair_key) ?? null,
      left: { id: row.left_customer_id, name: row.left_name, email: row.left_email, phone: row.left_phone, country: row.left_country },
      right: { id: row.right_customer_id, name: row.right_name, email: row.right_email, phone: row.right_phone, country: row.right_country },
    })),
  };
}

export function impactReport(db, runId = null) {
  const run = runId
    ? db.prepare('SELECT * FROM rebuild_runs WHERE id = ?').get(runId)
    : db.prepare('SELECT * FROM rebuild_runs ORDER BY id DESC LIMIT 1').get();
  if (!run) return null;
  const detail = JSON.parse(run.detail);
  const alerts = db.prepare('SELECT * FROM impact_alerts WHERE resolved_at IS NULL ORDER BY id DESC').all();
  const runAgg = db.prepare('SELECT * FROM aggregates WHERE run_key = ? ORDER BY cluster_version_id').all(detail.runKey);
  const recentRuns = db.prepare(
    'SELECT id, revision, origin, rule_version_id, actor, created_at FROM rebuild_runs ORDER BY id DESC LIMIT 25',
  ).all();
  return {
    run: {
      id: run.id,
      revision: run.revision,
      origin: run.origin,
      ruleVersionId: run.rule_version_id,
      actor: run.actor,
      createdAt: run.created_at,
    },
    changes: detail,
    aggregates: runAgg.map((a) => ({
      clusterVersionId: a.cluster_version_id,
      customerCount: a.customer_count,
      ltvCents: a.ltv_cents,
      segment: a.segment,
      computedAt: a.computed_at,
    })),
    openAlerts: alerts.map((a) => ({
      id: a.id,
      kind: a.kind,
      subject: a.subject,
      detail: JSON.parse(a.detail),
      createdAt: a.created_at,
    })),
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      revision: r.revision,
      origin: r.origin,
      ruleVersionId: r.rule_version_id,
      actor: r.actor,
      createdAt: r.created_at,
    })),
  };
}

export function customerTimeline(db, customerId) {
  if (!getCustomer(db, customerId)) throw httpError(404, `customer ${customerId} not found`);
  const memberships = db.prepare(
    `SELECT cv.id AS cluster_version_id, cv.lineage_id, cv.rule_version_id, cv.version_no, cv.status,
            cv.origin, cv.created_at, cv.superseded_at, cm.join_reason, cm.confidence
     FROM cluster_members cm JOIN cluster_versions cv ON cv.id = cm.cluster_version_id
     WHERE cm.customer_id = ? ORDER BY cv.id`,
  ).all(customerId);
  const pairs = db.prepare(
    'SELECT * FROM candidate_pairs WHERE left_customer_id = ? OR right_customer_id = ? ORDER BY id',
  ).all(customerId, customerId);
  const decisions = db.prepare(
    `SELECT pd.* FROM pair_decisions pd
     JOIN candidate_pairs cp ON cp.pair_key = pd.pair_key
     WHERE cp.left_customer_id = ? OR cp.right_customer_id = ? ORDER BY pd.id`,
  ).all(customerId, customerId);
  const lineageIds = [...new Set(memberships.map((m) => m.lineage_id))];
  return {
    customer: getCustomer(db, customerId),
    memberships: memberships.map((m) => ({
      clusterVersionId: m.cluster_version_id,
      lineageId: m.lineage_id,
      ruleVersionId: m.rule_version_id,
      versionNo: m.version_no,
      status: m.status,
      origin: m.origin,
      createdAt: m.created_at,
      supersededAt: m.superseded_at,
      joinReason: JSON.parse(m.join_reason),
      confidence: m.confidence,
    })),
    lineages: lineageIds.map((id) => clusterVersionsForLineage(db, id)),
    pairs: pairs.map((p) => ({
      ...mapPair(p),
      decision: mapDecision(
        db.prepare('SELECT * FROM pair_decisions WHERE pair_id = ? ORDER BY id DESC LIMIT 1').get(p.id),
      ),
    })),
    decisions: decisions.map(mapDecision),
  };
}

export function workbenchState(db) {
  const rule = db.prepare('SELECT id FROM rule_versions ORDER BY version_no DESC LIMIT 1').get();
  return {
    revision: revision(db),
    ruleVersion: rule?.id ?? null,
    counts: {
      customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
      activeClusters: db.prepare(`SELECT COUNT(*) AS n FROM cluster_versions WHERE status='active'`).get().n,
      lineageCount: db.prepare('SELECT COUNT(*) AS n FROM cluster_lineage').get().n,
      candidatePairs: db.prepare('SELECT COUNT(*) AS n FROM candidate_pairs').get().n,
      openReview: db.prepare(`SELECT COUNT(*) AS n FROM candidate_pairs WHERE status='open' AND band IN ('review','manual')`).get().n,
      activeDecisions: db.prepare('SELECT COUNT(*) AS n FROM pair_decisions WHERE active=1').get().n,
      openAlerts: db.prepare('SELECT COUNT(*) AS n FROM impact_alerts WHERE resolved_at IS NULL').get().n,
    },
  };
}

export function resolveAlerts(db, ids = null) {
  return tx(db, () => {
    const ts = nowIso();
    if (ids && ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE impact_alerts SET resolved_at = ? WHERE id IN (${placeholders})`).run(ts, ...ids);
    } else {
      db.prepare('UPDATE impact_alerts SET resolved_at = ? WHERE resolved_at IS NULL').run(ts);
    }
    bumpRevision(db);
    return { resolvedAt: ts };
  });
}

export { pairKey };
