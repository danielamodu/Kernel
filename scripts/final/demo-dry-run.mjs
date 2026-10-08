#!/usr/bin/env node
/**
 * FINAL LICENSED TAPE-OUT -- DRY RUN. The single end-to-end demo command.
 *   npm run demo:dry-run
 *   node scripts/final/demo-dry-run.mjs [--registry 0x..] [--router 0x..] [--wallet 0x..]
 * READ-ONLY. No signer is created, no key is read, nothing is broadcast.
 * Without --registry it validates against the deterministic EXPECTED registry
 * configuration from fixtures/final/demo-root.json, labeled NOT_DEPLOYED.
 * Gas estimates print ONLY with --router + --wallet explicitly supplied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { loadEnv, getProvider, fmtOKB, parseArgs, CIRCUITS_ABI, TRANSISTORS_ABI } from '../../scripts/phase1/chain.mjs';

const require = createRequire(import.meta.url);
const { parseNetlist } = require('../../src/lineage/netlist.js');
const { slotKey } = require('../../src/lineage/identity.js');
const { resolveLineage } = require('../../src/lineage/resolver.js');
const reader = require('../../src/lineage/chain-reader.js');
const { keyHashFor, readRegistration } = require('../../src/registry/client.js');
const { hashTerms } = require('../../src/registry/terms.js');
const { preflight } = require('../../src/router/preflight.js');
const { buildLicenseCalldata, requiredValue } = require('../../src/router/client.js');
const { computeLineageHash } = require('../../src/router/commitment.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

loadEnv();
const args = parseArgs();
const REGISTRY = args.registry || process.env.REGISTRY || '';
const ROUTER = args.router || process.env.ROUTER || '';
const WALLET = args.wallet || process.env.WALLET || '';
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'final', 'demo-root.json'), 'utf8'));

const L = console.log;
L('========================================');
L('FINAL LICENSED TAPE-OUT -- DRY RUN');
L('========================================');
L('Nothing is signed. Nothing is broadcast. No key required.');
L('');
L('Chain:');
L('X Layer (196)');

// 1-2. Load + parse.
const parsed = parseNetlist(FIX.netlist, FIX.nIn);
L('');
L('Root circuit:');
L('Prepared demo root (fixtures/final/demo-root.json)');
L(`  netlist: ${FIX.netlist.slice(0, 50)}... (${(FIX.netlist.length - 2) / 2}B)`);
L(`  gates: ${parsed.stats.nand} NAND, ${parsed.stats.latch} LATCH, ${parsed.stats.ref} REF`);

// 3-5. Lineage (live) + identity + live TapeOut reads.
const { provider, rpcUrl } = await getProvider();
const chainId = Number((await provider.getNetwork()).chainId);
if (chainId !== 196) throw new Error(`wrong chain ${chainId} -- refusing to plan`);
const dep = FIX.dependencies[0];
const slot = slotKey({ chainId, processor: dep.processor, circuitId: dep.circuitId });
L('');
L('Dependency:');
L('TRACE #1');
L('Dependency identity:');
L(slot);
const live = await reader.getCircuit(dep.processor, dep.circuitId);
if (!live) throw new Error('TRACE #1 unreadable -- RPC issue (circuits are immutable; retry, do not proceed blind)');
L('Dependency netlist hash:');
L(live.netlistHash);
L(`  live nIn=${live.nIn} nOut=${live.nOut} owner=${live.owner}`);
L(`  hash vs fixture expectation: ${live.netlistHash.toLowerCase() === dep.netlistHashExpected.toLowerCase() ? 'MATCH (VERIFIED LIVE)' : 'MISMATCH -- STOP'}`);
if (live.netlistHash.toLowerCase() !== dep.netlistHashExpected.toLowerCase()) process.exit(1);
// Closure: resolve FROM the live dep (must terminate dep-free).
const closure = await resolveLineage(
  { processor: dep.processor, circuitId: dep.circuitId },
  { fetchCircuit: reader.fetchCircuitForResolver, chainId },
);
L(`  lineage closure: ${closure.stats.nodeCount} node(s), ${closure.stats.edgeCount} edge(s), depth ${closure.depth}`);

// 6-7. Registry: live if configured, else expected config labeled NOT_DEPLOYED.
let record = null;
let registryMode;
if (REGISTRY) {
  registryMode = 'LIVE';
  record = await readRegistration(provider, REGISTRY, keyHashFor({ chainId, processor: dep.processor, circuitId: dep.circuitId }));
  L('');
  L(`Registry: LIVE at ${REGISTRY}`);
  L(`  record: ${record ? `active=${record.active} payee=${record.payee} price=${record.priceWei}` : 'ABSENT (unregistered)'}`);
} else {
  registryMode = 'NOT_DEPLOYED';
  record = {
    netlistHash: dep.netlistHashExpected, payee: dep.payeeExpected,
    priceWei: dep.priceWeiExpected, termsHash: dep.termsHash, active: true,
  };
  L('');
  L('Registry:');
  L('NOT DEPLOYED -- FUNDING REQUIRED');
  L('  using deterministic EXPECTED configuration from the fixture (not chain state)');
}

// 8-10. Validate + terms + lineageHash + payment.
const lookup = async (s) => {
  if (registryMode === 'LIVE') {
    const m = s.match(/^tapeout:v1:([0-9]+):(0x[0-9a-f]{40}):([0-9]+)$/);
    return readRegistration(provider, REGISTRY, keyHashFor({ chainId: m[1], processor: m[2], circuitId: m[3] }));
  }
  return s === slot ? record : null;
};
const fetchCircuit = async (ref) => {
  const c = await reader.getCircuit(ref.processor, ref.circuitId);
  return c ? { netlist: c.netlist, nIn: c.nIn, nOut: c.nOut, netlistHash: c.netlistHash } : null;
};
const cpuAbi = CIRCUITS_ABI;
const transAbi = TRANSISTORS_ABI;
const cpu = new ethers.Contract(FIX.targetProcessor, cpuAbi, provider);
const [transistors, tapeoutFee] = await Promise.all([cpu.transistors(), cpu.TAPEOUT_FEE()]);
const mat = new ethers.Contract(transistors, transAbi, provider);
const [mintPrice, protocolFee] = await Promise.all([mat.mintPrice(), mat.protocolFee()]);
const pf = await preflight({
  targetCpu: FIX.targetProcessor, netlist: FIX.netlist, nIn: FIX.nIn, nOut: FIX.nOut,
  fetchCircuit, lookupRegistry: lookup,
  tapeoutFeeWei: tapeoutFee.toString(),
  mintQuote: { mintPriceWei: mintPrice.toString(), protocolFeeWei: protocolFee.toString() },
  chainId,
});
const termsHash = hashTerms(dep.termsExpected);
L('');
L('License terms:');
L(`${dep.termsExpected.model} / ${dep.termsExpected.currency} / ${dep.termsExpected.attributionRequired ? 'attribution-required' : 'no-attribution'}`);
L(`  termsHash recomputed: ${termsHash}`);
L(`  termsHash expected:   ${dep.termsHash}`);
L(`  ${termsHash.toLowerCase() === dep.termsHash.toLowerCase() ? 'MATCH' : 'MISMATCH -- STOP'}`);
if (!pf.allowed) {
  L('');
  L(`Preflight: BLOCKED -- ${pf.failures.map((f) => `${f.code}: ${f.detail}`).join('; ')}`);
  process.exit(1);
}
L('');
L('Preflight: ALLOWED (all checks pass against ' + registryMode + ' registry state)');
L('');
L('License price:');
L(fmtOKB(pf.totalPriceWei));
L('');
L('TapeOut fee:');
L(fmtOKB(tapeoutFee));
const value = requiredValue({
  totalPriceWei: pf.totalPriceWei, nNand: pf.manufacture.nand, nLatch: pf.manufacture.latch,
  mintPriceWei: mintPrice.toString(), protocolFeeWei: protocolFee.toString(), tapeoutFeeWei: tapeoutFee.toString(),
});
L('');
L('Estimated total:');
L(`${fmtOKB(value)} + gas`);
L('');
L('Lineage hash:');
L(pf.lineageHash);
L(`  fixture expectation: ${FIX.lineageHash}`);
L(`  ${pf.lineageHash.toLowerCase() === FIX.lineageHash.toLowerCase() ? 'MATCH' : 'MISMATCH -- STOP'}`);

// 11-12. Calldata + gas only with explicit router/wallet.
const data = buildLicenseCalldata({ targetCpu: FIX.targetProcessor, netlist: FIX.netlist, nIn: FIX.nIn, nOut: FIX.nOut });
L('');
L('Router calldata:');
L(`${data.slice(0, 74)}... (${(data.length - 2) / 2}B)`);
L('');
L('Router:');
if (ROUTER && WALLET) {
  try {
    const gas = await provider.estimateGas({ from: WALLET, to: ROUTER, data, value });
    L(`${ROUTER} -- live gas estimate from ${WALLET}: ${gas}`);
  } catch (e) {
    L(`${ROUTER} -- estimate REVERTED (read-only): ${e.shortMessage || e.message} -- fix cause before funding`);
  }
} else {
  L(REGISTRY ? 'SET --router + --wallet for a live gas estimate (EVM-stub reference for this shape: ~307k; NOT an X Layer estimate)' : 'NOT DEPLOYED -- FUNDING REQUIRED');
}
L('');
L('Broadcast:');
L('BLOCKED');
L('');
L('========================================');
