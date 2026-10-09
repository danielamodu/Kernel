'use strict';
/**
 * Provenance aggregation: "what is inside this computation?" answered from
 * underlying circuit structure (resolver), enriched with registry attribution,
 * package claims, and the recomputed lineage commitment.
 *
 * getProvenance(rootRef, { fetchCircuit, lookupRegistry, packageStore,
 *   registryTerms?, chainId, maxDepth }) →
 * {
 *   root: { slotKey, chainId, processor, circuitId, nIn, nOut, netlistHash },
 *   direct: [...slots], transitive: [...slots], edges: [{from,to,refIndex}],
 *   dependencies: [{ slotKey, ..., package, packageStatus, registrationStatus, license }],
 *   lineageHash: <recomputed iff every dep verified, else null>,
 *   cycles, missing, truncated, stats
 * }
 * Deterministic. Missing/unreadable parts are explicit, never dropped.
 */
const { resolveDependencies } = require('./deps');
const { parseSlotKey } = require('../lineage/identity');
const { computeLineageHash } = require('../router/commitment');
const { keyHashFor } = require('../registry/client');

async function getProvenance(rootRef, opts = {}) {
  const {
    fetchCircuit, lookupRegistry, packageStore = null,
    chainId = 196, maxDepth = 8,
  } = opts;
  if (typeof fetchCircuit !== 'function') throw new Error('provenance: fetchCircuit is required');
  if (typeof lookupRegistry !== 'function') throw new Error('provenance: lookupRegistry is required');

  const dep = await resolveDependencies(rootRef, { fetchCircuit, lookupRegistry, packageStore, chainId, maxDepth });
  const rootSlot = dep.root;
  const parts = parseSlotKey(rootSlot);
  const rootFetch = await fetchCircuit({
    chainId: String(chainId), processor: parts.processor, circuitId: parts.circuitId,
  }).catch(() => null);

  // Lineage commitment recomputes ONLY when the root itself parsed AND every
  // dependency is verified; otherwise null with reasons on each dep.
  const rootOk = rootFetch && typeof rootFetch.netlist === 'string'
    && !dep.missing.some((m) => m.key === dep.root);
  const verifiable = dep.dependencies.filter((d) => d.registrationStatus === 'registered'
    && d.netlistHash && d.registration && d.registration.recordNetlistHash
    && d.registration.recordNetlistHash.toLowerCase() === d.netlistHash.toLowerCase());
  const allVerified = !!rootOk && verifiable.length === dep.dependencies.length;
  let lineageHash = null;
  if (allVerified) {
    lineageHash = computeLineageHash({
      targetCpu: parts.processor,
      nIn: rootFetch?.nIn ?? 0,
      nOut: rootFetch?.nOut ?? 0,
      netlist: rootFetch?.netlist ?? '0x',
      deps: dep.dependencies.map((d) => ({
        keyHash: keyHashFor({ chainId, processor: d.processor, circuitId: d.circuitId }),
        netlistHash: d.netlistHash,
        payee: d.registration.payee,
        priceWei: d.registration.priceWei,
        termsHash: d.registration.termsHash,
      })),    });
  }

  return {
    root: {
      slotKey: rootSlot,
      chainId: parts.chainId,
      processor: parts.processor,
      circuitId: parts.circuitId,
      nIn: rootFetch?.nIn ?? null,
      nOut: rootFetch?.nOut ?? null,
      netlistHash: rootFetch?.netlistHash ?? null,
    },
    direct: directOf(dep),
    transitive: transOf(dep),
    edges: edgesOf(dep),
    dependencies: dep.dependencies,
    lineageHash,
    lineageVerifiable: allVerified,
    cycles: dep.cycles,
    missing: dep.missing,
    truncated: dep.truncated,
    stats: dep.stats,
  };
}

// Direct = depth-1 unique slots in first-appearance order; transitive = the rest.
function directOf(dep) {
  const seen = new Set();
  const out = [];
  for (const d of dep.dependencies) {
    if (d.depth === 1 && !seen.has(d.slotKey)) {
      seen.add(d.slotKey);
      out.push(d.slotKey);
    }
  }
  return out;
}
function transOf(dep) {
  const direct = new Set(directOf(dep));
  const seen = new Set();
  const out = [];
  for (const d of dep.dependencies) {
    if (!direct.has(d.slotKey) && !seen.has(d.slotKey)) {
      seen.add(d.slotKey);
      out.push(d.slotKey);
    }
  }
  return out;
}
function edgesOf(dep) {
  return (dep.edges || []).map((e) => ({ from: e.from, to: e.to, refIndex: e.refIndex ?? null }));
}

module.exports = { getProvenance };
