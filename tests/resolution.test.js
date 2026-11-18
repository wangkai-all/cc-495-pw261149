import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { ensureRuleVersion, latestRule } from '../src/engine/rules.js';
import {
  materialize,
  currentClusters,
  reviewQueue,
  recordDecision,
  revokeDecision,
  recordManualOp,
  revokeManualOp,
  workbenchState,
  impactReport,
  clusterVersionsForLineage,
  customerTimeline,
  revision,
} from '../src/service/resolution.js';
import { importBatch } from '../src/service/import.js';

export function freshDb({ seed = false } = {}) {
  const db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule, origin: 'bootstrap' });
  if (seed) {
    importBatch(db, {
      label: 'test',
      idempotencyKey: 'test-seed',
      rows: [
        { source: 'crm', external_id: 'A1', name: 'Alice Johnson', email: 'alice@example.com', phone: '+1 555 1000', dob: '1990-01-01', address_line: '1 Main St', postal_code: '11111', country: 'US' },
        { source: 'shop', external_id: 'B1', name: 'Alice Johnson', email: 'alice@example.com', phone: null, dob: null, address_line: null, postal_code: null, country: 'US' },
      ],
      actor: 'test',
    });
  }
  return db;
}

function scenarioDb() {
  // Deterministic small dataset with known, non-ambiguous outcomes.
  const db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule, origin: 'bootstrap' });
  importBatch(db, {
    label: 'people',
    idempotencyKey: 'people-v1',
    actor: 'test',
    rows: [
      // pair 1: strong auto-link through phone + name + dob
      { source: 'crm', external_id: 'P1', name: 'Alice Johnson', email: 'alice@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main St', postal_code: '11111', country: 'US' },
      { source: 'shop', external_id: 'P2', name: 'Alice Johnson', email: 'alice@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main Street', postal_code: '11111', country: 'US' },
      // pair 2: fuzzy-only review candidate (same person, different contacts)
      { source: 'crm', external_id: 'Q1', name: 'Jonathan Smith', email: 'jon.smith@a.com', phone: '+15552000', dob: '1980-01-01', address_line: '10 Oak Street', postal_code: '22222', country: 'US' },
      { source: 'shop', external_id: 'Q2', name: 'Jon Smith', email: 'jon.smith@b.com', phone: '+15553000', dob: null, address_line: '10 Oak St', postal_code: '22222', country: 'US' },
      // pair 3: same name, different person (hard conflict)
      { source: 'crm', external_id: 'R1', name: 'Michael Brown', email: 'michael.brown@example.com', phone: '+15554000', dob: '1970-01-09', address_line: '5 Ave', postal_code: '33333', country: 'US' },
      { source: 'shop', external_id: 'R2', name: 'Michael Brown', email: 'mike.b@other.net', phone: '+15555000', dob: '1994-09-30', address_line: '5 Ave', postal_code: '33333', country: 'US' },
    ],
  });
  return db;
}

test('auto links create clusters and preserve one lineage per entity', () => {
  const db = scenarioDb();
  const clusters = currentClusters(db);
  const alice = clusters.find((c) => c.customers.some((x) => x.name === 'Alice Johnson') && c.customers.length === 2);
  assert.ok(alice, 'expected an auto-linked Alice cluster');
  const michael = clusters.filter((c) => c.customers.some((x) => x.name === 'Michael Brown'));
  assert.equal(michael.length, 2, 'same name + different DOB must stay apart');
});

test('review queue shows reasons, conflicts, and the shared keys', () => {
  const db = scenarioDb();
  const q = reviewQueue(db, { band: 'review', status: 'open' });
  const pair = q.pairs.find((p) => p.left.name === 'Jonathan Smith' && p.right.name === 'Jon Smith');
  assert.ok(pair, 'expected the Smith pair in the review band');
  assert.ok(pair.reasons.length > 0);
  assert.ok(pair.conflicts.some((c) => c.field === 'email' && c.severity === 'soft'));
  assert.equal(pair.decision, null);
});

test('approving a review pair merges the clusters and records evidence', () => {
  const db = scenarioDb();
  const q = reviewQueue(db, { band: 'review', status: 'open' });
  const pair = q.pairs.find((p) => p.left.name === 'Jonathan Smith');
  const before = currentClusters(db).filter((c) =>
    c.customers.some((x) => x.name.includes('Smith')),
  );
  assert.equal(before.length, 2);

  const result = recordDecision(db, {
    pairKey: pair.pairKey,
    action: 'approve',
    actor: 'analyst.one',
    reason: 'same address, same employer, confirmed by phone',
  });
  assert.equal(result.decision.action, 'approve');

  const after = currentClusters(db).filter((c) => c.customers.some((x) => x.name.includes('Smith')));
  assert.equal(after.length, 1, 'approval must merge the two clusters');
  assert.equal(after[0].customers.length, 2);
  const joinReason = after[0].customers.find((c) => c.name === 'Jon Smith').joinReason;
  assert.equal(joinReason.edgeKind, 'approval');
  assert.equal(joinReason.decisionId, result.decision.id);

  // Aggregates reflect the merge.
  const agg = result.materialization.aggregates.find((a) => a.lineageId === after[0].lineageId);
  assert.equal(agg.customerCount, 2);
});

test('revoking an approval splits the cluster back, keeps the evidence, and flags impact', () => {
  const db = scenarioDb();
  const q = reviewQueue(db, { band: 'review', status: 'open' });
  const pair = q.pairs.find((p) => p.left.name === 'Jonathan Smith');
  const approved = recordDecision(db, {
    pairKey: pair.pairKey,
    action: 'approve',
    actor: 'analyst.one',
    reason: 'confirmed',
  });
  assert.equal(
    currentClusters(db).filter((c) => c.customers.some((x) => x.name.includes('Smith'))).length,
    1,
  );

  const revoked = revokeDecision(db, {
    decisionId: approved.decision.id,
    actor: 'supervisor',
    reason: 'customer service says these are two people',
    expectedRevision: revision(db),
  });

  const smith = currentClusters(db).filter((c) => c.customers.some((x) => x.name.includes('Smith')));
  assert.equal(smith.length, 2, 'revocation must restore the split');

  // Evidence is still there.
  const decisionsForPair = db.prepare('SELECT * FROM pair_decisions WHERE pair_key = ?').all(pair.pairKey);
  assert.equal(decisionsForPair.length, 1, 'revoked decision row is retained');
  assert.equal(decisionsForPair[0].active, 0);
  assert.equal(decisionsForPair[0].revoked_by, 'supervisor');
  const evidence = db.prepare('SELECT * FROM candidate_pairs WHERE pair_key = ?').all(pair.pairKey);
  assert.ok(evidence.length >= 1, 'candidate evidence survives revocation');
  assert.equal(evidence[0].status, 'open', 'evidence returns to the review queue');

  const impact = impactReport(db);
  assert.ok(impact.openAlerts.some((a) => a.kind === 'revocation' && a.subject === pair.pairKey));
  assert.ok(revoked.revoked.evidenceRetained);
});

test('rule change keeps old cluster versions and records a rekey history', () => {
  const db = scenarioDb();
  const aliceLineage = currentClusters(db).find((c) => c.customers.some((x) => x.name === 'Alice Johnson')).lineageId;
  const rule1 = latestRule(db);
  const rule2 = ensureRuleVersion(db, {
    thresholds: { ...rule1.thresholds, review: 0.7, autoLink: 0.95 },
  }, 'tighten');
  const run = materialize(db, { rule: rule2, origin: 'rule-change', actor: 'admin' });
  assert.ok(run.changes.rekeys.length > 0, 'unchanged membership should become a rekey version');

  const history = clusterVersionsForLineage(db, aliceLineage);
  assert.ok(history.versions.length >= 2);
  assert.equal(history.versions[0].status, 'superseded');
  assert.equal(history.versions[0].supersededById, history.versions[1].id);
  assert.equal(history.versions[1].status, 'active');
  assert.ok(history.versions[0].edges.some((e) => e.kind === 'rekey'));
  // The old version's members are still queryable.
  assert.equal(history.versions[0].members.length, 2);
});

test('splitting a cluster is recorded as a manual op and revocable', () => {
  const db = scenarioDb();
  const alice = currentClusters(db).find((c) => c.customers.some((x) => x.name === 'Alice Johnson'));
  const ids = alice.customers.map((c) => c.id);
  const op = recordManualOp(db, {
    kind: 'split',
    groups: [[ids[0]], [ids[1]]],
    actor: 'analyst.two',
    reason: 'shared phone in household',
  });
  const after = currentClusters(db).filter((c) => c.customers.some((x) => x.name === 'Alice Johnson'));
  assert.equal(after.length, 2);

  revokeManualOp(db, {
    opId: op.op.id,
    actor: 'supervisor',
    reason: 'phone was a shared office line, not a household',
  });
  const restored = currentClusters(db).filter((c) => c.customers.some((x) => x.name === 'Alice Johnson'));
  assert.equal(restored.length, 1, 'revoking the split restores the merge');
  const opRow = db.prepare('SELECT * FROM manual_ops WHERE id = ?').get(op.op.id);
  assert.equal(opRow.active, 0);
});

test('duplicate approval is rejected with 409-style conflict', () => {
  const db = scenarioDb();
  const q = reviewQueue(db, { band: 'review', status: 'open' });
  const pair = q.pairs.find((p) => p.left.name === 'Jonathan Smith');
  recordDecision(db, { pairKey: pair.pairKey, action: 'approve', actor: 'a', reason: 'x' });
  assert.throws(
    () => recordDecision(db, { pairKey: pair.pairKey, action: 'approve', actor: 'b', reason: 'y' }),
    (err) => err.status === 409,
  );
});

test('confirmations racing on the same revision: exactly one wins', () => {
  const db = scenarioDb();
  const q = reviewQueue(db, { band: 'review', status: 'open' });
  const pair = q.pairs.find((p) => p.left.name === 'Jonathan Smith');
  const rev = revision(db);
  // First writer wins.
  recordDecision(db, { pairKey: pair.pairKey, action: 'approve', actor: 'a', reason: 'x', expectedRevision: rev });
  // Second writer with the stale screen revision is rejected before touching state.
  assert.throws(
    () => recordDecision(db, { pairKey: pair.pairKey, action: 'reject', actor: 'b', reason: 'y', expectedRevision: rev }),
    (err) => err.status === 409 && /stale revision/.test(err.message),
  );
  // Exactly one active decision exists.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pair_decisions WHERE active = 1').get().n, 1);
});

test('concurrent imports of the same idempotency key apply once', async () => {
  const db = scenarioDb();
  const rows = [
    { source: 'crm', external_id: 'N1', name: 'Nora Diaz', email: 'nora@example.com', phone: null, dob: null, address_line: null, postal_code: null, country: 'US' },
  ];
  const [a, b] = await Promise.allSettled([
    Promise.resolve().then(() => importBatch(db, { label: 'x', idempotencyKey: 'same-key', rows, actor: 't1' })),
    Promise.resolve().then(() => importBatch(db, { label: 'x', idempotencyKey: 'same-key', rows, actor: 't2' })),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'fulfilled');
  assert.equal(a.value.replayed, false);
  assert.equal(b.value.replayed, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name = ?').get('Nora Diaz').n, 1);
});

test('reusing an idempotency key with a different payload is refused', () => {
  const db = scenarioDb();
  const rows = [
    { source: 'crm', external_id: 'N2', name: 'Nora Diaz', email: 'nora@example.com' },
  ];
  importBatch(db, { label: 'x', idempotencyKey: 'fixed', rows, actor: 't1' });
  assert.throws(
    () =>
      importBatch(db, {
        label: 'x',
        idempotencyKey: 'fixed',
        rows: [{ ...rows[0], name: 'Nora D.' }],
        actor: 't1',
      }),
    (err) => err.status === 409,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers WHERE external_id = ?').get('N2').n, 1);
});

test('re-importing identical rows reports duplicates instead of inserting again', () => {
  const db = scenarioDb();
  const rows = [{ source: 'crm', external_id: 'D1', name: 'Dup Person', email: 'dup@example.com' }];
  const first = importBatch(db, { label: 'a', idempotencyKey: 'k1', rows, actor: 't' });
  assert.equal(first.batch.summary.inserted, 1);
  const second = importBatch(db, { label: 'b', idempotencyKey: 'k2', rows, actor: 't' });
  assert.equal(second.batch.summary.duplicate, 1);
  assert.equal(second.batch.summary.inserted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers WHERE external_id = ?').get('D1').n, 1);
});

test('duplicate external ids inside one batch are rejected, not silently collapsed', () => {
  const db = scenarioDb();
  const rows = [
    { source: 'crm', external_id: 'Z1', name: 'Zoe One', email: 'z@example.com' },
    { source: 'crm', external_id: 'Z1', name: 'Zoe Two', email: 'z2@example.com' },
  ];
  const result = importBatch(db, { label: 'dupes', idempotencyKey: 'kz', rows, actor: 't' });
  assert.equal(result.batch.summary.inserted, 1);
  assert.equal(result.batch.summary.rejected, 1);
  assert.match(result.batch.rows[1].reason, /duplicate of row 0/);
});

test('stale revision is reported with the current revision so the UI can refresh', () => {
  const db = scenarioDb();
  const rev = revision(db);
  recordManualOp(db, {
    kind: 'merge',
    groups: [[1, 2]],
    actor: 'x',
    reason: 'test',
  });
  assert.throws(
    () => recordManualOp(db, { kind: 'merge', groups: [[3, 4]], actor: 'y', reason: 'z', expectedRevision: rev }),
    (err) => err.status === 409 && err.details.current === revision(db),
  );
});

test('a rejected pair cannot be silently re-merged by an automatic link', () => {
  const db = scenarioDb();
  const michael = db.prepare(
    "SELECT cp.pair_key FROM candidate_pairs cp JOIN customers c ON c.id = cp.left_customer_id WHERE c.name = 'Michael Brown' LIMIT 1",
  ).get();
  // Reject the pair that the rules would not link anyway.
  recordDecision(db, { pairKey: michael.pair_key, action: 'reject', actor: 'a', reason: 'different people' });
  // Now loosen the rules so it would auto-link.
  const rule = latestRule(db);
  const loose = ensureRuleVersion(db, {
    thresholds: { ...rule.thresholds, autoLink: 0.6, review: 0.4 },
  }, 'loose');
  materialize(db, { rule: loose, origin: 'rule-change', actor: 'admin' });
  const clusters = currentClusters(db).filter((c) => c.customers.some((x) => x.name === 'Michael Brown'));
  assert.equal(clusters.length, 2, 'a human rejection must survive a rule change');
});

test('timeline exposes every cluster version a customer was part of', () => {
  const db = scenarioDb();
  const aliceId = db.prepare("SELECT id FROM customers WHERE name = 'Alice Johnson' LIMIT 1").get().id;
  const timeline = customerTimeline(db, aliceId);
  assert.ok(timeline.memberships.length >= 1);
  assert.ok(timeline.lineages.length >= 1);
  assert.ok(timeline.pairs.length >= 1);
});

test('workbench state counts stay consistent with query results', () => {
  const db = scenarioDb();
  const state = workbenchState(db);
  assert.equal(state.counts.customers, 6);
  assert.equal(state.counts.activeClusters, currentClusters(db).length);
  assert.ok(state.revision > 0);
});

test('an approval survives a rule change that stops scoring the pair', () => {
  const db = scenarioDb();
  // Approve a fuzzy-only pair.
  const q = reviewQueue(db, { band: 'review', status: 'open' });
  const pair = q.pairs.find((p) => p.left.name === 'Jonathan Smith');
  recordDecision(db, { pairKey: pair.pairKey, action: 'approve', actor: 'a', reason: 'confirmed' });
  assert.equal(
    currentClusters(db).filter((c) => c.customers.some((x) => x.name.includes('Smith'))).length,
    1,
  );

  // Tighten rules so far that nothing fuzzy is a candidate at all.
  const rule = latestRule(db);
  ensureRuleVersion(db, {
    thresholds: { autoLink: 0.999, review: 0.999, keyMatchMin: 0.999 },
    fuzzy: rule.fuzzy,
  }, 'nothing is a candidate');
  const newest = latestRule(db);
  const run = materialize(db, { rule: newest, origin: 'rule-change', actor: 'admin' });

  assert.ok(
    run.changes.carriedDecisions.includes(pair.pairKey),
    'an approval below the current auto band must be reported as carried',
  );
  const smith = currentClusters(db).filter((c) => c.customers.some((x) => x.name.includes('Smith')));
  assert.equal(smith.length, 1, 'human confirmation must not be erased by a rule change');

  // Evidence for the carried pair still exists under the new rule version.
  const ev = db.prepare(
    'SELECT * FROM candidate_pairs WHERE pair_key = ? AND rule_version_id = ?',
  ).get(pair.pairKey, newest.id);
  assert.ok(ev);
  assert.equal(ev.status, 'approved');
  assert.ok(JSON.parse(ev.reasons).some((r) => r.kind === 'carried-decision'));
});

test('a rejection also survives a rule change that would have auto-linked', () => {
  const db = scenarioDb();
  const michael = db.prepare(
    "SELECT cp.pair_key FROM candidate_pairs cp JOIN customers c ON c.id = cp.left_customer_id WHERE c.name = 'Michael Brown' LIMIT 1",
  ).get();
  recordDecision(db, { pairKey: michael.pair_key, action: 'reject', actor: 'a', reason: 'twins' });
  const rule = latestRule(db);
  const loose = ensureRuleVersion(db, {
    thresholds: { autoLink: 0.5, review: 0.3, keyMatchMin: 0.5 },
    fuzzy: rule.fuzzy,
  }, 'loose');
  const run = materialize(db, { rule: loose, origin: 'rule-change', actor: 'admin' });
  const clusters = currentClusters(db).filter((c) => c.customers.some((x) => x.name === 'Michael Brown'));
  assert.equal(clusters.length, 2, 'a human rejection must override the loosened auto band');
  assert.ok(run.changes.carriedDecisions.includes(michael.pair_key));
});

// ---------------------------------------------------------------------------
// Regression tests for review findings
// ---------------------------------------------------------------------------

test('join reasons name the edge that actually joined the member', () => {
  const db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule });
  importBatch(db, {
    label: 'chain',
    idempotencyKey: 'chain-1',
    actor: 't',
    rows: [
      // 1-2 auto via email, 2-3 auto via phone, 1-3 review only (never linked).
      { source: 'crm', external_id: 'A', name: 'Alice Johnson', email: 'ab@x.com', phone: '+15550001', dob: '1990-01-01', postal_code: '11111', country: 'US' },
      { source: 'crm', external_id: 'B', name: 'Alice Johnson', email: 'ab@x.com', phone: '+15550002', dob: '1990-01-01', postal_code: '11111', country: 'US' },
      { source: 'crm', external_id: 'C', name: 'Alice Johnson', email: 'c3@x.com', phone: '+15550002', dob: '1990-01-01', postal_code: '11111', country: 'US' },
    ],
  });
  const cluster = currentClusters(db).find((c) => c.customers.length === 3);
  assert.ok(cluster, 'chain must form one cluster');
  const byId = new Map(cluster.customers.map((c) => [c.id, c]));
  const c = byId.get(3);
  assert.equal(c.joinReason.pairKey, '2:3', 'member 3 joined through the 2-3 phone link');
  assert.equal(c.joinReason.edgeKind, 'auto');
  const root = [...byId.values()].find((x) => x.id === 1);
  assert.equal(root.joinReason.edgeKind, 'root');
  // No member claims a review-only edge as its join reason.
  for (const m of byId.values()) {
    if (m.joinReason.pairKey) {
      const ev = db.prepare('SELECT band FROM candidate_pairs WHERE pair_key = ?').get(m.joinReason.pairKey);
      assert.equal(ev.band, 'auto');
    }
  }
});

test('unequal split keeps the lineage on the largest continuation and starts new lineages for the rest', () => {
  const db = openDb(':memory:');
  const rule1 = ensureRuleVersion(db, { thresholds: { autoLink: 0.7, review: 0.3, keyMatchMin: 0.9 } }, 'v1');
  materialize(db, { rule: rule1 });
  importBatch(db, {
    label: 'three',
    idempotencyKey: 'three-1',
    actor: 't',
    rows: [
      { source: 'crm', external_id: 'A', name: 'Alice Johnson', email: 'a1@x.com', phone: '+15550001', dob: null, address_line: null, postal_code: '11111', country: 'US' },
      { source: 'crm', external_id: 'B', name: 'Alice Johnson', email: 'shared@x.com', phone: '+15550002', dob: null, address_line: null, postal_code: '11111', country: 'US' },
      { source: 'shop', external_id: 'C', name: 'Alice Johnson', email: 'shared@x.com', phone: '+15550002', dob: null, address_line: null, postal_code: '11111', country: 'US' },
    ],
  });
  const before = currentClusters(db).find((c) => c.customers.length === 3);
  const rule2 = ensureRuleVersion(db, { thresholds: { autoLink: 0.9, review: 0.3, keyMatchMin: 0.9 } }, 'v2');
  materialize(db, { rule: rule2, origin: 'rule-change' });
  const after = currentClusters(db).filter((c) => c.customers.some((x) => x.name === 'Alice Johnson'));
  const big = after.find((c) => c.customers.length === 2);
  const lone = after.find((c) => c.customers.length === 1);
  assert.equal(big.lineageId, before.lineageId, 'the 2/3 continuation keeps the original lineage');
  assert.notEqual(lone.lineageId, before.lineageId, 'the orphaned member starts a new lineage');
  const history = clusterVersionsForLineage(db, before.lineageId);
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[1].members.length, 2);
});

test('a single movement is recorded exactly once in cluster_edges', () => {
  const db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule });
  importBatch(db, {
    label: 'mixed',
    idempotencyKey: 'mixed-1',
    actor: 't',
    rows: [
      { source: 'crm', external_id: 'A', name: 'Alice Johnson', email: 'alice@example.com', dob: '1990-01-01', postal_code: '11111', country: 'US' },
      { source: 'crm', external_id: 'B', name: 'Alice Johnson', email: 'alice@example.com', dob: '1990-01-01', postal_code: '11111', country: 'US' },
      { source: 'crm', external_id: 'C', name: 'Bob Smith', email: 'bob@example.com', dob: '1980-01-01', postal_code: '22222', country: 'US' },
    ],
  });
  const [a, b, c] = db.prepare('SELECT id FROM customers ORDER BY id').all().map((r) => r.id);
  recordManualOp(db, { kind: 'split', groups: [[a, c], [b]], actor: 'x', reason: 'mixed partition' });
  const edges = db.prepare('SELECT * FROM cluster_edges').all();
  const seen = new Set();
  for (const e of edges) {
    const key = `${e.from_cluster_version_id}->${e.to_cluster_version_id}`;
    assert.ok(!seen.has(key), `duplicate edge ${key}`);
    seen.add(key);
  }
});

test('a partial import does not blank previously known fields', () => {
  const db = scenarioDb();
  const before = db.prepare("SELECT * FROM customers WHERE external_id = 'P1'").get();
  const out = importBatch(db, {
    label: 'enrichment',
    idempotencyKey: 'partial-1',
    actor: 't',
    rows: [{ source: 'crm', external_id: 'P1', name: 'Alice Johnson' }],
  });
  assert.equal(out.batch.summary.duplicate, 1, 'omitted fields are not a change');
  const after = db.prepare("SELECT * FROM customers WHERE external_id = 'P1'").get();
  assert.equal(after.email, before.email);
  assert.equal(after.phone, before.phone);
  assert.equal(after.dob, before.dob);
  assert.equal(after.address_line, before.address_line);
  assert.equal(after.postal_code, before.postal_code);

  // Fields that ARE supplied still update, and only those are reported.
  const upd = importBatch(db, {
    label: 'enrichment-2',
    idempotencyKey: 'partial-2',
    actor: 't',
    rows: [{ source: 'crm', external_id: 'P1', name: 'Alice Johnson', phone: '+15559999' }],
  });
  assert.equal(upd.batch.summary.updated, 1);
  assert.match(upd.batch.rows[0].reason, /phone/);
  const after2 = db.prepare("SELECT * FROM customers WHERE external_id = 'P1'").get();
  assert.equal(after2.phone, '+15559999');
  assert.equal(after2.email, before.email);
});

test('imports pinned to a superseded rule version are refused, not materialized backwards', () => {
  const db = scenarioDb();
  const rule1 = latestRule(db);
  const rule2 = ensureRuleVersion(db, { thresholds: { ...rule1.thresholds, autoLink: 0.95 } }, 'v2');
  materialize(db, { rule: rule2, origin: 'rule-change' });
  const row = { source: 'crm', external_id: 'LATE', name: 'Late Person' };
  assert.throws(
    () => importBatch(db, { label: 'late', idempotencyKey: 'late-1', rows: [row], actor: 't', ruleVersionId: rule1.id }),
    (err) => err.status === 409,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE external_id = 'LATE'").get().n, 0);
  // The current rule version is accepted.
  const ok = importBatch(db, { label: 'fine', idempotencyKey: 'fine-1', rows: [row], actor: 't', ruleVersionId: rule2.id });
  assert.equal(ok.materialization.ruleVersionId, rule2.id);
  // No evidence row points forward from a newer rule to an older one.
  const bad = db.prepare(
    `SELECT cp.id FROM candidate_pairs cp
     JOIN candidate_pairs newer ON newer.id = cp.superseded_by_id
     WHERE newer.rule_version_id < cp.rule_version_id`,
  ).all();
  assert.equal(bad.length, 0);
});

test('revoking a decision reopens the newest evidence and clears its supersede pointer', () => {
  const db = scenarioDb();
  const q = reviewQueue(db, { band: 'review', status: 'open' });
  const pair = q.pairs.find((p) => p.left.name === 'Jonathan Smith');
  const approved = recordDecision(db, { pairKey: pair.pairKey, action: 'approve', actor: 'a', reason: 'ok' });
  const rule1 = latestRule(db);
  // A rule change that still scores the pair creates a newer evidence row and
  // supersedes the one the decision was written against.
  const rule2 = ensureRuleVersion(db, { thresholds: { ...rule1.thresholds, autoLink: 0.93 } }, 'v2');
  materialize(db, { rule: rule2, origin: 'rule-change' });
  revokeDecision(db, {
    decisionId: approved.decision.id,
    actor: 's',
    reason: 'wrong person',
    expectedRevision: revision(db),
  });
  const newest = db.prepare(
    'SELECT * FROM candidate_pairs WHERE pair_key = ? ORDER BY rule_version_id DESC LIMIT 1',
  ).get(pair.pairKey);
  assert.equal(newest.status, 'open');
  assert.equal(newest.superseded_by_id, null);
  const rows = db.prepare('SELECT * FROM candidate_pairs WHERE pair_key = ?').all(pair.pairKey);
  assert.ok(rows.length >= 1, 'evidence history is retained');
});

test('aggregate impact reports segment changes, not only counts', () => {
  const db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule });
  importBatch(db, {
    label: 'seg',
    idempotencyKey: 'seg-1',
    actor: 't',
    rows: [{ source: 'crm', external_id: 'S1', name: 'Seg Person', email: 'seg@x.com', country: 'US' }],
  });
  const id = db.prepare("SELECT id FROM customers WHERE external_id = 'S1'").get().id;
  db.prepare('INSERT INTO customer_metrics (customer_id, ltv_cents, orders) VALUES (?, 0, 0)').run(id);
  materialize(db, { rule, origin: 'test' });
  db.prepare('UPDATE customer_metrics SET orders = 3, ltv_cents = 200000 WHERE customer_id = ?').run(id);
  materialize(db, { rule, origin: 'test' });
  const report = impactReport(db);
  const delta = report.changes.aggregateDiff.changed.find((c) => c.lineageId != null);
  assert.ok(delta, 'expected an aggregate delta');
  assert.equal(delta.before.segment, 'prospect');
  assert.equal(delta.after.segment, 'gold');
});

test('a merge manual op with more than one group is refused', () => {
  const db = scenarioDb();
  const ids = db.prepare('SELECT id FROM customers ORDER BY id').all().map((r) => r.id);
  assert.throws(
    () => recordManualOp(db, { kind: 'merge', groups: [[ids[0], ids[1]], [ids[2], ids[3]]], actor: 'x', reason: 'two' }),
    (err) => err.status === 400 && /exactly one group/.test(err.message),
  );
  const op = recordManualOp(db, { kind: 'merge', groups: [[ids[0], ids[1]]], actor: 'x', reason: 'one' });
  assert.equal(op.op.groups.length, 1);
});

test('a rule change that alters join evidence records a new version instead of reusing', () => {
  const db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule });
  importBatch(db, {
    label: 'links',
    idempotencyKey: 'links-1',
    actor: 't',
    rows: [
      { source: 'crm', external_id: 'A', name: 'Alice Johnson', email: 'alice@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main St', postal_code: '11111', country: 'US' },
      { source: 'shop', external_id: 'B', name: 'Alice Johnson', email: 'alice@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main St', postal_code: '11111', country: 'US' },
    ],
  });
  // Change B's email: the pair is still auto, but its evidence (score/provenance)
  // changed. The cluster must not be reported as untouched.
  const out = importBatch(db, {
    label: 'links-2',
    idempotencyKey: 'links-2',
    actor: 't',
    rows: [
      { source: 'crm', external_id: 'A', name: 'Alice Johnson', email: 'alice@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main St', postal_code: '11111', country: 'US' },
      { source: 'shop', external_id: 'B', name: 'Alice Johnson', email: 'b-new@example.com', phone: '+15551000', dob: '1990-01-01', address_line: '1 Main St', postal_code: '11111', country: 'US' },
    ],
  });
  assert.equal(out.materialization.changes.unchanged, 0);
  const cluster = currentClusters(db).find((c) => c.customers.length === 2);
  const member = cluster.customers.find((c) => c.id !== cluster.customers[0].id);
  assert.ok(member.joinReason.score < 1, 'join provenance reflects the weaker (phone-only) evidence');
});

test('a split that leaves part of a cluster unnamed is refused', () => {
  const db = openDb(':memory:');
  const rule = ensureRuleVersion(db, undefined, 'baseline');
  materialize(db, { rule });
  importBatch(db, {
    label: 'three',
    idempotencyKey: 'split-cover-1',
    actor: 't',
    rows: [
      { source: 'crm', external_id: 'A', name: 'Alice Johnson', email: 'x@x.com', phone: '+15550001', dob: '1990-01-01', postal_code: '11111', country: 'US' },
      { source: 'crm', external_id: 'B', name: 'Alice Johnson', email: 'x@x.com', phone: '+15550002', dob: '1990-01-01', postal_code: '11111', country: 'US' },
      { source: 'crm', external_id: 'C', name: 'Alice Johnson', email: 'x@x.com', phone: '+15550003', dob: '1990-01-01', postal_code: '11111', country: 'US' },
    ],
  });
  const ids = db.prepare('SELECT id FROM customers ORDER BY id').all().map((r) => r.id);
  assert.equal(currentClusters(db).filter((c) => c.customers.length === 3).length, 1);
  assert.throws(
    () => recordManualOp(db, { kind: 'split', groups: [[ids[0]], [ids[1]]], actor: 'x', reason: 'partial' }),
    (err) => err.status === 400 && /account for every member/.test(err.message),
  );
  // Naming every member is accepted.
  const op = recordManualOp(db, {
    kind: 'split',
    groups: [[ids[0]], [ids[1]], [ids[2]]],
    actor: 'x',
    reason: 'full partition',
  });
  assert.equal(currentClusters(db).filter((c) => c.customers.some((x) => ids.includes(x.id))).length, 3);
  assert.equal(op.op.groups.length, 3);
});

test('an explicitly null field in an import clears the stored value', () => {
  const db = scenarioDb();
  const before = db.prepare("SELECT * FROM customers WHERE external_id = 'P1'").get();
  assert.ok(before.phone);
  const out = importBatch(db, {
    label: 'retract phone',
    idempotencyKey: 'explicit-null-1',
    actor: 't',
    rows: [{ source: 'crm', external_id: 'P1', name: 'Alice Johnson', phone: null }],
  });
  assert.equal(out.batch.summary.updated, 1);
  assert.match(out.batch.rows[0].reason, /phone/);
  const after = db.prepare("SELECT * FROM customers WHERE external_id = 'P1'").get();
  assert.equal(after.phone, null);
  assert.equal(after.email, before.email, 'unmentioned fields are still preserved');
});
