#!/usr/bin/env node
/**
 * Inspect one circuit's registry standing (READ-ONLY).
 * Usage:
 *   node scripts/phase3/inspect-registration.mjs --chain 196 --processor 0x.. --circuit 1 [--registry 0x..]
 * Steps: derive identityKey → read live netlist → compute hash → query registry →
 * compare → print compliance result. Broadcasts nothing.
 *
 * Vocabulary guardrail (no license/payment mechanism exists yet): prints only
 * REGISTERED / UNREGISTERED / INACTIVE / MISMATCH / UNKNOWN / NOT_CONFIGURED.
 * Never prints "licensed".
 */
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { loadEnv, getProvider, parseArgs, addrUrl } from '../phase1/chain.mjs';

const require = createRequire(import.meta.url);
const reader = require('../../src/lineage/chain-reader.js');
const { slotKey } = require('../../src/lineage/identity');
const { keyHashFor, readRegistration } = require('../../src/registry/client');
const { compareRegistration } = require('../../src/registry/attribution');

loadEnv();
const args = parseArgs();
const CHAIN = args.chain || process.env.CHAIN_ID || '196';
const PROCESSOR = args.processor || process.env.PROCESSOR;
const CIRCUIT = args.circuit || process.env.CIRCUIT_ID;
const REGISTRY = args.registry || process.env.REGISTRY || '';
if (!PROCESSOR || !CIRCUIT) throw new Error('usage: --chain 196 --processor 0x.. --circuit N [--registry 0x..]');

const { provider } = await getProvider();
const netId = (await provider.getNetwork()).chainId;
if (netId !== BigInt(CHAIN)) throw new Error(`connected to chain ${netId}, asked for ${CHAIN}`);

const c = await reader.getCircuit(PROCESSOR, CIRCUIT);
if (!c) throw new Error('circuit absent or unreadable on chain (missing — see lineage resolver semantics)');
const slot = slotKey({ chainId: CHAIN, processor: c.processor, circuitId: c.circuitId });
const key = keyHashFor({ chainId: CHAIN, processor: c.processor, circuitId: c.circuitId });

console.log(`Circuit #${c.circuitId}`);
console.log(`Processor: ${c.processor} ${addrUrl(c.processor)}`);
console.log(`Identity: ${slot}`);
console.log(`Netlist hash: ${c.netlistHash}`);
console.log(`Owner: ${c.owner} · ${c.nIn} in / ${c.nOut} out / ${c.gateCount} gates, state ${c.nState}`);

console.log('\nRegistry:');
if (!REGISTRY) {
  console.log('  Status: NOT_CONFIGURED (no --registry given; no registry deployed yet)');
  console.log(`  To check later: derive key ${key} and query getRegistration/isRegistered.`);
  process.exit(0);
}
const rec = await readRegistration(provider, REGISTRY, key);
const verdict = compareRegistration(
  { chainId: CHAIN, processor: c.processor, circuitId: c.circuitId, liveNetlistHash: c.netlistHash },
  rec,
);
console.log(`  Status: ${verdict.status.toUpperCase()}`);
if (verdict.payee) console.log(`  Payee: ${verdict.payee}`);
if (verdict.priceWei !== undefined) console.log(`  Price: ${verdict.priceWei} wei (${ethers.formatEther(verdict.priceWei)} OKB-equiv native)`);
if (verdict.termsHash) console.log(`  Terms hash: ${verdict.termsHash}`);
console.log('\nIntegrity:');
console.log('  Identity: MATCH (record looked up by this slot key)');
console.log(`  Netlist: ${verdict.status === 'mismatch' ? `MISMATCH (record ${verdict.recordNetlistHash} vs live ${verdict.liveNetlistHash})` : verdict.hashVerified === false ? 'UNVERIFIED (no live hash — should not happen here)' : 'MATCH'}`);
