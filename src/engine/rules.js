import { createHash } from 'node:crypto';
import { nowIso } from '../db/index.js';
import {
  DEFAULT_DETERMINISTIC_KEYS,
  DEFAULT_FUZZY_WEIGHTS,
  DEFAULT_THRESHOLDS,
} from '../engine/matching.js';

export function defaultRuleConfig() {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    deterministic: structuredClone(DEFAULT_DETERMINISTIC_KEYS),
    fuzzy: { ...DEFAULT_FUZZY_WEIGHTS },
  };
}

export function normalizeRuleConfig(input = {}, base = defaultRuleConfig()) {
  const cfg = {
    thresholds: { ...base.thresholds, ...(input.thresholds ?? {}) },
    deterministic: input.deterministic ?? structuredClone(base.deterministic),
    fuzzy: { ...base.fuzzy, ...(input.fuzzy ?? {}) },
  };
  for (const k of ['autoLink', 'review', 'keyMatchMin']) {
    const v = cfg.thresholds[k];
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
      throw httpError(400, `thresholds.${k} must be a number between 0 and 1`);
    }
  }
  if (!(cfg.thresholds.review <= cfg.thresholds.autoLink)) {
    throw httpError(400, 'thresholds.review must be <= thresholds.autoLink');
  }
  if (!Array.isArray(cfg.deterministic) || cfg.deterministic.length === 0) {
    throw httpError(400, 'deterministic must be a non-empty array of key definitions');
  }
  for (const def of cfg.deterministic) {
    if (!def || typeof def.name !== 'string' || !Array.isArray(def.fields) || def.fields.length === 0) {
      throw httpError(400, 'each deterministic key needs a name and fields');
    }
    if (typeof def.weight !== 'number' || def.weight <= 0 || def.weight > 1) {
      throw httpError(400, `deterministic key ${def.name} needs a weight in (0,1]`);
    }
  }
  for (const field of ['name', 'address', 'dob', 'postal', 'country']) {
    const v = cfg.fuzzy[field];
    if (typeof v !== 'number' || v < 0) {
      throw httpError(400, `fuzzy.${field} must be a non-negative number`);
    }
  }
  if (Object.values(cfg.fuzzy).every((v) => v === 0)) {
    throw httpError(400, 'at least one fuzzy weight must be positive');
  }
  return cfg;
}

export function configHash(config) {
  const canonical = JSON.stringify(sortKeys(config));
  return createHash('sha256').update(canonical).digest('hex');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export function ensureRuleVersion(db, inputConfig, note = 'bootstrap') {
  const config = normalizeRuleConfig(inputConfig);
  const hash = configHash(config);
  const existing = db.prepare('SELECT * FROM rule_versions WHERE config_hash = ?').get(hash);
  if (existing) {
    const rule = hydrateRule(existing);
    Object.defineProperty(rule, 'created', { value: false, enumerable: false });
    return rule;
  }
  const next = db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM rule_versions').get().n;
  const info = db.prepare(
    `INSERT INTO rule_versions (version_no, config_hash, thresholds, deterministic, fuzzy, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    next,
    hash,
    JSON.stringify(config.thresholds),
    JSON.stringify(config.deterministic),
    JSON.stringify(config.fuzzy),
    note,
    nowIso(),
  );
  const rule = hydrateRule(db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(info.lastInsertRowid));
  Object.defineProperty(rule, 'created', { value: true, enumerable: false });
  return rule;
}

export function hydrateRule(row) {
  if (!row) return null;
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

export function getRule(db, id) {
  return hydrateRule(db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id));
}

export function listRules(db) {
  return db.prepare('SELECT * FROM rule_versions ORDER BY version_no DESC').all().map(hydrateRule);
}

export function latestRule(db) {
  return hydrateRule(db.prepare('SELECT * FROM rule_versions ORDER BY version_no DESC LIMIT 1').get());
}

export function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}
