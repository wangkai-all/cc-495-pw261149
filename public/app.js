const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'review',
  revision: null,
  ruleVersion: null,
  actor: localStorage.getItem('erw.actor') || 'analyst.amara',
  pairs: [],
  selectedPairKey: null,
  pairDetail: null,
  rules: null,
  impact: null,
  clusters: [],
  batches: [],
  lineage: null,
  busy: false,
};

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function badge(kind, text) {
  return el('span', { class: `badge ${kind}` }, text ?? kind);
}

function toast(message, tone = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast ${tone === 'bad' ? 'bad' : ''}`;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (node.hidden = true), 4200);
}

function setBusy(on) {
  state.busy = on;
  $('#connDot').classList.toggle('busy', on);
  $('#revisionPill').textContent = on ? 'rev …' : `rev ${state.revision ?? '–'}`;
}

async function api(method, path, body, { silent = false } = {}) {
  setBusy(true);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.details = data.details;
      throw err;
    }
    if (data.revision != null) state.revision = data.revision;
    return data;
  } catch (err) {
    if (!silent) toast(err.message, 'bad');
    throw err;
  } finally {
    setBusy(false);
  }
}

function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
  history.replaceState(null, '', `#${view}`);
  if (view === 'review') loadReview();
  if (view === 'clusters') loadClusters();
  if (view === 'impact') loadImpact();
  if (view === 'rules') loadRules();
  if (view === 'imports') loadImports();
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

async function ensureRules() {
  if (!state.rules) {
    try {
      state.rules = await api('GET', '/api/rules', undefined, { silent: true });
    } catch { /* non-fatal; scale falls back to defaults */ }
  }
}

async function loadReview({ keepSelection = true } = {}) {
  await ensureRules();
  const band = $('#bandFilter').value;
  const showDecided = $('#showDecided').checked;
  const q = new URLSearchParams({ limit: '200' });
  if (band) q.set('band', band);
  q.set('status', showDecided ? 'all' : 'open');
  const [pairs, stateInfo] = await Promise.all([
    api('GET', `/api/pairs?${q}`),
    api('GET', '/api/state', undefined, { silent: true }),
  ]);
  state.pairs = pairs.pairs;
  state.revision = stateInfo.revision;
  state.ruleVersion = stateInfo.ruleVersion;
  renderMetrics(stateInfo);
  renderPairList();
  if (keepSelection && state.selectedPairKey) {
    const still = state.pairs.find((p) => p.pairKey === state.selectedPairKey);
    if (still) await openPair(state.selectedPairKey, { silentMissing: true });
  }
  $('#revisionPill').textContent = `rev ${state.revision}`;
}

function renderMetrics(s) {
  const c = s.counts;
  const items = [
    ['Customers', c.customers],
    ['Active clusters', c.activeClusters],
    ['Review queue', c.openReview],
    ['Active decisions', c.activeDecisions],
    ['Open alerts', c.openAlerts],
  ];
  $('#reviewMetrics').replaceChildren(
    ...items.map(([k, v]) =>
      el('div', { class: 'metric' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, String(v))),
    ),
  );
}

function renderPairList() {
  const list = $('#pairList');
  if (state.pairs.length === 0) {
    list.replaceChildren(el('div', { class: 'empty' }, 'No candidate pairs for this filter.'));
    return;
  }
  list.replaceChildren(
    ...state.pairs.map((p) => {
      const statusBadge = p.decision ? badge(p.decision.action === 'approve' ? 'approved' : 'rejected', p.decision.action === 'approve' ? 'approved' : 'rejected') : null;
      return el(
        'button',
        {
          class: `pairRow${p.pairKey === state.selectedPairKey ? ' selected' : ''}`,
          onclick: () => openPair(p.pairKey),
        },
        el(
          'div',
          {},
          el('div', { class: 'names' }, `${p.left.name}  ↔  ${p.right.name}`),
          el(
            'div',
            { class: 'sub' },
            `#${p.leftCustomerId} · #${p.rightCustomerId} · `,
            statusBadge ?? badge(p.band, p.band),
            p.decision ? '' : ` · ${p.conflicts.length ? `${p.conflicts.length} conflict${p.conflicts.length > 1 ? 's' : ''}` : 'no conflicts'}`,
          ),
        ),
        el(
          'div',
          { class: 'score' },
          p.score.toFixed(2),
          el('small', {}, p.deterministicKeys.length ? `${p.deterministicKeys.length} key${p.deterministicKeys.length > 1 ? 's' : ''}` : 'fuzzy'),
        ),
      );
    }),
  );
}

const FIELDS = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['dob', 'Date of birth'],
  ['addressLine', 'Address'],
  ['postalCode', 'Postal code'],
  ['country', 'Country'],
  ['vatId', 'VAT ID'],
];

async function openPair(pairKey, { silentMissing = false } = {}) {
  state.selectedPairKey = pairKey;
  renderPairList();
  let detail;
  try {
    detail = await api('GET', `/api/pairs/${encodeURIComponent(pairKey)}`);
  } catch (err) {
    if (silentMissing) return;
    throw err;
  }
  state.pairDetail = detail;
  renderPairDetail(detail);
}

function renderPairDetail(d) {
  const conflicting = new Set(d.conflicts.map((c) => c.field));
  const fieldKey = { postal_code: 'postalCode', address: 'addressLine', vat_id: 'vatId' };
  const rec = (side) =>
    el(
      'div',
      { class: 'record' },
      el(
        'header',
        {},
        el('span', {}, `#${side.id} · ${side.source}`),
        el('span', {}, side.externalId),
      ),
      el(
        'dl',
        {},
        ...FIELDS.flatMap(([key, label]) => {
          const field = fieldKey[key] ?? key;
          const isDiff = conflicting.has(Object.keys(fieldKey).find((k) => fieldKey[k] === field) ?? field);
          return [
            el('dt', {}, label),
            el('dd', { class: isDiff ? 'diff' : '' }, side[key] ?? '—'),
          ];
        }),
      ),
    );

  const decision = d.decisions.find((x) => x.active);
  const scale = renderScale(d);
  const canDecide = !decision;

  const detail = el(
    'div',
    { class: 'detail' },
    el(
      'div',
      { class: 'detailHead' },
      el(
        'div',
        {},
        el('h3', {}, `${d.left.name}  ↔  ${d.right.name}`),
        el(
          'div',
          { class: 'sub', style: 'color:var(--ink-3);font-size:12px' },
          `Pair ${d.pairKey} · evidence #${d.evidenceHistory.at(-1)?.id ?? '—'} · rule v${d.ruleVersionId}`,
        ),
      ),
      el('div', { class: 'actions' }, badge(d.band, d.band), badge(d.status, d.status)),
    ),
    scale,
    el('div', { class: 'pairCards' }, rec(d.left), rec(d.right)),
    el(
      'div',
      { class: 'section' },
      el('h4', {}, `Match reasons (${d.reasons.length})`),
      el(
        'ul',
        { class: 'reasonList' },
        ...d.reasons.map((r) =>
          el(
            'li',
            {},
            el('span', { class: 'field' }, r.field),
            el('span', {}, r.detail),
            r.score != null ? el('span', { class: 'scoreTag' }, Number(r.score).toFixed(3)) : null,
          ),
        ),
        d.reasons.length === 0 ? el('li', {}, 'No positive match signals recorded.') : null,
      ),
    ),
    el(
      'div',
      { class: 'section' },
      el('h4', {}, `Conflicting fields (${d.conflicts.length})`),
      d.conflicts.length
        ? el(
            'ul',
            { class: 'conflictList' },
            ...d.conflicts.map((c) =>
              el(
                'li',
                {},
                el('span', { class: 'field' }, c.field),
                el('span', { style: 'flex:1' }, c.note),
                badge(c.severity === 'hard' ? 'hard' : 'soft', c.severity ?? 'conflict'),
              ),
            ),
          )
        : el('div', { class: 'note ok' }, 'No conflicting fields.'),
    ),
    el(
      'div',
      { class: 'section' },
      el('h4', {}, 'Shared deterministic keys'),
      d.deterministicKeys.length
        ? el(
            'ul',
            { class: 'reasonList' },
            ...d.deterministicKeys.map((k) =>
              el(
                'li',
                {},
                el('span', { class: 'field' }, k.name),
                el('span', {}, el('code', {}, k.value)),
                el('span', { class: 'scoreTag' }, `weight ${k.weight}`),
              ),
            ),
          )
        : el('div', { class: 'note' }, 'No shared deterministic key. This pair relies on fuzzy evidence only.'),
    ),
    el(
      'div',
      { class: 'section' },
      el('h4', {}, 'Affected clusters'),
      el(
        'div',
        { class: 'note' },
        d.affectedClusters.length
          ? d.affectedClusters
              .map((c) => `#${c.clusterVersionId} (lineage ${c.lineageId}, ${c.status})`)
              .join(' · ')
          : 'Neither customer is in a cluster yet.',
      ),
    ),
    renderDecisionArea(d, decision, canDecide),
    renderDecisionHistory(d.decisions),
    el(
      'div',
      { class: 'section' },
      el('h4', {}, 'Evidence history across rule versions'),
      el(
        'ul',
        { class: 'changeList' },
        ...d.evidenceHistory.map((e) =>
          el(
            'li',
            {},
            el('span', {}, `v${e.ruleVersionId}`),
            el('span', { class: 'scoreTag', style: 'margin-left:auto' }, Number(e.score).toFixed(3)),
            badge(e.band, e.band),
            badge(e.status, e.status),
          ),
        ),
      ),
    ),
  );
  $('#pairDetail').replaceChildren(detail);
}

function renderScale(d) {
  const thresholds = { review: 0.62, autoLink: 0.9 };
  // Use the rule's real thresholds if we can reach them cheaply.
  const t = state.rules?.current?.thresholds;
  if (t) {
    thresholds.review = t.review;
    thresholds.autoLink = t.autoLink;
  }
  const pct = (v) => `${Math.max(0, Math.min(1, v)) * 100}%`;
  const needle = el('span', { class: 'needle', style: `left:${pct(d.score)}` });
  return el(
    'div',
    { class: 'scaleWrap' },
    el(
      'div',
      { class: 'scale' },
      el('span', { class: 'zone', style: `left:0;width:${pct(thresholds.review)};background:var(--bad)` }),
      el('span', { class: 'zone', style: `left:${pct(thresholds.review)};width:calc(${pct(thresholds.autoLink)} - ${pct(thresholds.review)});background:var(--warn)` }),
      el('span', { class: 'zone', style: `left:${pct(thresholds.autoLink)};right:0;background:var(--ok)` }),
      needle,
    ),
    el(
      'div',
      { class: 'scaleLabels' },
      el('span', {}, 'reject'),
      el('span', {}, `review ≥ ${thresholds.review}`),
      el('span', {}, `auto ≥ ${thresholds.autoLink}`),
    ),
  );
}

function renderDecisionArea(d, decision, canDecide) {
  if (decision) {
    return el(
      'div',
      { class: 'note ok' },
      `${decision.action === 'approve' ? 'Approved' : 'Rejected'} by ${decision.actor} on ${shortDate(decision.createdAt)}.`,
      el(
        'div',
        { class: 'actions', style: 'margin-top:8px' },
        el(
          'button',
          {
            class: 'btn danger small',
            onclick: () => revokeDecision(decision),
          },
          'Revoke confirmation',
        ),
        el(
          'button',
          { class: 'btn ghost small', onclick: () => openLineageFrom(d) },
          'View cluster history',
        ),
      ),
    );
  }
  const reasonInput = el('input', { type: 'text', placeholder: 'Reason (recorded in the audit trail)', style: 'flex:1;min-width:220px' });
  const act = async (action) => {
    if (reasonInput.value.trim() === '') {
      toast('A reason is required for an audit-friendly decision.', 'bad');
      reasonInput.focus();
      return;
    }
    try {
      const res = await api('POST', `/api/pairs/${encodeURIComponent(d.pairKey)}/decisions`, {
        action,
        actor: state.actor,
        reason: reasonInput.value.trim(),
        expectedRevision: state.revision,
      });
      toast(`${action === 'approve' ? 'Approved' : 'Rejected'} ${d.pairKey} — cluster set rebuilt.`);
      await loadReview({ keepSelection: false });
      // The pair may have left the filtered list; keep it on screen so the
      // reviewer sees the new decision, its history, and the affected clusters.
      state.selectedPairKey = d.pairKey;
      renderPairList();
      await openPair(d.pairKey, { silentMissing: true });
      state.impact = null;
    } catch (err) {
      if (err.status === 409) {
        showStrip(
          'bad',
          `This screen is stale (${err.message}). The workbench moved to rev ${err.details?.current}. Reloaded; please re-check the evidence.`,
          () => loadReview({ keepSelection: true }),
        );
      }
    }
  };
  return el(
    'div',
    { class: 'section' },
    el('h4', {}, 'Adjudicate'),
    el(
      'div',
      { class: 'actions' },
      el(
        'button',
        {
          class: 'btn ok',
          disabled: !canDecide,
          onclick: () => act('approve'),
        },
        '✓ Confirm same entity',
      ),
      el(
        'button',
        {
          class: 'btn danger',
          onclick: () => act('reject'),
        },
        '✕ Different entities',
      ),
      reasonInput,
    ),
    el(
      'div',
      { class: 'note', style: 'margin-top:8px' },
      'Decisions are append-only. Approving merges the clusters; revoking later restores the split, ',
      'rebuilds downstream aggregates, and keeps both the decision row and the candidate evidence.',
    ),
  );
}

function renderDecisionHistory(decisions) {
  if (!decisions?.length) return el('div');
  return el(
    'div',
    { class: 'section' },
    el('h4', {}, 'Decision history'),
    el(
      'div',
      { class: 'decisionHistory' },
      ...decisions.map((x) =>
        el(
          'div',
          { class: `decRow${x.active ? '' : ' revoked'}` },
          badge(x.active ? (x.action === 'approve' ? 'approved' : 'rejected') : 'superseded', x.active ? x.action : 'revoked'),
          el('span', { class: 'who' }, x.actor),
          el('span', { class: 'meta' }, shortDate(x.createdAt)),
          x.revokedAt ? el('span', { class: 'meta' }, `— revoked by ${x.revokedBy}: ${x.revokeReason}`) : null,
          x.reason ? el('span', { class: 'why' }, `“${x.reason}”`) : null,
        ),
      ),
    ),
  );
}

async function revokeDecision(decision) {
  const reason = prompt('Why is this confirmation being revoked? (recorded, required)');
  if (!reason || !reason.trim()) return;
  try {
    const res = await api('POST', `/api/decisions/${decision.id}/revoke`, {
      actor: state.actor,
      reason: reason.trim(),
      expectedRevision: state.revision,
    });
    const changed = res.materialization?.changes?.aggregateDiff?.changed?.length ?? 0;
    toast(`Revoked. Evidence retained; ${changed} downstream aggregate${changed === 1 ? '' : 's'} updated.`);
    showStrip(
      'ok',
      'Confirmation revoked. The pair returned to the review queue and downstream aggregates were rebuilt; the decision row and evidence remain in history.',
      null,
    );
    await loadReview({ keepSelection: false });
    if (state.selectedPairKey) await openPair(state.selectedPairKey, { silentMissing: true });
  } catch (err) {
    if (err.status === 409) {
      showStrip('bad', `Stale screen: ${err.message}`, () => loadReview({ keepSelection: true }));
    }
  }
}

function openLineageFrom(d) {
  const lineages = [...new Set(d.affectedClusters.map((c) => c.lineageId))];
  showView('clusters');
  if (lineages[0] != null) setTimeout(() => openLineage(lineages[0]), 60);
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

async function loadClusters() {
  const [clusters, ops] = await Promise.all([
    api('GET', '/api/clusters'),
    api('GET', '/api/manual-ops', undefined, { silent: true }).catch(() => ({ active: [] })),
  ]);
  state.clusters = clusters;
  state.manualOps = ops.active ?? [];
  $('#clusterHint').textContent = `${clusters.length} active cluster versions · merges/splits appear in history`;
  renderManualOpsTools();
  $('#clusterGrid').replaceChildren(
    ...clusters.map((c) => {
      const title = c.customers.map((x) => x.name).slice(0, 3).join(' · ');
      return el(
        'div',
        { class: `clusterCard${c.customers.length > 1 ? ' multi' : ''}` },
        el(
          'div',
          { class: 'clusterTop' },
          el(
            'div',
            {},
            el('div', { class: 'title' }, title),
            el('div', { class: 'sub' }, `lineage ${c.lineageId} · v${c.versionNo} · ${c.customers.length} record${c.customers.length > 1 ? 's' : ''}`),
          ),
          badge(c.customers.length > 1 ? 'merged' : 'open', c.customers.length > 1 ? 'entity' : 'singleton'),
        ),
        ...c.customers.map((m) =>
          el(
            'div',
            { class: 'member' },
            el(
              'div',
              {},
              el('div', {}, `#${m.id} ${m.name}`),
              el('div', { class: 'email' }, m.email ?? m.phone ?? '—'),
            ),
            el('div', { class: 'conf' }, m.joinReason?.edgeKind ? `${m.joinReason.edgeKind}` : ''),
          ),
        ),
        el(
          'div',
          { class: 'clusterStats' },
          el('span', {}, 'LTV ', el('b', {}, money(c.metrics.ltvCents))),
          el('span', {}, 'Orders ', el('b', {}, String(c.metrics.orders))),
          el('span', {}, 'Segment ', el('b', {}, c.metrics.segment)),
        ),
        el(
          'div',
          { class: 'actions' },
          el('button', { class: 'btn ghost small', onclick: () => openLineage(c.lineageId) }, 'History'),
          el(
            'button',
            {
              class: 'btn ghost small',
              onclick: () => openCustomerTimeline(c.customers[0].id),
            },
            'Customer timeline',
          ),
        ),
      );
    }),
  );
}

function clusterIdLabel(cluster) {
  const names = cluster.customers.map((c) => c.name);
  const head = names.slice(0, 2).join(' + ') + (names.length > 2 ? ` +${names.length - 2}` : '');
  return `lineage ${cluster.lineageId}: ${head}`;
}

function selectedLineages() {
  return $$('.pickCluster:checked').map((box) => Number(box.value));
}

function idsForLineage(lineageId) {
  const cluster = state.clusters.find((x) => x.lineageId === lineageId);
  return cluster ? cluster.customers.map((m) => m.id) : [];
}

async function submitManualOp(kind) {
  const lineages = selectedLineages();
  if (lineages.length < (kind === 'split' ? 2 : 1)) {
    toast(kind === 'split' ? 'Pick at least two clusters to split apart.' : 'Pick at least one cluster.', 'bad');
    return;
  }
  const reason = $('#opReason').value.trim();
  if (!reason) {
    toast('A reason is required for a manual operation.', 'bad');
    $('#opReason').focus();
    return;
  }
  const groups =
    kind === 'merge' ? [lineages.flatMap(idsForLineage)] : lineages.map(idsForLineage);
  try {
    const res = await api('POST', '/api/manual-ops', {
      kind,
      groups,
      actor: state.actor,
      reason,
      expectedRevision: state.revision,
    });
    toast(
      `${kind === 'merge' ? 'Merged' : 'Split'} — ${res.materialization.changes.merges.length} merges, ` +
        `${res.materialization.changes.splits.length} splits recorded.`,
    );
    await loadClusters();
  } catch (err) {
    if (err.status === 409) {
      showStrip('bad', `Stale screen: ${err.message}`, () => loadClusters());
    }
  }
}

async function revokeManualOp(op) {
  const why = prompt('Why is this manual operation being revoked? (required)');
  if (!why || !why.trim()) return;
  try {
    await api('POST', `/api/manual-ops/${op.id}/revoke`, {
      actor: state.actor,
      reason: why.trim(),
      expectedRevision: state.revision,
    });
    toast('Manual operation revoked; clusters rebuilt.');
    await loadClusters();
  } catch (err) {
    if (err.status === 409) showStrip('bad', `Stale screen: ${err.message}`, () => loadClusters());
  }
}

function renderManualOpsTools() {
  const panel = $('#manualOpsPanel');
  if (!panel) return;
  const pickList = el(
    'div',
    { class: 'pickList' },
    ...state.clusters.map((c) =>
      el(
        'label',
        { class: 'pickRow' },
        el('input', { type: 'checkbox', class: 'pickCluster', value: String(c.lineageId) }),
        el('span', {}, clusterIdLabel(c)),
        el('span', { class: 'conf' }, `${c.customers.length} record${c.customers.length > 1 ? 's' : ''}`),
      ),
    ),
  );
  const reason = el('input', {
    type: 'text',
    id: 'opReason',
    placeholder: 'Reason (required, recorded on the operation)',
    style: 'flex:1;min-width:220px',
  });
  const ops = state.manualOps ?? [];
  panel.replaceChildren(
    el(
      'div',
      { class: 'panelHead' },
      el('h2', {}, 'Manual merge / split'),
      el('span', { class: 'hint' }, 'Pins a partition against future rule changes'),
    ),
    el(
      'div',
      { class: 'manualOps' },
      pickList,
      el(
        'div',
        { class: 'actions' },
        el('button', { class: 'btn ok', onclick: () => submitManualOp('merge') }, 'Merge selected'),
        el('button', { class: 'btn danger', onclick: () => submitManualOp('split') }, 'Split selected'),
        reason,
      ),
      ops.length
        ? el(
            'div',
            { class: 'section' },
            el('h4', {}, `Active manual operations (${ops.length})`),
            ...ops.map((op) =>
              el(
                'div',
                { class: 'decRow' },
                badge(op.kind, op.kind),
                el('span', { class: 'who' }, op.actor),
                el('span', { class: 'meta' }, shortDate(op.createdAt)),
                el('span', { class: 'why' }, op.reason ?? ''),
                el('button', { class: 'btn danger small', onclick: () => revokeManualOp(op) }, 'Revoke'),
              ),
            ),
          )
        : el('div', { class: 'note' }, 'No active manual operations.'),
    ),
  );
}

async function openLineage(lineageId) {
  const data = await api('GET', `/api/lineages/${lineageId}`);
  state.lineage = data;
  $('#lineagePanel').hidden = false;
  $('#lineageTitle').textContent = `Cluster history · lineage ${lineageId}`;
  $('#lineageBody').replaceChildren(
    el(
      'div',
      { class: 'note' },
      'Every version is immutable. Older versions are marked superseded but keep their members and edges, ',
      'so rule changes, merges, splits, and revocations are all reconstructable.',
    ),
    ...data.versions.map((v) =>
      el(
        'div',
        { class: `versionCard${v.status === 'active' ? ' active' : ''}` },
        el(
          'div',
          { class: 'versionHead' },
          el('span', { class: 'v' }, `v${v.versionNo} · cluster #${v.id}`),
          el('span', {}, badge(v.status, v.status), ' ', badge(v.origin, v.origin)),
          el('span', { class: 'meta', style: 'color:var(--ink-3);font-size:11.5px' }, `${shortDate(v.createdAt)}${v.supersededAt ? ` → ${shortDate(v.supersededAt)}` : ''}`),
        ),
        el(
          'div',
          { class: 'versionBody' },
          el(
            'div',
            {},
            ...v.members.map((m) =>
              el('div', { class: 'member' }, el('div', {}, `#${m.customerId} ${m.name}`), el('div', { class: 'conf' }, `rule v${v.ruleVersionId}`)),
            ),
          ),
          ...v.edges.map((e) =>
            el(
              'div',
              { class: 'edgeRow' },
              badge(e.kind === 'rekey' ? 'superseded' : e.kind, e.kind),
              el('span', {}, e.from === v.id ? `→ #${e.to}` : `← #${e.from}`),
              el('code', {}, JSON.stringify(e.detail)),
            ),
          ),
        ),
      ),
    ),
  );
  $('#lineagePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openCustomerTimeline(customerId) {
  const data = await api('GET', `/api/customers/${customerId}/timeline`);
  $('#lineagePanel').hidden = false;
  $('#lineageTitle').textContent = `Customer timeline · #${customerId} ${data.customer.name}`;
  const parts = [];
  parts.push(el('div', { class: 'note' }, `${data.memberships.length} cluster memberships · ${data.pairs.length} candidate pairs · ${data.decisions.length} decisions`));
  for (const membership of data.memberships) {
    parts.push(
      el(
        'div',
        { class: 'ruleHistRow' },
        el('div', {}, `Cluster #${membership.clusterVersionId} (lineage ${membership.lineageId}, v${membership.versionNo})`),
        el('div', { class: 'meta' }, `rule v${membership.ruleVersionId} · ${membership.origin} · ${membership.status} · joined via ${membership.joinReason.edgeKind ?? 'root'}`),
      ),
    );
  }
  const pairList = el(
    'div',
    { class: 'changeList' },
    ...data.pairs.map((p) =>
      el(
        'li',
        {},
        el('span', {}, `${p.pairKey} · v${p.ruleVersionId}`),
        el('span', { class: 'scoreTag', style: 'margin-left:auto' }, Number(p.score).toFixed(3)),
        badge(p.band, p.band),
        badge(p.status, p.status),
      ),
    ),
  );
  parts.push(el('div', { class: 'section' }, el('h4', {}, 'Candidate evidence'), pairList));
  parts.push(renderDecisionHistory(data.decisions));
  $('#lineageBody').replaceChildren(...parts);
  $('#lineagePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

async function loadImpact(runId = null) {
  const data = await api('GET', `/api/impact${runId ? `?runId=${runId}` : ''}`);
  state.impact = data;
  if (!data) {
    $('#impactSummary').replaceChildren(el('div', { class: 'empty' }, 'No materialization runs yet.'));
    return;
  }
  renderImpact(data);
}

function renderImpact(data) {
  const c = data.changes;
  const changedAgg = c.aggregateDiff?.changed?.length ?? 0;
  const cards = [
    ['Revision', String(data.run.revision)],
    ['Rule version', `v${data.run.ruleVersionId}`],
    ['Origin', data.run.origin],
    ['Merges', String(c.merges.length)],
    ['Splits', String(c.splits.length)],
    ['New clusters', String(c.newClusters.length)],
    ['Rekeys', String(c.rekeys.length)],
    ['Aggregates changed', String(changedAgg)],
    ['Conflicts', String(c.conflicts.length)],
  ];
  $('#impactSummary').replaceChildren(
    ...cards.map(([k, v]) => el('div', { class: 'metric' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v))),
  );

  const picker = $('#runPicker');
  picker.value = String(data.run.id);
  if (picker.options.length !== data.recentRuns.length) {
    picker.replaceChildren(
      ...data.recentRuns.map((r) => el('option', { value: r.id }, `#${r.id} rev ${r.revision} · ${r.origin}`)),
    );
    picker.value = String(data.run.id);
  }

  const group = (title, children) =>
    el('div', { class: 'changeGroup' }, el('h4', {}, title), el('ul', { class: 'changeList' }, ...children));

  const groups = [];
  if (c.merges.length) {
    groups.push(
      group(
        'Merges',
        c.merges.map((m) =>
          el('li', {}, badge('merged', 'merge'), `cluster #${m.into} absorbed ${m.from.map((x) => `#${x}`).join(', ')}`),
        ),
      ),
    );
  }
  if (c.splits.length) {
    groups.push(
      group(
        'Splits',
        c.splits.map((s) =>
          el('li', {}, badge('split', 'split'), `cluster #${s.from} fragmented into ${s.into.map((x) => `#${x}`).join(', ')}`),
        ),
      ),
    );
  }
  if (c.conflicts.length) {
    groups.push(
      group(
        'Conflicts left for a human',
        c.conflicts.map((x) => el('li', {}, badge('hard', 'conflict'), `${x.pairKey}: ${x.message}`)),
      ),
    );
  }
  if (c.aggregateDiff?.changed?.length) {
    groups.push(
      group(
        'Downstream aggregate deltas',
        c.aggregateDiff.changed.map((d) => {
          const before = d.before ? money(d.before.ltvCents) : '—';
          const after = d.after ? money(d.after.ltvCents) : 'removed';
          const delta = d.before && d.after ? d.after.customerCount - d.before.customerCount : null;
          return el(
            'li',
            {},
            el('span', {}, `lineage ${d.lineageId ?? '—'}`),
            el('span', { class: 'delta' }, `${before} → ${after}`),
            delta != null
              ? el('span', { class: `delta ${delta >= 0 ? 'up' : 'down'}` }, `${delta >= 0 ? '+' : ''}${delta} customers`)
              : null,
          );
        }),
      ),
    );
  }
  if (data.openAlerts.length) {
    groups.push(
      group(
        `Open impact alerts (${data.openAlerts.length})`,
        data.openAlerts.map((a) =>
          el(
            'li',
            {},
            badge('rejected', a.kind),
            el('span', {}, a.subject),
            el(
              'span',
              { class: 'meta', style: 'color:var(--ink-3)' },
              `${a.detail.actor ?? ''}${a.detail.reason ? ` — ${a.detail.reason}` : ''}`,
            ),
            el('span', { class: 'scoreTag', style: 'margin-left:auto' }, shortDate(a.createdAt)),
          ),
        ),
      ),
    );
  }
  groups.push(
    el(
      'div',
      { class: 'changeGroup' },
      el('h4', {}, 'Recent runs'),
      el(
        'ul',
        { class: 'runList' },
        ...data.recentRuns.map((r) =>
          el(
            'li',
            {},
            el('span', { class: 'scoreTag' }, `#${r.id}`),
            el('span', { class: 'scoreTag' }, `rev ${r.revision}`),
            el('span', {}, r.origin),
            el('span', { class: 'meta', style: 'color:var(--ink-3)' }, r.actor ?? ''),
            el('span', { style: 'margin-left:auto;color:var(--ink-3)' }, shortDate(r.createdAt)),
          ),
        ),
      ),
    ),
  );
  $('#impactBody').replaceChildren(...groups);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

async function loadRules() {
  const data = await api('GET', '/api/rules');
  state.rules = data;
  const cur = data.current;
  $('#ruleHint').textContent = `active v${cur.versionNo} · hash ${cur.configHash.slice(0, 10)}…`;
  const num = (key, val) => {
    const input = el('input', { type: 'number', step: '0.01', min: '0', max: '1', value: String(val), 'data-key': key });
    return input;
  };
  const auto = num('autoLink', cur.thresholds.autoLink);
  const review = num('review', cur.thresholds.review);
  const keyMin = num('keyMatchMin', cur.thresholds.keyMatchMin);
  const note = el('input', { type: 'text', value: '', placeholder: 'Why are you changing the rules?' });
  const fuzzyInputs = Object.entries(cur.fuzzy).map(([field, w]) => {
    const input = el('input', { type: 'number', step: '0.01', min: '0', value: String(w), 'data-field': field });
    return el('label', {}, `${field} weight`, input);
  });
  const editor = el(
    'div',
    { class: 'ruleEditor' },
    el('div', { class: 'note' }, 'Changing rules creates a new immutable rule version, then re-materializes clusters. Existing cluster versions are preserved.'),
    el('div', { class: 'fieldGrid' }, el('label', {}, 'Auto-link ≥', auto), el('label', {}, 'Review ≥', review), el('label', {}, 'Key match floor', keyMin)),
    el('div', { class: 'section' }, el('h4', {}, 'Fuzzy weights'), el('div', { class: 'fieldGrid' }, ...fuzzyInputs)),
    el(
      'div',
      { class: 'section' },
      el('h4', {}, 'Deterministic keys'),
      el(
        'table',
        { class: 'keyTable' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Key'), el('th', {}, 'Fields'), el('th', {}, 'Weight'))),
        el(
          'tbody',
          {},
          ...cur.deterministic.map((k) =>
            el('tr', {}, el('td', {}, el('code', {}, k.name)), el('td', {}, el('code', {}, k.fields.join(' + '))), el('td', {}, String(k.weight))),
          ),
        ),
      ),
    ),
    el('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-2)' }, 'Change note', note),
    el(
      'div',
      { class: 'actions' },
      el(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            const config = {
              thresholds: {
                autoLink: Number(auto.value),
                review: Number(review.value),
                keyMatchMin: Number(keyMin.value),
              },
              fuzzy: Object.fromEntries(fuzzyInputs.map((label) => [label.querySelector('input').dataset.field, Number(label.querySelector('input').value)])),
              deterministic: cur.deterministic,
            };
            try {
              const res = await api('POST', '/api/rules', {
                config,
                actor: state.actor,
                note: note.value || 'rule change',
              });
              state.rules = null;
              if (res.unchanged) {
                toast(`These rules are already active as v${res.rule.versionNo}; nothing changed.`);
              } else {
                const ch = res.materialization.changes;
                toast(
                  `Rule v${res.rule.versionNo} active — ${ch.rekeys.length} rekeys, ` +
                    `${ch.merges.length} merges, ${ch.splits.length} splits, ` +
                    `${ch.carriedDecisions.length} human decisions carried forward.`,
                );
              }
              await loadRules();
            } catch { /* toasted */ }
          },
        },
        'Save as new version',
      ),
      el('button', { class: 'btn ghost', onclick: () => loadRules() }, 'Reset'),
    ),
  );
  $('#ruleEditor').replaceChildren(editor);

  $('#ruleHistory').replaceChildren(
    ...data.versions.map((v) =>
      el(
        'div',
        { class: `ruleHistRow${v.id === cur.id ? ' current' : ''}` },
        el('div', {}, `v${v.versionNo}`, v.id === cur.id ? badge('active', 'active') : badge('superseded', 'inactive')),
        el(
          'div',
          { class: 'meta' },
          `auto ≥ ${v.thresholds.autoLink} · review ≥ ${v.thresholds.review} · ${shortDate(v.createdAt)} · ${v.note ?? ''}`,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const SAMPLE_ROWS = [
  { source: 'crm', external_id: 'N-2001', name: 'William Chen', email: 'will.chen@gmail.com', phone: '+1 415 555 0101', dob: '1985-03-14', address_line: '120 Market St', postal_code: '94105', country: 'US' },
  { source: 'shopify', external_id: 'N-2002', name: 'Will Chen', email: 'will.chen@gmail.com', phone: null, dob: null, address_line: null, postal_code: null, country: 'US' },
];

async function loadImports() {
  const data = await api('GET', '/api/imports');
  state.batches = data.batches;
  $('#batchList').replaceChildren(
    ...data.batches.map((b) =>
      el(
        'div',
        { class: 'batchRow' },
        el('div', { style: 'display:flex;justify-content:space-between;gap:8px' }, el('b', {}, b.label), el('span', { class: 'meta' }, shortDate(b.createdAt))),
        el('div', { class: 'meta' }, `#${b.id} · key ${b.idempotencyKey} · ${b.recordCount} rows`),
        el(
          'div',
          { class: 'summaryChips' },
          ...Object.entries(b.summary).map(([k, v]) => badge(k === 'inserted' ? 'approved' : k === 'rejected' ? 'rejected' : k === 'updated' ? 'review' : 'superseded', `${k} ${v}`)),
        ),
      ),
    ),
    data.batches.length === 0 ? el('div', { class: 'empty' }, 'No batches imported yet.') : null,
  );
}

async function submitImport() {
  const label = $('#impLabel').value.trim() || 'import';
  let rows;
  try {
    rows = JSON.parse($('#impRows').value);
  } catch (err) {
    toast(`Rows must be valid JSON: ${err.message}`, 'bad');
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    toast('Rows must be a non-empty JSON array.', 'bad');
    return;
  }
  const key = $('#impKey').value.trim() || `import-${Date.now()}`;
  $('#impKey').value = key;
  try {
    const res = await api('POST', '/api/imports', { label, idempotencyKey: key, rows, actor: state.actor });
    const s = res.batch.summary;
    $('#impResult').replaceChildren(
      el(
        'div',
        { class: `note ${res.replayed ? 'warn' : 'ok'}` },
        res.replayed
          ? `Replayed existing batch #${res.batch.id}. Nothing was written. Same idempotency key and identical payload.`
          : `Batch #${res.batch.id}: ${s.inserted} inserted, ${s.updated} updated, ${s.duplicate} duplicate, ${s.rejected} rejected.`,
        el(
          'ul',
          {},
          ...res.batch.rows
            .filter((r) => r.status !== 'inserted')
            .map((r) => el('li', {}, `row ${r.rowIndex} (${r.externalId ?? '—'}): ${r.status}${r.reason ? ` — ${r.reason}` : ''}`)),
        ),
      ),
    );
    toast(res.replayed ? 'Idempotent replay: no changes.' : 'Batch imported and clusters rebuilt.');
    await loadImports();
  } catch (err) {
    if (err.status === 409) toast('That idempotency key was already used with a different payload.', 'bad');
  }
}

// ---------------------------------------------------------------------------
// Status strip
// ---------------------------------------------------------------------------

function showStrip(tone, message, action) {
  const strip = $('#statusStrip');
  strip.hidden = false;
  strip.dataset.tone = tone;
  strip.replaceChildren(
    el('span', {}, message),
    el('span', { class: 'spacer' }),
    action ? el('button', { class: 'btn ghost small', onclick: action }, 'Reload') : null,
    el('button', { class: 'btn ghost small', onclick: () => (strip.hidden = true) }, 'Dismiss'),
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  $('#actor').value = state.actor;
  $('#actor').addEventListener('change', (e) => {
    state.actor = e.target.value.trim() || 'anonymous';
    localStorage.setItem('erw.actor', state.actor);
  });
  $('#refreshBtn').addEventListener('click', () => showView(state.view));
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
  $('#bandFilter').addEventListener('change', () => loadReview({ keepSelection: false }));
  $('#showDecided').addEventListener('change', () => loadReview({ keepSelection: false }));
  $('#closeLineage').addEventListener('click', () => ($('#lineagePanel').hidden = true));
  $('#runPicker').addEventListener('change', (e) => loadImpact(Number(e.target.value)));
  $('#resolveAlerts').addEventListener('click', async () => {
    await api('POST', '/api/alerts/resolve', {});
    toast('Open alerts resolved.');
    loadImpact();
  });
  $('#impSubmit').addEventListener('click', submitImport);
  $('#impSample').addEventListener('click', () => {
    $('#impRows').value = JSON.stringify(SAMPLE_ROWS, null, 2);
    $('#impKey').value = '';
  });
  $('#impKey').value = `import-${Date.now()}`;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'r' && !e.target.matches('input,textarea,select') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      showView(state.view);
    }
  });
}

wire();
const initial = location.hash.slice(1) || 'review';
showView(['review', 'clusters', 'impact', 'rules', 'imports'].includes(initial) ? initial : 'review');
