'use strict';
/**
 * Minimal in-process EVM harness (@ethereumjs/vm v10) for router execution tests.
 * Test-only helper (not a .test.js file). Funded EOAs, deployment, calls, receipts.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createVM, runTx } = require('@ethereumjs/vm');
const { SimpleStateManager } = require('@ethereumjs/statemanager');
const { createTx } = require('@ethereumjs/tx');
const {
  Account, Address, createAddressFromPrivateKey, hexToBytes, bytesToHex,
} = require('@ethereumjs/util');
const { ethers } = require('ethers');

const BUILD = path.join(__dirname, '..', '..', 'build');
const artifact = (name) => JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.json`), 'utf8'));

const GAS_PRICE = 1000000000n;
const GAS_LIMIT = 10000000n;

async function createHarness() {
  const stateManager = new SimpleStateManager();
  const vm = await createVM({ stateManager });
  const nonces = new Map();
  const keys = new Map();

  function eoa(seedByte) {
    const pk = new Uint8Array(32).fill(0);
    pk[31] = seedByte;
    const addr = createAddressFromPrivateKey(pk);
    keys.set(addr.toString(), pk);
    nonces.set(addr.toString(), 0n);
    return addr;
  }

  async function fund(addr, balance) {
    await stateManager.putAccount(addr, new Account(0n, balance));
  }

  async function balanceOf(addr) {
    const acct = await stateManager.getAccount(addr);
    return acct ? BigInt(acct.balance) : 0n;
  }

  async function send({ from, to, data, value }) {
    const fromStr = from.toString();
    const nonce = nonces.get(fromStr) ?? 0n;
    const tx = createTx(
      {
        nonce,
        gasPrice: GAS_PRICE,
        gasLimit: GAS_LIMIT,
        to: to ? bytesToHex(to.bytes) : undefined,
        value: value ?? 0n,
        data: data ? hexToBytes(data) : undefined,
      },
      { chain: 'mainnet' },
    );
    nonces.set(fromStr, nonce + 1n);
    const res = await runTx(vm, { tx: tx.sign(keys.get(fromStr)), skipBalance: false });
    const receipt = res.receipt;
    const rawLogs = receipt.logs || [];
    const logs = rawLogs.map((l) => { // tuple [address, topics[], data] (Uint8Array)
      const arr = Array.isArray(l) ? l : [l.address, l.topics, l.data];
      return {
        address: bytesToHex(arr[0]),
        topics: arr[1].map((t) => bytesToHex(t)),
        data: bytesToHex(arr[2]),
      };
    });
    return {
      status: Number(receipt.status),
      gasUsed: res.totalGasSpent,
      logs,
      returnValue: bytesToHex(res.execResult?.returnValue ?? new Uint8Array(0)),
      createdAddress: res.createdAddress ? bytesToHex(res.createdAddress.bytes) : null,
    };
  }

  async function deploy(from, name, ...ctorArgs) {
    const art = artifact(name);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const types = (art.abi.find((e) => e.type === 'constructor') || { inputs: [] }).inputs.map((i) => i.type);
    const initCode = art.bytecode + (types.length ? coder.encode(types, ctorArgs).slice(2) : '');
    const r = await send({ from, data: initCode });
    if (r.status !== 1 || !r.createdAddress) throw new Error(`deploy ${name} failed (status ${r.status})`);
    return { address: r.createdAddress, receipt: r };
  }

  return {
    vm, stateManager, eoa, fund, balanceOf, send, deploy, GAS_PRICE, Address,
  };
}

module.exports = { createHarness, artifact };
