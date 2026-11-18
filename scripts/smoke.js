#!/usr/bin/env node
// End-to-end walkthrough of the workbench guarantees. Prints a narrative of
// what happened after each step so it doubles as a demo and as a smoke test.
//
//   node scripts/smoke.js
//
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
  impactReport,
  clusterVersionsForLineage,
  workbenchState,
  revision,
} from '../src/service/resolution.js';
import { importBatch } from '../src/service/import.js';
import { seedIfEmpty, SEED_ROWS } from './seed.js';

const line = (t) => console.log(`\n=== ${t} ${'='.repeat(Math.max(0, 68 - t.length))}`);
let failures = 0;
function check(label, condition, extra = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

const db = openDb(':memory:');
line('1. seed');
seedIfEmpty(db);
let clusters = currentClusters(db);
const multi = clusters.filter((c) => c.customers.length > 1);
console.log(`  ${clusters.length} clusters, ${multi.length} multi-record`);
for (const c of multi) console.log(`  · ${c.customers.map((x) => x.name).join(' + ')}`);
check('deterministic keys auto-linked William/Bill/W. Chen', multi.some((c) => c.customers.length === 3));
check('different Michael Browns stay apart', clusters.filter((c) => c.customers.some((x) => x.name === 'Michael Brown')).length === 2);
check('household Rossis stay apart', clusters.filter((c) => c.customers.some((x) => x.name.endsWith('Rossi'))).length === 2);

line('2. review queue');
const queue = reviewQueue(db, { band: 'review', status: 'open' });
console.log(`  ${queue.total} pairs need review`);
for (const p of queue.pairs) {
  console.log(`  · ${p.pairKey} ${p.score.toFixed(3)} ${p.left.name} ↔ ${p.right.name}`);
  console.log(`      reasons: ${p.reasons.map((r) => r.kind + ':' + r.field).join(', ') || 'none'}`);
  console.log(`      conflicts: ${p.conflicts.map((c) => c.field + '/' + c.severity).join(', ') || 'none'}`);
}
check('review queue exposes reasons', queue.pairs.every((p) => p.reasons.length > 0));

line('3. approve a review pair');
// Choose a review pair whose two records are in different clusters, so the
// approval genuinely bridges them rather than reinforcing an existing path.
function clusterOf(customerId) {
  return currentClusters(db).find((c) => c.customers.some((x) => x.id === customerId));
}
const target = queue.pairs.find(
  (p) => clusterOf(p.leftCustomerId).lineageId !== clusterOf(p.rightCustomerId).lineageId,
) ?? queue.pairs[0];
console.log(`  target ${target.pairKey} ${target.left.name} ↔ ${target.right.name}`);
const approved = recordDecision(db, {
  pairKey: target.pairKey,
  action: 'approve',
  actor: 'analyst.smoke',
  reason: 'verified via support conversation',
});
check('approval is recorded', approved.decision.id > 0);
const merged = currentClusters(db).find((c) =>
  c.customers.some((x) => x.id === target.leftCustomerId),
);
check('approval merged the pair', merged.customers.some((x) => x.id === target.rightCustomerId));

line('4. change rules, keep history');
const v1 = latestRule(db);
const lineageBefore = merged.lineageId;
const versionCountBefore = clusterVersionsForLineage(db, lineageBefore).versions.length;
const v2 = ensureRuleVersion(db, {
  thresholds: { ...v1.thresholds, review: 0.65, autoLink: 0.92 },
  fuzzy: { ...v1.fuzzy },
}, 'smoke: tighter thresholds');
const ruleRun = materialize(db, { rule: v2, origin: 'rule-change', actor: 'admin.smoke' });
console.log(`  rule v${v2.versionNo} applied — ${ruleRun.changes.rekeys.length} rekeys, ${ruleRun.changes.merges.length} merges, ${ruleRun.changes.splits.length} splits`);
const versions = clusterVersionsForLineage(db, lineageBefore).versions;
check('old cluster version preserved', versions.length > versionCountBefore);
check('old version is superseded, not deleted', versions.some((v) => v.status === 'superseded'));
check('new version is active', versions.some((v) => v.status === 'active'));
check('history links versions with edges', versions.some((v) => v.edges.length > 0));

line('5. revoke the approval');
const revoked = revokeDecision(db, {
  decisionId: approved.decision.id,
  actor: 'supervisor.smoke',
  reason: 'support evidence was for a different account',
  expectedRevision: revision(db),
});
const afterRevoke = currentClusters(db);
check(
  'clusters split back after revocation',
  !afterRevoke.some(
    (c) => c.customers.some((x) => x.id === target.leftCustomerId) && c.customers.some((x) => x.id === target.rightCustomerId),
  ),
);
const decisionRow = db.prepare('SELECT * FROM pair_decisions WHERE id = ?').get(approved.decision.id);
check('revoked decision row retained', decisionRow && decisionRow.active === 0);
const evidence = db.prepare('SELECT * FROM candidate_pairs WHERE pair_key = ?').all(target.pairKey);
check('candidate evidence retained after revocation', evidence.length > 0);
const impact = impactReport(db);
check('revocation raises a downstream impact alert', impact.openAlerts.some((a) => a.kind === 'revocation'));
check('aggregate diff computed for the revocation run', Array.isArray(impact.changes.aggregateDiff.changed));

line('6. manual merge and split');
const ids = clusters[0].customers.map((c) => c.id);
const singleIds = currentClusters(db).filter((c) => c.customers.length === 1).slice(0, 2).map((c) => c.customers[0].id);
const op = recordManualOp(db, {
  kind: 'merge',
  groups: [singleIds],
  actor: 'steward.smoke',
  reason: 'confirmed same account by phone',
});
const manualMerged = currentClusters(db).find((c) => c.customers.some((x) => x.id === singleIds[0]));
check('manual merge applied', manualMerged.customers.length >= 2);
check('manual merge emitted merge edges', op.materialization.changes.merges.length > 0);

// Split the merged pair back apart, then revoke the split to show it is a
// first-class, reversible assertion rather than a destructive edit.
const splitOp = recordManualOp(db, {
  kind: 'split',
  groups: singleIds.map((id) => [id]),
  actor: 'steward.smoke',
  reason: 'second look: shared phone was a household line',
});
const splitApart = currentClusters(db).filter((c) => singleIds.some((id) => c.customers.some((x) => x.id === id)));
check('manual split applied', splitApart.length === 2);
check('manual split emitted split edges', splitOp.materialization.changes.splits.length > 0);
try {
  recordManualOp(db, {
    kind: 'split',
    groups: [[singleIds[0]]],
    actor: 'steward.smoke',
    reason: 'partial',
  });
  check('partial split refused', false, '(no error thrown)');
} catch (err) {
  check('partial split refused', err.status === 400, `status=${err.status}`);
}
revokeManualOp(db, { opId: splitOp.op.id, actor: 'supervisor.smoke', reason: 'merge was correct' });
check(
  'revoking the split restores the manual merge',
  currentClusters(db).filter((c) => singleIds.every((id) => c.customers.some((x) => x.id === id))).length === 1,
);

line('7. concurrent confirmation semantics (single process)');
const stateBefore = workbenchState(db);
try {
  recordDecision(db, {
    pairKey: target.pairKey,
    action: 'approve',
    actor: 'racer.one',
    reason: 'race',
    expectedRevision: stateBefore.revision,
  });
  recordDecision(db, {
    pairKey: target.pairKey,
    action: 'approve',
    actor: 'racer.two',
    reason: 'race',
    expectedRevision: stateBefore.revision,
  });
  check('second stale confirmation rejected', false, '(no error thrown)');
} catch (err) {
  check('second stale confirmation rejected', err.status === 409, `status=${err.status}`);
}

line('8. idempotent import');
const newRows = [
  { source: 'crm', external_id: 'SMOKE-1', name: 'Smoke Tester', email: 'smoke@example.com', phone: null, dob: null, address_line: null, postal_code: null, country: 'US' },
];
const first = importBatch(db, { label: 'smoke', idempotencyKey: 'smoke-key', rows: newRows, actor: 'smoke' });
const second = importBatch(db, { label: 'smoke', idempotencyKey: 'smoke-key', rows: newRows, actor: 'smoke' });
check('first import inserts', first.batch.summary.inserted === 1);
check('replay is a no-op', second.replayed === true);
check('replay reports the same batch', second.batch.id === first.batch.id);

line('summary');
const finalState = workbenchState(db);
console.log(`  revision ${finalState.revision} · ${finalState.counts.customers} customers · ${finalState.counts.activeClusters} active clusters · ${finalState.counts.candidatePairs} evidence rows`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
