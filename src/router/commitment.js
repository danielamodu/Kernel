'use strict';
/**
 * Lineage commitment: deterministic keccak256 over the EXACT abi.encode layout the
 * LicensedTapeoutRouter computes on-chain:
 *
 *   keccak256(abi.encode(
 *     targetCpu, nIn, nOut, keccak256(nl),
 *     keyHashes[], netlistHashes[], payees[], prices[], termsHashes[]
 *   ))
 *
 * Dependency order = first appearance in netlist (the contract's dedup order).
 * Same bytes + same registry state → same hash, on- or off-chain. Any change to
 * netlist, pins (via hashes), payee, price, or terms changes the hash.
 */
const { ethers } = require('ethers');

function computeLineageHash({ targetCpu, nIn, nOut, netlist, deps }) {
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(targetCpu)) throw new Error(`commitment: bad targetCpu: ${targetCpu}`);
  if (!/^0[xX]([0-9a-fA-F]{2})+$/.test(netlist)) throw new Error('commitment: bad netlist hex');
  if (!Array.isArray(deps)) throw new Error('commitment: deps must be an array');
  const norm = deps.map((d, i) => {
    for (const f of ['keyHash', 'netlistHash', 'payee', 'priceWei', 'termsHash']) {
      if (d[f] === undefined) throw new Error(`commitment: dep ${i} missing ${f}`);
    }
    if (!/^0[xX][0-9a-fA-F]{64}$/.test(d.keyHash)) throw new Error(`commitment: dep ${i} bad keyHash`);
    if (!/^0[xX][0-9a-fA-F]{64}$/.test(d.netlistHash)) throw new Error(`commitment: dep ${i} bad netlistHash`);
    if (!/^0[xX][0-9a-fA-F]{40}$/.test(d.payee)) throw new Error(`commitment: dep ${i} bad payee`);
    if (!/^0[xX][0-9a-fA-F]{64}$/.test(d.termsHash)) throw new Error(`commitment: dep ${i} bad termsHash`);
    let priceWei;
    try {
      if (typeof d.priceWei !== 'string') throw new Error('not a string');
      priceWei = BigInt(d.priceWei).toString();
      if (BigInt(priceWei) < 0n) throw new Error('negative');
    } catch (e) {
      throw new Error(`commitment: dep ${i} bad priceWei (${/not a string|negative/.test(e.message) ? e.message : 'not a uint'})`);
    }
    return {
      keyHash: '0x' + d.keyHash.slice(2).toLowerCase(),
      netlistHash: '0x' + d.netlistHash.slice(2).toLowerCase(),
      payee: '0x' + d.payee.slice(2).toLowerCase(),
      priceWei,
      termsHash: '0x' + d.termsHash.slice(2).toLowerCase(),
    };
  });
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(coder.encode(
    ['address', 'uint32', 'uint32', 'bytes32', 'bytes32[]', 'bytes32[]', 'address[]', 'uint256[]', 'bytes32[]'],
    [
      targetCpu.toLowerCase(), Number(nIn), Number(nOut), ethers.keccak256(netlist),
      norm.map((d) => d.keyHash), norm.map((d) => d.netlistHash), norm.map((d) => d.payee),
      norm.map((d) => d.priceWei), norm.map((d) => d.termsHash),
    ],
  ));
}

module.exports = { computeLineageHash };
