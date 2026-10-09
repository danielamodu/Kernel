'use strict';
/**
 * Application package store: curated packages/*.json files mapping
 * name + semver → immutable computational identity.
 *
 * No chain access here (pure file data + validation). Resolution results:
 *   resolvePackageVersion → {status:'ok', package} | {status:'unknown-package'|'unknown-version', ...}
 *   resolvePackage        → {status:'ok', package} | {status:'unknown', ...}
 * Duplicate versions in a file fail CLOSED at load time.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildPackage } = require('./package');
const { isValidVersion, maxVersion } = require('./versions');
const { slotKey } = require('../lineage/identity');

function fail(why) {
  throw new Error(`store: ${why}`);
}

function loadFile(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail(`unreadable package file: ${filePath}`);
  }
  if (!raw || typeof raw !== 'object') fail(`bad package file: ${filePath}`);
  if (typeof raw.name !== 'string' || !raw.name) fail(`package file missing name: ${filePath}`);
  if (!Array.isArray(raw.versions) || raw.versions.length === 0) {
    fail(`package ${raw.name}: versions[] must be non-empty`);
  }
  const seen = new Set();
  const versions = raw.versions.map((v, i) => {
    if (!v || typeof v !== 'object') fail(`package ${raw.name}[${i}]: bad entry`);
    if (!isValidVersion(v.version)) fail(`package ${raw.name}[${i}]: bad version ${v.version}`);
    if (seen.has(v.version)) fail(`package ${raw.name}: duplicate version ${v.version}`);
    seen.add(v.version);
    return buildPackage({
      schema: 'kernel-package-v1',
      name: raw.name,
      version: v.version,
      identity: { chainId: v.chainId, processor: v.processor, circuitId: v.circuitId },
      ...(raw.description ? { description: raw.description } : {}),
      ...(raw.displayName ? { displayName: raw.displayName } : {}),
    });
  });
  return { name: raw.name, file: filePath, versions };
}

function loadStore(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    fail(`package dir unreadable: ${dir}`);
  }
  const packages = new Map();
  for (const f of files) {
    const p = loadFile(path.join(dir, f));
    if (packages.has(p.name)) fail(`duplicate package name across files: ${p.name}`);
    packages.set(p.name, p);
  }
  return {
    dir,
    names: () => [...packages.keys()],
    get: (name) => packages.get(name) || null,
  };
}

function resolvePackageVersion(store, name, version) {
  const p = store.get(name);
  if (!p) return { status: 'unknown-package', name };
  if (version === 'latest') {
    const v = maxVersion(p.versions.map((x) => x.version));
    const found = p.versions.find((x) => x.version === v);
    return { status: 'ok', package: found };
  }
  if (!isValidVersion(version)) return { status: 'unknown-version', name, version, reason: 'not valid semver' };
  const found = p.versions.find((x) => x.version === version);
  if (!found) {
    return {
      status: 'unknown-version', name, version,
      available: p.versions.map((x) => x.version),
    };
  }
  return { status: 'ok', package: found };
}

/** Reverse lookup: which package claims this exact immutable identity? */
function resolvePackage(store, identity) {
  let slot;
  try {
    slot = slotKey(identity);
  } catch {
    return { status: 'unknown', reason: 'bad identity' };
  }
  for (const name of store.names()) {
    for (const v of store.get(name).versions) {
      if (slotKey(v.identity) === slot) return { status: 'ok', package: v };
    }
  }
  return { status: 'unknown', slot };
}

module.exports = { loadStore, resolvePackageVersion, resolvePackage };
