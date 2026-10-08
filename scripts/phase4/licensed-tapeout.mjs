#!/usr/bin/env node
/**
 * Broadcast a licensed tape-out (WALLET OWNER ONLY, DUAL GATE).
 *   CONFIRM_BROADCAST=1 CONFIRM_LICENSED_TAPEOUT=1 node scripts/phase4/licensed-tapeout.mjs \
 *     --router 0x.. --registry 0x.. [--target 0x..] [--root-fixture ...] [--out state/phase4-tapeout.json]
 * Without BOTH gates: prints the refusal and exits (prepare first with
 * scripts/phase4/prepare-licensed-tapeout.mjs).
 * Flow: live preflight (fresh reads) -> value check -> broadcast -> wait ->
 * parse LicensedTapeout/LicensePaid -> verify lineageHash + read back circuit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import {
  loadEnv, getProvider, getSigner, fmtOKB, txUrl, parseArgs, readState, writeState,
  CIRCUITS_ABI, TRANSISTORS_ABI,
} from '../phase1/chain.mjs';

const require = createRequire(import.meta.url);
const reader = require('../../src/lineage/chain-reader.js');
const { keyHashFor, readRegistration } = require('../../src/registry/client.js');
const { preflight } = require('../../src/router/preflight.js');
const { buildLicenseCalldata, requiredValue, routerInterface } = require('../../src/router/client.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function need2(name, cond) {
  if (!cond) throw new Error(`refusing licensed tape-out without ${name} (see prepare script output)`);
}

loadEnv();
const args = parseArgs();
need2('CONFIRM_BROADCAST=1', process.env.CONFIRM_BROADCAST === '1');
need2('CONFIRM_LICENSED_TAPEOUT=1', process.env.CONFIRM_LICENSED_TAPEOUT === '1');

const st = readState();
const ROUTER = args.router || process.env.ROUTER || st.router;
const REGISTRY = args.registry || process.env.REGISTRY || st.registry;
const TARGET = args.target || process.env.TARGET_PROCESSOR || '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a';
const FIXTURE = args['root-fixture'] || 'tests/phase4/fixtures/demo-root-trace.json';
need2('--router', ROUTER);
need2('--registry (canonical registration must exist)', REGISTRY);

const fix = JSON.parse(fs.readFileSync(path.resolve(ROOT, FIXTURE), 'utf8'));
const { provider } = await getProvider();
const chainId = Number((await provider.getNetwork()).chainId);
const { signer, address: payer } = await getSigner(provider);

// Fresh live preflight (never trust a stale plan for money movement).
const cpu = new ethers.Contract(TARGET, CIRCUITS_ABI, provider);
const [transistors, tapeoutFee] = await Promise.all([cpu.transistors(), cpu.TAPEOUT_FEE()]);
const mat = new ethers.Contract(transistors, TRANSISTORS_ABI, provider);
const [mintPrice, protocolFee] = await Promise.all([mat.mintPrice(), mat.protocolFee()]);
const lookup = async (slot) => {
  const m = slot.match(/^tapeout:v1:([0-9]+):(0x[0-9a-f]{40}):([0-9]+)$/);
  return readRegistration(provider, REGISTRY, keyHashFor({ chainId: m[1], processor: m[2], circuitId: m[3] }));
};
const fetchCircuit = async ({ processor, circuitId }) => {
  const c = await reader.getCircuit(processor, circuitId);
  return c ? { netlist: c.netlist, nIn: c.nIn, nOut: c.nOut, netlistHash: c.netlistHash } : null;
};
const pf = await preflight({
  targetCpu: TARGET, netlist: fix.netlist, nIn: fix.nIn, nOut: fix.nOut,
  fetchCircuit, lookupRegistry: lookup,
  tapeoutFeeWei: tapeoutFee.toString(),
  mintQuote: { mintPriceWei: mintPrice.toString(), protocolFeeWei: protocolFee.toString() },
  chainId,
});
if (!pf.allowed) throw new Error(`live preflight BLOCKED: ${pf.failures.map((f) => `${f.code} ${f.detail}`).join('; ')}`);
const value = requiredValue({
  totalPriceWei: pf.totalPriceWei, nNand: pf.manufacture.nand, nLatch: pf.manufacture.latch,
  mintPriceWei: mintPrice.toString(), protocolFeeWei: protocolFee.toString(), tapeoutFeeWei: tapeoutFee.toString(),
});
const data = buildLicenseCalldata({ targetCpu: TARGET, netlist: fix.netlist, nIn: fix.nIn, nOut: fix.nOut });
console.error(`[licensed-tapeout] payer=${payer} value=${fmtOKB(value)} lineageHash=${pf.lineageHash}`);
console.error(`[licensed-tapeout] deps=${pf.dependencies.map((d) => `${d.processor}#${d.circuitId}:${d.priceWei}`).join(',')}`);

const tx = await signer.sendTransaction({ to: ROUTER, data, value });
console.error(`[licensed-tapeout] broadcast ${tx.hash} ${txUrl(tx.hash)}`);
const receipt = await tx.wait();
if (Number(receipt.status) !== 1) throw new Error(`licensed tape-out reverted: ${tx.hash}`);

// Parse + verify proof events.
const licensed = [];
const paid = [];
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== ROUTER.toLowerCase()) continue;
  try {
    const p = routerInterface.parseLog(log);
    if (p.name === 'LicensedTapeout') licensed.push(p.args);
    if (p.name === 'LicensePaid') paid.push(p.args);
  } catch { /* foreign log */ }
}
if (licensed.length !== 1) throw new Error(`expected 1 LicensedTapeout, got ${licensed.length}`);
const ev = licensed[0];
if (ev.lineageHash.toLowerCase() !== pf.lineageHash.toLowerCase()) {
  throw new Error(`lineageHash MISMATCH: event ${ev.lineageHash} vs local ${pf.lineageHash}`);
}
if (ev.totalPriceWei.toString() !== pf.totalPriceWei) throw new Error('totalPrice mismatch');
// Read back the manufactured circuit (owner must be the payer: router forwards the NFT).
const newId = ev.newCircuitId.toString();
const [onchainNl, owner] = await Promise.all([cpu.netlist(newId), cpu.ownerOf(newId)]);
if (onchainNl.toLowerCase() !== fix.netlist.toLowerCase()) throw new Error('manufactured bytes mismatch');
if (owner.toLowerCase() !== payer.toLowerCase()) throw new Error(`circuit owner ${owner} != payer ${payer}`);
console.error(`[licensed-tapeout] verified: circuit #${newId} owned by payer, bytes match, lineageHash match`);

const saved = writeState({
  ...st,
  licensedTapeout: {
    router: ROUTER, registry: REGISTRY, target: TARGET, payer,
    circuitId: newId, netlist: fix.netlist, lineageHash: pf.lineageHash,
    totalPriceWei: pf.totalPriceWei, valueWei: value,
    dependencies: pf.dependencies, paid: paid.map((p) => ({ key: p.key, payee: p.payee, price: p.price.toString(), termsHash: p.termsHash })),
    tx: tx.hash, txUrl: txUrl(tx.hash), block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(),
  },
});
console.log(JSON.stringify(saved.licensedTapeout, null, 2));
