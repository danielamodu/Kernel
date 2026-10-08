#!/usr/bin/env node
/**
 * Deploy the AttributionRegistry (or simulate it).
 *
 *   DRY RUN (default-safe, needs NO key, broadcasts NOTHING):
 *     node scripts/phase3/deploy-registry.mjs --dry-run [--wallet 0x..]
 *
 *   LIVE (wallet owner only):
 *     CONFIRM_BROADCAST=1 node scripts/phase3/deploy-registry.mjs [--out state/phase3.json]
 *
 * Dry run prints: target chain, contract, constructor args (none), init-code hash
 * and size, deployment calldata, gas estimate (when WALLET is set), gas cost, and
 * the required balance. Requires `npm run phase3:compile` first (pretest does it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { loadEnv, getProvider, fmtOKB, addrUrl, txUrl, parseArgs, getSigner, requireBroadcastConfirm } from '../phase1/chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(ROOT, 'build', 'AttributionRegistry.json');

loadEnv();
const args = parseArgs();
const DRY = args['dry-run'] !== undefined || /^true|1$/i.test(process.env.DRY_RUN || '');

if (!fs.existsSync(BUILD)) {
  throw new Error('build artifact missing — run `npm run phase3:compile` first (runs automatically as pretest)');
}
const artifact = JSON.parse(fs.readFileSync(BUILD, 'utf8'));
// Root-cause guard (activation incident): refuse to deploy a stale build whose
// sourceHash does not match the current .sol file.
import { createHash as __createHash } from 'node:crypto';
const __srcHash = '0x' + __createHash('sha256').update(
  fs.readFileSync(path.join(ROOT, 'contracts', 'AttributionRegistry.sol'), 'utf8')).digest('hex');
if (__srcHash !== artifact.sourceHash) {
  throw new Error(`stale build: source is ${__srcHash} but artifact is ${artifact.sourceHash} — run npm run phase3:compile`);
}
const initCode = artifact.bytecode; // no constructor args: deployment calldata == init code

if (DRY) {
  console.log('='.repeat(72));
  console.log('DRY RUN — read-only simulation. NOTHING IS BROADCAST. This is NOT a deployment.');
  console.log('='.repeat(72));
  const { provider, rpcUrl } = await getProvider();
  const chainId = (await provider.getNetwork()).chainId;
  console.log(`[net] chainId=${chainId} rpc=${rpcUrl}`);
  if (chainId !== 196n) throw new Error('wrong chain — refusing to plan');
  console.log(`[contract] ${artifact.contractName} (${artifact.sourceFile})`);
  console.log(`[contract] source ${artifact.sourceHash} · ${artifact.compiler}`);
  console.log(`[contract] constructor args: none`);
  console.log(`[contract] init code: ${(initCode.length - 2) / 2} bytes, keccak=${ethers.keccak256(initCode)}`);
  console.log(`[contract] calldata (deployment tx data) = init code above`);
  const wallet = args.wallet || process.env.WALLET || '';
  let gas = null;
  if (/^0[xX][0-9a-fA-F]{40}$/.test(wallet)) {
    try {
      gas = await provider.estimateGas({ from: wallet, data: initCode });
      console.log(`[gas] estimateGas from ${wallet}: ${gas}`);
    } catch (e) {
      console.log(`[warn] estimateGas failed: ${e.shortMessage || e.message}`);
    }
    const bal = await provider.getBalance(wallet);
    console.log(`[wallet] ${wallet} balance=${fmtOKB(bal)}`);
  } else {
    console.log('[gas] set WALLET=0x.. for a gas estimate (read-only eth_estimateGas)');
  }
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice ?? 0n;
  if (gas !== null) console.log(`[total] gas cost ≈ ${fmtOKB(gas * gp)} (@${gp} wei); deployment value = 0 (no payable constructor)`);
  else console.log('[total] fund ~0.005 OKB headroom for a ~2.6 kB init-code deployment (exact figure prints with WALLET set)');
  console.log('DRY RUN COMPLETE — nothing broadcast. See docs/PHASE3.md §activation.');
  process.exit(0);
}

// ---------------- LIVE ----------------
requireBroadcastConfirm('deploy the AttributionRegistry (spends OKB on mainnet)');
const { provider } = await getProvider();
const { signer, address: deployer, balance } = await getSigner(provider);
console.error(`[deploy] deployer ${deployer} balance=${fmtOKB(balance)}`);
const factory = new ethers.ContractFactory(artifact.abi, initCode, signer);
const deployTx = await factory.getDeployTransaction();
const gas = await provider.estimateGas({ ...deployTx, from: deployer });
console.error(`[deploy] gasEstimate=${gas} calldata=${initCode.slice(0, 66)}…(${(initCode.length - 2) / 2}B)`);
const contract = await factory.deploy();
console.error(`[deploy] broadcast ${contract.deploymentTransaction().hash} ${txUrl(contract.deploymentTransaction().hash)}`);
await contract.waitForDeployment();
const addr = await contract.getAddress();
// waitForTransaction (not a single getTransactionReceipt): the receipt may lag
// the deployment promise on some RPCs. Observed once on X Layer (null receipt).
const receipt = await provider.waitForTransaction(contract.deploymentTransaction().hash, 1, 180000);
if (!receipt) throw new Error('receipt unavailable after 180s — check explorer before retrying anything');
console.error(`[deploy] confirmed ${addr} ${addrUrl(addr)} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
// Sanity: code present + slotKey precompile check via static call.
if ((await provider.getCode(addr)) === '0x') throw new Error('no code at deployed address');
const code = (await provider.getCode(addr)).length;
console.log(JSON.stringify({
  chainId: 196, registry: addr, registryUrl: addrUrl(addr),
  deployer, deployTx: contract.deploymentTransaction().hash,
  block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(),
  deployedBytes: code / 2 - 1, sourceHash: artifact.sourceHash,
}, null, 2));
if (args.out !== undefined) {
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'state', 'phase3.json'), JSON.stringify({ registry: addr }, null, 2) + '\n');
  console.error('[deploy] state saved to state/phase3.json');
}
