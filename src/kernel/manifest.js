'use strict';
/**
 * Deterministic computational manifest (application artifact, NOT a protocol standard).
 * Schema kernel-manifest-v1. Canonical form: recursively key-sorted JSON, dependency
 * list sorted by slotKey. manifestHash = sha256(canonical). Reproducible from the
 * same resolved state; rejects anything malformed.
 */
const { createHash } = require('node:crypto');
const { isValidVersion } = require('./versions');

const SCHEMA = 'kernel-manifest-v1';

function fail(why) {
  throw new Error(`manifest: ${why}`);
}

function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const SLOT_RE = /^tapeout:v1:[0-9]+:0x[0-9a-f]{40}:[0-9]+$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

function checkDep(d, i) {
  if (!d || typeof d !== 'object') fail(`dependencies[${i}]: must be an object`);
  if (typeof d.identity !== 'string' || !SLOT_RE.test(d.identity)) fail(`dependencies[${i}]: bad identity`);
  if (d.version !== null && d.version !== undefined && !isValidVersion(d.version)) {
    fail(`dependencies[${i}]: bad version ${d.version}`);
  }
  if (typeof d.netlistHash !== 'string' || !HASH_RE.test(d.netlistHash)) fail(`dependencies[${i}]: bad netlistHash`);
  const lic = d.license;
  if (!lic || typeof lic !== 'object') fail(`dependencies[${i}]: license required`);
  if (typeof lic.required !== 'boolean') fail(`dependencies[${i}]: license.required must be boolean`);
  if (lic.required) {
    if (typeof lic.termsHash !== 'string' || !HASH_RE.test(lic.termsHash)) fail(`dependencies[${i}]: bad termsHash`);
    if (typeof lic.priceWei !== 'string') fail(`dependencies[${i}]: bad priceWei`);
    try {
      if (BigInt(lic.priceWei) < 0n) fail(`dependencies[${i}]: negative priceWei`);
    } catch (e) {
      if (e.message.startsWith('dependencies')) throw e;
      fail(`dependencies[${i}]: bad priceWei`);
    }
    if (lic.payee !== undefined && lic.payee !== null && !ADDR_RE.test(lic.payee)) {
      fail(`dependencies[${i}]: bad payee`);
    }
  }
  const out = {
    identity: d.identity,
    version: d.version ?? null,
    netlistHash: d.netlistHash.toLowerCase(),
    license: {
      required: lic.required,
      termsHash: lic.required ? lic.termsHash.toLowerCase() : null,
      priceWei: lic.required ? BigInt(lic.priceWei).toString() : null,
      ...(lic.required && lic.payee ? { payee: lic.payee.toLowerCase() } : {}),
    },
  };
  return out;
}

function buildManifest(input) {
  if (!input || typeof input !== 'object') fail('manifest must be an object');
  const allowed = ['schema', 'name', 'version', 'root', 'dependencies', 'netlistHash', 'lineageHash'];
  for (const k of Object.keys(input)) if (!allowed.includes(k)) fail(`unknown field: ${k}`);
  if (input.schema !== SCHEMA) fail(`unsupported schema (want ${SCHEMA})`);
  if (typeof input.name !== 'string' || !input.name) fail('name required');
  if (!isValidVersion(input.version)) fail(`bad version: ${input.version}`);
  const root = input.root || {};
  if (typeof root !== 'string' || !SLOT_RE.test(root)) fail('root must be a slot key string');
  const rootSlot = root;
  if (typeof input.netlistHash !== 'string' || !HASH_RE.test(input.netlistHash)) fail('bad root netlistHash');
  if (typeof input.lineageHash !== 'string' || !HASH_RE.test(input.lineageHash)) fail('bad lineageHash');
  if (!Array.isArray(input.dependencies)) fail('dependencies must be an array');
  const deps = input.dependencies.map(checkDep).sort((a, b) => (a.identity < b.identity ? -1 : 1));
  return Object.freeze({
    schema: SCHEMA,
    name: input.name,
    version: input.version,
    root: rootSlot,
    dependencies: Object.freeze(deps),
    netlistHash: input.netlistHash.toLowerCase(),
    lineageHash: input.lineageHash.toLowerCase(),
  });
}

function validateManifest(input) {
  try {
    return { ok: true, value: buildManifest(input) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function parseManifest(json) {
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    fail('manifest JSON malformed');
  }
  return buildManifest(v);
}

function canonicalManifest(m) {
  return sortedJson(buildManifest(m));
}

function manifestHash(m) {
  return '0x' + createHash('sha256').update(canonicalManifest(m), 'utf8').digest('hex');
}

module.exports = { SCHEMA, buildManifest, validateManifest, parseManifest, canonicalManifest, manifestHash };
