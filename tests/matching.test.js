import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  normalizePhone,
  normalizeName,
  nameSimilarity,
  computeMatch,
  deterministicKeyValues,
  blockingTokens,
  DEFAULT_FUZZY_WEIGHTS,
  DEFAULT_THRESHOLDS,
} from '../src/engine/matching.js';

test('email normalization folds case, plus-addressing, and gmail dots', () => {
  assert.equal(normalizeEmail('  Bill.Chen+orders@GMAIL.com '), 'billchen@gmail.com');
  assert.equal(normalizeEmail('Bob+promo@Example.com'), 'bob@example.com');
  assert.equal(normalizeEmail(null), '');
});

test('phone normalization applies country dialing codes', () => {
  assert.equal(normalizePhone('(415) 555-0101', 'US'), '+14155550101');
  assert.equal(normalizePhone('0049 30 555 2200', 'DE'), '+49305552200');
  assert.equal(normalizePhone('030 555 2200', 'DE'), '+49305552200');
  assert.equal(normalizePhone('+44 20 7946 0102', 'GB'), '+442079460102');
});

test('nicknames canonicalize to a stable comparison form', () => {
  assert.equal(normalizeName('Bill Chen'), normalizeName('William Chen'));
  assert.equal(normalizeName('Bob Mueller'), normalizeName('Robert Mueller'));
  assert.equal(normalizeName('LIZ Taylor'), normalizeName('Elizabeth Taylor'));
});

test('name similarity treats initials and nicknames as compatible', () => {
  assert.ok(nameSimilarity('William Chen', 'W. Chen').sim >= 0.9);
  assert.ok(nameSimilarity('Elizabeth Taylor', 'E. Taylor').sim >= 0.9);
  assert.ok(nameSimilarity('Robert Müller', 'Bob Mueller').sim >= 0.9);
});

test('name similarity refuses household members with different given names', () => {
  const sim = nameSimilarity('Sofia Rossi', 'Marco Rossi');
  assert.ok(sim.sim < 0.6, `expected low similarity, got ${sim.sim}`);
});

test('deterministic keys only exist when all fields are present', () => {
  const keys = deterministicKeyValues({ name: 'Priya Raman', email: null, phone: null, dob: null });
  assert.deepEqual(keys.map((k) => k.name), []);
  const withEmail = deterministicKeyValues({ name: 'Priya Raman', email: 'P.Raman@example.com', country: 'IN' });
  assert.deepEqual(withEmail.map((k) => k.name), ['email']);
});

test('blocking tokens include normalized email, phone, name tokens, postal', () => {
  const tokens = blockingTokens({
    name: 'William Chen',
    email: 'Bill.Chen+x@gmail.com',
    phone: '415-555-0101',
    country: 'US',
    postal_code: '94105',
  });
  assert.ok(tokens.includes('e:billchen@gmail.com'));
  assert.ok(tokens.includes('p:+14155550101'));
  assert.ok(tokens.includes('n:william'));
  assert.ok(tokens.includes('pc:94105'));
});

test('an exact shared phone supports auto-linking despite different emails', () => {
  const left = { name: 'William Chen', email: 'william.chen@gmail.com', phone: '+1 415 555 0101', dob: '1985-03-14', address_line: '120 Market St', postal_code: '94105', country: 'US' };
  const right = { name: 'W. Chen', email: 'wchen@acme-corp.com', phone: '4155550101', dob: null, address_line: '120 Market Street', postal_code: '94105', country: 'US' };
  const m = computeMatch(left, right, DEFAULT_FUZZY_WEIGHTS, DEFAULT_THRESHOLDS);
  assert.equal(m.band, 'auto');
  assert.ok(m.deterministicKeys.some((k) => k.name === 'phone'));
  assert.ok(m.reasons.some((r) => r.kind === 'deterministic-key'));
  assert.ok(m.conflicts.some((c) => c.field === 'email' && c.severity === 'soft'));
});

test('conflicting DOB blocks auto-link even with an exact name and shared postal', () => {
  const left = { name: 'Michael Brown', email: 'michael.brown@example.com', phone: '+1 212 555 0144', dob: '1970-01-09', address_line: '5th Avenue 300', postal_code: '10001', country: 'US' };
  const right = { name: 'Michael Brown', email: 'mike.b@otherdomain.net', phone: '+1 212 555 0199', dob: '1994-09-30', address_line: '5th Avenue 300', postal_code: '10001', country: 'US' };
  const m = computeMatch(left, right, DEFAULT_FUZZY_WEIGHTS, DEFAULT_THRESHOLDS);
  assert.notEqual(m.band, 'auto');
  assert.equal(m.hardConflict, true);
  assert.ok(m.conflicts.some((c) => c.field === 'dob' && c.severity === 'hard'));
});

test('a shared address alone does not create review-queue noise for strangers', () => {
  const left = { name: 'Sofia Rossi', email: 'sofia.rossi@example.it', phone: null, dob: '1989-04-18', address_line: 'Via Roma 22', postal_code: '00184', country: 'IT' };
  const right = { name: 'Marco Rossi', email: 'marco.rossi@example.it', phone: null, dob: '1987-08-07', address_line: 'Via Roma 22', postal_code: '00184', country: 'IT' };
  const m = computeMatch(left, right, DEFAULT_FUZZY_WEIGHTS, DEFAULT_THRESHOLDS);
  assert.equal(m.band, 'reject');
});

test('conflicting VAT ids are a hard conflict', () => {
  const left = { name: 'Acme Widgets', email: null, phone: null, dob: null, address_line: null, postal_code: null, country: 'DE', vat_id: 'DE811234567' };
  const right = { name: 'Acme Widgets', email: null, phone: null, dob: null, address_line: null, postal_code: null, country: 'DE', vat_id: 'DE999999999' };
  const m = computeMatch(left, right, DEFAULT_FUZZY_WEIGHTS, DEFAULT_THRESHOLDS);
  assert.equal(m.hardConflict, true);
  assert.ok(m.conflicts.some((c) => c.field === 'vat_id' && c.severity === 'hard'));
});

test('thresholds change the band without changing the underlying score', () => {
  const left = { name: 'Elizabeth Taylor', email: 'a@example.com', phone: null, dob: '1990-06-21', address_line: '8 Carnaby Street', postal_code: 'W1F 9PP', country: 'GB' };
  const right = { name: 'E. Taylor', email: 'b@example.com', phone: null, dob: null, address_line: '8 Carnaby Street', postal_code: 'W1F 9PP', country: 'GB' };
  const strict = computeMatch(left, right, DEFAULT_FUZZY_WEIGHTS, { ...DEFAULT_THRESHOLDS, autoLink: 0.99, review: 0.9 });
  const loose = computeMatch(left, right, DEFAULT_FUZZY_WEIGHTS, { ...DEFAULT_THRESHOLDS, autoLink: 0.8, review: 0.5 });
  assert.equal(strict.score, loose.score);
  assert.equal(loose.band, 'auto');
  assert.notEqual(strict.band, 'auto');
});
