'use strict';
/**
 * First-class dependency resolution: netlist-authoritative structural discovery
 * (Phase 2 resolver) + registry attribution (Phase 3 join) + package enrichment.
 *
 * resolveDependencies(rootRef, { fetchCircuit, lookupRegistry, packageStore, chainId, maxDepth })
 * Netlist bytes decide WHAT is depended on; the store says whether a package
 * claims it; the registry says whether it is attributed. Never the reverse.
 */
const { resolveLineage } = require('../lineage/resolver');
const { attributeLineage } = require('../registry/attribution');
const { parseSlotKey } = require('../lineage/identity');
const { resolvePackage } = require('./store');

async function resolveDependencies(rootRef, opts = {}) {
  const {
    fetchCircuit, lookupRegistry, packageStore = null,
    chainId = 196, maxDepth = 8,
  } = opts;
  if (typeof fetchCircuit !== 'function') throw new Error('deps: fetchCircuit is required');
  if (typeof lookupRegistry !== 'function') throw new Error('deps: lookupRegistry is required');

  const lineage = await resolveLineage(rootRef, { fetchCircuit, chainId, maxDepth });
  const attr = await attributeLineage(lineage, { lookup: lookupRegistry });
  const byKey = new Map(lineage.nodes.map((n) => [n.key, n]));
  const occurrences = {};
  for (const e of lineage.edges) occurrences[e.to] = (occurrences[e.to] || 0) + 1;

  const dependencies = attr.dependencies.map((d) => {
    const node = byKey.get(d.slotKey) || null;
    const parts = parseSlotKey(d.slotKey);
    let pkg = null;
    let packageStatus = 'unknown';
    if (packageStore) {
      const r = resolvePackage(packageStore, {
        chainId: parts.chainId, processor: parts.processor, circuitId: parts.circuitId,
      });
      if (r.status === 'ok') {
        pkg = r.package;
        packageStatus = 'known';
      }
    }
    return {
      slotKey: d.slotKey,
      chainId: parts.chainId,
      processor: parts.processor,
      circuitId: parts.circuitId,
      depth: node ? node.depth : null,
      occurrences: occurrences[d.slotKey] || 0,
      nIn: node ? node.nIn : null,
      nOut: node ? node.nOut : null,
      netlistHash: node ? node.netlistHash : (d.liveNetlistHash || null),
      nodeStatus: node ? node.status : 'absent',
      package: pkg,
      packageStatus,
      registrationStatus: d.status,
      registration: d.status === 'registered' || d.status === 'inactive' || d.status === 'mismatch'
        ? {
          payee: d.payee || null, priceWei: d.priceWei || null, termsHash: d.termsHash || null,
          recordNetlistHash: d.recordNetlistHash || null,
        }
        : null,
      reason: d.reason || node?.error || null,
    };
  });

  return {
    root: lineage.root,
    depth: lineage.depth,
    cycles: lineage.cycles,
    missing: lineage.missing,
    truncated: lineage.truncated,
    edges: lineage.edges.map((e) => ({ from: e.from, to: e.to, refIndex: e.refIndex ?? null, gateOffset: e.gateOffset ?? null })),
    dependencies,
    stats: {
      ...lineage.stats,
      knownPackages: dependencies.filter((d) => d.packageStatus === 'known').length,
    },
  };
}

module.exports = { resolveDependencies };
