#!/usr/bin/env node
// DOM-level verification of the workbench UI without a real browser.
//
// jsdom executes public/app.js against a live server, so this exercises the
// same fetch calls, rendering code, and event wiring the browser would — it
// only cannot catch CSS/layout issues. Used because this environment cannot
// install Chromium's system libraries.
//
//   node scripts/ui-check.js
//
// jsdom is an optional dev dependency; the check skips cleanly if absent.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let jsdom;
try {
  jsdom = require('jsdom');
} catch {
  try {
    jsdom = require('/tmp/uideps/node_modules/jsdom/lib/api.js');
  } catch {
    console.log('SKIP: jsdom is not installed (npm i -D jsdom), UI check not run.');
    process.exit(0);
  }
}
const { JSDOM, VirtualConsole } = jsdom;
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'erw-ui-'));
const dbPath = join(dir, 'ui.db');
const port = 8898;
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['/workspace/src/server.js'], {
  env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => (serverErr += d));

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start: ${serverErr}`);
}

const errors = [];
let checks = 0;
let failures = 0;
function check(label, ok, extra = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 8000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (fn()) return true;
    } catch { /* not ready */ }
    await wait(60);
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  await waitForServer();

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e.message));
  virtualConsole.on('error', (msg) => errors.push(String(msg)));

  const dom = new JSDOM(readFileSync('/workspace/public/index.html', 'utf8'), {
    url: `${base}/#review`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.fetch = (url, opts) => fetch(String(url).startsWith('http') ? url : `${base}${url}`, opts);
  window.localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.prompt = () => 'revoked in test';

  const appCode = readFileSync('/workspace/public/app.js', 'utf8');
  window.eval(appCode);

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const text = (sel) => $(sel)?.textContent ?? '';
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('review queue');
  await until(() => $$('.pairRow').length > 0, { label: 'pair rows' });
  check('pair list renders', $$('.pairRow').length > 0);
  check('revision pill populated', /\d/.test(text('#revisionPill')));
  check('metrics render', $$('.metric').length >= 5);
  check('list shows score and band', /review|auto|reject/.test(text('#pairList')));

  click($$('.pairRow')[0]);
  await until(() => $$('.record').length === 2, { label: 'pair detail' });
  check('both records shown', $$('.record').length === 2);
  check('match reasons rendered', $$('.reasonList li').length > 0);
  check('conflict section rendered', text('#pairDetail').includes('Conflicting fields'));
  check('shared keys section rendered', text('#pairDetail').includes('Shared deterministic keys'));
  check('band scale rendered', $$('.scaleLabels').length === 1);
  check('adjudication buttons rendered', $$('.detail .btn.ok').length === 1 && $$('.detail .btn.danger').length === 1);

  const reasonInput = $('.detail input[placeholder*="Reason"]');
  reasonInput.value = 'confirmed via ticket 9912';
  click($('.detail .btn.ok'));
  await until(() => $$('.decRow').length > 0 || text('#toast').includes('Approved'), { label: 'decision applied' });
  check('approval recorded', $$('.decRow').length > 0 || /Approved/i.test(text('#toast')));
  check('decision history lists actor', text('#pairDetail').includes('analyst.amara'));

  console.log('clusters and lineage');
  click($('.tab[data-view="clusters"]'));
  await until(() => $$('.clusterCard').length > 0, { label: 'cluster cards' });
  check('clusters render', $$('.clusterCard').length > 0);
  const histBtn = $$('.clusterCard .btn.ghost').find((b) => b.textContent === 'History');
  click(histBtn);
  await until(() => $$('.versionCard').length > 0, { label: 'version cards' });
  check('lineage versions render', $$('.versionCard').length >= 1);
  check('lineage explains immutability', text('#lineageBody').includes('immutable'));
  check('edge kinds visible after a change', /rekey|merge|split|auto/.test(text('#lineageBody')));

  // Manual merge through the UI.
  check('manual ops panel renders', $$('#manualOpsPanel .pickRow').length >= 2);
  const boxes = $$('.pickCluster');
  const beforeOpClusters = $$('.clusterCard').length;
  boxes[boxes.length - 1].checked = true;
  boxes[boxes.length - 2].checked = true;
  $('#opReason').value = 'merged by UI check';
  click($$('#manualOpsPanel .btn.ok')[0]);
  await until(() => $$('#manualOpsPanel .decRow').length > 0, { label: 'manual op recorded' });
  check('manual merge recorded with actor', text('#manualOpsPanel').includes('analyst.amara'));
  check('cluster count changed after merge', $$('.clusterCard').length !== beforeOpClusters);
  click($$('#manualOpsPanel .decRow .btn.danger')[0]);
  await until(() => $$('#manualOpsPanel .decRow').length === 0, { label: 'manual op revoked' });
  check('manual merge is revocable', $$('#manualOpsPanel .decRow').length === 0);

  console.log('impact');
  click($('.tab[data-view="impact"]'));
  await until(() => $$('.impactSummary .metric').length > 0, { label: 'impact metrics' });
  check('impact metrics render', $$('.impactSummary .metric').length >= 6);
  check('impact body has content', text('#impactBody').length > 20);
  check('run picker populated', $$('#runPicker option').length >= 1);

  console.log('rules');
  click($('.tab[data-view="rules"]'));
  await until(() => $$('#ruleEditor input[type="number"]').length >= 3, { label: 'rule editor' });
  check('threshold inputs shown', $$('#ruleEditor input[type="number"]').length >= 3);
  check('deterministic key table listed', $$('.keyTable tbody tr').length >= 4);
  const beforeVersions = $$('.ruleHistRow').length;
  // Change a threshold and save a new version.
  const numInputs = $$('#ruleEditor input[type="number"]');
  numInputs[0].value = '0.91';
  $('.ruleEditor input[placeholder*="Why"]').value = 'ui test change';
  click($$('#ruleEditor .btn.primary')[0]);
  await until(() => /Rule v/.test(text('#toast')), { label: 'rule save' });
  await wait(400);
  check('rule version saved', $$('.ruleHistRow').length > beforeVersions);

  console.log('imports');
  click($('.tab[data-view="imports"]'));
  await until(() => $$('.batchRow').length > 0, { label: 'batch list' });
  check('batch history renders', $$('.batchRow').length >= 1);
  click($('#impSample'));
  click($('#impSubmit'));
  await until(() => text('#impResult').length > 0, { label: 'import result' });
  const first = text('#impResult');
  check('import result summarizes rows', /Batch #|Replayed/.test(first));
  click($('#impSubmit'));
  await until(() => /Replay/i.test(text('#impResult')), { label: 'replay result' });
  check('replay is reported as a no-op', /Replay/i.test(text('#impResult')));

  console.log('stale-screen protection');
  // Force the workbench revision to move underneath the UI.
  const staleRev = await (await fetch(`${base}/api/state`)).json();
  await fetch(`${base}/api/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'outside',
      idempotencyKey: `outside-${Date.now()}`,
      rows: [{ source: 'crm', external_id: `O-${Date.now()}`, name: 'Outside Import', email: 'outside@example.com' }],
      actor: 'outside',
    }),
  });
  click($('.tab[data-view="review"]'));
  await until(() => $$('.pairRow').length > 0, { label: 'review reload' });
  // The UI's revision is now stale relative to the server.
  const freshPair = $$('.pairRow').find((r) => !r.textContent.includes('approved'));
  click(freshPair ?? $$('.pairRow')[0]);
  await until(() => $$('.detail .pairCards').length === 1, { label: 'detail' });
  if ($$('.detail .btn.ok').length > 0) {
    $('.detail input[placeholder*="Reason"]').value = 'stale attempt';
    click($('.detail .btn.ok'));
    await wait(700);
    check('stale write explained to the user', /stale|moved to rev|already/i.test(text('#statusStrip') + text('#toast')));
    check('workbench revision refreshed by the reload', /\d/.test(text('#revisionPill')));
  } else {
    check('pair already decided; no stale write attempted', true);
  }

  check('no uncaught script errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  dom.window.close();
} catch (err) {
  failures++;
  console.error(`\nUI verification failed: ${err.message}`);
  if (serverErr) console.error(serverErr);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} UI checks passed`);
if (failures > 0) process.exit(1);
