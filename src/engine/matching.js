// Normalization + candidate generation for customer entity resolution.
// Pure functions only: no DB access, so they are easy to unit test exhaustively.

const NICKNAMES = new Map([
  ['william', ['bill', 'will', 'billy', 'liam']],
  ['robert', ['bob', 'rob', 'bobby', 'robbie']],
  ['richard', ['rick', 'rich', 'dick', 'ricky']],
  ['james', ['jim', 'jimmy', 'jamie']],
  ['john', ['jack', 'johnny', 'jon']],
  ['joseph', ['joe', 'joey']],
  ['margaret', ['maggie', 'meg', 'peggy']],
  ['elizabeth', ['liz', 'beth', 'betty', 'eliza']],
  ['katherine', ['kate', 'kathy', 'katie', 'catherine']],
  ['catherine', ['kate', 'kathy', 'katie', 'katherine']],
  ['michael', ['mike', 'mikey']],
  ['christopher', ['chris', 'topher']],
  ['daniel', ['dan', 'danny']],
  ['edward', ['ed', 'eddie', 'ted']],
  ['anthony', ['tony']],
  ['patricia', ['pat', 'patty', 'tricia']],
  ['jennifer', ['jen', 'jenny']],
  ['susan', ['sue', 'susie']],
  ['deborah', ['deb', 'debbie']],
  ['steven', ['steve', 'stevie']],
  ['stephen', ['steve', 'stevie']],
  ['thomas', ['tom', 'tommy']],
  ['charles', ['charlie', 'chuck']],
  ['mohammed', ['muhammad', 'mohamed', 'mohammad']],
  ['muhammad', ['mohammed', 'mohamed', 'mohammad']],
]);

// Build reverse nickname lookup: alias -> canonical.
const ALIAS_TO_CANON = new Map();
for (const [canonical, aliases] of NICKNAMES) {
  for (const a of aliases) ALIAS_TO_CANON.set(a, canonical);
}
// Canonical names are also their own canonical.
for (const canonical of NICKNAMES.keys()) ALIAS_TO_CANON.set(canonical, canonical);

export function foldText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function stripPunctuation(value) {
  return value.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function canonicalTokens(name) {
  const tokens = stripPunctuation(foldText(name)).split(' ').filter(Boolean);
  return tokens.map((t) => ALIAS_TO_CANON.get(t) ?? t);
}

export function normalizeName(name) {
  return canonicalTokens(name).join(' ');
}

export function normalizeEmail(email) {
  if (!email) return '';
  const e = foldText(email).trim();
  // Strip plus-addressing and dots in local part for gmail-like providers.
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1).trim();
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (['gmail.com', 'googlemail.com'].includes(domain)) {
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

export function normalizePhone(phone, defaultCountry = null) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  // Very small E.164-ish normalizer, sufficient for the demo.
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0') && defaultCountry) {
    const cc = COUNTRY_DIAL.get(defaultCountry.toUpperCase());
    if (cc) return `+${cc}${digits.replace(/^0+/, '')}`;
  }
  if (digits.length === 10 && defaultCountry) {
    const cc = COUNTRY_DIAL.get(defaultCountry.toUpperCase());
    if (cc) return `+${cc}${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

const COUNTRY_DIAL = new Map([
  ['US', '1'], ['CA', '1'], ['GB', '44'], ['UK', '44'], ['DE', '49'],
  ['FR', '33'], ['NL', '31'], ['ES', '34'], ['IT', '39'], ['SE', '46'],
  ['AU', '61'], ['IN', '91'], ['BR', '55'], ['JP', '81'], ['SG', '65'],
]);

export function normalizeVat(vat) {
  if (!vat) return '';
  return String(vat).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizePostal(postal) {
  if (!postal) return '';
  return String(postal).toUpperCase().replace(/\s+/g, '');
}

export function normalizeDob(dob) {
  if (!dob) return '';
  const s = String(dob).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

// ---- Deterministic keys -------------------------------------------------
// Key definitions are data (stored on the rule version), so changing them is
// itself an auditable rule change rather than a code deploy.

export const DEFAULT_DETERMINISTIC_KEYS = [
  { name: 'email', fields: ['email'], weight: 1.0 },
  { name: 'phone', fields: ['phone'], weight: 0.95 },
  { name: 'vat', fields: ['vat_id'], weight: 1.0 },
  { name: 'name-dob', fields: ['name', 'dob'], weight: 0.8 },
  { name: 'name-postal', fields: ['name', 'postal_code'], weight: 0.7 },
];

export function deterministicKeyValues(customer, keyDefs = DEFAULT_DETERMINISTIC_KEYS) {
  const out = [];
  for (const def of keyDefs) {
    const parts = def.fields.map((f) => keyFieldValue(customer, f));
    if (parts.every((p) => p && p.length > 0)) {
      out.push({ name: def.name, value: parts.join('|'), weight: def.weight, fields: def.fields });
    }
  }
  return out;
}

export function keyFieldValue(customer, field) {
  switch (field) {
    case 'email': return normalizeEmail(customer.email);
    case 'phone': return normalizePhone(customer.phone, customer.country);
    case 'vat_id': return normalizeVat(customer.vat_id);
    case 'name': {
      const n = normalizeName(customer.name);
      return n ? n : '';
    }
    case 'dob': return normalizeDob(customer.dob);
    case 'postal_code': return normalizePostal(customer.postal_code);
    default: return '';
  }
}

// ---- Fuzzy similarity ---------------------------------------------------

export function jarosWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  const window = Math.max(0, Math.floor(Math.max(m, n) / 2) - 1);
  const aMatch = new Array(m).fill(false);
  const bMatch = new Array(n).fill(false);
  let matches = 0;
  for (let i = 0; i < m; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, n);
    for (let j = lo; j < hi; j++) {
      if (!bMatch[j] && a[i] === b[j]) {
        aMatch[i] = bMatch[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < m; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  const jaro = (matches / m + matches / n + (matches - t) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, m, n); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function tokenSetSimilarity(a, b) {
  const sa = new Set(stripPunctuation(foldText(a)).split(' ').filter(Boolean));
  const sb = new Set(stripPunctuation(foldText(b)).split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / new Set([...sa, ...sb]).size;
}

export function addressSimilarity(a, b) {
  const token = tokenSetSimilarity(a ?? '', b ?? '');
  const chars = jarosWinkler(foldText(a ?? ''), foldText(b ?? ''));
  return Math.max(token, chars * 0.85);
}

export const DEFAULT_FUZZY_WEIGHTS = {
  name: 0.45,
  address: 0.2,
  dob: 0.15,
  postal: 0.1,
  country: 0.1,
};

export const DEFAULT_THRESHOLDS = {
  autoLink: 0.9,     // >= auto-link without review
  review: 0.62,      // >= human review queue
  keyMatchMin: 0.95, // deterministic exact key -> treated as strong evidence
};

const PARTICLES = new Set([
  'von', 'van', 'de', 'der', 'den', 'da', 'di', 'del', 'della', 'la', 'le',
  'bin', 'al', 'el', 'dos', 'das', 'du', 'st', 'saint',
]);

function nameParts(name) {
  const tokens = stripPunctuation(foldText(name)).split(' ').filter((t) => t && !PARTICLES.has(t));
  if (tokens.length === 0) return { given: [], surname: '' };
  if (tokens.length === 1) return { given: [], surname: tokens[0] };
  return {
    given: tokens.slice(0, -1).map((t) => ALIAS_TO_CANON.get(t) ?? t),
    surname: tokens[tokens.length - 1],
  };
}

function tokenMatch(a, b) {
  if (a === b) return 1;
  // Initials: "w" matches "william" but is weaker evidence than a full name.
  if (a.length === 1 && b.startsWith(a)) return 0.92;
  if (b.length === 1 && a.startsWith(b)) return 0.92;
  return jarosWinkler(a, b);
}

/**
 * Surname/given-name aware similarity. Exact surname + compatible given name
 * (including initials and nicknames) scores near 1; matching surname with an
 * unrelated given name is capped low, so households are not merged by address.
 */
export function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return { sim: 0, parts: null, reason: 'missing name' };
  if (na === nb) return { sim: 1, parts: { surname: 1, given: 1 }, reason: 'normalized names identical' };
  const pa = nameParts(a);
  const pb = nameParts(b);
  const surnameSim = Math.max(
    tokenMatch(pa.surname, pb.surname),
    jarosWinkler(pa.surname, pb.surname),
  );
  let givenSim = null;
  if (pa.given.length > 0 && pb.given.length > 0) {
    const [short, long] = pa.given.length <= pb.given.length ? [pa.given, pb.given] : [pb.given, pa.given];
    let total = 0;
    for (const t of short) {
      let best = 0;
      for (const u of long) best = Math.max(best, tokenMatch(t, u));
      total += best;
    }
    givenSim = total / short.length;
  }
  // Token order is not identity evidence: "Chen William" == "William Chen".
  const ta = stripPunctuation(foldText(a)).split(' ').filter(Boolean).sort().join(' ');
  const tb = stripPunctuation(foldText(b)).split(' ').filter(Boolean).sort().join(' ');
  if (ta === tb) return { sim: 0.95, parts: { surname: surnameSim, given: givenSim }, reason: 'same name tokens, different order' };

  let sim;
  if (givenSim == null) {
    // Surname-only record: rely on the surname but do not claim certainty.
    sim = surnameSim * 0.9;
  } else {
    sim = 0.6 * surnameSim + 0.4 * givenSim;
    // Same household name, unrelated given name: cap hard. This keeps shared
    // addresses from dragging relatives into the review queue.
    if (surnameSim >= 0.9 && givenSim < 0.5) sim = Math.min(sim, 0.5 + 0.1 * givenSim);
  }
  return {
    sim: Math.min(1, sim),
    parts: { surname: surnameSim, given: givenSim },
    reason: givenSim == null ? 'surname-only comparison' : 'surname + given names',
  };
}

export function computeMatch(left, right, weights = DEFAULT_FUZZY_WEIGHTS, thresholds = DEFAULT_THRESHOLDS) {
  const keys = sharedDeterministicKeys(left, right);
  const reasons = [];
  const conflicts = [];
  let score = 0;
  let weightUsed = 0;
  let hardConflict = false;

  const nameSimResult = nameSimilarity(left.name, right.name);
  const nameSim = nameSimResult.sim;
  if (left.name && right.name) {
    weightUsed += weights.name;
    score += weights.name * nameSim;
    if (nameSim >= 0.9) {
      reasons.push({ field: 'name', kind: 'fuzzy', detail: `name similarity ${nameSim.toFixed(3)}`, score: nameSim });
    }
    if (nameSim < 0.55) {
      conflicts.push({
        field: 'name',
        severity: 'hard',
        left: left.name,
        right: right.name,
        note: 'names differ materially (surname or given name)',
      });
      if (nameSimResult.parts && nameSimResult.parts.surname < 0.8) hardConflict = true;
    }
    if (normalizeName(left.name) !== normalizeName(right.name) && nameSim >= 0.9) {
      reasons.push({ field: 'name', kind: 'alias', detail: `"${left.name}" ~ "${right.name}" after canonicalization` });
    }
  }

  const addrSim = addressSimilarity(left.address_line, right.address_line);
  if (left.address_line && right.address_line) {
    weightUsed += weights.address;
    score += weights.address * addrSim;
    if (addrSim >= 0.85) {
      reasons.push({ field: 'address', kind: 'fuzzy', detail: `address similarity ${addrSim.toFixed(3)}`, score: addrSim });
    } else if (addrSim < 0.4) {
      conflicts.push({ field: 'address', severity: 'soft', left: left.address_line, right: right.address_line, note: 'different address' });
    }
  }

  const ld = normalizeDob(left.dob);
  const rd = normalizeDob(right.dob);
  if (ld && rd) {
    weightUsed += weights.dob;
    if (ld === rd) {
      score += weights.dob;
      reasons.push({ field: 'dob', kind: 'exact', detail: 'date of birth matches' });
    } else {
      // A mismatch is evidence of two people, not merely missing evidence.
      score -= 0.12;
      hardConflict = true;
      conflicts.push({
        field: 'dob',
        severity: 'hard',
        left: left.dob,
        right: right.dob,
        note: 'different date of birth',
      });
    }
  }

  const lp = normalizePostal(left.postal_code);
  const rp = normalizePostal(right.postal_code);
  if (lp && rp) {
    weightUsed += weights.postal;
    if (lp === rp) {
      score += weights.postal;
      reasons.push({ field: 'postal_code', kind: 'exact', detail: `postal code ${lp} matches` });
    } else {
      conflicts.push({ field: 'postal_code', severity: 'soft', left: left.postal_code, right: right.postal_code, note: 'different postal code' });
    }
  }

  const lc = foldText(left.country).trim();
  const rc = foldText(right.country).trim();
  if (lc && rc) {
    weightUsed += weights.country;
    if (lc === rc) score += weights.country;
    else conflicts.push({ field: 'country', severity: 'soft', left: left.country, right: right.country, note: 'different country' });
  }

  // Strong identifiers that are present on both sides but disagree. These are
  // soft signals (people keep several emails/phones) but they still lower
  // confidence and prevent a silent auto-link.
  const emailConflict = bothPresentDifferent(normalizeEmail(left.email), normalizeEmail(right.email));
  if (emailConflict) {
    score -= 0.04;
    conflicts.push({ field: 'email', severity: 'soft', left: left.email, right: right.email, note: 'different email addresses' });
  }
  const phoneConflict = bothPresentDifferent(
    normalizePhone(left.phone, left.country),
    normalizePhone(right.phone, right.country),
  );
  if (phoneConflict) {
    score -= 0.04;
    conflicts.push({ field: 'phone', severity: 'soft', left: left.phone, right: right.phone, note: 'different phone numbers' });
  }
  const vatConflict = bothPresentDifferent(normalizeVat(left.vat_id), normalizeVat(right.vat_id));
  if (vatConflict) {
    score -= 0.15;
    hardConflict = true;
    conflicts.push({ field: 'vat_id', severity: 'hard', left: left.vat_id, right: right.vat_id, note: 'different VAT ids' });
  }

  // Normalize by weight actually used so sparse records are not penalized twice.
  let fuzzyScore = weightUsed > 0 ? Math.max(0, score) / weightUsed : 0;

  // Deterministic keys dominate: an exact shared key floors the score, unless
  // a hard conflict says these cannot be the same entity.
  let keyBoost = 0;
  for (const k of keys) {
    keyBoost = Math.max(keyBoost, k.weight);
    reasons.push({
      field: k.fields.join('+'),
      kind: 'deterministic-key',
      detail: `${k.name} key "${k.value}" is identical`,
      key: k.name,
      weight: k.weight,
    });
  }
  if (keyBoost > 0 && !hardConflict) fuzzyScore = Math.max(fuzzyScore, keyBoost);
  if (hardConflict) fuzzyScore = Math.min(fuzzyScore, Math.max(0, thresholds.autoLink - 0.0001));

  let band = 'reject';
  if (fuzzyScore >= thresholds.autoLink) band = 'auto';
  else if (fuzzyScore >= thresholds.review) band = 'review';
  if (hardConflict && band === 'auto') band = 'review';
  // Shared address/postal alone must not put a clearly different person in the
  // review queue when there is no strong identifier in common.
  if (hardConflict && keys.length === 0 && nameSim < 0.55) band = 'reject';

  return {
    score: Number(fuzzyScore.toFixed(4)),
    band,
    reasons,
    conflicts,
    deterministicKeys: keys,
    hardConflict,
  };
}

function bothPresentDifferent(a, b) {
  return Boolean(a) && Boolean(b) && a !== b;
}

export function sharedDeterministicKeys(left, right, keyDefs = DEFAULT_DETERMINISTIC_KEYS) {
  const lk = deterministicKeyValues(left, keyDefs);
  const rk = deterministicKeyValues(right, keyDefs);
  const out = [];
  for (const l of lk) {
    for (const r of rk) {
      if (l.name === r.name && l.value === r.value) {
        out.push({ name: l.name, value: l.value, weight: l.weight, fields: l.fields });
      }
    }
  }
  // VAT ids are also compared directly so a mismatch is surfaced as a conflict.
  return out;
}

// Candidate blocking: a pair is only scored if it shares a blocking token.
// This keeps the workbench honest about what it did NOT compare.
export function blockingTokens(customer) {
  const tokens = new Set();
  const email = normalizeEmail(customer.email);
  if (email) tokens.add(`e:${email}`);
  const phone = normalizePhone(customer.phone, customer.country);
  if (phone) tokens.add(`p:${phone}`);
  const vat = normalizeVat(customer.vat_id);
  if (vat) tokens.add(`v:${vat}`);
  const name = normalizeName(customer.name);
  if (name) {
    for (const t of name.split(' ')) if (t.length >= 3) tokens.add(`n:${t}`);
    tokens.add(`pst:${normalizePostal(customer.postal_code)}|${name.split(' ')[0] ?? ''}`);
  }
  const postal = normalizePostal(customer.postal_code);
  if (postal) tokens.add(`pc:${postal}`);
  const dob = normalizeDob(customer.dob);
  if (dob) tokens.add(`d:${dob}`);
  return [...tokens];
}
