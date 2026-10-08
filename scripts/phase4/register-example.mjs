#!/usr/bin/env node
/**
 * Prepare (default) or broadcast the canonical TRACE #1 registration.
 *   Dry run (needs NO key): node scripts/phase4/register-example.mjs [--registry 0x..]
 *   Live (owner only, DUAL gate): CONFIRM_BROADCAST=1 CONFIRM_REGISTRY_DEPLOY=1 node scripts/phase4/register-example.mjs --registry 0x..
 * Canonical values: chain 196, TRACE processor, circuit 1, LIVE netlistHash,
 * payee = live ownerOf(1) (the TRACE deployer), price 0.0005 OKB, single-license terms.
 * Overrides: --payee, --price-wei, --terms (JSON string). Live path reads the record
 * back and verifies byte-for-byte, then saves state/phase4-registration.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import {
  loadEnv, getProvider, getSigner, FACTORY, FACTORY_ABI,
  CIRCUITS_ABI, fmtOKB, addrUrl, txUrl, parseArgs, readState, writeState,
} from '../phase1/chain.mjs';

const require = createRequire(import.meta.url);
const { keyHashFor, buildRegisterCalldata, readRegistration } = require('../../src/registry/client.js');
const { canonicalizeTerms, hashTerms } = require('../../src/registry/terms.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRACE_PROC = '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a';
const TRACE_ID = 1;
const DEFAULT_PRICE = 500000000000000n; // 0.0005 OKB (brief §11 example)

loadEnv();
const args = parseArgs();
const DRY = !(process.env.CONFIRM_BROADCAST === '1' && process.env.CONFIRM_REGISTRY_DEPLOY === '1');
const REGISTRY = args.registry || process.env.REGISTRY || '';
const st = readState();

const { provider, rpcUrl } = await getProvider();
const chainId = Number((await provider.getNetwork()).chainId);
if (chainId !== 196) throw new Error('wrong chain — refusing');

// Live canonical reads (no assumptions).
const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
const cpu = new ethers.Contract(TRACE_PROC, CIRCUITS_ABI, provider);
const [isCPU, info, netlist, owner] = await Promise.all([
  factory.isCPU(TRACE_PROC), cpu.circuitInfo(TRACE_ID), cpu.netlist(TRACE_ID), cpu.ownerOf(TRACE_ID),
]);
if (!isCPU) throw new Error('TRACE processor not registered — aborting canonical example');
const netlistHash = ethers.keccak256(netlist);
const payee = ethers.getAddress(args.payee || process.env.REG_PAYEE || owner);
const price = BigInt(args['price-wei'] || process.env.REG_PRICE_WEI || DEFAULT_PRICE);
const terms = canonicalizeTerms(args.terms
  ? JSON.parse(args.terms)
  : {
    version: 1, model: 'single-license', priceWei: price.toString(),
    currency: 'OKB', attributionRequired: true,
    note: 'Canonical demo: TRACE circuit #1 via licensed-router path.',
  });
const termsHash = hashTerms(terms);
const key = keyHashFor({ chainId, processor: TRACE_PROC, circuitId: TRACE_ID });

console.log('Canonical TRACE #1 registration plan');
console.log(`  chainId: ${chainId}  processor: ${TRACE_PROC}  circuit: ${TRACE_ID}`);
console.log(`  circuitInfo: nIn=${info[0]} nOut=${info[1]} nState=${info[2]} gates=${info[3]}`);
console.log(`  netlist: ${netlist.slice(0, 66)}… (${(netlist.length - 2) / 2}B)  hash=${netlistHash}`);
console.log(`  payee: ${payee} (default: live ownerOf)  price: ${fmtOKB(price)}`);
console.log(`  terms: ${JSON.stringify(terms)}  termsHash=${termsHash}`);
console.log(`  slot key: ${key}`);
if (!REGISTRY) {
  console.log('  registry: NOT_DEPLOYED — deploy first (scripts/phase3/deploy-registry.mjs)');
  console.log('  calldata: (needs --registry) ' + buildRegisterCalldata({
    chainId, processor: TRACE_PROC, circuitId: TRACE_ID,
    netlistHash, payee, priceWei: price.toString(), termsHash,
  }).slice(0, 74) + '…');
  console.log('  Broadcast: BLOCKED (no registry; dry-run only)');
  process.exit(0);
}
console.log(`  registry: ${REGISTRY} ${addrUrl(REGISTRY)}`);

// Pre-flight read: already registered?
const existing = await readRegistration(provider, REGISTRY, key);
if (existing) {
  console.log(` already registered: active=${existing.active} payee=${existing.payee} price=${fmtOKB(existing.priceWei)}`);
  console.log(`  hash check: ${existing.netlistHash.toLowerCase() === netlistHash.toLowerCase() ? 'MATCH' : `MISMATCH (record ${existing.netlistHash})`}`);
  if (DRY) { console.log('  Broadcast: BLOCKED (dry-run; nothing sent)'); process.exit(0); }
}
if (DRY) {
  console.log('  calldata: ' + buildRegisterCalldata({
    chainId, processor: TRACE_PROC, circuitId: TRACE_ID,
    netlistHash, payee, priceWei: price.toString(), termsHash,
  }));
  console.log('  Broadcast: BLOCKED — set CONFIRM_BROADCAST=1 + CONFIRM_REGISTRY_DEPLOY=1 to send');
  process.exit(0);
}

// ---------------- LIVE (dual gate satisfied) ----------------
const { signer, address: sender } = await getSigner(provider);
const data = buildRegisterCalldata({
  chainId, processor: TRACE_PROC, circuitId: TRACE_ID,
  netlistHash, payee, priceWei: price.toString(), termsHash,
});
const gas = await provider.estimateGas({ from: sender, to: REGISTRY, data });
console.error(`[register] gasEstimate=${gas} sender=${sender}`);
const tx = await signer.sendTransaction({ to: REGISTRY, data });
console.error(`[register] broadcast ${tx.hash} ${txUrl(tx.hash)}`);
const receipt = await tx.wait();
if (Number(receipt.status) !== 1) throw new Error(`registration reverted: ${tx.hash}`);
const back = await readRegistration(provider, REGISTRY, key);
const checks = [
  ['netlistHash', back.netlistHash.toLowerCase() === netlistHash.toLowerCase()],
  ['payee', back.payee.toLowerCase() === payee.toLowerCase()],
  ['price', back.priceWei === price.toString()],
  ['termsHash', back.termsHash.toLowerCase() === termsHash.toLowerCase()],
  ['active', back.active === true],
  ['registeredBy', back.registeredBy.toLowerCase() === sender.toLowerCase()],
];
const bad = checks.filter(([, v]) => !v).map(([k]) => k);
if (bad.length) throw new Error(`read-back mismatch (tx ok, state wrong): ${bad.join(', ')}`);
console.error('[register] read-back byte-for-byte verified');
const saved = writeState({
  ...st,
  registry: REGISTRY,
  canonicalRegistration: {
    chainId, processor: TRACE_PROC, circuitId: TRACE_ID, key,
    netlistHash, payee, priceWei: price.toString(), terms: termsHash, termsJson: terms,
    tx: tx.hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(),
  },
});
console.log(JSON.stringify(saved.canonicalRegistration, null, 2));
