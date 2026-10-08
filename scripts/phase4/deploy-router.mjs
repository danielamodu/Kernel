#!/usr/bin/env node
/**
 * Deploy LicensedTapeoutRouter (or simulate it).
 *   Dry run (needs NO key): node scripts/phase4/deploy-router.mjs --dry-run [--registry 0x..] [--wallet 0x..]
 *   Live (owner only): CONFIRM_BROADCAST=1 node scripts/phase4/deploy-router.mjs --registry 0x.. [--out state/phase4-router.json]
 * Constructor: (registry, factory[X Layer 0x1f09…0761]). No other args.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  loadEnv, getProvider, getSigner, requireBroadcastConfirm,
  FACTORY, fmtOKB, addrUrl, txUrl, parseArgs,
} from '../phase1/chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(ROOT, 'build', 'LicensedTapeoutRouter.json');

loadEnv();
const args = parseArgs();
const DRY = args['dry-run'] !== undefined || /^true|1$/i.test(process.env.DRY_RUN || '');
const REGISTRY = args.registry || process.env.REGISTRY || '';

if (!fs.existsSync(BUILD)) throw new Error('build artifact missing — run npm run phase3:compile first');
const artifact = JSON.parse(fs.readFileSync(BUILD, 'utf8'));
import { createHash as __createHash } from 'node:crypto';
const __srcHash = '0x' + __createHash('sha256').update(
  fs.readFileSync(path.join(ROOT, 'contracts', 'LicensedTapeoutRouter.sol'), 'utf8')).digest('hex');
if (__srcHash !== artifact.sourceHash) {
  throw new Error(`stale build: source is ${__srcHash} but artifact is ${artifact.sourceHash} — run npm run phase3:compile`);
}

if (DRY) {
  console.log('='.repeat(72));
  console.log('DRY RUN — read-only simulation. NOTHING IS BROADCAST. This is NOT a deployment.');
  console.log('='.repeat(72));
  const { provider, rpcUrl } = await getProvider();
  const chainId = (await provider.getNetwork()).chainId;
  console.log(`[net] chainId=${chainId} rpc=${rpcUrl}`);
  if (chainId !== 196n) throw new Error('wrong chain — refusing to plan');
  console.log(`[contract] LicensedTapeoutRouter (${artifact.sourceFile})`);
  console.log(`[contract] source ${artifact.sourceHash} · ${artifact.compiler}`);
  console.log(`[contract] constructor args: registry=${REGISTRY || '<--registry 0x..>'} factory=${FACTORY}`);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const initCode = artifact.bytecode + (REGISTRY
    ? coder.encode(['address', 'address'], [REGISTRY, FACTORY]).slice(2)
    : '<registry-dependent>');
  console.log(`[contract] init code: ${artifact.bytecode.length / 2 - 1}B + 64B args, keccak=${REGISTRY ? ethers.keccak256(initCode) : 'n/a'}`);
  const wallet = args.wallet || process.env.WALLET || '';
  if (REGISTRY && /^0[xX][0-9a-fA-F]{40}$/.test(wallet)) {
    try {
      const gas = await provider.estimateGas({ from: wallet, data: initCode });
      console.log(`[gas] estimateGas from ${wallet}: ${gas}`);
      const fee = await provider.getFeeData();
      console.log(`[total] gas cost ≈ ${fmtOKB(gas * (fee.gasPrice ?? 0n))}; deployment value = 0`);
    } catch (e) {
      console.log(`[warn] estimateGas failed: ${e.shortMessage || e.message}`);
    }
    console.log(`[wallet] balance=${fmtOKB(await provider.getBalance(wallet))}`);
  } else {
    console.log('[gas] set --registry + WALLET=0x.. for a live gas estimate');
  }
  console.log('DRY RUN COMPLETE — nothing broadcast.');
  process.exit(0);
}

requireBroadcastConfirm('deploy the LicensedTapeoutRouter (spends OKB on mainnet)');
if (!REGISTRY) throw new Error('live deploy needs --registry 0x.. (deploy it first, or use the Phase 3 script)');
const { provider } = await getProvider();
const { signer, address: deployer, balance } = await getSigner(provider);
console.error(`[deploy] deployer ${deployer} balance=${fmtOKB(balance)}`);
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
const contract = await factory.deploy(REGISTRY, FACTORY);
console.error(`[deploy] broadcast ${contract.deploymentTransaction().hash} ${txUrl(contract.deploymentTransaction().hash)}`);
await contract.waitForDeployment();
const addr = await contract.getAddress();
const receipt = await provider.waitForTransaction(contract.deploymentTransaction().hash, 1, 180000);
if (!receipt) throw new Error('receipt unavailable after 180s — check explorer before retrying anything');
console.error(`[deploy] confirmed ${addr} ${addrUrl(addr)} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
if ((await provider.getCode(addr)) === '0x') throw new Error('no code at deployed address');
const deployed = { chainId: 196, router: addr, routerUrl: addrUrl(addr), registry: REGISTRY, factory: FACTORY, deployer, deployTx: contract.deploymentTransaction().hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(), sourceHash: artifact.sourceHash };
console.log(JSON.stringify(deployed, null, 2));
if (args.out !== undefined) {
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'state', 'phase4-router.json'), JSON.stringify(deployed, null, 2) + '\n');
  console.error('[deploy] state saved to state/phase4-router.json');
}
