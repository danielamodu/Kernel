'use strict';
/**
 * Router preflight: offline/read-only validation of a composed circuit against
 * live (or twin) registry state. NEVER broadcasts, NEVER needs a key.
 *
 * preflight({ targetCpu, netlist, nIn, nOut, fetchCircuit, lookupRegistry,
 *             tapeoutFeeWei?, mintQuote? }) →
 *   { allowed, dependencies[], totalPriceWei, lineageHash, manufacture, failures[] }
 *
 * Failure codes (explicit, never silent): UNREGISTERED, INACTIVE, NETLIST_MISMATCH,
 * INVALID_PAYEE, INVALID_PRICE, MISSING_TERMS, MALFORMED_REF, MISSING_DEPENDENCY,
 * PIN_MISMATCH, FEE_UNKNOWN.
 *
 * `fetchCircuit` resolves live netlists (chain-reader); `lookupRegistry` maps
 * slotKey -> record|null (memory twin or on-chain reader). `mintQuote` optionally
 * provides { mintPriceWei, protocolFeeWei } for exact manufacturing math; without
 * it the plan reports manufacture as estimated-from-live-reads when a provider is
 * available, else FEE_UNKNOWN.
 */
const { parseNetlist } = require('../lineage/netlist');
const { slotKey, parseSlotKey } = require('../lineage/identity');
const { keyHashFor } = require('../registry/client');
const { computeLineageHash } = require('./commitment');

function parseSlot(slot) {
  try {
    return parseSlotKey(slot);
  } catch {
    return { chainId: '', processor: '', circuitId: '' };
  }
}

function fail(code, detail) {
  return { code, detail };
}

async function preflight({
  targetCpu, netlist, nIn, nOut, fetchCircuit, lookupRegistry,
  tapeoutFeeWei = null, mintQuote = null, chainId = 196,
}) {
  const failures = [];
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(targetCpu || '')) {
    return { allowed: false, failures: [fail('BAD_TARGET', `bad targetCpu: ${targetCpu}`)] };
  }
  let parsed;
  try {
    parsed = parseNetlist(netlist, nIn);
  } catch (e) {
    return { allowed: false, failures: [fail('MALFORMED_REF', e.message)] };
  }

  // Unique deps, first-appearance order == contract dedup/commitment order.
  const seen = new Set();
  const uniqRefs = [];
  for (const r of parsed.refs) {
    const slot = slotKey({ chainId, processor: r.processor, circuitId: r.circuitId.toString() });
    if (!seen.has(slot)) {
      seen.add(slot);
      uniqRefs.push({ slot, ref: r });
    }
  }

  const dependencies = [];
  let totalPriceWei = 0n;
  for (const { slot, ref } of uniqRefs) {
    const parts = parseSlot(slot);
    const base = {
      slotKey: slot, chainId: parts.chainId, processor: parts.processor, circuitId: parts.circuitId,
    };
    const live = await fetchCircuit({
      chainId: String(chainId), processor: ref.processor, circuitId: ref.circuitId.toString(),
    }).catch((e) => ({ __fetchError: e?.message || String(e) }));
    if (!live || live.__fetchError || typeof live.netlist !== 'string') {
      failures.push(fail('MISSING_DEPENDENCY', `${slot}: ${live?.__fetchError || 'unreadable'}`));
      dependencies.push({ ...base, status: 'missing', reason: live?.__fetchError || 'unreadable' });
      continue;
    }
    // Pin agreement mirrors the contract's early PinMismatch check.
    if (live.nIn !== undefined && (live.nIn !== ref.inputs.length || (live.nOut !== undefined && live.nOut !== ref.nOut))) {
      failures.push(fail('PIN_MISMATCH', `${slot}: REF wants ${ref.inputs.length}/${ref.nOut}, live has ${live.nIn}/${live.nOut}`));
      dependencies.push({ ...base, status: 'pin-mismatch' });
      continue;
    }
    const record = await lookupRegistry(slot).catch((e) => ({ __lookupError: e?.message || String(e) }));
    if (!record) {
      failures.push(fail('UNREGISTERED', slot));
      dependencies.push({ ...base, status: 'unregistered' });
      continue;
    }
    const dep = {
      ...base,
      netlistHash: (live.netlistHash || '').toLowerCase(),
      payee: (record.payee || '').toLowerCase(),
      priceWei: BigInt(record.priceWei).toString(),
      termsHash: (record.termsHash || '').toLowerCase(),
      hashVerified: true,
    };
    if (!record.active) {
      failures.push(fail('INACTIVE', slot));
      dep.status = 'inactive';
    } else if (!dep.netlistHash || dep.netlistHash !== (record.netlistHash || '').toLowerCase()) {
      failures.push(fail('NETLIST_MISMATCH', `${slot}: record ${record.netlistHash} vs live ${dep.netlistHash || 'n/a'}`));
      dep.status = 'mismatch';
    } else if (/^0x0{40}$/.test(dep.payee)) {
      failures.push(fail('INVALID_PAYEE', slot));
      dep.status = 'invalid-payee';
    } else if (!/^0x[0-9a-f]{64}$/.test(dep.termsHash) || dep.termsHash === '0x' + '00'.repeat(32)) {
      failures.push(fail('MISSING_TERMS', slot));
      dep.status = 'missing-terms';
    } else {
      try {
        if (BigInt(dep.priceWei) < 0n) throw new Error('negative');
      } catch {
        failures.push(fail('INVALID_PRICE', `${slot}: ${record.priceWei}`));
        dep.status = 'invalid-price';
        dependencies.push(dep);
        continue;
      }
      dep.status = 'ok';
      totalPriceWei += BigInt(dep.priceWei);
    }
    dependencies.push(dep);
  }

  // Manufacturing math (exact when quote known).
  const own = { nand: parsed.stats.nand, latch: parsed.stats.latch };
  let manufacture = null;
  if (mintQuote && tapeoutFeeWei !== null) {
    const mp = BigInt(mintQuote.mintPriceWei);
    const pf = BigInt(mintQuote.protocolFeeWei);
    let mintValue = BigInt(own.nand) * mp + BigInt(own.latch) * mp;
    if (own.nand > 0) mintValue += pf;
    if (own.latch > 0) mintValue += pf;
    manufacture = {
      nand: own.nand, latch: own.latch,
      mintValueWei: mintValue.toString(),
      tapeoutFeeWei: BigInt(tapeoutFeeWei).toString(),
    };
  } else {
    failures.push(fail('FEE_UNKNOWN', 'mintQuote/tapeoutFeeWei not provided (live reads fill this in prepare script)'));
  }

  const okDeps = dependencies.filter((d) => d.status === 'ok');
  let lineageHash = null;
  if (failures.length === 0) {
    lineageHash = computeLineageHash({
      targetCpu, nIn, nOut, netlist,
      deps: okDeps.map((d) => ({
        keyHash: keyHashFor({ chainId, processor: d.processor, circuitId: d.circuitId }),
        netlistHash: d.netlistHash,
        payee: d.payee,
        priceWei: d.priceWei,
        termsHash: d.termsHash,
      })),
    });
  }
  return {
    allowed: failures.length === 0,
    dependencies,
    totalPriceWei: totalPriceWei.toString(),
    lineageHash,
    manufacture,
    own,
    failures,
  };
}

module.exports = { preflight };
