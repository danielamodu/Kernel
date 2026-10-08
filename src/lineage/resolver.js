'use strict';
/**
 * Recursive REF lineage resolver — pure logic, injected fetch.
 *
 * resolveLineage(rootRef, { fetchCircuit, chainId, maxDepth })
 *   rootRef: { processor, circuitId } (chainId from options)
 *   fetchCircuit: async ({ chainId, processor, circuitId }) →
 *     { netlist, nIn, nOut, netlistHash? } | null.
 *     null (or a throw) = missing/unreadable → recorded explicitly, never dropped.
 *   maxDepth: max edges root→node (root = depth 0). Default 8.
 *
 * Guarantees: terminates on cycles (reported with the path); duplicates yield one
 * node + one edge PER ref record; depth violations and missing deps are explicit;
 * output is deterministic (netlist order, FIFO queue) — resolve twice, deep-equal.
 */
const { parseNetlist } = require('./netlist');
const { makeIdentity, slotKey, identityKey } = require('./identity');

const DEFAULT_MAX_DEPTH = 8;

function slotOf(chainId, processor, circuitId) {
  return slotKey(makeIdentity({ chainId, processor, circuitId }));
}

async function resolveLineage(rootRef, opts = {}) {
  const chainId = String(opts.chainId ?? 196);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const fetchCircuit = opts.fetchCircuit;
  if (typeof fetchCircuit !== 'function') throw new Error('resolver: fetchCircuit is required');
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error(`resolver: bad maxDepth: ${maxDepth}`);
  if (!rootRef || !rootRef.processor || rootRef.circuitId === undefined) {
    throw new Error('resolver: rootRef needs { processor, circuitId }');
  }

  const rootSlot = slotOf(chainId, rootRef.processor, rootRef.circuitId);
  const nodes = new Map(); // slot -> node
  const edges = [];
  const cycles = [];
  const missing = [];
  const truncated = [];
  let maxReached = 0;

  const ensureNode = (slot, id, depth) => {
    if (!nodes.has(slot)) {
      nodes.set(slot, {
        key: slot, ...id, nIn: null, nOut: null, netlistHash: id.netlistHash ?? null,
        depth, status: 'pending', own: { nand: 0, latch: 0, ref: 0 }, error: null,
      });
    }
    return nodes.get(slot);
  };

  // Stack-based DFS in netlist order; `path` detects back-edges (cycles).
  const stack = [{ slot: rootSlot, id: makeIdentity({ chainId, ...rootRef }), depth: 0, path: [] }];

  while (stack.length) {
    const { slot, id, depth, path } = stack.pop();
    maxReached = Math.max(maxReached, depth);
    const node = ensureNode(slot, id, depth);

    if (path.includes(slot)) {
      // Back-edge: this traversal path closes a cycle. Record it; the shared
      // node keeps its own status (usually 'resolved') — cycles live in `cycles`.
      cycles.push([...path.slice(path.indexOf(slot)), slot]);
      continue;
    }
    if (node.status !== 'pending') {
      continue; // duplicate reference: node already classified; edge was added at push time
    }
    if (depth > maxDepth) {
      node.status = 'truncated';
      node.error = `depth ${depth} exceeds maxDepth ${maxDepth}`;
      truncated.push(slot);
      continue;
    }

    let data = null;
    let fetchError = null;
    try {
      data = await fetchCircuit({ chainId, processor: id.processor, circuitId: id.circuitId });
    } catch (e) {
      fetchError = e && e.message ? e.message : String(e);
    }
    if (!data || typeof data.netlist !== 'string') {
      node.status = 'missing';
      node.error = fetchError ?? 'fetch returned null (absent or unreadable)';
      missing.push({ key: slot, reason: node.error });
      continue;
    }

    let parsed;
    try {
      parsed = parseNetlist(data.netlist, data.nIn);
    } catch (e) {
      node.status = 'missing';
      node.error = `unparseable netlist: ${e.message}`;
      missing.push({ key: slot, reason: node.error });
      continue;
    }

    node.status = 'resolved';
    node.nIn = data.nIn;
    node.nOut = data.nOut;
    if (data.netlistHash) node.netlistHash = data.netlistHash;
    node.key = slot; // graph structure keys on slot; content hash rides along
    node.own = { nand: parsed.stats.nand, latch: parsed.stats.latch, ref: parsed.stats.ref };

    // Push children in REVERSE netlist order so pops resolve in netlist order.
    for (let i = parsed.refs.length - 1; i >= 0; i--) {
      const r = parsed.refs[i];
      const childId = makeIdentity({ chainId, processor: r.processor, circuitId: r.circuitId.toString() });
      const childSlot = slotKey(childId);
      edges.push({ from: slot, to: childSlot, refIndex: r.index, gateOffset: r.offset });
      ensureNode(childSlot, childId, depth + 1);
      stack.push({ slot: childSlot, id: childId, depth: depth + 1, path: [...path, slot] });
    }
  }

  const nodeList = [...nodes.values()].map((n) => ({
    key: n.key,
    chainId: n.chainId,
    processor: n.processor,
    circuitId: n.circuitId,
    netlistHash: n.netlistHash,
    depth: n.depth,
    status: n.status,
    nIn: n.nIn,
    nOut: n.nOut,
    own: n.own,
    ...(n.error ? { error: n.error } : {}),
  }));

  const direct = [...new Set(edges.filter((e) => e.from === rootSlot).map((e) => e.to))];
  const seen = new Set([rootSlot, ...direct]);
  const transitive = [];
  for (const e of edges) {
    if (!seen.has(e.to)) {
      seen.add(e.to);
      transitive.push(e.to);
    }
  }

  const resolved = nodeList.filter((n) => n.status === 'resolved');
  return {
    root: rootSlot,
    rootIdentity: { ...makeIdentity({ chainId, ...rootRef }) },
    nodes: nodeList,
    edges,
    directDependencies: direct,
    transitiveDependencies: transitive,
    depth: maxReached,
    cycles,
    missing,
    truncated,
    stats: {
      nodeCount: nodeList.length,
      edgeCount: edges.length,
      nandCount: resolved.reduce((s, n) => s + n.own.nand, 0),
      latchCount: resolved.reduce((s, n) => s + n.own.latch, 0),
      refCount: resolved.reduce((s, n) => s + n.own.ref, 0),
      uniqueDependencies: nodeList.length - 1,
      cycles: cycles.length,
      missing: missing.length,
      truncated: truncated.length,
    },
  };
}

module.exports = { resolveLineage, DEFAULT_MAX_DEPTH };
