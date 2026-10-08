'use strict';
/**
 * Lineage → registry join (the attribution layer).
 *
 * Given a Phase 2 lineage result, look up each unique dependency slot in a
 * registry and report an explicit per-dependency status. Pure logic; the registry
 * is injected as `lookup(slotKeyString) -> record | null`, so this works against
 * the in-memory twin, the on-chain contract reader, or any future store.
 *
 * Dependency statuses (explicit vocabulary — never imply licensing):
 *   registered   — active record, live hash matches record hash
 *   unregistered — no record for this slot
 *   inactive     — record exists but was deactivated
 *   mismatch     — record exists but live netlistHash differs (do NOT trust record)
 *   unknown      — dependency unreadable live (missing/truncated node): cannot verify
 *
 * Duplicates appear ONCE (unique slots, direct-first order). The root itself is
 * reported separately (rootRegistration) and never counted as its own dependency.
 */
const { parseSlotKey } = require('../lineage/identity');

function normHash(h) {
  return typeof h === 'string' ? h.toLowerCase() : null;
}

/**
 * Compare one live observation against one registry record (or null).
 * Pure; also used by scripts/phase3/inspect-registration.mjs.
 */
function compareRegistration({ chainId, processor, circuitId, liveNetlistHash }, record) {
  void chainId; void processor; void circuitId; // identity match is established by key lookup
  if (!record) return { registered: false, status: 'unregistered' };
  if (!record.active) {
    return {
      registered: false, status: 'inactive',
      payee: record.payee, priceWei: record.priceWei, termsHash: record.termsHash,
      recordNetlistHash: record.netlistHash,
    };
  }
  const live = normHash(liveNetlistHash);
  const rec = normHash(record.netlistHash);
  if (!live) {
    return {
      registered: true, status: 'registered', hashVerified: false,
      payee: record.payee, priceWei: record.priceWei, termsHash: record.termsHash,
      recordNetlistHash: record.netlistHash,
    };
  }
  if (live !== rec) {
    return {
      registered: false, status: 'mismatch',
      payee: record.payee, priceWei: record.priceWei, termsHash: record.termsHash,
      recordNetlistHash: record.netlistHash, liveNetlistHash: live,
    };
  }
  return {
    registered: true, status: 'registered', hashVerified: true,
    payee: record.payee, priceWei: record.priceWei, termsHash: record.termsHash,
    recordNetlistHash: record.netlistHash, liveNetlistHash: live,
  };
}

/**
 * attributeLineage(lineageResult, { lookup }) →
 * { root, rootRegistration, dependencies: [...], stats }
 */
async function attributeLineage(lineage, { lookup }) {
  if (!lineage || !Array.isArray(lineage.nodes) || !Array.isArray(lineage.edges)) {
    throw new Error('attribution: lineage result with nodes[]/edges[] required');
  }
  if (typeof lookup !== 'function') throw new Error('attribution: lookup(slotKey) is required');
  const byKey = new Map(lineage.nodes.map((n) => [n.key, n]));

  // Unique dependency slots: direct (netlist order) first, then transitive.
  const ordered = [];
  const seen = new Set([lineage.root]);
  for (const pass of [lineage.directDependencies || [], lineage.transitiveDependencies || []]) {
    for (const k of pass) {
      if (!seen.has(k)) {
        seen.add(k);
        ordered.push(k);
      }
    }
  }
  // Any node not covered by the two lists (shouldn't happen) still gets reported.
  for (const n of lineage.nodes) {
    if (!seen.has(n.key)) {
      seen.add(n.key);
      ordered.push(n.key);
    }
  }

  const dependencies = [];
  for (const slot of ordered) {
    const node = byKey.get(slot);
    const parts = parseSlotKey(slot);
    if (!node || node.status === 'missing' || node.status === 'truncated' || !node.netlistHash) {
      dependencies.push({
        slotKey: slot,
        chainId: parts.chainId,
        processor: parts.processor,
        circuitId: parts.circuitId,
        registered: false,
        status: 'unknown',
        reason: !node ? 'node absent from lineage' : `node ${node.status}${node.error ? `: ${node.error}` : ''}`,
        liveNetlistHash: (node && node.netlistHash) || null,
      });
      continue;
    }
    const record = await lookup(slot);
    dependencies.push({
      slotKey: slot,
      chainId: parts.chainId,
      processor: parts.processor,
      circuitId: parts.circuitId,
      liveNetlistHash: node.netlistHash,
      ...compareRegistration(
        { chainId: parts.chainId, processor: parts.processor, circuitId: parts.circuitId, liveNetlistHash: node.netlistHash },
        record,
      ),
    });
  }

  // Root's own registration (informational; root is never its own dependency).
  const rootNode = byKey.get(lineage.root);
  const rootRegistration = rootNode && rootNode.netlistHash
    ? compareRegistration(
      { chainId: rootNode.chainId, processor: rootNode.processor, circuitId: rootNode.circuitId, liveNetlistHash: rootNode.netlistHash },
      await lookup(lineage.root),
    )
    : { registered: false, status: 'unknown', reason: 'root unreadable' };

  const byStatus = {};
  for (const d of dependencies) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  return {
    root: lineage.root,
    rootRegistration,
    dependencies,
    stats: { total: dependencies.length, byStatus },
  };
}

module.exports = { attributeLineage, compareRegistration };
