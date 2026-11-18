import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { latestRule, ensureRuleVersion } from '../src/engine/rules.js';
import { importBatch } from '../src/service/import.js';
import { materialize } from '../src/service/resolution.js';

const here = dirname(fileURLToPath(import.meta.url));

// Deliberately messy CRM-shaped data: nicknames, typos, plus-addressing,
// casing, country prefixes, shared households, and one true negative that
// must not merge (same name, different person).
export const SEED_ROWS = [
  { source: 'crm', external_id: 'C-1001', name: 'William Chen', email: 'william.chen@gmail.com', phone: '+1 415 555 0101', dob: '1985-03-14', address_line: '120 Market St', postal_code: '94105', country: 'US', vat_id: null },
  { source: 'shopify', external_id: 'S-771', name: 'Bill Chen', email: 'bill.chen+orders@gmail.com', phone: '415-555-0101', dob: '1985-03-14', address_line: '120 Market Street', postal_code: '94105', country: 'US', vat_id: null },
  { source: 'billing', external_id: 'B-55', name: 'W. Chen', email: 'wchen@acme-corp.com', phone: '14155550101', dob: null, address_line: '120 Market St', postal_code: '94105', country: 'US', vat_id: 'US-ACME-7781' },

  { source: 'crm', external_id: 'C-1002', name: 'Robert Müller', email: 'robert.mueller@example.de', phone: '+49 30 555 2200', dob: '1978-11-02', address_line: 'Hauptstraße 14', postal_code: '10115', country: 'DE', vat_id: null },
  { source: 'shopify', external_id: 'S-772', name: 'Bob Mueller', email: 'bob.mueller@example.de', phone: '030 555 2200', dob: '1978-11-02', address_line: 'Hauptstrasse 14', postal_code: '10115', country: 'DE', vat_id: null },

  { source: 'crm', external_id: 'C-1003', name: 'Elizabeth Taylor', email: 'elizabeth.taylor@example.com', phone: '+44 20 7946 0102', dob: '1990-06-21', address_line: '8 Carnaby Street', postal_code: 'W1F 9PP', country: 'GB', vat_id: null },
  { source: 'billing', external_id: 'B-57', name: 'Liz Taylor', email: 'liz.taylor@example.com', phone: '020 7946 0102', dob: '1990-06-21', address_line: '8 Carnaby St', postal_code: 'W1F9PP', country: 'GB', vat_id: 'GB-998877665' },
  { source: 'support', external_id: 'T-204', name: 'E. Taylor', email: 'etaylor@example.com', phone: null, dob: null, address_line: '8 Carnaby Street', postal_code: 'W1F 9PP', country: 'GB', vat_id: null },

  // True negative: same name and city, different DOB and email.
  { source: 'crm', external_id: 'C-1004', name: 'Michael Brown', email: 'michael.brown@example.com', phone: '+1 212 555 0144', dob: '1970-01-09', address_line: '5th Avenue 300', postal_code: '10001', country: 'US', vat_id: null },
  { source: 'shopify', external_id: 'S-774', name: 'Michael Brown', email: 'mike.b@otherdomain.net', phone: '+1 212 555 0199', dob: '1994-09-30', address_line: '5th Avenue 300', postal_code: '10001', country: 'US', vat_id: null },

  // Household: two different people at the same address, no name similarity.
  { source: 'crm', external_id: 'C-1005', name: 'Sofia Rossi', email: 'sofia.rossi@example.it', phone: '+39 06 555 3300', dob: '1989-04-18', address_line: 'Via Roma 22', postal_code: '00184', country: 'IT', vat_id: null },
  { source: 'crm', external_id: 'C-1006', name: 'Marco Rossi', email: 'marco.rossi@example.it', phone: '+39 06 555 3301', dob: '1987-08-07', address_line: 'Via Roma 22', postal_code: '00184', country: 'IT', vat_id: null },

  // A record with only a deterministic VAT key to exercise key-only linking.
  { source: 'billing', external_id: 'B-60', name: 'Acme Widgets GmbH', email: null, phone: null, dob: null, address_line: 'Hauptstraße 14', postal_code: '10115', country: 'DE', vat_id: 'DE811234567' },
  { source: 'billing', external_id: 'B-61', name: 'Acme Widgets GMBH', email: 'ap@acme-widgets.de', phone: null, dob: null, address_line: 'Hauptstrasse 14', postal_code: '10115', country: 'DE', vat_id: 'DE811234567' },

  { source: 'support', external_id: 'T-210', name: 'Priya Raman', email: 'priya.raman@example.com', phone: '+91 80 5550 1100', dob: '1992-12-05', address_line: 'MG Road 42', postal_code: '560001', country: 'IN', vat_id: null },
  { source: 'shopify', external_id: 'S-780', name: 'Priya Raman', email: 'priya.raman@example.com', phone: null, dob: null, address_line: null, postal_code: null, country: 'IN', vat_id: null },
];

const METRICS = {
  'C-1001': { ltv: 240_000, orders: 8 },
  'S-771': { ltv: 55_000, orders: 3 },
  'B-55': { ltv: 0, orders: 0 },
  'C-1002': { ltv: 620_000, orders: 14 },
  'S-772': { ltv: 80_000, orders: 2 },
  'C-1003': { ltv: 175_000, orders: 6 },
  'B-57': { ltv: 40_000, orders: 1 },
  'T-204': { ltv: 0, orders: 0 },
  'C-1004': { ltv: 90_000, orders: 4 },
  'S-774': { ltv: 20_000, orders: 1 },
  'C-1005': { ltv: 310_000, orders: 9 },
  'C-1006': { ltv: 45_000, orders: 2 },
  'B-60': { ltv: 900_000, orders: 22 },
  'B-61': { ltv: 130_000, orders: 4 },
  'T-210': { ltv: 12_000, orders: 1 },
  'S-780': { ltv: 0, orders: 0 },
};

export function seedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  if (count > 0) return false;
  seed(db);
  return true;
}

export function seed(db) {
  const rule = ensureRuleVersion(db, undefined, 'initial baseline');
  importBatch(db, {
    label: 'initial backlog',
    idempotencyKey: 'seed-initial-2026-11-18',
    rows: SEED_ROWS,
    actor: 'seed',
  });
  const ruleRow = latestRule(db);
  const customers = db.prepare('SELECT * FROM customers').all();
  for (const c of customers) {
    const metrics = METRICS[c.external_id] ?? { ltv: 0, orders: 0 };
    db.prepare(
      `INSERT INTO customer_metrics (customer_id, ltv_cents, orders) VALUES (?,?,?)
       ON CONFLICT(customer_id) DO UPDATE SET ltv_cents=excluded.ltv_cents, orders=excluded.orders`,
    ).run(c.id, metrics.ltv, metrics.orders);
  }
  // Rebuild so aggregates include seeded metrics.
  materialize(db, { rule: ruleRow ?? rule, origin: 'seed', actor: 'seed' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.DB_PATH ?? join(here, '..', 'data', 'workbench.db');
  const db = openDb(dbPath);
  const seeded = seedIfEmpty(db);
  console.log(
    seeded
      ? `seeded ${SEED_ROWS.length} records into ${dbPath}`
      : `${dbPath} already contains customers; nothing to do`,
  );
}
