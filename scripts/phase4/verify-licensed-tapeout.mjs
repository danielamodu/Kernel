#!/usr/bin/env node
/**
 * Verify a licensed tape-out from chain data only (READ-ONLY).
 * Usage:
 *   node scripts/phase4/verify-licensed-tapeout.mjs --router 0x.. --tx 0x.. [--registry 0x..]
 * Steps: fetch tx -> decode licenseAndTapeout args -> resolve lineage live ->
 * recompute lineageHash -> compare with LicensedTapeout event -> read back new
 * circuit (netlist bytes, owner==payer) -> report. Exits nonzero on any mismatch.
 */
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import {
  loadEnv, getProvider, parseArgs, addrUrl, txUrl, CIRCUITS_ABI, readState,
} from '../phase1/chain.mjs';

const require = createRequire(import.meta.url);
const reader = require('../../src/lineage/chain-reader.js');
const { keyHashFor, readRegistration } = require('../../src/registry/client.js');
const { computeLineageHash } = require('../../src/router/commitment.js');
const { routerInterface } = require('../../src/router/client.js');
const { parseNetlist } = require('../../src/lineage/netlist.js');

loadEnv();
const args = parseArgs();
const st = readState();
const ROUTER = args.router || process.env.ROUTER || st.licensedTapeout?.router;
const TX = args.tx || process.env.LICENSED_TAPEOUT_TX || st.licensedTapeout?.tx;
const REGISTRY = args.registry || process.env.REGISTRY || st.registry || st.licensedTapeout?.registry;
if (!ROUTER || !TX) throw new Error('usage: --router 0x.. --tx 0x.. [--registry 0x..]');

const failures = [];
const check = (name, cond, detail = '') => {
  console.error(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const { provider } = await getProvider();
const chainId = Number((await provider.getNetwork()).chainId);
const tx = await provider.getTransaction(TX);
check('tx exists', !!tx, TX);
check('tx to router', tx && tx.to && tx.to.toLowerCase() === ROUTER.toLowerCase());
const decoded = routerInterface.parseTransaction({ data: tx.data });
check('tx is licenseAndTapeout', decoded && decoded.name === 'licenseAndTapeout');
const { targetCpu, nl, nIn, nOut } = { targetCpu: decoded.args.targetCpu, nl: decoded.args.nl, nIn: Number(decoded.args.nIn), nOut: Number(decoded.args.nOut) };

const receipt = await provider.getTransactionReceipt(TX);
check('receipt ok', receipt && Number(receipt.status) === 1);
const licensed = [];
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== ROUTER.toLowerCase()) continue;
  try {
    const p = routerInterface.parseLog(log);
    if (p.name === 'LicensedTapeout') licensed.push(p.args);
  } catch { /* foreign */ }
}
check('exactly one LicensedTapeout', licensed.length === 1, `got ${licensed.length}`);
const ev = licensed[0];

// Independent lineage recomputation from the tx calldata.
const parsed = parseNetlist(nl, nIn);
const deps = [];
for (const r of parsed.refs) {
  const c = await reader.getCircuit(r.processor, r.circuitId.toString());
  check(`dep ${r.processor}#${r.circuitId} readable`, !!c);
  if (!c) continue;
  check(`dep pins agree (REF ${r.inputs.length}/${r.nOut} vs live ${c.nIn}/${c.nOut})`,
    c.nIn === r.inputs.length && c.nOut === r.nOut);
  deps.push({
    keyHash: keyHashFor({ chainId, processor: r.processor, circuitId: r.circuitId.toString() }),
    netlistHash: c.netlistHash, r, live: c,
  });
}
// Registry cross-check where address known.
if (REGISTRY) {
  for (const d of deps) {
    const rec = await readRegistration(provider, REGISTRY, d.keyHash);
    check(`registry record live for ${d.r.processor}#${d.r.circuitId}`, !!rec && rec.active);
    if (rec) {
      check('record hash == live hash', (rec.netlistHash || '').toLowerCase() === (d.live.netlistHash || '').toLowerCase());
      d.payee = rec.payee; d.priceWei = rec.priceWei; d.termsHash = rec.termsHash;
    }
  }
} else {
  console.error('[SKIP] registry cross-check: no --registry (event fields still verified)');
}
const recomputed = computeLineageHash({
  targetCpu, nIn, nOut, netlist: nl,
  deps: deps.filter((d) => d.payee).map((d) => ({
    keyHash: d.keyHash, netlistHash: d.netlistHash, payee: d.payee, priceWei: d.priceWei, termsHash: d.termsHash,
  })),
});
if (REGISTRY) check('event lineageHash == recomputed', (ev.lineageHash || '').toLowerCase() === recomputed.toLowerCase(), `event=${ev.lineageHash}`);

// Manufactured circuit read-back (owner must equal tx payer).
const cpu = new ethers.Contract(targetCpu, CIRCUITS_ABI, provider);
const newId = ev.newCircuitId.toString();
const [back, owner] = await Promise.all([cpu.netlist(newId), cpu.ownerOf(newId)]);
check('on-chain netlist == submitted bytes', (back || '').toLowerCase() === nl.toLowerCase());
check('circuit owner == tx payer', (owner || '').toLowerCase() === (tx.from || '').toLowerCase(), `owner=${owner} payer=${tx.from}`);

console.log(JSON.stringify({
  router: ROUTER, tx: TX, txUrl: txUrl(TX), targetCpu, targetUrl: addrUrl(targetCpu),
  newCircuitId: newId, lineageHash: ev.lineageHash, totalPriceWei: ev.totalPriceWei.toString(),
  depCount: Number(ev.depCount), payer: ev.payer,
  recomputedLineageHash: REGISTRY ? recomputed : null,
  failures, ok: failures.length === 0,
}, null, 2));
if (failures.length) process.exit(1);
console.error('[verify-licensed-tapeout] all checks passed');
