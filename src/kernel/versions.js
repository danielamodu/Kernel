'use strict';
/**
 * Application-level semantic versions for Kernel packages.
 * Pure, dependency-free. Covers: strict validation (X.Y.Z numeric, optional
 * prerelease), precedence comparison, exact + latest resolution.
 * Deliberately NO range language (^, ~, *) — exact pins and `latest` are all
 * the resolver needs; ranges would imply negotiability that immutable circuits
 * do not have.
 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(SEMVER_RE);
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    prerelease: m[4] === undefined ? null : m[4], raw: v,
  };
}

function isValidVersion(v) {
  return parseSemver(v) !== null;
}

/**
 * Compare precedence: -1 | 0 | 1. Numeric core first; prerelease lowers
 * precedence (no-prerelease > prerelease); prerelease identifiers compare
 * numerically when both numeric, lexically otherwise (SemVer §11 ordering).
 */
function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`versions: invalid semver: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === null) return 1;
  if (y.prerelease === null) return -1;
  const xi = x.prerelease.split('.');
  const yi = y.prerelease.split('.');
  for (let i = 0; i < Math.max(xi.length, yi.length); i++) {
    if (xi[i] === undefined) return -1;
    if (yi[i] === undefined) return 1;
    if (xi[i] === yi[i]) continue;
    const xn = /^\d+$/.test(xi[i]);
    const yn = /^\d+$/.test(yi[i]);
    if (xn && yn) return Number(xi[i]) < Number(yi[i]) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return xi[i] < yi[i] ? -1 : 1;
  }
  return 0;
}

function sortVersions(list) {
  return [...list].sort(compareSemver);
}

function maxVersion(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return sortVersions(list).at(-1);
}

module.exports = { parseSemver, isValidVersion, compareSemver, sortVersions, maxVersion };
