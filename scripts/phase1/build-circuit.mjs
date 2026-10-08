#!/usr/bin/env node
/**
 * Build the Phase 1 circuit artifact (fully offline — no RPC, no key).
 * Default: 2-input AND from 2 NAND gates (src/phase1/circuit.js).
 * Usage: node scripts/phase1/build-circuit.mjs [--out state/phase1-circuit.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from './chain.mjs';

const require = createRequire(import.meta.url);
const AND = require('../../src/phase1/circuit.js');
const { decode, truthTable } = require('../../src/phase1/netlist.js');

const args = parseArgs();
const nl = AND.netlistHex();
const decoded = decode(nl, AND.N_IN);
const table = truthTable(AND.GATES, AND.N_IN, AND.N_OUT);

const artifact = {
  name: 'phase1-and',
  description: '2-input AND from 2 NAND gates (NOT(NAND(A,B))). See src/phase1/circuit.js for rationale.',
  nIn: AND.N_IN,
  nOut: AND.N_OUT,
  nNand: AND.N_NAND,
  nLatch: AND.N_LATCH,
  refCount: decoded.refCount,
  netlist: nl,
  byteLength: (nl.length - 2) / 2,
  truthTable: table,
  materialRequired: { NAND: AND.N_NAND, LATCH: AND.N_LATCH },
};

console.log(JSON.stringify(artifact, null, 2));
if (args.out) {
  const p = path.resolve(args.out);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(artifact, null, 2) + '\n');
  console.error(`[build-circuit] wrote ${p}`);
}
