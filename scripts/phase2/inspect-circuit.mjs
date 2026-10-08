#!/usr/bin/env node
/**
 * Inspect a TapeOut circuit's computational lineage (READ-ONLY).
 * Usage:
 *   node scripts/phase2/inspect-circuit.mjs --processor 0x.. --circuit 1 [--max-depth 8]
 *   node scripts/phase2/inspect-circuit.mjs --processor 0x.. --circuit 1 --fixture-root tests/phase2/fixtures/nested.json
 *     (--fixture-root: resolve a SYNTHETIC local netlist as root, live deps from chain.
 *      Labels the root SYNTHETIC; useful to preview lineage before taping out.)
 * Prints a human tree, a summary, and machine-readable JSON. Broadcasts nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEnv, parseArgs, addrUrl } from '../phase1/chain.mjs';

const require = createRequire(import.meta.url);
const reader = require('../../src/lineage/chain-reader.js');
const { resolveLineage } = require('../../src/lineage/resolver.js');

loadEnv();
const args = parseArgs();
const PROCESSOR = args.processor || process.env.PROCESSOR;
const CIRCUIT = args.circuit || process.env.CIRCUIT_ID;
const MAX_DEPTH = Number(args['max-depth'] ?? process.env.MAX_DEPTH ?? 8);
if (!PROCESSOR || !CIRCUIT) throw new Error('usage: --processor 0x.. --circuit N [--max-depth N]');
if (!Number.isInteger(MAX_DEPTH) || MAX_DEPTH < 0) throw new Error(`bad --max-depth: ${args['max-depth']}`);

const jsonOut = args['json-out'] || null;
const bigReplacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

const { chainId, rpcUrl, block } = await reader.getChain();
console.log(`X Layer read-only @ ${rpcUrl} (chain ${chainId}, block ${block})`);

const proc = await reader.getProcessor(PROCESSOR);
console.log(`Processor ${proc.processor} ${addrUrl(proc.processor)}`);
console.log(`  registered(isCPU)=${proc.isCPU} nextId=${proc.nextId} material=${proc.transistors}`);

// Fetch strategy: fixture-root (synthetic) served from memory, everything else live.
let fixtureRoot = null;
if (args['fixture-root']) {
  const f = JSON.parse(fs.readFileSync(path.resolve(args['fixture-root']), 'utf8'));
  if (!f.root || !f.root.netlist) throw new Error('--fixture-root needs a fixture with .root.netlist');
  fixtureRoot = { ...f.root, label: f.label || 'SYNTHETIC' };
  console.log(`Root: SYNTHETIC local netlist from ${args['fixture-root']} (NOT on chain)`);
}
const fetch = async (ref) => {
  if (fixtureRoot && ref.processor.toLowerCase() === fixtureRoot.processor.toLowerCase()
      && String(ref.circuitId) === String(fixtureRoot.circuitId)) {
    return { netlist: fixtureRoot.netlist, nIn: fixtureRoot.nIn, nOut: fixtureRoot.nOut, netlistHash: null };
  }
  return reader.fetchCircuitForResolver(ref);
};

const rootRef = fixtureRoot
  ? { processor: fixtureRoot.processor, circuitId: fixtureRoot.circuitId }
  : { processor: PROCESSOR, circuitId: CIRCUIT };

const lin = await resolveLineage(rootRef, { fetchCircuit: fetch, chainId, maxDepth: MAX_DEPTH });
const byKey = new Map(lin.nodes.map((n) => [n.key, n]));

// ---- human tree (DFS from root; revisits marked, cycles cut) ----
console.log(`\nCircuit #${rootRef.circuitId}`);
console.log(`Processor: ${rootRef.processor}`);
const seen = new Set();
const treeLines = [];
function emit(key, prefix, isLast, trail) {
  const n = byKey.get(key);
  const kids = lin.edges.filter((e) => e.from === key);
  const tag = n.status === 'resolved'
    ? `${n.own.nand} NAND, ${n.own.latch} LATCH, ${n.own.ref} REF`
    : `${n.status}${n.error ? `: ${n.error}` : ''}`;
  treeLines.push(`${prefix}${isLast ? '└─' : '├─'} #${n.circuitId} [${n.processor.slice(0, 10)}…] (${tag})`);
  if (trail.includes(key)) {
    treeLines.push(`${prefix}${isLast ? '   ' : '│  '}└─ ※ cycle back to #${n.circuitId} (terminated)`);
    return;
  }
  if (seen.has(key)) {
    treeLines.push(`${prefix}${isLast ? '   ' : '│  '}└─ ※ already shown above`);
    return;
  }
  seen.add(key);
  kids.forEach((e, i) => emit(e.to, prefix + (isLast ? '   ' : '│  '), i === kids.length - 1, [...trail, key]));
}
seen.add(lin.root);
lin.edges.filter((e) => e.from === lin.root).forEach((e, i, arr) => emit(e.to, '', i === arr.length - 1, [lin.root]));
if (!lin.edges.some((e) => e.from === lin.root)) treeLines.push('(no REF dependencies)');
console.log(treeLines.join('\n'));

// ---- summary ----
const root = byKey.get(lin.root);
console.log('\nLineage:');
console.log(`- root: ${lin.root}`);
console.log(`- netlist hash (keccak256): ${root.netlistHash ?? 'n/a'}`);
console.log(`- direct dependencies: ${lin.directDependencies.length}`);
console.log(`- transitive dependencies: ${lin.transitiveDependencies.length}`);
console.log(`- nodes: ${lin.stats.nodeCount}, edges: ${lin.stats.edgeCount}, depth reached: ${lin.depth}`);
console.log(`- NAND gates: ${lin.stats.nandCount}, LATCH gates: ${lin.stats.latchCount}, REF gates: ${lin.stats.refCount}`);
console.log(`- cycles: ${lin.stats.cycles}, missing: ${lin.stats.missing}, truncated: ${lin.stats.truncated}`);
if (lin.cycles.length) console.log(`  cycle paths: ${JSON.stringify(lin.cycles)}`);
if (lin.missing.length) console.log(`  missing: ${JSON.stringify(lin.missing.map((m) => m.key))}`);

// ---- machine JSON ----
const out = { chainId, rpcUrl, block, processor: proc.processor, inspectedCircuit: String(rootRef.circuitId), syntheticRoot: !!fixtureRoot, lineage: lin };
console.log('\n--- JSON ---');
console.log(JSON.stringify(out, bigReplacer, 2));
if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(out, bigReplacer, 2) + '\n');
  console.error(`[inspect] JSON wrote ${jsonOut}`);
}
