'use strict';
/**
 * Deterministic verification pipeline: `verifyComposition()` runs up to 10
 * structured checks and returns { verified, checks[] } — never just a boolean.
 * "Kernel Verified" means every applicable check passed. Inapplicable checks are
 * marked skipped:true (not failed). Nothing here consults subjective trust:
 * every check re-derives from bytes or live reads.
 *
 * Checks:
 *  IDENTITY_RESOLVES, CIRCUIT_EXISTS, NETLIST_READABLE, NETLIST_MATCH,
 *  REGISTRATION_PRESENT, REGISTRATION_IDENTITY_MATCH, TERMS_MATCH,
 *  DEPENDENCIES_RESOLVED, LINEAGE_REPRODUCIBLE, MANIFEST_CONSISTENT
 */
const { slotKey, parseSlotKey } = require('../lineage/identity');
const { resolveDependencies } = require('./deps');
const { validateManifest } = require('./manifest');

function check(code, passed, detail, skipped = false) {
  return { code, passed: skipped ? true : !!passed, skipped: !!skipped, ...(detail ? { detail } : {}) };
}

async function verifyComposition(opts = {}) {
  const {
    root, // {chainId, processor, circuitId} (slot parts; netlist fetched live)
    fetchCircuit, lookupRegistry, packageStore = null,
    expectedNetlistHash = null, // application lock (e.g. from a manifest)
    expectedTermsHash = null, // application lock for the ROOT registration
    requireRegistration = false, // root must hold an active record
    manifest = null,
    chainId = 196, maxDepth = 8,
  } = opts;
  if (typeof fetchCircuit !== 'function') throw new Error('verify: fetchCircuit is required');
  if (typeof lookupRegistry !== 'function') throw new Error('verify: lookupRegistry is required');
  const checks = [];

  // 1. Identity resolves to a well-formed slot.
  let slot = null;
  try {
    slot = slotKey({ chainId, ...(root || {}) });
    checks.push(check('IDENTITY_RESOLVES', true, slot));
  } catch (e) {
    checks.push(check('IDENTITY_RESOLVES', false, e.message));
    return { verified: false, checks };
  }
  const parts = parseSlotKey(slot);

  // 2-3. Circuit exists; netlist readable.
  let live = null;
  let fetchError = null;
  try {
    live = await fetchCircuit({ chainId: String(chainId), processor: parts.processor, circuitId: parts.circuitId });
  } catch (e) {
    fetchError = e?.message || String(e);
  }
  checks.push(check('CIRCUIT_EXISTS', !!live, fetchError || `slot ${slot}`));
  const readable = !!(live && typeof live.netlist === 'string' && Number.isInteger(live.nIn));
  checks.push(check('NETLIST_READABLE', readable, readable ? `${(live.netlist.length - 2) / 2}B, nIn=${live.nIn}` : (fetchError || 'unreadable')));

  // 4. Expected content hash matches (skipped when no lock provided).
  if (expectedNetlistHash === null || expectedNetlistHash === undefined) {
    checks.push(check('NETLIST_MATCH', true, 'no expected hash provided', true));
  } else {
    const got = (live && live.netlistHash ? live.netlistHash : '').toLowerCase() || null;
    checks.push(check('NETLIST_MATCH', !!got && got === String(expectedNetlistHash).toLowerCase(),
      got ? `live ${got}` : 'no live hash'));
  }

  // 5-7. Registration presence / binding / terms (root).
  // Note: lookup is keyed by slotKey string; keyHash derivation lives in the
  // registry client. Absence is explicit, never an exception.
  let record = null;
  try {
    record = await lookupRegistry(slot);
  } catch (e) {
    record = { __lookupError: e?.message || String(e) };
  }
  if (record && !record.__lookupError) {
    const active = record.active === true;
    checks.push(check('REGISTRATION_PRESENT', requireRegistration ? active : true,
      requireRegistration ? (active ? 'active record' : 'absent or inactive') : 'not required (reported only)',
      !requireRegistration && !active ? true : false));
    checks.push(check('REGISTRATION_IDENTITY_MATCH',
      !!record.netlistHash && !!record.payee && !/^0x0{40}$/.test(record.payee || ''),
      'record carries nonzero hash + payee'));
    if (expectedTermsHash === null || expectedTermsHash === undefined) {
      checks.push(check('TERMS_MATCH', true, 'no expected terms provided', true));
    } else {
      checks.push(check('TERMS_MATCH',
        (record.termsHash || '').toLowerCase() === String(expectedTermsHash).toLowerCase()));
    }
  } else {
    checks.push(check('REGISTRATION_PRESENT', !requireRegistration,
      record ? `lookup failed: ${record.__lookupError}` : 'no record',
      !requireRegistration));
    checks.push(check('REGISTRATION_IDENTITY_MATCH', !requireRegistration, 'no record', !requireRegistration));
    checks.push(check('TERMS_MATCH', expectedTermsHash === null || expectedTermsHash === undefined,
      expectedTermsHash === null ? 'no expected terms provided' : 'no record to compare', expectedTermsHash === null));
  }

  // 8-9. Dependencies resolve; lineage reproduces deterministically.
  let deps = null;
  try {
    deps = await resolveDependencies(
      { processor: parts.processor, circuitId: parts.circuitId },
      { fetchCircuit, lookupRegistry, packageStore, chainId, maxDepth },
    );
    const missing = deps.missing.length;
    const truncated = deps.truncated.length;
    checks.push(check('DEPENDENCIES_RESOLVED', missing === 0 && truncated === 0,
      `${deps.dependencies.length} dep(s), missing=${missing}, truncated=${truncated}, cycles=${deps.cycles.length}`));
    const again = await resolveDependencies(
      { processor: parts.processor, circuitId: parts.circuitId },
      { fetchCircuit, lookupRegistry, packageStore, chainId, maxDepth },
    );
    const same = JSON.stringify({ d: deps.dependencies.map((x) => x.slotKey), e: deps.edges })
      === JSON.stringify({ d: again.dependencies.map((x) => x.slotKey), e: again.edges });
    checks.push(check('LINEAGE_REPRODUCIBLE', same, same ? 'two resolutions identical' : 'NONDETERMINISM DETECTED'));
  } catch (e) {
    checks.push(check('DEPENDENCIES_RESOLVED', false, e.message));
    checks.push(check('LINEAGE_REPRODUCIBLE', false, 'resolution failed'));
  }

  // 10. Manifest consistency (skipped when no manifest supplied).
  if (manifest === null || manifest === undefined) {
    checks.push(check('MANIFEST_CONSISTENT', true, 'no manifest provided', true));
  } else {
    const v = validateManifest(manifest);
    if (!v.ok) {
      checks.push(check('MANIFEST_CONSISTENT', false, v.reason));
    } else {
      const m = v.value;
      const rootOk = m.root === slot;
      const hashOk = !live || !live.netlistHash || m.netlistHash.toLowerCase() === live.netlistHash.toLowerCase();
      const depIds = new Set((deps ? deps.dependencies : []).map((d) => d.slotKey));
      const manifestIds = new Set(m.dependencies.map((d) => d.identity));
      const sameSet = depIds.size === manifestIds.size && [...depIds].every((k) => manifestIds.has(k));
      checks.push(check('MANIFEST_CONSISTENT', rootOk && hashOk && sameSet,
        `root:${rootOk} hash:${hashOk} deps:${sameSet}`));
    }
  }

  const failed = checks.filter((c) => !c.passed);
  return { verified: failed.length === 0, checks, failed: failed.map((c) => c.code) };
}

module.exports = { verifyComposition };
