// Cluster construction from candidate evidence + human decisions.
//
// The engine is deliberately explicit about precedence:
//   1. active manual merges (a human said these belong together)
//   2. active approvals on a candidate pair
//   3. automatic links from the current rule version
// and about hard constraints:
//   - active rejections (a human said these do NOT belong together)
//   - active manual splits (a human pinned a partition)
//
// When evidence contradicts itself (e.g. an approval whose transitive closure
// would swallow a rejected pair), the engine refuses to guess: the edge is
// dropped and a conflict is reported for a human to resolve.

export function pairKey(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${x}:${y}`;
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map();
    for (const id of ids) this.parent.set(id, id);
  }
  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    // Deterministic: smaller id becomes root.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
    return true;
  }
}

export function buildClusters({ customerIds, pairs, decisionsByPair, manualOps = [], bandOf = (p) => p.band }) {
  const uf = new UnionFind(customerIds);
  const members = new Map(customerIds.map((id) => [id, new Set([id])]));
  const conflicts = [];
  // How each customer actually joined its final cluster. Attribution happens
  // at the union that pulled it in, not from "the first pair that mentions it",
  // so a review-only pair never masquerades as join evidence.
  const joinEvidence = new Map();

  const activeDecision = (pk) => decisionsByPair.get(pk) ?? null;

  // Hard cannot-link constraints.
  const cannotLink = new Map(); // customerId -> Map(customerId -> reason)
  const addCannot = (a, b, reason) => {
    if (a === b) return;
    if (!cannotLink.has(a)) cannotLink.set(a, new Map());
    if (!cannotLink.has(b)) cannotLink.set(b, new Map());
    cannotLink.get(a).set(b, reason);
    cannotLink.get(b).set(a, reason);
  };
  for (const pair of pairs) {
    const decision = activeDecision(pair.pairKey);
    if (decision?.action === 'reject') {
      addCannot(pair.leftCustomerId, pair.rightCustomerId, `pair ${pair.pairKey} rejected by ${decision.actor}`);
    }
  }
  const activeSplits = manualOps.filter((op) => op.kind === 'split' && op.active);
  for (const op of activeSplits) {
    // Cross-group cannot-link: a split pins a partition, so no group may be
    // rejoined with another while the split is active.
    for (let i = 0; i < op.groups.length; i++) {
      for (let j = i + 1; j < op.groups.length; j++) {
        for (const a of op.groups[i]) {
          for (const b of op.groups[j]) addCannot(a, b, `manual split op#${op.id}`);
        }
      }
    }
  }

  const violatesCannot = (a, b) => cannotLink.get(a)?.has(b) ?? false;
  const rootsConflict = (ra, rb, via) => {
    const setA = members.get(ra);
    const setB = members.get(rb);
    for (const a of setA) {
      for (const b of setB) {
        if (violatesCannot(a, b)) {
          return { a, b, reason: cannotLink.get(a).get(b) };
        }
      }
    }
    return null;
  };

  const evidence = []; // {left,right,kind,decision,score}
  const tryUnion = (a, b, kind, pair, decision) => {
    if (a === b) return false;
    const ra = uf.find(a);
    const rb = uf.find(b);
    if (ra === rb) return false;
    const conflict = rootsConflict(ra, rb);
    if (conflict) {
      conflicts.push({
        kind,
        leftCustomerId: a,
        rightCustomerId: b,
        pairKey: pairKey(a, b),
        detail: conflict,
        message: `cannot link ${a} and ${b} (${kind}) because ${conflict.reason}`,
      });
      return false;
    }
    uf.union(a, b);
    const newRoot = uf.find(a);
    const otherRoot = newRoot === ra ? rb : ra;
    const absorbed = [...members.get(otherRoot)];
    for (const id of absorbed) members.get(newRoot).add(id);
    members.delete(otherRoot);
    evidence.push({ left: a, right: b, kind, score: pair?.score ?? null, decision });
    // Only the absorbed side is "joined"; the surviving root keeps no join
    // reason. Record each customer's first join event so multi-hop chains keep
    // the edge that actually brought them in.
    for (const id of absorbed) {
      if (!joinEvidence.has(id)) {
        joinEvidence.set(id, { left: a, right: b, kind, pair, decision });
      }
    }
    return true;
  };

  // 1. Manual merges, and the must-link side of manual splits (a pinned
  // partition holds its groups together as well as apart).
  for (const op of manualOps.filter((o) => o.active)) {
    for (const group of op.groups) {
      for (let i = 1; i < group.length; i++) {
        tryUnion(
          group[0],
          group[i],
          op.kind === 'merge' ? 'manual-merge' : 'manual-split',
          null,
          { actor: op.actor, opId: op.id },
        );
      }
    }
  }

  // 2. Approvals (strongest automated evidence).
  const approvals = pairs.filter((p) => activeDecision(p.pairKey)?.action === 'approve');
  for (const pair of approvals) {
    tryUnion(pair.leftCustomerId, pair.rightCustomerId, 'approval', pair, activeDecision(pair.pairKey));
  }

  // 3. Automatic links.
  const autos = pairs.filter((p) => {
    const d = activeDecision(p.pairKey);
    if (d) return false;
    return bandOf(p) === 'auto';
  });
  for (const pair of autos) {
    tryUnion(pair.leftCustomerId, pair.rightCustomerId, 'auto', pair, null);
  }

  const groups = new Map();
  for (const id of customerIds) {
    const root = uf.find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  const pairByKey = new Map(pairs.map((p) => [p.pairKey, p]));
  const result = [...groups.values()]
    .map((ids) => {
      ids.sort((a, b) => a - b);
      const links = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const pair = pairByKey.get(pairKey(ids[i], ids[j]));
          const decision = pair ? activeDecision(pair.pairKey) : null;
          if (pair || decision) {
            const evidenceRow = evidence.find(
              (e) => (e.left === ids[i] && e.right === ids[j]) || (e.left === ids[j] && e.right === ids[i]),
            );
            links.push({
              left: ids[i],
              right: ids[j],
              pairId: pair?.id ?? null,
              pairKey: pairKey(ids[i], ids[j]),
              score: pair?.score ?? null,
              band: pair?.band ?? null,
              decision: decision ?? null,
              edgeKind: evidenceRow?.kind ?? null,
            });
          }
        }
      }
      return { members: ids, links };
    })
    .sort((a, b) => a.members[0] - b.members[0]);

  // Attach each member's actual join event. Roots have none.
  for (const group of result) {
    group.joinOf = new Map();
    for (const id of group.members) {
      const ev = joinEvidence.get(id);
      if (!ev) continue;
      const link = group.links.find(
        (l) => pairKey(l.left, l.right) === pairKey(ev.left, ev.right),
      );
      group.joinOf.set(id, link ?? { left: ev.left, right: ev.right, pairKey: pairKey(ev.left, ev.right), edgeKind: ev.kind, pairId: ev.pair?.id ?? null, score: ev.pair?.score ?? null, band: ev.pair?.band ?? null, decision: ev.decision ?? null });
    }
  }

  return { groups: result, conflicts };
}
