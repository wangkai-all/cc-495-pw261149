# Customer Entity Resolution Workbench

A runnable workbench for resolving the same customer across CRM, shop, billing,
and support records. It combines **deterministic keys**, **fuzzy matching**, and
**human adjudication**, and it treats every one of those as evidence that is
never destroyed.

No build step, no runtime dependencies beyond Node 22.5+ (`node:sqlite`).

```bash
npm run seed     # create data/workbench.db with a deliberately messy demo set
npm start        # http://localhost:8787
npm test         # 54 unit + integration tests, incl. real multi-process races
npm run smoke    # narrative end-to-end walkthrough of the guarantees
npm run ui-check # optional: drives public/app.js in jsdom (needs `npm i -D jsdom`)
```

`DB_PATH` and `PORT` are honoured. `npm start` seeds automatically on an empty
database.

## What it does

| Step | Mechanism |
| --- | --- |
| Normalize | Unicode folding, nickname canonicalization (`Bill`→`william`), Gmail dot/plus stripping, E.164-ish phones, VAT and postal normalization |
| Block | Inverted index over shared blocking tokens so only plausible pairs are scored |
| Score | Surname/given-name-aware fuzzy similarity + exact keys; weights and thresholds come from a versioned rule row |
| Band | `auto` (link), `review` (human queue), `reject` (kept as evidence when it has any signal) |
| Cluster | Union-find with must-link (merges, split groups) and cannot-link (rejections, split partitions) constraints |
| Aggregate | Rebuilt per materialization run; LTV/orders/segment per cluster |

### Match model

* **Deterministic keys** are data, not code: `email`, `phone`, `vat_id`,
  `name+dob`, `name+postal`. An exact shared key floors the score.
* **Hard conflicts** (different DOB, different VAT id, materially different
  names) cap the score below the auto band and force `review`. Two people with
  the same name and address do not silently become one customer.
* **Soft conflicts** (different email/phone) lower confidence and are shown to
  the reviewer, but do not by themselves block a link.
* **Households**: an exact surname with an unrelated given name is capped, so
  shared addresses alone don't flood the review queue.

## Guarantees, and where they live

The whole design rests on one rule: **decisions and clusters are append-only.
Nothing is updated in place except a status field.**

### Rule or threshold changes keep old clusters

`POST /api/rules` creates an immutable `rule_versions` row, then re-materializes.
For each resulting cluster:

* unchanged members and evidence → same lineage, new `rekey` version; the old
  version becomes `superseded` with `superseded_by_id` pointing forward;
* changed members → the lineage continues and a `merge` / `split` version is
  written, with edges describing what moved;
* a lineage that no longer exists → its active version is superseded, never
  deleted.

Inheritance is assigned globally: the new cluster with the largest member
overlap claims an old lineage first, so an incidental one-member overlap cannot
steal a lineage that another cluster clearly continues.

`GET /api/lineages/:id` returns every version with its members and edges.

### Merges and splits have history

Automatic changes emit `merge` / `split` edges derived from member movement
(`emitMovementEdges`). Each `(from, to)` version pair is written at most once,
so a change that both continues a lineage and moves members is never recorded
twice with contradicting kinds. Manual operations are first-class `manual_ops`
rows with actor, reason, and a revocable `active` flag. A manual split both pins
the partition (cannot-link across groups) and holds each group together
(must-link within it), so later rule changes cannot silently undo it. A merge
must name exactly one group, and a split must account for every member of the
clusters it touches — a partial split is rejected with `400` rather than
leaving an unnamed customer silently attached.

### Revoking a confirmation affects downstream aggregation without losing evidence

`POST /api/decisions/:id/revoke`:

1. flips `pair_decisions.active` to 0 and stamps who/when/why — the row stays;
2. reopens the newest `candidate_pairs` evidence row (older rows keep their
   history status, and the reopened row's supersede pointer is cleared);
3. writes an `impact_alerts` row;
4. re-materializes, which splits the clusters back apart and recomputes
   aggregates;
5. records an aggregate *delta* (`before → after`, including removed clusters
   and `segment` changes, not just member counts and LTV).

The candidate pair, its match reasons, its conflicts, the original decision, and
the cluster versions it produced all remain queryable.

### Human decisions survive rule changes

If a later rule version stops scoring an approved or rejected pair, the evidence
row is carried into the new rule version with a `carried-decision` reason. A rule
change can therefore never silently erase a human's call.

### Concurrency and duplicate imports

* A monotonic `revision` counter is returned by `/api/state` and every mutation.
  Write endpoints accept `expectedRevision`; a mismatch is a `409` with the
  current revision, so a stale review screen cannot double-confirm.
* A partial unique index (`ux_pair_decisions_active`) allows exactly one active
  decision per pair at the database level.
* All multi-step writes run inside `BEGIN IMMEDIATE` (`src/db/index.js`), so
  concurrent OS processes serialize rather than interleave.
* Imports are keyed by an idempotency key: replay returns the original batch and
  writes nothing; reusing a key with a different payload is a `409`. Duplicate
  `(source, external_id)` within a batch is rejected with a reason, and re-
  importing identical rows reports `duplicate` rather than inserting again.
* Imports materialize under the latest rule version; pinning a superseded
  version is a `409`, so an import can never move evidence (and the active
  clusters) backwards.
* A sparse row updates only the fields it supplies. Omitted optional fields keep
  their stored values; a field sent explicitly as `null` clears it — enrichment
  feeds routinely send required columns only, and must not wipe known values.

The test suite proves the last two points with two real child processes against
a shared file database (`tests/api.test.js`).

## UI

`public/` is a dependency-free single-page app:

* **Review queue** — candidate pairs with score, band, shared keys, match
  reasons, conflicting fields (hard vs soft), affected clusters, evidence
  history across rule versions, and confirm/reject with a recorded reason.
  Revocation lives on the decision history.
* **Clusters** — active clusters with members and join reasons; a manual
  merge/split panel that pins partitions and can be revoked; click through to
  the full lineage version history or a single customer's timeline.
* **Impact & history** — merges, splits, rekeys, conflicts left for humans,
  aggregate deltas with before → after, and open alerts. Any past run can be
  inspected.
* **Rules** — edit thresholds and fuzzy weights, save as an immutable version,
  and see the resulting change report.
* **Imports** — paste a JSON batch, see per-row outcomes, replay behaviour, and
  batch history.

Every mutation shows the workbench revision; a stale screen gets a clear
"the workbench moved to rev N" banner rather than a silent no-op.

## API

```
GET  /api/state
GET  /api/customers                     GET /api/customers/:id/timeline
GET  /api/pairs?band&status&limit        GET /api/pairs/:pairKey
POST /api/pairs/:pairKey/decisions       POST /api/decisions/:id/revoke
GET  /api/clusters                       GET /api/lineages/:id
POST /api/manual-ops                     POST /api/manual-ops/:id/revoke
GET  /api/manual-ops
GET  /api/impact?runId                   POST /api/alerts/resolve
GET  /api/rules                          POST /api/rules
POST /api/imports                        GET /api/imports
```

## Schema notes

See `src/db/schema.sql`. The tables that carry the audit trail are
`candidate_pairs`, `pair_decisions`, `manual_ops`, `cluster_versions`,
`cluster_members`, `cluster_edges`, `rebuild_runs`, and `aggregates`.

`cluster_versions.status` is the only column that changes on an existing
cluster row; everything else is a new row. Foreign keys are enforced
(`PRAGMA foreign_keys = ON`), and decisions, evidence, and cluster versions are
never deleted by application code.

## Layout

```
src/engine/matching.js     normalization, keys, similarity, banding (pure)
src/engine/clustering.js   constraint-aware union-find (pure)
src/engine/rules.js        rule versions, validation, config hashing
src/service/resolution.js  materialization, decisions, queries
src/service/import.js      idempotent bulk import
src/server.js              HTTP API + static files
public/                    workbench UI
scripts/seed.js            demo data
scripts/smoke.js           end-to-end walkthrough
tests/                     node:test suites
scripts/ui-check.js        jsdom-driven UI verification (skips if jsdom absent)
```
