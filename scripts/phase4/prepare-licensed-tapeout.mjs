#!/usr/bin/env node
/**
 * Prepare a licensed tape-out: full READ/PREPARE pipeline, NEVER broadcasts.
 * Usage:
 *   node scripts/phase4/prepare-licensed-tapeout.mjs [--target 0x..] [--registry 0x..]
 *     [--router 0x..] [--root-fixture tests/phase4/fixtures/demo-root-trace.json]
 *     [--wallet 0x..] [--out reports/phase4-plan.json]
 * No private key needed, no safety gate needed (nothing is sent).
 * Prints the Licensed TapeOut Plan + machine JSON. Ends with Broadcast: BLOCKED
 * (broadcasting lives in licensed-tapeout.mjs behind dual safety gates).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import {
  loadEnv, getProvider, fmtOKB, addrUrl, parseArgs,
  CIRCUITS_ABI, TRANSISTORS_ABI, FACTORY, FACTORY_ABI,
} from '../phase1/chain.mjs';

const require = createRequire(import.meta.url);
const { audit } = require('../../src/phase1/netlist.js');
const reader = require('../../src/lineage/chain-reader.js');
const { keyHashFor, readRegistration } = require('../../src/registry/client.js');
const { preflight } = require('../../src/router/preflight.js');
const { buildLicenseCalldata, requiredValue } = require('../../src/router/client.js');

loadEnv();
const args = parseArgs();
const TARGET = args.target || process.env.TARGET_PROCESSOR || '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a'; // TRACE
const REGISTRY = args.registry || process.env.REGISTRY || '';
const ROUTER = args.router || process.env.ROUTER || '';
const FIXTURE = args['root-fixture'] || 'tests/phase4/fixtures/demo-root-trace.json';
const WALLET = args.wallet || process.env.WALLET || '';

const { provider, rpcUrl } = await getProvider();
const chainId = Number((await provider.getNetwork()).chainId);
console.log(`X Layer read-only @ ${rpcUrl} (chain ${chainId})`);

// 1-2. Root circuit bytes (canonical demo fixture; re-encoded to prove determinism).
const fix = JSON.parse(fs.readFileSync(path.resolve(FIXTURE), 'utf8'));
console.log(`Root fixture: ${FIXTURE} [${fix.label}] — ${fix.note}`);
const { encodeRef } = require('../../src/lineage/ref.js');
const { parseNetlist } = require('../../src/lineage/netlist.js');
const parsed = parseNetlist(fix.netlist, fix.nIn);
if (parsed.refs.length !== fix.refs.length) throw new Error('fixture refs disagree with netlist parse');
for (const r of parsed.refs) {
  const rebuilt = encodeRef({ processor: r.processor, circuitId: r.circuitId.toString(), inputs: r.inputs, nOut: r.nOut });
  const orig = '0x' + fix.netlist.slice(2 + r.offset * 2, 2 + (r.offset + r.length) * 2);
  if (rebuilt.toLowerCase() !== orig.toLowerCase()) throw new Error(`REF#${r.index} not reproducible from encoder`);
}
console.log(`Root reproducibility: all ${parsed.refs.length} REF record(s) re-encode byte-identical`);
const a = audit(fix.netlist, fix.nIn, fix.nOut);
console.log(`Root netlist: ${fix.netlist} (${a.byteLength}B, sha256 logged in JSON)`);
console.log(`Root audit: ${a.nNand} NAND, ${a.nLatch} LATCH, ${a.refCount} REF, outputs ${JSON.stringify(a.outputs)}`);

// Target processor + factory checks (read-only).
const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
const cpu = new ethers.Contract(TARGET, CIRCUITS_ABI, provider);
const [isCPU, transistors, tapeoutFee, nextId] = await Promise.all([
  factory.isCPU(TARGET), cpu.transistors(), cpu.TAPEOUT_FEE(), cpu.nextId(),
]);
console.log(`Target processor ${TARGET} ${addrUrl(TARGET)}: isCPU=${isCPU}, nextId=${nextId}, TAPEOUT_FEE=${fmtOKB(tapeoutFee)}`);
if (!isCPU) throw new Error('target is not a factory-registered processor — plan halted');
const mat = new ethers.Contract(transistors, TRANSISTORS_ABI, provider);
const [mintPrice, protocolFee, supplyCap, minted] = await Promise.all([
  mat.mintPrice(), mat.protocolFee(), mat.supplyCap(), mat.minted(),
]);
console.log(`Material ${transistors}: mintPrice=${fmtOKB(mintPrice)}/u protocolFee=${fmtOKB(protocolFee)}/call minted=${minted}/${supplyCap}`);

// 3-4. Lineage: live dependency reads for every REF in the root.
for (const r of parsed.refs) {
  const c = await reader.getCircuit(r.processor, r.circuitId.toString());
  console.log(`Dep ${r.processor}#${r.circuitId}: ${c ? `live nIn=${c.nIn} nOut=${c.nOut} hash=${c.netlistHash}` : 'MISSING on chain'}`);
}

// 5-7. Registry + preflight (needs --registry; otherwise honest NOT_PRICED plan).
let plan;
if (!REGISTRY) {
  console.log('\nRegistry: NOT_CONFIGURED — lineage shown, but prices/validation need --registry.');
  console.log('Broadcast: BLOCKED (no registry; see licensed-tapeout.mjs for the gated flow)');
  plan = { registry: null, broadcast: 'BLOCKED' };
} else {
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
  for (const d of pf.dependencies) {
    console.log(`Dep ${d.processor}#${d.circuitId}: status=${d.status} payee=${d.payee || 'n/a'} price=${d.priceWei ? fmtOKB(d.priceWei) : 'n/a'} hashVerified=${d.hashVerified ?? 'n/a'}`);
  }
  if (!pf.allowed) {
    console.log(`\nPreflight: BLOCKED — ${pf.failures.map((f) => `${f.code} ${f.detail}`).join('; ')}`);
    plan = { allowed: false, failures: pf.failures, broadcast: 'BLOCKED' };
  } else {
    // 8-9. Calldata + value + gas.
    const data = buildLicenseCalldata({ targetCpu: TARGET, netlist: fix.netlist, nIn: fix.nIn, nOut: fix.nOut });
    const value = requiredValue({
      totalPriceWei: pf.totalPriceWei, nNand: pf.manufacture.nand, nLatch: pf.manufacture.latch,
      mintPriceWei: mintPrice.toString(), protocolFeeWei: protocolFee.toString(), tapeoutFeeWei: tapeoutFee.toString(),
    });
    console.log(`\nLicensed TapeOut Plan\nRoot: processor ${TARGET}, NEW circuit (nextId now ${nextId})`);
    console.log(`Dependencies: ${pf.dependencies.length}, total license payment ${fmtOKB(pf.totalPriceWei)}`);
    console.log(`TapeOut fee: ${fmtOKB(tapeoutFee)}, mint value: ${fmtOKB(BigInt(value) - BigInt(pf.totalPriceWei) - tapeoutFee)}`);
    console.log(`Total required: ${fmtOKB(value)} (exact — router rejects anything else)`);
    console.log(`lineageHash: ${pf.lineageHash}`);
    console.log(`calldata: ${data.slice(0, 74)}…(${(data.length - 2) / 2}B)`);
    if (ROUTER && WALLET) {
      try {
        const gas = await provider.estimateGas({ from: WALLET, to: ROUTER, data, value });
        console.log(`Estimated gas (live, via router ${ROUTER}): ${gas}`);
      } catch (e) {
        console.log(`Gas estimate failed (read-only revert — fix cause before funding): ${e.shortMessage || e.message}`);
      }
    } else {
      console.log('Estimated gas: n/a without --router/--wallet (EVM-stub reference for this shape: ~307k; NOT an X Layer estimate)');
    }
    console.log('Broadcast: BLOCKED — CONFIRM_LICENSED_TAPEOUT != 1 (see scripts/phase4/licensed-tapeout.mjs)');
    plan = {
      allowed: true, targetCpu: TARGET, registry: REGISTRY,
      dependencies: pf.dependencies, totalPriceWei: pf.totalPriceWei,
      manufacture: pf.manufacture, lineageHash: pf.lineageHash,
      calldata: data, valueWei: value, broadcast: 'BLOCKED',
    };
  }
}

const out = {
  chainId, rpcUrl, target: TARGET, targetUrl: addrUrl(TARGET),
  rootFixture: FIXTURE, rootNetlist: fix.netlist,
  tapeoutFeeWei: tapeoutFee.toString(),
  mint: { priceWei: mintPrice.toString(), protocolFeeWei: protocolFee.toString(), minted: minted.toString(), supplyCap: supplyCap.toString() },
  plan,
};
console.log('\n--- JSON ---');
console.log(JSON.stringify(out, null, 2));
if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), JSON.stringify(out, null, 2) + '\n');
  console.error(`[prepare] plan wrote ${args.out}`);
}
