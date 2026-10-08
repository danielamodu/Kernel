'use strict';
/**
 * Deterministic license-terms representation (offline, no chain).
 *
 * Schema v1 (exact — same terms object → same hash, always):
 *   { version: 1, model, priceWei, currency, attributionRequired, note? }
 *   model ∈ {'single-license','gratis','custom'}
 *   priceWei: canonical uint decimal string ('0' allowed = gratis pricing)
 *   currency: 1–16 chars, explicit denomination (e.g. 'OKB' = X Layer native wei)
 *   attributionRequired: boolean
 *   note: optional string ≤ 280 chars (short human pointer, NOT legal text)
 * No other top-level keys allowed (strict: unknown keys reject).
 *
 * WHAT IS HASHED: keccak256(utf8(canonical JSON)) where canonical JSON is
 * recursively key-sorted, separators (',',':') with no whitespace. The resulting
 * bytes32 is the on-chain termsHash. Human-readable terms stay OFF-CHAIN.
 */
const { ethers } = require('ethers');

const VERSION = 1;
const MODELS = ['single-license', 'gratis', 'custom'];
const MAX_NOTE = 280;

function fail(why) {
  throw new Error(`terms: ${why}`);
}

function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Validate + normalize to canonical form. Throws on anything invalid. */
function canonicalizeTerms(t) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) fail('terms must be an object');
  const keys = Object.keys(t);
  const allowed = ['version', 'model', 'priceWei', 'currency', 'attributionRequired', 'note'];
  for (const k of keys) if (!allowed.includes(k)) fail(`unknown field: ${k}`);
  for (const k of ['version', 'model', 'priceWei', 'currency', 'attributionRequired']) {
    if (!(k in t)) fail(`missing field: ${k}`);
  }
  if (t.version !== VERSION) fail(`unsupported version (want ${VERSION}): ${t.version}`);
  if (!MODELS.includes(t.model)) fail(`unknown model: ${t.model} (want one of ${MODELS.join(',')})`);
  let price;
  if (typeof t.priceWei !== 'string') fail('priceWei must be a decimal string (JS numbers lose precision)');
  try {
    price = BigInt(t.priceWei);
  } catch {
    fail(`priceWei not a uint: ${t.priceWei}`);
  }
  if (price < 0n) fail('priceWei negative');
  if (price.toString(10) !== String(t.priceWei)) fail(`priceWei not canonical (no leading +/zeros): ${t.priceWei}`);
  if (typeof t.currency !== 'string' || t.currency.length < 1 || t.currency.length > 16) {
    fail('currency must be 1–16 chars (explicit denomination, e.g. OKB)');
  }
  if (typeof t.attributionRequired !== 'boolean') fail('attributionRequired must be boolean');
  const out = {
    version: 1,
    model: t.model,
    priceWei: price.toString(10),
    currency: t.currency,
    attributionRequired: t.attributionRequired,
  };
  if ('note' in t && t.note !== undefined) {
    if (typeof t.note !== 'string' || t.note.length > MAX_NOTE) fail(`note must be a string ≤ ${MAX_NOTE} chars`);
    out.note = t.note;
  }
  return Object.freeze(out);
}

/** { ok, value?, reason? } wrapper — never throws on bad input. */
function validateTerms(t) {
  try {
    return { ok: true, value: canonicalizeTerms(t) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Canonical JSON string (exactly what is hashed). */
function canonicalJson(t) {
  return sortedJson(canonicalizeTerms(t));
}

/** termsHash = keccak256(utf8(canonicalJson)). Returns 0x bytes32 hex. */
function hashTerms(t) {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(t)));
}

module.exports = { VERSION, MODELS, canonicalizeTerms, validateTerms, canonicalJson, hashTerms };
