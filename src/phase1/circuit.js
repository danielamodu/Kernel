'use strict';
/**
 * Phase 1 minimal circuit: 2-input AND built from 2 NAND gates.
 *
 * Why AND (and not XOR / half-adder):
 * - Smallest useful circuit in the brief: AND = NOT(NAND(a,b)) needs exactly 2 NANDs.
 * - XOR needs >= 4 NANDs (plus output buffers in canvas convention); a half-adder
 *   needs AND + XOR (>= 6). Start minimal per instructions; do not optimize prematurely.
 * - No LATCH (combinational only): material math is exactly 2 NAND units.
 * - No REF (first circuit must have REF count 0): nothing on our processor exists yet.
 * - 4-row truth table keeps on-chain `eval` verification trivial.
 *
 * Signals: 0 = const-0, 1 = const-1, 2 = A, 3 = B.
 *   g0: NAND(2,3) -> 4          (NAND of inputs)
 *   g1: NAND(4,4) -> 5          (NOT => AND)
 * Outputs: last nOut=1 signal => [5].
 *
 * NOTE: the official canvas appends +2 NAND output buffers per output pin. Those are
 * a canvas convention, not a contract requirement (the contract executes whatever
 * netlist it is given; TRACE's buffers are ordinary gates). We tape out the bare
 * 2-gate form so "transistor usage" is exactly auditable as 2 NAND.
 */
const { OP, encode, truthTable } = require('./netlist');

const N_IN = 2;
const N_OUT = 1;
const GATES = Object.freeze([
  Object.freeze({ op: OP.NAND, a: 2, b: 3, out: 4 }),
  Object.freeze({ op: OP.NAND, a: 4, b: 4, out: 5 }),
]);
const N_NAND = 2;
const N_LATCH = 0;

function netlistHex() {
  return encode(GATES);
}

/** Expected outputs: AND truth table as [out] per input row [A,B]. */
function expectedTable() {
  return truthTable(GATES, N_IN, N_OUT);
}

module.exports = { N_IN, N_OUT, GATES, N_NAND, N_LATCH, netlistHex, expectedTable };
