#!/usr/bin/env node
/**
 * Independently verify a Phase 1 tape-out (READ-ONLY — no key, no broadcast).
 * Usage:
 *   node scripts/phase1/verify.mjs [--processor 0x..] [--circuit N] [--creation-tx 0x..]
 *     [--mint-tx 0x..] [--tapeout-tx 0x..] [--out report.json]
 * Falls back to PROCESSOR/CIRCUIT_ID/... env or state/phase1.json.
 * Exit 0 only if EVERY check passes; any mismatch fails closed with details.
 */
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  loadEnv, getProvider, FACTORY, FACTORY_ABI, CIRCUITS_ABI, TRANSISTORS_ABI,
  fmtOKB, txUrl, addrUrl, parseArgs, readState,
} from './chain.mjs';

const require = createRequire(import.meta.url);
const { decode, truthTable, encode, packInputs, unpackOutputs } = require('../../src/phase1/netlist.js');
const AND = require('../../src/phase1/circuit.js');

loadEnv();
const args = parseArgs();
const st = readState();

// Expected circuit model: defaults to the Phase 1 AND; override via env/args to
// verify any known circuit (e.g. a dry run against TRACE circuit #1). The local
// model ALWAYS comes from decoding the expected netlist bytes — never trusted blind.
const EXPECT_NETLIST = (args['expect-netlist'] || process.env.EXPECT_NETLIST || AND.netlistHex()).toLowerCase();
const EXPECT_OWNER = (args['expect-owner'] || process.env.EXPECT_OWNER || st.minter || '').toLowerCase();
const EXPECT_NIN = Number(args['expect-nin'] ?? process.env.EXPECT_NIN ?? AND.N_IN);
const EXPECT_NOUT = Number(args['expect-nout'] ?? process.env.EXPECT_NOUT ?? AND.N_OUT);
const EXPECT_GATES = Number(args['expect-gates'] ?? process.env.EXPECT_GATES ?? AND.GATES.length);

const PROCESSOR = args.processor || process.env.PROCESSOR || st.processor;
const CIRCUIT = args.circuit || process.env.CIRCUIT_ID || st.circuitId;
const CREATION_TX = args['creation-tx'] || process.env.CREATION_TX || st.creationTx;
const MINT_TX = args['mint-tx'] || process.env.MINT_TX || st.mintTx?.hash;
const TAPEOUT_TX = args['tapeout-tx'] || process.env.TAPEOUT_TX || st.tapeoutTx;
if (!PROCESSOR) throw new Error('processor unknown');
if (!CIRCUIT) throw new Error('circuit id unknown');

const failures = [];
const check = (name, cond, detail = '') => {
  console.error(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const { provider, rpcUrl, block: tip } = await getProvider();
const chainId = (await provider.getNetwork()).chainId;
check('chainId is 196', chainId === 196n, `got ${chainId}`);

const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
check('factory has code', (await provider.getCode(FACTORY)) !== '0x');
check('processor registered (isCPU)', await factory.isCPU(PROCESSOR));

const cpu = new ethers.Contract(PROCESSOR, CIRCUITS_ABI, provider);
const TRANSISTORS = await cpu.transistors();
const mat = new ethers.Contract(TRANSISTORS, TRANSISTORS_ABI, provider);
check('processor has code', (await provider.getCode(PROCESSOR)) !== '0x');
check('transistors has code', (await provider.getCode(TRANSISTORS)) !== '0x');
check('reciprocal link cpu→material', (await cpu.transistors()).toLowerCase() === TRANSISTORS.toLowerCase());
check('reciprocal link material→cpu', (await mat.circuits()).toLowerCase() === PROCESSOR.toLowerCase());
if (st.transistors) check('transistors matches state file', TRANSISTORS.toLowerCase() === st.transistors.toLowerCase());

// Circuit metadata vs the locally-decoded expected model.
// The model is derived by DECODING the expected netlist bytes (never trusted blind),
// then every on-chain field is compared against that decode.
const expDec = decode(EXPECT_NETLIST, EXPECT_NIN);
const EXPECT_REFCOUNT = Number(args['expect-refcount'] ?? process.env.EXPECT_REFCOUNT ?? expDec.refCount);
const info = await cpu.circuitInfo(CIRCUIT);
check('nIn matches model', info[0] === BigInt(EXPECT_NIN), `chain=${info[0]} model=${EXPECT_NIN}`);
check('nOut matches model', info[1] === BigInt(EXPECT_NOUT), `chain=${info[1]} model=${EXPECT_NOUT}`);
check('gateCount matches model', info[3] === BigInt(EXPECT_GATES), `chain=${info[3]} model=${EXPECT_GATES}`);
const onchainNl = await cpu.netlist(CIRCUIT);
check('on-chain netlist equals expected bytes', onchainNl.toLowerCase() === EXPECT_NETLIST, `chain=${onchainNl.slice(0, 66)}…`);
const dec = decode(onchainNl, Number(info[0]));
check('nState == decoded latch count', info[2] === BigInt(dec.nLatch), `chain=${info[2]} decoded=${dec.nLatch}`);
check('gateCount == decoded gate count', info[3] === BigInt(dec.gates.length), `chain=${info[3]} decoded=${dec.gates.length}`);
check('REF count as expected', dec.refCount === EXPECT_REFCOUNT, `got ${dec.refCount}`);
check('re-encode matches chain bytes', encode(dec.gates).toLowerCase() === onchainNl.toLowerCase());
check('decoded gates match model gates', JSON.stringify(dec.gates) === JSON.stringify(expDec.gates));

// Ownership.
const owner = await cpu.ownerOf(CIRCUIT);
check('ownerOf succeeds', ethers.isAddress(owner), owner);
if (EXPECT_OWNER) check('owner matches expectation', owner.toLowerCase() === EXPECT_OWNER, `owner=${owner}`);
const nextId = await cpu.nextId();
check('circuit id <= nextId', BigInt(CIRCUIT) <= nextId, `id=${CIRCUIT} nextId=${nextId}`);

// Full truth table, executed ON CHAIN via eval, compared to the local model.
// (Combinational REF-free circuits only; anything else fails closed here.)
if (expDec.refCount !== 0 || expDec.nLatch !== 0) {
  throw new Error('local model has REF/LATCH — on-chain full-table eval not supported by this script');
}
const localRows = truthTable(expDec.gates, EXPECT_NIN, EXPECT_NOUT);
for (const { inputs, outputs: exp } of localRows) {
  const packed = packInputs(inputs);
  const raw = await cpu.eval(CIRCUIT, packed); // single bytes return — handled by unpackOutputs
  const got = unpackOutputs(raw, EXPECT_NOUT);
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  check(`eval(${inputs}) == ${exp}`, ok, `chain=${got}`);
}

// Material accounting.
const nandId = await mat.NAND();
const latchId = await mat.LATCH();
check('NAND token id is 0', nandId === 0n);
check('LATCH token id is 1', latchId === 1n);
const minted = await mat.minted();
check('minted covers model NAND burn', minted >= BigInt(expDec.nNand), `minted=${minted} modelNAND=${expDec.nNand}`);
const supplyCap = await mat.supplyCap();
check('minted <= supplyCap', minted <= supplyCap);

// Transaction receipts + events (where hashes known).
async function inspectTx(label, hash, want) {
  if (!hash) {
    console.error(`[SKIP] ${label}: no hash provided`);
    return null;
  }
  const r = await provider.getTransactionReceipt(hash);
  check(`${label} receipt exists`, !!r, hash);
  if (!r) return null;
  check(`${label} status ok`, r.status === 1, `status=${r.status}`);
  for (const [contract, event, pred] of want) {
    const hits = r.logs.filter((l) => l.address.toLowerCase() === contract.toLowerCase()).flatMap((l) => {
      try {
        const c = contract === FACTORY ? factory : contract === PROCESSOR ? cpu : mat;
        const p = c.interface.parseLog(l);
        return p?.name === event && (!pred || pred(p.args)) ? [p.args] : [];
      } catch { return []; }
    });
    check(`${label} has ${event}`, hits.length === 1, `hits=${hits.length}`);
  }
  return { block: Number(r.blockNumber), gasUsed: r.gasUsed.toString(), from: r.from, to: r.to };
}

const creation = await inspectTx('creation', CREATION_TX, [
  [FACTORY, 'CPUCreated', (a) => a.circuits.toLowerCase() === PROCESSOR.toLowerCase()],
]);
const mint = await inspectTx('mint', MINT_TX, [
  [TRANSISTORS, 'Minted', (a) => a.id === 0n && a.amount >= BigInt(expDec.nNand)],
]);
const tapeout = await inspectTx('tapeout', TAPEOUT_TX, [
  [PROCESSOR, 'TapedOut', (a) => a.circuitId.toString() === String(CIRCUIT) && a.gateCount === BigInt(EXPECT_GATES) && a.nState === BigInt(expDec.nLatch)],
]);

const tapeoutFee = await cpu.TAPEOUT_FEE();
const report = {
  chainId: Number(chainId),
  rpcUrl,
  tipBlock: tip,
  factory: FACTORY,
  processor: PROCESSOR,
  processorUrl: addrUrl(PROCESSOR),
  transistors: TRANSISTORS,
  transistorsUrl: addrUrl(TRANSISTORS),
  circuitId: String(CIRCUIT),
  circuitUrl: `${addrUrl(PROCESSOR)}#circuit-${CIRCUIT}`,
  owner,
  netlist: onchainNl,
  netlistBytes: (onchainNl.length - 2) / 2,
  circuitInfo: { nIn: Number(info[0]), nOut: Number(info[1]), nState: Number(info[2]), gateCount: Number(info[3]) },
  refCount: dec.refCount,
  nNand: dec.nNand,
  nLatch: dec.nLatch,
  truthTableRowsVerifiedOnChain: localRows.length,
  material: {
    supplyCap: supplyCap.toString(),
    minted: minted.toString(),
    mintPriceWei: (await mat.mintPrice()).toString(),
    protocolFeeWei: (await mat.protocolFee()).toString(),
  },
  tapeoutFeeWei: tapeoutFee.toString(),
  transactions: {
    creation: creation ? { ...creation, hash: CREATION_TX, url: txUrl(CREATION_TX) } : null,
    mint: mint ? { ...mint, hash: MINT_TX, url: txUrl(MINT_TX) } : null,
    tapeout: tapeout ? { ...tapeout, hash: TAPEOUT_TX, url: txUrl(TAPEOUT_TX) } : null,
  },
  failures,
  ok: failures.length === 0,
};

console.log(JSON.stringify(report, null, 2));
if (args.out) {
  const p = path.resolve(args.out);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(report, null, 2) + '\n');
  console.error(`[verify] report wrote ${p}`);
}
if (failures.length) {
  console.error(`[verify] ${failures.length} FAILURES: ${failures.join('; ')}`);
  process.exit(1);
}
console.error('[verify] all checks passed');
