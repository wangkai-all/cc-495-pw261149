-- Customer Entity Resolution Workbench schema.
-- Design invariant: decisions are append-only. Clusters are never mutated in place:
-- every rule/threshold change, merge, split, or approval revocation writes a new
-- cluster version and a link row that points at its predecessor. Evidence
-- (candidate pairs, match reasons, source records, matches) is never deleted.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL,              -- import batch / system of record
  external_id   TEXT    NOT NULL,              -- id in source system
  name          TEXT    NOT NULL,
  email         TEXT,
  phone         TEXT,
  dob           TEXT,                          -- ISO date
  address_line  TEXT,
  postal_code   TEXT,
  country       TEXT,
  vat_id        TEXT,
  imported_at   TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  idempotency_key TEXT  NOT NULL UNIQUE,
  payload_hash  TEXT    NOT NULL,
  record_count  INTEGER NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS import_rows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES import_batches(id),
  row_index     INTEGER NOT NULL,
  external_id   TEXT    NOT NULL,
  customer_id   INTEGER REFERENCES customers(id),
  status        TEXT    NOT NULL,  -- inserted | duplicate | updated | rejected
  reason        TEXT,
  raw           TEXT    NOT NULL,
  UNIQUE (batch_id, row_index)
);

-- A rule/threshold version. Every ingest or explicit re-run pins a version.
-- Identical configs collapse onto one version so re-running a build is idempotent.
CREATE TABLE IF NOT EXISTS rule_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no    INTEGER NOT NULL UNIQUE,
  config_hash   TEXT    NOT NULL UNIQUE,
  thresholds    TEXT    NOT NULL,   -- JSON
  deterministic TEXT    NOT NULL,   -- JSON key definitions
  fuzzy         TEXT    NOT NULL,   -- JSON field weights
  note          TEXT,
  created_at    TEXT    NOT NULL
);

-- Cluster lineage: an immutable identity for a chain of cluster versions.
CREATE TABLE IF NOT EXISTS cluster_lineage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT    NOT NULL,
  origin        TEXT    NOT NULL   -- auto | manual-merge | manual-split | rekey
);

-- A materialized cluster at a given rule version. NEVER updated except for
-- the `status` transition (active -> superseded), which is what preserves old clusters.
CREATE TABLE IF NOT EXISTS cluster_versions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lineage_id        INTEGER NOT NULL REFERENCES cluster_lineage(id),
  rule_version_id   INTEGER NOT NULL REFERENCES rule_versions(id),
  version_no        INTEGER NOT NULL,       -- per-lineage sequence
  status            TEXT    NOT NULL,       -- active | superseded
  origin            TEXT    NOT NULL,       -- auto | merge | split | rekey | approved
  support_hash      TEXT    NOT NULL,       -- signature of members + supporting evidence
  created_at        TEXT    NOT NULL,
  superseded_at     TEXT,
  superseded_by_id  INTEGER REFERENCES cluster_versions(id),
  UNIQUE (lineage_id, version_no)
);

CREATE TABLE IF NOT EXISTS cluster_members (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_version_id INTEGER NOT NULL REFERENCES cluster_versions(id),
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  join_reason        TEXT    NOT NULL,      -- JSON: key/fuzzy/approval evidence
  confidence         REAL    NOT NULL,
  UNIQUE (cluster_version_id, customer_id)
);

-- Every change to a cluster version emits one or more edges in this table.
-- Rebuilds (rule change) emit `rekeyed-from` edges so the audit trail survives.
CREATE TABLE IF NOT EXISTS cluster_edges (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  from_cluster_version_id INTEGER REFERENCES cluster_versions(id),
  to_cluster_version_id   INTEGER NOT NULL REFERENCES cluster_versions(id),
  kind                   TEXT    NOT NULL,  -- merge | split | rekey | duplicate-merge
  detail                 TEXT    NOT NULL,  -- JSON
  created_at             TEXT    NOT NULL
);

-- Candidate pairs are evidence. Even after a decision they stay, so revoking
-- a confirmation cannot lose the underlying match evidence. pair_key is the
-- unordered customer pair, stable across rule versions, so human decisions
-- follow the evidence instead of being stranded on an old rule version.
CREATE TABLE IF NOT EXISTS candidate_pairs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_key           TEXT    NOT NULL,
  left_customer_id   INTEGER NOT NULL REFERENCES customers(id),
  right_customer_id  INTEGER NOT NULL REFERENCES customers(id),
  rule_version_id    INTEGER NOT NULL REFERENCES rule_versions(id),
  score              REAL    NOT NULL,
  band               TEXT    NOT NULL CHECK (band IN ('auto','review','reject','manual')),
  reasons            TEXT    NOT NULL,      -- JSON array of match reasons
  conflicts          TEXT    NOT NULL,      -- JSON array of conflicting fields
  deterministic_keys TEXT    NOT NULL,      -- JSON array of shared keys
  status             TEXT    NOT NULL CHECK (status IN ('open','approved','rejected','superseded')),
  superseded_by_id   INTEGER REFERENCES candidate_pairs(id),
  created_at         TEXT    NOT NULL,
  UNIQUE (pair_key, rule_version_id)
);

-- Human adjudication. Append-only: each row is a distinct confirmation or
-- rejection. Revocation flips `active` and stamps who/when/why; nothing is
-- deleted, so downstream rebuilds can always replay what was decided.
CREATE TABLE IF NOT EXISTS pair_decisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id          INTEGER NOT NULL REFERENCES candidate_pairs(id),
  pair_key         TEXT    NOT NULL,
  action           TEXT    NOT NULL CHECK (action IN ('approve','reject')),
  actor            TEXT    NOT NULL,
  reason           TEXT,
  created_at       TEXT    NOT NULL,
  revoked_at       TEXT,
  revoked_by       TEXT,
  revoke_reason    TEXT,
  active           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS ix_pair_decisions_pair ON pair_decisions(pair_key, active);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pair_decisions_active ON pair_decisions(pair_key) WHERE active = 1;
CREATE INDEX IF NOT EXISTS ix_candidate_pairs_key ON candidate_pairs(pair_key);

-- Downstream aggregation snapshot. A full rebuild writes one row per active
-- cluster; `run_key` groups the rows written by a single recalculation.
CREATE TABLE IF NOT EXISTS aggregates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key         TEXT    NOT NULL,
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  cluster_version_id INTEGER NOT NULL REFERENCES cluster_versions(id),
  customer_count  INTEGER NOT NULL,
  ltv_cents       INTEGER NOT NULL,
  segment         TEXT    NOT NULL,
  computed_at     TEXT    NOT NULL,
  UNIQUE (run_key, cluster_version_id)
);

CREATE TABLE IF NOT EXISTS customer_metrics (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id),
  ltv_cents    INTEGER NOT NULL,
  orders       INTEGER NOT NULL
);

-- Work items raised when a revocation or rule change invalidates prior work.
CREATE TABLE IF NOT EXISTS impact_alerts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,   -- revocation | rule-change | split
  subject        TEXT NOT NULL,
  detail         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);

-- Append-only manual operations on clusters. A merge forces members together,
-- a split pins a partition (groups may never be re-unioned while active).
-- Both survive rule changes and are revoked (never deleted) like pair decisions.
CREATE TABLE IF NOT EXISTS manual_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('merge','split')),
  groups      TEXT NOT NULL,          -- JSON array of arrays of customer ids
  actor       TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT,
  revoke_reason TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);

-- Single-row revision counter. Every mutation bumps it; clients use it for
-- optimistic concurrency (and to detect stale review screens).
CREATE TABLE IF NOT EXISTS workbench_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per materialization run. `detail` carries the impact report:
-- which clusters merged/split, aggregate deltas, conflicts left for humans.
CREATE TABLE IF NOT EXISTS rebuild_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  revision        INTEGER NOT NULL,
  origin          TEXT    NOT NULL,
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  actor           TEXT,
  detail          TEXT    NOT NULL,
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS ix_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS ix_customers_vat ON customers(vat_id);
CREATE INDEX IF NOT EXISTS ix_cluster_members_customer ON cluster_members(customer_id);
CREATE INDEX IF NOT EXISTS ix_edges_to ON cluster_edges(to_cluster_version_id);
CREATE INDEX IF NOT EXISTS ix_aggregates_run ON aggregates(run_key);
