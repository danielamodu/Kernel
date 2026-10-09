'use strict';
/**
 * Kernel engine façade — the clean application API for ecosystem consumers
 * (builders, explorers, marketplaces, wallets, X Layer apps). Thin composition
 * over the tested modules below; no new logic lives here.
 *
 *   discoverPackage, resolvePackage, resolvePackageVersion  (store)
 *   resolveDependencies                                     (deps)
 *   verifyPackage  ("Kernel Verified" = all checks green)  (verify)
 *   buildManifest                                           (manifest)
 *   getProvenance                                           (provenance)
 *   prepareLicense  (preflight + commitment + calldata)     (router modules)
 *   prepareComposition (parse + audit a candidate netlist)  (lineage)
 *   preparePublish                                          (publish)
 */
const { loadStore, resolvePackageVersion, resolvePackage } = require('./store');
const { resolveDependencies } = require('./deps');
const { verifyComposition } = require('./verify');
const { buildManifest, validateManifest, manifestHash } = require('./manifest');
const { getProvenance } = require('./provenance');
const { buildPackage, packageHash } = require('./package');
const { preflight } = require('../router/preflight');
const { buildLicenseCalldata, requiredValue } = require('../router/client');
const { computeLineageHash } = require('../router/commitment');
const { preparePublish, executePublish } = require('./publish');
const { parseNetlist } = require('../lineage/netlist');
const { audit } = require('../phase1/netlist');
const { maxVersion } = require('./versions');

const discoverPackage = (store, name) => {
  const entry = store.get(name);
  if (!entry) return { status: 'unknown-package', name };
  const versions = entry.versions.map((v) => v.version);
  return { status: 'ok', name, versions, latest: maxVersion(versions) };
};

/**
 * Licensed-flow preparation in one call: preflight + value + calldata.
 * Read-only. Broadcast stays with the caller (licensed-tapeout script / UI wallet).
 */
async function prepareLicense({
  targetCpu, netlist, nIn, nOut, fetchCircuit, lookupRegistry,
  tapeoutFeeWei, mintQuote, chainId = 196,
}) {
  const pf = await preflight({
    targetCpu, netlist, nIn, nOut, fetchCircuit, lookupRegistry,
    tapeoutFeeWei, mintQuote, chainId,
  });
  if (!pf.allowed) return { ...pf, calldata: null, valueWei: null };
  const valueWei = requiredValue({
    totalPriceWei: pf.totalPriceWei, nNand: pf.manufacture.nand, nLatch: pf.manufacture.latch,
    mintPriceWei: mintQuote.mintPriceWei, protocolFeeWei: mintQuote.protocolFeeWei, tapeoutFeeWei,
  });
  return {
    ...pf,
    calldata: buildLicenseCalldata({ targetCpu, netlist, nIn, nOut }),
    valueWei,
  };
}

/** Parse + audit a candidate composition netlist (offline structural check). */
function prepareComposition({ netlist, nIn, nOut }) {
  const parsed = parseNetlist(netlist, nIn);
  const audited = audit(netlist, nIn, nOut);
  return { parsed, audited };
}

module.exports = {
  // discover / resolve
  loadStore, discoverPackage, resolvePackage, resolvePackageVersion,
  // compose
  resolveDependencies, prepareComposition,
  // prove
  verifyComposition, buildManifest, validateManifest, manifestHash, getProvenance,
  // license
  preflight, prepareLicense, buildLicenseCalldata, requiredValue, computeLineageHash,
  // publish
  buildPackage, packageHash, preparePublish, executePublish,
};
