#!/usr/bin/env node
/**
 * Independent demo verifier: re-derives EVERYTHING from chain bytes + fixture,
 * trusting neither the router's return values nor any saved state.
 *   node scripts/final/verify-demo.mjs            (fixture/dry-run mode, default)
 *   node scripts/final/verify-demo.mjs --live --tx 0x.. --router 0x.. [--registry 0x..]
 *     (live mode: replays the licensed-tx calldata against live state)
 * READ-ONLY in both modes. Exit nonzero on any mismatch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadEnv, getProvider, parseArgs } from '../../scripts/phase1/chain.mjs';

const require = createRequire(import.meta.url);
const { parseNetlist } = require('../../src/lineage/netlist.js');
const { slotKey } = require('../../src/lineage/identity.js');
const { keyHashFor, readRegistration } = require('../../src/registry/client.js');
const { hashTerms } = require('../../src/registry/terms.js');
const { computeLineageHash } = require('../../src/router/commitment.js');
const { routerInterface } = require('../../src/router/client.js');
const reader = require('../../src/lineage/chain-reader.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv();
const args = parseArgs();
const LIVE = args.live !== undefined;
const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' -- ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'final', 'demo-root.json'), 'utf8'));
const dep = FIX.dependencies[0];

// ---- fixture leg (no chain): bytes -> parse -> identity -> terms -> commitment ----
const parsed = parseNetlist(FIX.netlist, FIX.nIn);
check('demo parses to exactly 1 REF, 0 NAND/LATCH', parsed.stats.ref === 1 && parsed.stats.nand === 0 && parsed.stats.latch === 0);
const r = parsed.refs[0];
check('REF targets TRACE #1 with pins [2,3,4,5]/2', r.processor === dep.processor && r.circuitId === 1n && JSON.stringify(r.inputs) === '[2,3,4,5]' && r.nOut === 2);
check('identityKey matches fixture', slotKey({ chainId: 196, processor: r.processor, circuitId: '1' }) === dep.identityKey);
check('terms recompute to fixture termsHash', hashTerms(dep.termsExpected) === dep.termsHash);
const recomputed = computeLineageHash({
  targetCpu: FIX.targetProcessor, nIn: FIX.nIn, nOut: FIX.nOut, netlist: FIX.netlist,
  deps: [{
    keyHash: keyHashFor({ chainId: 196, processor: dep.processor, circuitId: dep.circuitId }),
    netlistHash: dep.netlistHashExpected, payee: dep.payeeExpected,
    priceWei: dep.priceWeiExpected, termsHash: dep.termsHash,
  }],
});
check('lineageHash recomputes to fixture value', recomputed.toLowerCase() === FIX.lineageHash.toLowerCase());

// ---- live leg (read-only): dep bytes + registry state ----
const { provider } = await getProvider();
const chainId = Number((await provider.getNetwork()).chainId);
check('chain is X Layer 196', chainId === 196);
const live = await reader.getCircuit(dep.processor, dep.circuitId);
check('live dep readable', !!live);
if (live) {
  check('live hash == fixture hash', live.netlistHash.toLowerCase() === dep.netlistHashExpected.toLowerCase());
  check('live pins agree with REF', live.nIn === r.inputs.length && live.nOut === r.nOut);
}
const REGISTRY = args.registry || process.env.REGISTRY || '';
if (REGISTRY) {
  const rec = await readRegistration(provider, REGISTRY, keyHashFor({ chainId: 196, processor: dep.processor, circuitId: dep.circuitId }));
  check('registry record present+active', !!rec && rec.active, rec ? `active=${rec.active}` : 'absent');
  if (rec) {
    check('record hash == live hash', rec.netlistHash.toLowerCase() === live.netlistHash.toLowerCase());
    check('record payee/price match fixture', rec.payee.toLowerCase() === dep.payeeExpected && rec.priceWei === dep.priceWeiExpected);
  }
} else {
  console.log('[SKIP] registry cross-check (no --registry; registry NOT_DEPLOYED)');
}

// ---- live-tx replay (only with --live --tx --router) ----
if (LIVE) {
  const TX = args.tx || process.env.LICENSED_TAPEOUT_TX || '';
  const ROUTER = args.router || process.env.ROUTER || '';
  if (!TX || !ROUTER) throw new Error('live mode needs --tx and --router (nothing to replay yet)');
  const tx = await provider.getTransaction(TX);
  const dec = routerInterface.parseTransaction({ data: tx.data });
  check('tx is licenseAndTapeout to router', dec.name === 'licenseAndTapeout' && tx.to.toLowerCase() === ROUTER.toLowerCase());
  check('tx calldata netlist == fixture bytes', dec.args.nl.toLowerCase() === FIX.netlist.toLowerCase());
  const receipt = await provider.getTransactionReceipt(TX);
  check('receipt success', receipt && Number(receipt.status) === 1);
  const ev = receipt.logs.map((l) => {
    try { return l.address.toLowerCase() === ROUTER.toLowerCase() ? routerInterface.parseLog(l) : null; } catch { return null; }
  }).filter((p) => p && p.name === 'LicensedTapeout');
  check('exactly one LicensedTapeout', ev.length === 1);
  if (ev.length === 1) check('event lineageHash == recomputed', ev[0].args.lineageHash.toLowerCase() === recomputed.toLowerCase());
} else {
  console.log('[SKIP] live-tx replay (fixture mode; pass --live --tx --router after activation)');
}

if (failures.length) { console.log(`\n${failures.length} FAILURE(S): ${failures.join('; ')}`); process.exit(1); }
console.log('\nAll verify-demo checks passed.');
