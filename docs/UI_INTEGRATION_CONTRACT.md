# UI Integration Contract — Kernel engine (`src/kernel/index.js`)

Audience: the UI agent. This is the exact, tested interface. Every signature,
shape, and error below matches the code (`npm test`: 167 green, incl.
`tests/kernel/hardening.test.js`). No broadcasts happen inside these modules
(except through an explicitly injected executor — see `executePublish`).

Notation: `bigint-ish` = decimal string accepted anywhere a uint goes
(JS numbers are rejected for wei — precision). All hashes/addresses lowercase
`0x` hex. Async unless noted.

## 0. Import

```js
const K = require('./src/kernel/index.js'); // CJS; pure offline except where noted
```

No init, no singletons, no ambient state. Every function takes explicit inputs
(injected `fetchCircuit`/`lookupRegistry` control chain-vs-mock).

## 1. Package lookup + canonical identity

```js
store = K.loadStore('packages/');                       // throws on dup versions / bad files
K.discoverPackage(store, 'trace-core')
  // => { status:'ok', name, versions:['1.0.0'], latest:'1.0.0' }
  // => { status:'unknown-package', name }              // nothing fabricated, ever
K.resolvePackageVersion(store, 'trace-core', '1.0.0' | 'latest')
  // => { status:'ok', package }                        // package: §3 shape
  // => { status:'unknown-package' } | { status:'unknown-version', available:[...] }
K.resolvePackage(store, { chainId:196, processor:'0x…', circuitId:1 })
  // => { status:'ok', package } | { status:'unknown', slot? }
```

Package object (`kernel-package-v1`): `{ schema, name, version,
identity:{chainId:'196', processor:'0x…', circuitId:'1'},
description?, license?:{priceWei, currency, attributionRequired, note?},
publisher?, displayName? }`. Identity triple is the ONLY on-chain truth;
`name`/`version`/`description` are application metadata, `displayName` is
presentation-only (see `FIELD_PROVENANCE` in `src/kernel/package.js`).

## 2. Versions

`K` re-exports nothing here — use `src/kernel/versions.js` if needed:
`isValidVersion('1.0.0')`, `compareSemver(a,b)` (-1|0|1, prerelease-aware),
`maxVersion([...])`. Strict `X.Y.Z`, no ranges. A version maps 1:1 to an
immutable identity; new computation = new circuit = new version entry.

## 3. Dependencies + provenance

```js
await K.resolveDependencies({ processor, circuitId }, {
  fetchCircuit,   // async ({chainId,processor,circuitId}) -> {netlist,nIn,nOut,netlistHash?} | null
  lookupRegistry, // async (slotKey) -> record | null   (record: {active,netlistHash,payee,priceWei,termsHash})
  packageStore,   // optional store (enriches package/packageStatus)
  chainId = 196, maxDepth = 8,
});
// => { root, depth, cycles, missing, truncated, edges:[{from,to,refIndex,gateOffset}],
//      dependencies: [{ slotKey, chainId, processor, circuitId, depth, occurrences,
//        nIn, nOut, netlistHash, nodeStatus, package|null, packageStatus,
//        registrationStatus, registration:{payee,priceWei,termsHash,recordNetlistHash}|null,
//        reason|null }], stats }
await K.getProvenance(sameArgs);
// => { root:{...live...}, direct:[slots], transitive:[slots], edges,
//      dependencies, lineageHash|null, lineageVerifiable, cycles, missing, truncated, stats }
```

Rules the UI must honor:
- Netlist bytes decide dependencies. Never substitute UI-entered metadata.
- `occurrences` counts REF records; **payment count = number of unique slots**
  (`dependencies.length`), never the occurrence sum — matches router behavior.
- `lineageHash` is non-null ONLY when the root parsed AND every dep is
  hash-verified; otherwise null with per-dep reasons. Never display a null hash.
- `fetchCircuit` may return numeric strings for `nIn`/`nOut` (coerced); it MUST
  return `netlist` bytes and SHOULD return keccak `netlistHash` (without it,
  hash verification is impossible and statuses degrade to unverified).
- A throwing `fetchCircuit`/`lookupRegistry` degrades that slot to
  `unknown`/`missing` with `reason` — the join never aborts, never drops a slot.

## 4. Manifests

```js
K.buildManifest({ schema:'kernel-manifest-v1', name, version, root:<slotKey>,
  dependencies:[{ identity:<slotKey>, version|null, netlistHash,
    license:{ required, termsHash|null, priceWei|null, payee? } }],
  netlistHash, lineageHash });            // throws on malformed input
K.validateManifest(obj);                  // => { ok, value? , reason? }
K.manifestHash(manifest);                 // sha256 hex (application hash)
```
Dependency order is canonicalized (sorted by slot). Round-trips byte-identical.

## 5. License / registry reads

```js
await K.preflight({ targetCpu, netlist, nIn, nOut, fetchCircuit, lookupRegistry,
  tapeoutFeeWei, mintQuote:{mintPriceWei, protocolFeeWei}, chainId=196 });
// => { allowed, dependencies:[{..., status}], totalPriceWei, lineageHash|null,
//      manufacture:{nand,latch,mintValueWei,tapeoutFeeWei}|null, own, failures:[{code,detail}] }
```
Failure codes (show these, never generic errors): `UNREGISTERED, INACTIVE,
NETLIST_MISMATCH, INVALID_PAYEE, INVALID_PRICE, MISSING_TERMS, MALFORMED_REF,
MISSING_DEPENDENCY, PIN_MISMATCH, FEE_UNKNOWN, LOOKUP_FAILED, BAD_TARGET`.
`LOOKUP_FAILED` = registry unreachable — offer retry, never treat as unregistered.
`allowed:false` always carries `lineageHash:null`. Shape is identical on all
paths (empty `dependencies:[]`, `totalPriceWei:'0'` on early BAD_TARGET).

```js
await K.prepareLicense(sameArgs);   // preflight + { calldata, valueWei } or nulls when blocked
K.buildLicenseCalldata({ targetCpu, netlist, nIn, nOut });  // exact router calldata
K.requiredValue({ totalPriceWei, nNand, nLatch, mintPriceWei, protocolFeeWei, tapeoutFeeWei }); // exact wei string
K.computeLineageHash({ targetCpu, nIn, nOut, netlist, deps:[{keyHash,netlistHash,payee,priceWei,termsHash}] });
```
`keyHashFor` lives in `src/registry/client.js` (keccak of 96-byte abi.encode —
matches the contract's `slotKey()`; pinned by layout test).

## 6. Verification results

```js
await K.verifyComposition({ root:{processor,circuitId}, fetchCircuit, lookupRegistry,
  packageStore?, expectedNetlistHash?, expectedTermsHash?, requireRegistration?,
  manifest?, chainId?, maxDepth? });
// => { verified, checks:[{code,passed,skipped,detail?}], failed:[codes] }
```
Codes: `IDENTITY_RESOLVES, CIRCUIT_EXISTS, NETLIST_READABLE, NETLIST_MATCH,
REGISTRATION_PRESENT, REGISTRATION_IDENTITY_MATCH, TERMS_MATCH,
DEPENDENCIES_RESOLVED, LINEAGE_REPRODUCIBLE, MANIFEST_CONSISTENT`.
**"Kernel Verified" = `verified === true`.** A check with `skipped:true` also
reports `passed:true` — the UI MUST distinguish skipped (grey, "not checked")
from passed (green). A confirmed transaction NEVER implies verified; only this
result does.

## 7. Receipts

```js
K /* receipt.js (import directly) */.buildReceipt({ schema:'kernel-receipt-v1',
  component:<slot>, packageVersion|null, termsHash, priceWei, payee, payer,
  transaction, blockNumber, resultingCircuit:<slot>, lineageHash });  // throws on partial data
```
Partial evidence must throw, never default. All fields required (except
nullable `packageVersion`).

## 8. Publishing

```js
await K.preparePublish({ packageInput, fetchCircuit, lookupRegistry,
  termsInput?, payeeOverride?, chainId? });
// => { package, slotKey, keyHash, live:{...}, terms, termsHash, payee, priceWei,
//      registerCalldata, valueWei:'0', alreadyRegistered:false }
// Throws (no broadcast, no gas spent): unreadable circuit, missing payee,
// terms/price mismatch, active record exists, INACTIVE TOMBSTONE exists
// (re-registration always reverts on-chain — fail here instead).
await K.executePublish(plan, { broadcast, registry });
// broadcast: async ({to,data,value}) => ({hash,...}). Validates plan + registry
// address shape first. The CALLER owns all gates (confirm dialogs, signer,
// receipt handling). Importing or preparing never broadcasts.
```

## 9. Related reads (already stable)

- `src/registry/client.js`: `keyHashFor`, `build*Calldata`, `readRegistration(provider, registry, key)` → record|null, `readIsRegistered`.
- `src/registry/terms.js`: `canonicalizeTerms`, `hashTerms`, `validateTerms` (exact hashed bytes documented there).
- `src/lineage/chain-reader.js`: `getCircuit` (null = absent; **transport errors throw** — timeouts/refusals/rate-limits are NOT absence), `fetchCircuitForResolver`, `isAbsenceError` (exported for custom handling).
- Statuses vocabulary: `registered (hashVerified?)` / `unregistered` / `inactive` / `mismatch` / `unknown`. **`registered` alone is NOT proof** — display "verified" only with `hashVerified === true` (or a fresh `NETLIST_MATCH`).

## 10. Data provenance quick-map

ON-CHAIN: identity triple, registry record fields, transactions, tape-out results.
DERIVED: netlistHash, REF graph, lineageHash, manifest/package hashes, fee math, verification verdicts.
APPLICATION: names, versions, descriptions, terms documents, publisher claims, curated store.
PRESENTATION: displayName, UI copy, demo labels. Never trusted for decisions.

## 11. Error handling rules for the UI

- Every engine rejection is a thrown `Error` with a `module: reason` prefix
  (`package:`, `store:`, `manifest:`, `verify:`, `publish:`, `commitment:`,
  `resolver:`, `registry:`, `attribution:`, `terms:`) — route by prefix.
- Async joins degrade per-item with `status` + `reason`; only programmer errors
  (missing fetch/lookup functions, bad root shape) throw synchronously.
- Retry `unknown`/`LOOKUP_FAILED`/`FEE_UNKNOWN`; do not retry terminal states
  (`mismatch`, `inactive`, `MALFORMED_REF`) without user-changed inputs.

## 12. Minimal example (offline, no key, no network)

```js
const K = require('./src/kernel/index.js');
const store = K.loadStore('./packages');
const { package: pkg } = K.resolvePackageVersion(store, 'trace-core', '1.0.0');
const deps = await K.resolveDependencies(
  { processor: pkg.identity.processor, circuitId: pkg.identity.circuitId },
  { fetchCircuit: liveFetch, lookupRegistry: liveLookup, packageStore: store },
);
const verdict = await K.verifyComposition({
  root: pkg.identity, fetchCircuit: liveFetch, lookupRegistry: liveLookup,
  expectedNetlistHash: liveHash, requireRegistration: true,
});
// verdict.verified === true  →  "Kernel Verified"
```
(`liveFetch`/`liveLookup` = `src/lineage/chain-reader.js` + registry `readRegistration`
wired to a provider; the CLI scripts show the exact wiring.)
