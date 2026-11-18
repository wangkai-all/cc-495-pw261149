import { createHash } from 'node:crypto';
import { nowIso, tx } from '../db/index.js';
import { httpError } from '../engine/rules.js';
import { insertCustomer, materialize } from './resolution.js';
import { latestRule, ensureRuleVersion, hydrateRule } from '../engine/rules.js';
import { normalizeEmail, normalizePhone, normalizeVat, normalizeDob, normalizePostal } from '../engine/matching.js';

const REQUIRED = ['source', 'external_id', 'name'];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(rows) {
  return createHash('sha256').update(stableStringify(rows)).digest('hex');
}

function normalizeRow(raw, rowIndex) {
  const errors = [];
  for (const field of REQUIRED) {
    if (raw[field] == null || String(raw[field]).trim() === '') {
      errors.push(`missing required field "${field}"`);
    }
  }
  const country = raw.country ? String(raw.country).trim().toUpperCase() : null;
  return {
    rowIndex,
    raw,
    errors,
    supplied: suppliedFields(raw),
    customer: {
      source: raw.source != null ? String(raw.source).trim() : '',
      external_id: raw.external_id != null ? String(raw.external_id).trim() : '',
      name: raw.name != null ? String(raw.name).trim() : '',
      email: raw.email ? normalizeEmail(raw.email) : null,
      phone: raw.phone ? normalizePhone(raw.phone, country) : null,
      dob: raw.dob ? normalizeDob(raw.dob) : null,
      address_line: raw.address_line ? String(raw.address_line).trim() : null,
      postal_code: raw.postal_code ? normalizePostal(raw.postal_code) : null,
      country,
      vat_id: raw.vat_id ? normalizeVat(raw.vat_id) : null,
    },
  };
}

function changedFields(existing, next) {
  const fields = [];
  for (const key of ['name', 'email', 'phone', 'dob', 'address_line', 'postal_code', 'country', 'vat_id']) {
    if ((existing[key] ?? null) !== (next[key] ?? null)) fields.push(key);
  }
  return fields;
}

const OPTIONAL_FIELDS = ['email', 'phone', 'dob', 'address_line', 'postal_code', 'country', 'vat_id'];

/**
 * Which optional fields the payload actually mentions.
 *
 * Sparse enrichment feeds send only the columns they know about. A field that is
 * absent is "no information", while a field explicitly present with `null` or
 * `""` is an instruction to clear it. Tracking the keys (not the normalised
 * values) is what lets both cases behave correctly.
 */
function suppliedFields(raw) {
  const supplied = new Set();
  for (const key of OPTIONAL_FIELDS) {
    if (Object.hasOwn(raw, key)) supplied.add(key);
  }
  return supplied;
}

/**
 * Merge an incoming row into the stored one.
 *
 * Fields the payload does not mention keep their stored value; fields it
 * mentions (even as `null`) win. Required identity fields (`source`,
 * `external_id`, `name`) are always taken from the payload.
 */
function mergePartial(existing, next, supplied) {
  const merged = { ...next };
  for (const key of OPTIONAL_FIELDS) {
    if (!supplied.has(key)) merged[key] = existing[key] ?? null;
  }
  return merged;
}

/**
 * Import a batch of customer records.
 *
 * Idempotency:
 *  - same idempotencyKey + same payload  -> returns the original batch (replay)
 *  - same idempotencyKey + different payload -> 409, nothing written
 *  - unique external ids are upserted; a row that matches an existing row
 *    exactly is reported `duplicate`, never silently written twice.
 *  - duplicate (source, external_id) inside one batch is rejected with reason.
 *
 * Each successful import triggers a fresh materialization under the current
 * rule version, so new records immediately produce candidate evidence.
 */
export function importBatch(db, { label, idempotencyKey, rows, actor = 'importer', ruleVersionId = null }) {
  if (!idempotencyKey || String(idempotencyKey).trim() === '') {
    throw httpError(400, 'idempotencyKey is required');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw httpError(400, 'rows must be a non-empty array');
  }
  if (rows.length > 5000) throw httpError(413, 'batch limit is 5000 rows');
  const hash = payloadHash(rows);
  const ts = nowIso();

  return tx(db, () => {
    const prior = db.prepare('SELECT * FROM import_batches WHERE idempotency_key = ?').get(idempotencyKey);
    if (prior) {
      if (prior.payload_hash !== hash) {
        throw httpError(409, 'idempotency key reused with a different payload', {
          idempotencyKey,
          existingBatchId: prior.id,
        });
      }
      return {
        replayed: true,
        batch: describeBatch(db, prior),
        materialization: null,
      };
    }

    let rule = latestRule(db);
    if (ruleVersionId != null) {
      const pinned = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(Number(ruleVersionId));
      if (!pinned) throw httpError(404, `rule version ${ruleVersionId} not found`);
      if (!rule || pinned.id !== rule.id) {
        // Importing under a superseded rule would re-materialize the workspace
        // backwards: evidence rows for the newer rule would be superseded by
        // older-rule rows, and the active clusters would regress while keeping
        // forward-pointing lineage. Importers pick the rule that is current.
        throw httpError(409, 'imports must materialize under the latest rule version', {
          requestedRuleVersionId: pinned.id,
          latestRuleVersionId: rule?.id ?? null,
        });
      }
      rule = hydrateRule(pinned);
    }
    rule = rule ?? ensureRuleVersion(db, undefined, 'bootstrap');

    const batchInfo = db.prepare(
      `INSERT INTO import_batches (label, idempotency_key, payload_hash, record_count, created_at)
       VALUES (?,?,?,?,?)`,
    ).run(String(label ?? 'import'), idempotencyKey, hash, rows.length, ts);
    const batchId = Number(batchInfo.lastInsertRowid);

    const results = [];
    const seenInBatch = new Map();

    rows.forEach((raw, idx) => {
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        results.push({ rowIndex: idx, externalId: null, status: 'rejected', reason: 'row must be an object' });
        db.prepare(
          `INSERT INTO import_rows (batch_id, row_index, external_id, customer_id, status, reason, raw)
           VALUES (?,?,?, NULL, 'rejected', ?, ?)`,
        ).run(batchId, idx, '', 'row must be an object', JSON.stringify(raw ?? null));
        return;
      }
      const norm = normalizeRow(raw, idx);
      if (norm.errors.length > 0) {
        results.push({
          rowIndex: idx,
          externalId: norm.customer.external_id || null,
          status: 'rejected',
          reason: norm.errors.join('; '),
        });
        db.prepare(
          `INSERT INTO import_rows (batch_id, row_index, external_id, customer_id, status, reason, raw)
           VALUES (?,?,?, NULL, 'rejected', ?, ?)`,
        ).run(batchId, idx, norm.customer.external_id, norm.errors.join('; '), JSON.stringify(raw));
        return;
      }
      const dedupeKey = `${norm.customer.source}\u0000${norm.customer.external_id}`;
      if (seenInBatch.has(dedupeKey)) {
        const first = seenInBatch.get(dedupeKey);
        const same = stableStringify(rows[first]) === stableStringify(raw);
        const reason = same
          ? `duplicate of row ${first} in this batch (identical payload)`
          : `duplicate of row ${first} in this batch with conflicting payload`;
        results.push({ rowIndex: idx, externalId: norm.customer.external_id, status: 'rejected', reason });
        db.prepare(
          `INSERT INTO import_rows (batch_id, row_index, external_id, customer_id, status, reason, raw)
           VALUES (?,?,?, NULL, 'rejected', ?, ?)`,
        ).run(batchId, idx, norm.customer.external_id, reason, JSON.stringify(raw));
        return;
      }
      seenInBatch.set(dedupeKey, idx);

      const existing = db.prepare(
        'SELECT * FROM customers WHERE source = ? AND external_id = ?',
      ).get(norm.customer.source, norm.customer.external_id);
      let customerId;
      let status;
      let reason = null;
      if (!existing) {
        customerId = insertCustomer(db, norm.customer, ts);
        status = 'inserted';
      } else {
        // Sparse rows keep previously known values for fields they omit.
        const merged = mergePartial(existing, norm.customer, norm.supplied);
        const diff = changedFields(existing, merged);
        if (diff.length === 0) {
          customerId = existing.id;
          status = 'duplicate';
          reason = 'record already exists with identical values';
          db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?').run(ts, customerId);
        } else {
          db.prepare(
            `UPDATE customers SET name=?, email=?, phone=?, dob=?, address_line=?, postal_code=?,
               country=?, vat_id=?, updated_at=? WHERE id=?`,
          ).run(
            merged.name,
            merged.email,
            merged.phone,
            merged.dob,
            merged.address_line,
            merged.postal_code,
            merged.country,
            merged.vat_id,
            ts,
            existing.id,
          );
          customerId = existing.id;
          status = 'updated';
          reason = `changed: ${diff.join(', ')}`;
        }
      }
      db.prepare(
        `INSERT INTO import_rows (batch_id, row_index, external_id, customer_id, status, reason, raw)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(batchId, idx, norm.customer.external_id, customerId, status, reason, JSON.stringify(raw));
      results.push({
        rowIndex: idx,
        externalId: norm.customer.external_id,
        customerId,
        status,
        reason,
      });
    });

    const run = materialize(db, { rule, origin: 'import', actor });
    return {
      replayed: false,
      batch: describeBatch(db, { id: batchId }, results),
      materialization: run,
    };
  });
}

export function describeBatch(db, batch, results = null) {
  const rows = results ?? db.prepare(
    'SELECT row_index, external_id, customer_id, status, reason FROM import_rows WHERE batch_id = ? ORDER BY row_index',
  ).all(batch.id).map((r) => ({
    rowIndex: r.row_index,
    externalId: r.external_id,
    customerId: r.customer_id,
    status: r.status,
    reason: r.reason,
  }));
  const summary = rows.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { inserted: 0, updated: 0, duplicate: 0, rejected: 0 },
  );
  return { id: batch.id, summary, rows, rowCount: rows.length };
}

export function listBatches(db) {
  return db.prepare('SELECT * FROM import_batches ORDER BY id DESC').all().map((b) => {
    const summary = db.prepare(
      'SELECT status, COUNT(*) AS n FROM import_rows WHERE batch_id = ? GROUP BY status',
    ).all(b.id);
    return {
      id: b.id,
      label: b.label,
      idempotencyKey: b.idempotency_key,
      recordCount: b.record_count,
      createdAt: b.created_at,
      summary: Object.fromEntries(summary.map((s) => [s.status, s.n])),
    };
  });
}
