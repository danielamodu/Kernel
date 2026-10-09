'use strict';
/**
 * Shared harness for kernel tests: fixture maps, memory registry, package store.
 * (Helper module, not a test file.)
 */
const path = require('node:path');
const fs = require('node:fs');
const { MemoryRegistry } = require('../../src/registry/memory');
const { keyHashFor } = require('../../src/registry/client');
const { hashTerms } = require('../../src/registry/terms');
const { loadStore } = require('../../src/kernel/store');

const FIXDIR = path.join(__dirname, '..', 'phase2', 'fixtures');
const fix = (n) => JSON.parse(fs.readFileSync(path.join(FIXDIR, n), 'utf8'));

const A = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x1d207352dd708498cada1524eb4b36b5fa178886';
const BY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIVE_HASH = '0x' + 'ab'.repeat(32);
const TERMS = hashTerms({ version: 1, model: 'single-license', priceWei: '100', currency: 'OKB', attributionRequired: true });

const store = () => loadStore(path.join(__dirname, '..', '..', 'packages'));

/** fetch serving a fixture root + map (or overrides); unknown slots => null. */
function fixtureFetch(fix, { hash = LIVE_HASH, extra = {} } = {}) {
  const map = { ...(fix.circuits || {}), ...extra };
  if (fix.root) map[`${fix.root.processor.toLowerCase()}:${fix.root.circuitId}`] = fix.root;
  return async ({ processor, circuitId }) => {
    const hit = map[`${String(processor).toLowerCase()}:${circuitId}`];
    return hit ? { ...hit, netlistHash: hash } : null;
  };
}

function memLookup(mem) {
  return async (slot) => {
    const m = slot.match(/^tapeout:v1:([0-9]+):(0x[0-9a-f]{40}):([0-9]+)$/);
    if (!m) return null;
    return mem.getRegistration(keyHashFor({ chainId: m[1], processor: m[2], circuitId: m[3] }));
  };
}

function registerDep(mem, proc, id, over = {}) {
  return mem.register({
    chainId: 196, processor: proc, circuitId: id, netlistHash: LIVE_HASH,
    payee: PAYEE, priceWei: '100', termsHash: TERMS, by: BY, ...over,
  });
}

module.exports = { fix, store, fixtureFetch, memLookup, registerDep, A, PAYEE, BY, LIVE_HASH, TERMS };
