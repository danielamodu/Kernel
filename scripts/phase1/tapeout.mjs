#!/usr/bin/env node
/**
 * Mint material + tape out the Phase 1 AND circuit (BROADCASTS 1-2 txs).
 * Usage:
 *   CONFIRM_BROADCAST=1 node scripts/phase1/tapeout.mjs [--processor 0x..] [--transistors 0x..]
 * Env: RPC_URLS, PRIVATE_KEY, PROCESSOR, TRANSISTORS (or state/phase1.json from create step).
 * Mints missing NAND in ONE batch call (single protocolFee), then tapes out.
 * Prints updated state JSON. Fails closed if TapedOut is absent or bytes mismatch.
 */
import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import {
  loadEnv, getProvider, getSigner, requireBroadcastConfirm,
  CIRCUITS_ABI, TRANSISTORS_ABI, fmtOKB, txUrl, parseArgs, readState, writeState,
} from './chain.mjs';

const require = createRequire(import.meta.url);
const AND = require('../../src/phase1/circuit.js');
const { decode } = require('../../src/phase1/netlist.js');

loadEnv();
const args = parseArgs();
const st = readState();
const PROCESSOR = args.processor || process.env.PROCESSOR || st.processor;
const TRANSISTORS = args.transistors || process.env.TRANSISTORS || st.transistors;
if (!PROCESSOR || !TRANSISTORS) throw new Error('processor/transistors unknown: pass --processor/--transistors, set env, or run create-processor first');

requireBroadcastConfirm('mint material and tape out (spends OKB on mainnet)');

const nl = AND.netlistHex();
const pre = decode(nl, AND.N_IN); // local self-check before spending anything
if (pre.refCount !== 0 || pre.nNand !== AND.N_NAND || pre.nLatch !== AND.N_LATCH) {
  throw new Error('local netlist self-check failed — refusing to spend');
}

const { provider } = await getProvider();
const { signer, address: me } = await getSigner(provider);
const cpu = new ethers.Contract(PROCESSOR, CIRCUITS_ABI, provider);
const mat = new ethers.Contract(TRANSISTORS, TRANSISTORS_ABI, provider);

// Live quote (re-read everything; never trust cached fees).
const [transistors, tapeoutFee, mintPrice, protocolFee, balNAND, balLATCH, supplyCap, minted, nextBefore] =
  await Promise.all([
    cpu.transistors(), cpu.TAPEOUT_FEE(), mat.mintPrice(), mat.protocolFee(),
    mat.balanceOf(me, 0n), mat.balanceOf(me, 1n),
    mat.supplyCap(), mat.minted(), cpu.nextId(),
  ]);
if (transistors.toLowerCase() !== TRANSISTORS.toLowerCase()) throw new Error('MATERIAL_PROVENANCE_MISMATCH');
const needNAND = BigInt(AND.N_NAND) > balNAND ? BigInt(AND.N_NAND) - balNAND : 0n;
const needLATCH = BigInt(AND.N_LATCH) > balLATCH ? BigInt(AND.N_LATCH) - balLATCH : 0n;
if (needNAND + needLATCH > supplyCap - minted) throw new Error('INSUFFICIENT_MATERIAL_SUPPLY');
const mintValue = needNAND > 0n ? mintPrice * needNAND + protocolFee : 0n;
console.error(`[tapeout] balances NAND=${balNAND} LATCH=${balLATCH} needNAND=${needNAND} mintValue=${fmtOKB(mintValue)} tapeoutFee=${fmtOKB(tapeoutFee)} nextId(before)=${nextBefore}`);

const wMat = new ethers.Contract(TRANSISTORS, TRANSISTORS_ABI, signer);
const wCpu = new ethers.Contract(PROCESSOR, CIRCUITS_ABI, signer);
let mintTx = null;
if (needNAND > 0n) {
  const t = await wMat.mint(0n, needNAND, { value: mintValue });
  console.error(`[tapeout] mint broadcast ${t.hash} ${txUrl(t.hash)}`);
  const r = await t.wait();
  if (Number(r.status) !== 1) throw new Error(`mint reverted: ${t.hash}`);
  mintTx = { hash: t.hash, block: Number(r.blockNumber), gasUsed: r.gasUsed.toString(), valueWei: mintValue.toString() };
  console.error(`[tapeout] mint confirmed block=${r.blockNumber} gasUsed=${r.gasUsed}`);
}

const t = await wCpu.tapeout(nl, AND.N_IN, AND.N_OUT, { value: tapeoutFee });
console.error(`[tapeout] tapeout broadcast ${t.hash} ${txUrl(t.hash)}`);
const r = await t.wait();
if (Number(r.status) !== 1) throw new Error(`tapeout reverted: ${t.hash}`);
console.error(`[tapeout] confirmed block=${r.blockNumber} gasUsed=${r.gasUsed}`);

// Extract TapedOut authored by us on our processor (exactly one).
let taped = null;
for (const log of r.logs) {
  if (log.address.toLowerCase() !== PROCESSOR.toLowerCase()) continue;
  try {
    const parsed = cpu.interface.parseLog(log);
    if (parsed?.name === 'TapedOut' && parsed.args.author.toLowerCase() === me.toLowerCase()) {
      if (taped) throw new Error('ambiguous TapedOut events');
      taped = parsed.args;
    }
  } catch { /* foreign log shape */ }
}
if (!taped) throw new Error('TapedOut event missing — refusing to claim success');
const circuitId = taped.circuitId.toString();

// Immediate read-back: bytes on chain must equal what we submitted.
const onchain = await cpu.netlist(circuitId);
if (onchain.toLowerCase() !== nl.toLowerCase()) throw new Error('MANUFACTURED_BYTES_MISMATCH');
console.error(`[tapeout] read-back match: circuit #${circuitId} netlist identical`);

const out = {
  ...st,
  processor: PROCESSOR,
  transistors: TRANSISTORS,
  minter: me,
  mintTx,
  tapeoutTx: t.hash,
  tapeoutBlock: Number(r.blockNumber),
  tapeoutGasUsed: r.gasUsed.toString(),
  tapeoutFeeWei: tapeoutFee.toString(),
  circuitId,
  tapedOut: { gateCount: Number(taped.gateCount), nState: Number(taped.nState) },
  netlist: nl,
};
console.log(JSON.stringify(out, null, 2));
writeState(out);
console.error('[tapeout] state saved to state/phase1.json');
