'use strict';
/**
 * Canonical Kernel Package model (application artifact, NOT a protocol standard).
 *
 * A package binds human meaning to an immutable computational identity:
 *   { schema, name, version, identity{chainId,processor,circuitId},
 *     description?, license?, publisher? }
 *
 * Field provenance (NON-NEGOTIABLE classification — see FIELD_PROVENANCE):
 *   onchain      — authoritative chain state (identity slot; registry record at verify time)
 *   derived      — recomputed from on-chain bytes (hashes, graphs, verification)
 *   application  — curated metadata (name, version, description, license intent)
 *   presentation — display-only (labels, copy). NEVER trusted for decisions.
 *
 * Versioning rule: a version maps to EXACTLY ONE immutable identity. New
 * computation = new circuit = new version entry. Metadata never mutates a circuit.
 */
const { createHash } = require('node:crypto');
const { makeIdentity } = require('../lineage/identity');
const { isValidVersion } = require('./versions');

const SCHEMA = 'kernel-package-v1';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Every canonical field, tagged. Tests enforce total coverage.
const FIELD_PROVENANCE = Object.freeze({
  schema: 'application',
  name: 'application',
  version: 'application',
  'identity.chainId': 'onchain',
  'identity.processor': 'onchain',
  'identity.circuitId': 'onchain',
  description: 'application',
  'license.priceWei': 'application',
  'license.currency': 'application',
  'license.attributionRequired': 'application',
  'license.note': 'application',
  publisher: 'application',
  displayName: 'presentation',
});

function fail(why) {
  throw new Error(`package: ${why}`);
}

function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function checkLicense(lic) {
  if (lic === undefined || lic === null) return undefined;
  if (typeof lic !== 'object' || Array.isArray(lic)) fail('license must be an object');
  const allowed = ['priceWei', 'currency', 'attributionRequired', 'note'];
  for (const k of Object.keys(lic)) if (!allowed.includes(k)) fail(`license: unknown field ${k}`);
  let price;
  try {
    if (typeof lic.priceWei !== 'string') fail('license.priceWei must be a decimal string');
    price = BigInt(lic.priceWei);
  } catch (e) {
    if (String(e.message).startsWith('package:')) throw e;
    fail(`license.priceWei not a uint: ${lic.priceWei}`);
  }
  if (price < 0n) fail('license.priceWei negative');
  if (price.toString(10) !== lic.priceWei) fail('license.priceWei not canonical');
  if (typeof lic.currency !== 'string' || lic.currency.length < 1 || lic.currency.length > 16) {
    fail('license.currency must be 1-16 chars');
  }
  if (typeof lic.attributionRequired !== 'boolean') fail('license.attributionRequired must be boolean');
  const out = {
    priceWei: price.toString(10), currency: lic.currency, attributionRequired: lic.attributionRequired,
  };
  if (lic.note !== undefined) {
    if (typeof lic.note !== 'string' || lic.note.length > 280) fail('license.note must be ≤ 280 chars');
    out.note = lic.note;
  }
  return out;
}

/** Validate + normalize to canonical form (throws). Unknown top-level fields reject. */
function buildPackage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('package must be an object');
  const allowed = ['schema', 'name', 'version', 'identity', 'description', 'license', 'publisher', 'displayName'];
  for (const k of Object.keys(input)) if (!allowed.includes(k)) fail(`unknown field: ${k}`);
  if (input.schema !== SCHEMA) fail(`unsupported schema (want ${SCHEMA}): ${input.schema}`);
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) fail(`bad package name: ${input.name}`);
  if (!isValidVersion(input.version)) fail(`bad version: ${input.version}`);
  const id = makeIdentity(input.identity || {}); // reuses lineage identity (chain+processor+circuitId)
  const out = {
    schema: SCHEMA,
    name: input.name,
    version: input.version,
    identity: { chainId: id.chainId, processor: id.processor, circuitId: id.circuitId },
  };
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.length > 500) fail('description must be ≤ 500 chars');
    out.description = input.description;
  }
  const lic = checkLicense(input.license ?? undefined);
  if (lic !== undefined) out.license = lic;
  if (input.publisher !== undefined && input.publisher !== null) {
    if (typeof input.publisher !== 'string' || !/^0[xX][0-9a-fA-F]{40}$/.test(input.publisher)) {
      fail(`bad publisher address: ${input.publisher}`);
    }
    out.publisher = '0x' + input.publisher.slice(2).toLowerCase();
  }
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string' || input.displayName.length > 80) fail('displayName must be ≤ 80 chars');
    out.displayName = input.displayName;
  }
  return Object.freeze(out);
}

function validatePackage(input) {
  try {
    return { ok: true, value: buildPackage(input) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function parsePackage(json) {
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    fail('package JSON malformed');
  }
  return buildPackage(v);
}

/** Canonical serialization (field order fixed). */
function canonicalPackage(pkg) {
  return sortedJson(buildPackage(pkg));
}

/** sha256 over canonical bytes (application hash; on-chain artifacts use keccak). */
function packageHash(pkg) {
  return '0x' + createHash('sha256').update(canonicalPackage(pkg), 'utf8').digest('hex');
}

module.exports = { SCHEMA, FIELD_PROVENANCE, buildPackage, validatePackage, parsePackage, canonicalPackage, packageHash };
