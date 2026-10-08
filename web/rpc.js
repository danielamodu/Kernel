'use strict';
/* Minimal X Layer JSON-RPC + ABI codec. Dependency-free on purpose: the UI only
 * needs a fixed set of view calls whose layouts are pinned in tests. Anything
 * that fails to decode is reported as unavailable, never guessed. */
const RPC_URL = KERNEL_SNAPSHOT.rpc;

let _rpcId = 1;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.okx.com', Referer: 'https://www.okx.com/' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'rpc error');
  return body.result;
}

const strip0x = (h) => (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h);
const pad64 = (hex) => hex.padStart(64, '0');
function encAddr(a) { return pad64(strip0x(a).toLowerCase()); }
function encUint(v) { return pad64(BigInt(v).toString(16)); }
function encBytes32(h) { return pad64(strip0x(h).toLowerCase()); }

async function ethCall(to, data, tag = 'latest') {
  return rpc('eth_call', [{ to, data }, tag]);
}
function word(hex, i) { return BigInt('0x' + strip0x(hex).slice(i * 64, i * 64 + 64)); }
function decAddrWord(hex, i) { return '0x' + strip0x(hex).slice(i * 64 + 24, i * 64 + 64); }
function decBytes(hex) {
  // ABI dynamic bytes: [offset][length][padded data]
  const h = strip0x(hex);
  const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return '0x' + h.slice(off + 64, off + 64 + len * 2);
}
function decCircuitInfo(hex) {
  return { nIn: word(hex, 0), nOut: word(hex, 1), nState: word(hex, 2), gateCount: word(hex, 3) };
}
function decRecord(hex) {
  // AttributionRegistry.Record: bytes32,address,uint256,bytes32,uint64,address,bool,bool
  const h = strip0x(hex);
  const w = (i) => h.slice(i * 64, i * 64 + 64);
  return {
    netlistHash: '0x' + w(0),
    payee: '0x' + w(1).slice(24),
    priceWei: BigInt('0x' + w(2)).toString(),
    termsHash: '0x' + w(3),
    registeredAt: BigInt('0x' + w(4)).toString(),
    registeredBy: '0x' + w(5).slice(24),
    active: w(6) !== '0'.repeat(64),
    exists: w(7) !== '0'.repeat(64),
  };
}

const S = KERNEL_SELECTORS;
const Live = {
  async blockNumber() { return rpc('eth_blockNumber', []); },
  async balance(addr) { return rpc('eth_getBalance', [addr, 'latest']); },
  async code(addr) { return rpc('eth_getCode', [addr, 'latest']); },
  async receipt(hash) { return rpc('eth_getTransactionReceipt', [hash]); },
  async tx(hash) {
    const t = await rpc('eth_getTransactionByHash', [hash]);
    if (!t) throw new Error('tx not found');
    return t;
  },
  async isCPU(processor) {
    const r = await ethCall(KERNEL_SNAPSHOT.factory, S.isCPU + encAddr(processor));
    return word(r, 0) === 1n;
  },
  async nextId(processor) {
    return (await ethCall(processor, S.nextId).then((r) => word(r, 0))).toString();
  },
  async circuitInfo(processor, id) {
    return decCircuitInfo(await ethCall(processor, S.circuitInfo + encUint(id)));
  },
  async netlist(processor, id) {
    return decBytes(await ethCall(processor, S.netlist + encUint(id)));
  },
  async ownerOf(processor, id) {
    return decAddrWord(await ethCall(processor, S.ownerOf + encUint(id)), 0);
  },
  async tapeoutFee(processor) {
    return word(await ethCall(processor, S.TAPEOUT_FEE), 0).toString();
  },
  async registration(registry, keyHash) {
    const r = await ethCall(registry, S.getRegistration + encBytes32(keyHash));
    const rec = decRecord(r);
    if (!rec.exists) throw new Error('NotRegistered');
    return rec;
  },
  async isRegistered(registry, keyHash) {
    return word(await ethCall(registry, S.isRegistered + encBytes32(keyHash)), 0) === 1n;
  },
};
