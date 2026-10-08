# TapeOut Protocol — Ground Truth (Phase 0)

Status: research complete. No frontend, no marketplace, no licensing contracts built in this phase.
Date: 2026-09-26. All on-chain values below were read live from X Layer mainnet (chain ID 196)
unless marked otherwise.

## 0. Sources and evidence grading

Every claim in this document carries an evidence tag:

- `[RPC]` — verified by the author via live `eth_call` / receipt reads against
  `https://xlayerrpc.okx.com` on 2026-09-26 (chain ID `0xc4` = 196 confirmed).
- `[BUNDLE]` — extracted from the official TapeOut frontend JavaScript served by
  `https://tapeout.net` (the canvas + chain adapter chunks). This is primary-source
  client code, not documentation prose: opcode constants, ABI arrays, chain configs,
  and UI strings are quoted from it.
- `[REPO]` — observed in third-party hackathon builder repos (X Layer mainnet
  deployments with transactions and verification scripts). Treated as secondary:
  useful for addresses, flows, and cross-checks, never as sole proof.
- `[HYP]` — hypothesis consistent with evidence but not directly confirmed. These are
  collected in Section 9 as experiments to run before Phase 1 builds on them.

Primary sources consulted:

1. Official TapeOut canvas/app: `https://tapeout.net` (SPA; logic in versioned
   `assets/*.js` chunks, fetched 2026-09-26). No official GitHub repo, no official
   docs site, and no published npm SDK were found (`tapeout`, `@tapeout/sdk`,
   `tapeout-sdk` all 404 on the npm registry; GitHub code search returns only
   TinyTapeout ASIC results and hackathon builder repos).
2. X Layer mainnet RPC + OKLink/OKX explorer records linked from builder repos.
3. Builder repos (secondary): `tizerluo/neon-reliquary-xlayer` (11 circuits,
   processor `0x57E9…1A44`, factory index 231), `btcc6758-svg/trace-xlayer-growth`
   (processor `0x7761…1274a`, full prepare/verify scripts, `deployment-config.json`),
   `ll0402733-sys/ignix-burst` (processor `0x2DA2…0fbb0`, 5-NAND XNOR burn circuit),
   `niohe-x/interlock-xlayer` (processor `0x163C…9814`).
4. X Layer network info via `https://web3.okx.com/xlayer` and live RPC.

> Consequence for Phase 1: there is no official SDK to depend on. The de-facto
> interface is the on-chain ABI (Section 8.5, `[BUNDLE]` + `[RPC]` cross-checked)
> plus raw RPC. Phase 1 should vendor the ABI JSON in-repo and treat the
> `tapeout.net` bundle as a reference implementation, not a dependency.

---

## 1. Architecture

### 1.1 Contract roles

```
                        ┌─────────────────────────────────┐
                        │  Factory (one per chain)        │
                        │  createCPU / cpuAt / cpuCount / │
                        │  isCPU / deployFee / ...        │
                        │  event CPUCreated               │
                        └────────┬────────────────────────┘
                 createCPU(name, symbol, story, supply, mintPrice) [payable: deployFee]
                                 │ deploys TWO contracts, emits CPUCreated
                ┌────────────────┴────────────────┐
                ▼                                 ▼
 ┌──────────────────────────┐    ┌──────────────────────────────┐
 │ Transistors (ERC-1155)   │    │ Circuits / Processor (ERC-721 │
 │ "material"               │◄──►│ style circuit NFTs) "CPU"    │
 │ token 0 = NAND           │    │ tapeout(nl,nIn,nOut) [payable]│
 │ token 1 = LATCH          │    │ eval / step (read-only exec) │
 │ mint(id, amount) [pay]   │    │ netlist / circuitInfo /      │
 │ supplyCap / minted /     │    │ ownerOf / nextId /           │
 │ mintPrice / protocolFee /│    │ TAPEOUT_FEE / transistors()  │
 │ creator / circuits() /   │    │ event TapedOut               │
 │ owed / withdraw          │    │ each circuit ⇒ on-chain      │
 └──────────────────────────┘    │ container (asset holder)     │
                                 └──────────────────────────────┘
```

- One `createCPU` call deploys exactly one Transistors contract and one Circuits
  contract, permanently linked both ways (`circuits.transistors()` ⇄
  `transistors.circuits()`) `[BUNDLE][REPO]` (reciprocal-link check is enforced by
  every serious client: `src/xlayer.js` reverts on `MATERIAL_PROVENANCE_MISMATCH`;
  the TRACE `verify-creation.mjs` script asserts it on two RPCs `[REPO]`).
- Economics are set once at creation and are immutable: `supplyCap` (= transistorSupply),
  `mintPrice`, `story`, `cpuName` have no setters in the ABI `[BUNDLE]`. Only fee
  *policy* at the factory level (`deployFee`, `protocolFee`, wallets) is owner-controlled.
- The Circuits contract holds the execution semantics (`eval`/`step`), the NFT
  ownership record (`ownerOf`), and the netlist store (`netlist(id)`). The Transistors
  contract holds mint economics and creator revenue (`owed`/`withdraw`).
- Each minted circuit NFT owns an on-chain **container** contract that can hold assets
  (`cv.acctOpened`: "This circuit has its own on-chain container"; circuit-market code
  reads "assets in this circuit's container"; `circuitAccountImpl 0xAf4E…751d` on BNB
  `[BUNDLE]`). Container mechanics on X Layer were not probed — see Section 9.

### 1.2 Chain deployments (verified vs referenced)

| Chain | Chain ID | Factory | Status |
|---|---|---|---|
| X Layer mainnet | 196 (`0xc4`) | `0x1f09daefa827f02cbb40967cc91b259763760761` | `[RPC]` live: `cpuCount` = 247, `isCPU` = true for all four sample processors |
| BNB Smart Chain | 56 | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | `[BUNDLE]` (official frontend chain config; not re-probed here) |
| BSC testnet | 97 | `0x076e383ff2e490A493f1f5c4359e922C46c54c01` | `[BUNDLE]` (frontend config only) |
| X Layer testnet | 195 | unknown | Not found. No factory address in any source. See Section 9. |

Sample X Layer mainnet processors (`isCPU` = true `[RPC]`):

| Processor | Transistors (ERC-1155) | nextId `[RPC]` | Notes |
|---|---|---|---|
| `0x57E9e1111f42F448126A9F12b2b3f99a79dd1A44` (Nandverse Foundry, factory index 231) | `0x911d63D068C05e7741fD507517c3aC7793c35bE2` (NDVR) | 11 | 11 circuits `[REPO]` |
| `0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a` (TRACE) | `0x9F842F33147E477e1219e753e2929e1DFc0Fe16C` | 1 | 1 circuit (4-in/2-out/8-NAND) |
| `0x2DA2c22C6a01cec71D283ea25BcF20c36fA0fbb0` (IGNIX BURST) | `0x9D00C7b04d023de46A45137F75540AA24904E815` | 1 | 5-NAND XNOR qualification circuit `[REPO]` |
| `0x163C980ee0E9eccc142fED1dfdbb962e89da9814` (Interlock) | `0xD1Ce3f46479379B2844cc8513AFab96e4F6b48FB` | 5 | README documents 2 circuits; chain says 5 IDs assigned (more tapeouts exist) |

---

## 2. Processor Lifecycle

Flow: `create processor → configure economics (at creation, immutable) → use processor → tape out circuit`.

### 2.1 Creation call

```
createCPU(string name, string symbol, string story,
          uint256 transistorSupply, uint256 mintPrice)
  payable (msg.value must cover deployFee)
  returns (address transistors, address circuits)
  event CPUCreated(address indexed circuits, address indexed transistors,
                   address indexed creator, string name,
                   uint256 supply, uint256 mintPrice)
```

- `transistorSupply` becomes the immutable `supplyCap` (total NAND+LATCH units that can
  ever be minted for this processor). `mintPrice` (wei per material unit, in the native
  gas token: OKB on X Layer) is immutable. `name`/`symbol`/`story` are immutable
  (`cpuName`, `cpuSymbol`, `story` view functions; no setters) `[BUNDLE][RPC]`.
  TRACE on-chain readback: `cpuName` = "TRACE Growth Processor", `cpuSymbol` = "TRACE",
  `supplyCap` = 100,000, `mintPrice` = 0.00001 OKB `[RPC]` — exactly the
  `deployment-config.json` proposal `[REPO]`.
- Anyone can call `createCPU`. No allowlist, no approval, no stake. The only gate is
  the flat `deployFee` = **0.0066 OKB** (`0x1772aa3f848000` wei `[RPC]`), paid to the
  factory/protocol. Classification of "who may create a processor": **NOT ENFORCEABLE**
  beyond the fee (permissionless by design).
- The factory's registry is the trust root everything else checks: `isCPU(address)`,
  `cpuAt(index)`, `cpuCount()`. X Layer `cpuCount` = 247 on 2026-09-26 `[RPC]`.
  Frontends refuse to read/tape-out through non-registered processors
  (`NOT_FACTORY_PROCESSOR`, `refNotRegistered`: "likely a fake contract") `[BUNDLE]`.
  That refusal is **APPLICATION ENFORCED** — the contracts themselves do not stop you
  from deploying or using a lookalike.

### 2.2 Creation receipt anatomy (TRACE, X Layer)

Tx `0x34c4d8ef5f94775d83b8096b4ad7b5c032df700fadf3dc09dc049686fc4d769f`
(block `0x444cd6f`), gas used 931,943 `[RPC]`:

- Log from factory `0x1f09…0761`: `CPUCreated` (topics: circuits, transistors, creator;
  creator = `0x1d207352dd708498cada1524eb4b36b5fa178886`, the deployment wallet).
- The creation was routed through an account-abstraction/relay path: receipt `from`
  (`0x7321…0857f`) differs from the `creator` in the event. **Ground-truth rule: the
  factory event, not `tx.from`, identifies the creator** `[REPO][RPC]`.
- Follow-on view checks that must all agree before a processor is trusted
  (mirrors TRACE `verify-creation.mjs`): both deployed contracts have code,
  `isCPU(circuits)` is true, `circuits.transistors() == transistors`,
  `transistors.circuits() == circuits`, `transistors.creator() == event creator`,
  `supplyCap`/`mintPrice`/`story` equal the proposal `[REPO][RPC]`.

### 2.3 Ongoing economics (per processor, immutable per-unit terms)

- Mint: `mint(uint256 id, uint256 amount)` payable, `id` 0 = NAND, 1 = LATCH
  (`NAND()` → 0, `LATCH()` → 1 `[RPC]`). Cost of one mint **call** for `n` units:
  `n × mintPrice + protocolFee`, where `protocolFee` = **0.00066 OKB** per call
  (`0x25844398d4000` wei `[RPC]`, identical on factory, TRACE and Nandverse
  transistors contracts). Batching units into one call amortises the fee `[BUNDLE]`
  (frontend `yt()`: `d = m*p + E`).
- Revenue split: `n × mintPrice` accrues to the processor **creator** (withdrawable via
  `owed(address)` / `withdraw()`); `protocolFee` accrues to the protocol. Evidence:
  TRACE deployer `owed` = 0.00008 OKB = exactly 8 × 0.00001 OKB (the 8 NAND minted for
  circuit #1) `[RPC]`. This is the only built-in "royalty": it pays the **processor
  creator on material mints**, never a circuit author on reuse/REF (Section 5).
- Tape-out fee: flat **0.0013 OKB** per circuit (`TAPEOUT_FEE() = 0x49e57d6354000`
  `[RPC]` on all four X Layer processors; the X Layer adapter hard-asserts this exact
  value `[REPO]`). Note: the BNB `CIRCUITS_ABI` in the same bundle has **no**
  `TAPEOUT_FEE` entry — X Layer processors are a newer contract version. Do not assume
  BNB fee behavior from X Layer numbers.
- Taped-out circuits are permanent and unmodifiable ("permanent, free-to-call,
  unmodifiable on-chain circuits" `[BUNDLE]`). `eval`/`step` are free view calls.

---

## 3. Circuit Lifecycle

Flow: `construct netlist → (optionally: mint material) → tapeout → circuit NFT + container`.

### 3.1 Netlist model (exact)

Signal numbering: `0` = const-0, `1` = const-1, `2 … 2+nIn−1` = inputs; every gate
appends its output(s) sequentially. Forward references are rejected (inputs must refer
to already-defined signals) `[BUNDLE]` (`netlist-nwZJybgD.js`, decoder `R`).

| Op | Byte layout (all ints big-endian) | Size |
|---|---|---|
| `NAND = 0x00` | `00 \|\| u24(a) \|\| u24(b)` | 7 bytes |
| `LATCH = 0x01` | `01 \|\| u24(d)` | 4 bytes |
| `REF = 0x02` | `02 \|\| address(cpu, 20B) \|\| u64(circuitId) \|\| u8(nIns) \|\| u8(nOut) \|\| u24(ins[nIns])` | 31 + 3×nIns bytes; outputs (nOut of them) are allocated implicitly, not stored |

- `u24` signal indices ⇒ max signal index 16,777,215. REF pin counts are `u8` ⇒
  **≤ 255 inputs and ≤ 255 outputs per REF** `[BUNDLE]`.
- Outputs of the whole circuit are the last `nOut` signals. LATCH output = previous
  state; new state sampled after all NANDs evaluate; state starts at zero
  (`CIRCUIT-ABI.md` `[REPO]`, evaluator `G` in `tapeoutChain` chunk `[BUNDLE]`).
- Canvas rule (relevant to cost): each output pin gets **+2 NAND output buffers**
  (`blifDupOut`, `blifBuffer` `[BUNDLE]`); the TRACE circuit's last two gates are
  exactly these buffers (Section 3.3).

### 3.2 Tape-out call

```
tapeout(bytes nl, uint32 nIn, uint32 nOut) payable
  (msg.value must cover TAPEOUT_FEE = 0.0013 OKB on X Layer)
  returns (uint256 circuitId)
  event TapedOut(uint256 indexed circuitId, address indexed author,
                 uint32 gateCount, uint32 nState)
```

- The caller must hold enough material: tape-out **burns/consumes** NAND/LATCH against
  the caller's ERC-1155 balance. Evidence: `eth_estimateGas` of a 1-NAND tape-out from
  the TRACE deployer (balance 0/0 `[RPC]`) reverts with custom error `0x03dee4c5…`
  (args embed caller, 0, 1); the same flow succeeds after `mint` in every builder repo
  `[RPC][REPO]`. Exact error name needs verified contract source (Section 9).
- `gateCount` = own gates at this level; `nState` = own LATCH count + resolved REF
  state (frontend resolver: LATCH adds 1, REF adds the sub-circuit's `nState`)
  `[BUNDLE]`. A circuit whose elements are *entirely* REF has own burn 0
  (`tooBigZero`: "its own burn is 0: the whole thing references other circuits")
  `[BUNDLE]` — i.e. **REF gates cost no transistors**, only the flat tape-out fee + gas.
- Circuit IDs are sequential per processor starting at 1; `nextId()` = number of
  circuits taped so far (= highest assigned ID). Evidence: TRACE `nextId` = 1 with
  circuit #1 existing; Nandverse `nextId` = 11 with circuits 1–11; an `eth_call`
  simulation of a new TRACE tape-out returned ID 2 `[RPC]`.
- Resulting assets: (1) the circuit NFT (`ownerOf(id)`; transferable incl. via
  `safeTransferFrom`; listed/sold on the circuit market `[BUNDLE][RPC]`); (2) a
  per-circuit on-chain **container** that can hold assets — assets in it are
  explicitly *not* priced into market sales and the seller can withdraw first
  (`acctOpened`, `assetsFail` `[BUNDLE]`). Do not design licensing around "the buyer
  also gets the container contents."

### 3.3 End-to-end readback proof (TRACE circuit #1, X Layer)

- `circuitInfo(1)` → `(nIn=4, nOut=2, nState=0, gateCount=8)` `[RPC]`.
- `netlist(1)` → 56 bytes (`0x38`) decoding gate-for-gate to the published 8-NAND
  design (NOT-fresh, NOT-(depth∧activity), AND-OR core, two input ANDs, two output
  buffers) — byte-identical to `dist/circuit.js` `encode()` and its SHA-256 in
  `dist/netlist.json` `[RPC][REPO]`.
- `eval(1, 0x01)` → `0x00` (discover=0, showcase=0), matching the local truth table
  row for inputs `[1,0,0,0]` `[RPC][REPO]`.
- `ownerOf(1)` = deployment wallet `0x1d20…8886` `[RPC]`.
- Tape-out tx `0xf93f88…e8510c` (block `0x444ff48`, gas used 338,109 for a
  mint-8 + tape-out batch routed via relay; `effectiveGasPrice` reported `0x0`)
  emits, in order: ERC-1155 `TransferSingle/Batch` (8 NAND to deployer),
  `TransferSingle` (burn on tape-out, mint-burn trace), ERC-721 `Transfer`
  (circuit #1 to deployer), `TapedOut(1, deployer, 8, 0)` `[RPC]`.
- Truth-table verification pattern (all 2^nIn rows via `eval`) is the standard
  "circuit is what it claims" check; both builder repos do it on two RPCs `[REPO]`.

### 3.4 Pre-tapeout vs post-tapeout information

| Before tape-out (client-side only) | After tape-out (on-chain, permanent) |
|---|---|
| Netlist bytes, nIn/nOut, quote (mint + tape-out fees), self-check result. None of this is on-chain until a tx is sent. Mempool may briefly expose plaintext netlists (BNB has an opt-in `commitDesign` MEV shield; X Layer MEV behavior untested — Section 9). | `circuitInfo`, `netlist` bytes, `ownerOf`, `TapedOut` event (circuitId, author, gateCount, nState, tx/block), `eval`/`step` execution, container. All free to read. |

---

## 4. REF Technical Specification

### 4.1 What REF is

REF (opcode `0x02`) is a **netlist-level sub-circuit reference**: one gate record that
points at an already taped-out circuit `(cpu address, circuitId)` plus a pin map. It is
the protocol's composition primitive ("Split it in your tool and compose with REF";
"Split into multiple circuits and compose with REF" `[BUNDLE]`). It is **not** a
frontend copy-paste: the reference is stored in the taped-out netlist bytes and
resolved by execution (`eval`/`step` recurse into the sub-circuit; the canvas resolver
`gt()`/`G()` fetches the sub-circuit's netlist and checks pin counts) `[BUNDLE]`.

### 4.2 Exact representation

A circuit's identity and dependencies, exactly:

- **Processor ID/key**: the Circuits contract address (e.g. `0x7761…1274a`), qualified
  by chain ID (196) and factory registration (`isCPU` true). Human shortcuts exist
  (`1-2-231.tapekit.org`, `1.2.238`) whose middle field is undecoded — hypothesis:
  `{circuitId}.{chainCode}.{factoryCpuIndex}` with X Layer = 2 (factory index 231/238
  both < `cpuCount` 247 `[RPC]`); treat as `[HYP]`, Section 9.
- **Circuit ID**: `uint256`, sequential from 1 per processor (`nextId` = count) `[RPC]`.
- **Netlist**: the `bytes` stored by `tapeout` and returned by `netlist(id)` — the
  exact gate stream of Section 3.1.
- **REF dependency record** (inside that stream): `02 ‖ cpu(20B) ‖ u64 circuitId ‖
  u8 nIns ‖ u8 nOut ‖ u24 ins…`. Example (probed, not broadcast): referencing TRACE
  circuit #1 with inputs on signals 2–5 is 43 bytes:
  `02‖7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a‖0000000000000001‖0402‖000002000003000004000005`.

### 4.3 On-chain resolution semantics (evidence)

- Pin-count agreement is enforced at composition time: the canvas resolver throws if
  `ins.length != sub.nIn || nOut != sub.nOut` `[BUNDLE]`; the contract path is
  believed to check the same (a mismatched REF is the "self-check passed, on-chain
  failed" hazard the frontend warns about — Section 4.4).
- Execution is recursive and stateless at the parent level: parent state slices are
  passed down, sub-outputs feed parent signals (`G()` `[BUNDLE]`). Mining counts only
  own-level gates (`mineNote`, `refWarn`, `gatesOwn … incl. references`, and the
  `circuitBurn()` view returning own `nandBurn/latchBurn` `[BUNDLE]`).
- **X Layer capabilities are better than the frontend admits.** The official canvas
  currently *refuses* L2 tape-outs containing REF (`l2NoRef`: "sub-circuits are
  currently read from BNB only… it cannot go to an L2 yet") `[BUNDLE]` — but that
  block is client-side. A direct `eth_call` of `tapeout(REF_netlist, 4, 2)` against
  the TRACE processor on X Layer mainnet, referencing same-chain circuit #1 with
  correct pins, **returned a new circuit ID (2) without reverting** `[RPC]`. So:
  same-chain REF resolution is a live contract capability on X Layer; the BNB-only
  limitation is in the official frontend's resolver, not (observably) in the X Layer
  contracts. A broadcast (state-changing) REF tape-out on X Layer has *not* been
  executed here — Section 9, experiment #1.

### 4.4 Limits and failure modes (all `[BUNDLE]` unless noted)

- Single-tx netlist ceiling ≈ 40 kB ("measured failure around 40k"; `msgTooBig`
  blocks before spending). This ceiling is the *reason* REF exists.
- Frontend guards (cycle `refCycle`, depth `refTooDeep`, count `refTooMany`, size
  `refTooBig`, pending-fetch `msgRefPending`) are **APPLICATION ENFORCED**. On-chain
  behavior for cyclic/deep REF graphs is untested — Section 9.
- Cross-chain REF (e.g. X Layer circuit referencing a BNB circuit) has no on-chain
  read path available to the referencing chain's EVM and is expected to fail; the
  frontend blocks it to avoid "transistors paid, tape-out reverted" (`l2NoRef`).
  Whether the X Layer contract reverts cleanly (with material unspent, since mint and
  tape-out are separate txs) vs consuming gas only, is Section 9, experiment #2.

---

## 5. Licensing Feasibility

Target flow: creator registers circuit → defines terms → integrator selects circuit →
license payment → REF composition → tape-out. Per-step enforceability:

| Step | What is technically available | Classification |
|---|---|---|
| Register circuit (claim "this circuit is mine, terms = X") | Anyone can store `(processor, circuitId) → termsHash/price/payee` in a third-party registry; authorship *declarations* can be wallet-signed (`personal_sign` over the tape-out proof, as `nr-oath-provenance` does `[REPO]`). Nothing binds the *protocol* to the registry. | Registry entry: **CONTRACT ENFORCED** (within the registry). Protocol recognition of it: **NOT ENFORCEABLE**. |
| Define license terms (price, scope) | Same registry; terms are metadata. The TapeOut contracts have no terms field, no royalty hook, no license-aware entry point. | **APPLICATION ENFORCED** at best (honest clients read the registry). |
| Integrator selects circuit | Discovery UI reads `netlist`/`circuitInfo`/`eval` freely. | N/A (read path is open by design). |
| License payment | A router contract can atomically `pay licensor → mint material → tapeout(REF netlist)` in one tx and emit `LicenseUsed(newCircuit, refCpu, refId, payer)`. For users of *that router*, payment is guaranteed. | **CONTRACT ENFORCED** on the opt-in path only. |
| REF composition | The REF bytes are assembled client-side and passed to permissionless `tapeout`. The official factory/processor cannot require prior payment. | Pre-payment requirement: **NOT ENFORCEABLE**. Post-hoc lineage: **PROTOCOL RECORDED** (REF tuple is immutable in `netlist()` bytes; `TapedOut.author` + block are permanent). |
| Tape-out | Permissionless (material + flat fee). | Gating: **NOT ENFORCEABLE**. Attribution afterwards: **PROTOCOL RECORDED**. |

What *is* enforceable, precisely:

1. **Opt-in atomicity** (CONTRACT ENFORCED): a license router can make *its own flow*
   atomic (payment + manufacture + proof event). It cannot make *the factory's flow*
   go through it.
2. **Detection and proof** (CONTRACT READABLE / PROTOCOL RECORDED): any contract or
   indexer can call `netlist(id)` and deterministically extract every
   `(cpu, circuitId)` REF tuple by scanning for `0x02` records (Section 4.2), plus
   `circuitInfo`/`TapedOut` for authorship and block height. Flattened copies (REF
   inlined as raw NANDs) are detectable by netlist-hash / gate-subgraph matching
   off-chain; `keccak256(netlist)` fingerprints are cheap to store on-chain at
   registration time.
3. **Marketplace transfer** (CONTRACT ENFORCED): circuit NFTs are real ERC-721-style
   assets (`ownerOf`, approvals, market sale Gulf `buy`/`list` on BNB `[BUNDLE]`);
   *ownership* transfer with payment is enforceable. *Usage/reuse licensing* is not.
4. **Creator mint revenue** (PROTOCOL ENFORCED): the processor creator earns
   `mintPrice` per material unit minted (`owed`/`withdraw`), but this pays the
   *processor* creator on *material*, never the *circuit* author on *reuse*.

---

## 6. Bypass Analysis

**Question: "If Bob owns the required transistor supply and has access to the official
TapeOut factory, can Bob compose Alice's circuit with REF and tape it out without
interacting with our licensing contract?"**

**Answer: Yes — trivially, in at least four ways. No proposed pre-tapeout payment
check can stop him.**

1. **Direct REF tape-out (cheapest bypass).** Bob reads Alice's `(processor, circuitId,
   nIn, nOut)` from chain (all public), hand-builds the 31+3·nIns-byte REF record
   (Section 4.2), calls `tapeout` on any processor he chooses (his own, Alice's, or a
   third party's — the target processor is freely editable in the canvas,
   `targetNote1` `[BUNDLE]`), pays only material + 0.0013 OKB. No callback, approval,
   or payment to Alice or to any licensing contract occurs anywhere in this path.
   Why: `tapeout` resolves REF by *reading* the referenced netlist; reading requires
   no authorization, and the ABI contains no license hook `[BUNDLE][RPC]`.
2. **Flatten-and-copy (no REF fingerprint at top level).** Bob reads Alice's full
   `netlist()` bytes (free view call), inlines the gates into his own netlist (exactly
   what the canvas "load onto canvas → tape it out again" flow does: "Taping it out
   again burns your own transistors and creates a new circuit; this original circuit
   is not affected" `[BUNDLE]`), and tapes out. The result is functionally Alice's
   circuit with zero on-chain reference to her. Only off-chain hash/subgraph matching
   can flag it.
3. **Reimplementation.** Bob re-derives the same logic (or writes BLIF → compiles via
   the documented Yosys path `[BUNDLE]`) and tapes out an equivalent circuit. No
   byte-level lineage at all; only behavioral similarity (truth-table equivalence)
   remains, which no contract checks.
4. **Processor shopping.** Even if Alice's *processor* tried to gate (it cannot —
   processors are fixed logic with no per-circuit policy entry point `[BUNDLE]`),
   Bob tapes out on a different processor, including one he creates himself for
   0.0066 OKB. Factory registration (`isCPU`) is the only "officialness" signal and it
   is granted to every payer, including Bob.

Additional bypass-relevant facts:

- Wrapping/gating the official factory is impossible from outside: the factory has no
  hooks, no per-CPU policy, and `tapeout`/`mint`/`createCPU` are directly callable;
  a wrapper can only offer an *alternative* path, never close the direct path.
  Deploying a *separate* gating factory forfeits `isCPU` registration, official
  frontend support, and mining eligibility — i.e. forfeits the ecosystem that makes
  TapeOut valuable. **Do not do this.**
- Frontend checks ("verify license before tape-out", "L2 REF blocked") are
  **APPLICATION ENFORCED** and bypassed by any direct contract call (proven by the
  Section 4.3 probe: the contract accepted what the official UI refuses to build).
- The one durable asymmetry in our favor: **Bob cannot erase history.** Alice's
  original `TapedOut` (author, block, netlist hash) predates any copy, and REF-based
  copies name her circuit explicitly and permanently. Enforcement must therefore be
  *retrospective* (detect → prove → reward/slash via our own staking or marketplace
  rules) rather than *preventive*.

---

## 7. Recommended Architecture

Given ONLY the evidence above, the strongest implementable system is an
**attribution-and-settlement layer over a permissionless base** — it never claims to
prevent unlicensed tape-outs.

### 7.1 Components (all buildable on verified primitives)

1. **License registry** (new contract): `register(processor, circuitId, termsHash,
   price, payee, scope)` callable permissionlessly; stores terms + block. For
   registered circuits also store `keccak256(netlist)` (read once via `netlist(id)`)
   to enable flattened-copy detection. *Enforcement: CONTRACT ENFORCED as a record;
   protocol-ignored.*
2. **Licensed tape-out router** (new contract, the "honest path"): single tx
   `licenseAndTapeout(refCpu, refId, targetProcessor, nl, nIn, nOut, licenseId)` that
   (a) checks `refCpu/refId` matches the license, (b) pulls `price` to `payee`,
   (c) forwards mint value + `TAPEOUT_FEE` and calls `mint` + `tapeout`,
   (d) parses the *submitted* `nl` bytes on-chain for `0x02` records (bounded: reject
   `nl.length` above a small cap, e.g. a few kB, to bound parse gas) and reverts on
   undeclared/unpaid REFs, (e) emits
   `LicensedTapeout(newProcessor, newId, refCpu, refId, payer, licenseId)`.
   *Enforcement: CONTRACT ENFORCED for router users; bypassable by direct factory
   calls (stated openly).*
3. **Lineage indexer** (off-chain, deterministic): scan `TapedOut` events per
   processor; fetch `netlist(id)`; extract REF tuples (Section 4.2 exact layout);
   join against the registry; flag (i) licensed uses (router event present),
   (ii) unlicensed REF uses (tuple present, no license event), (iii) suspected
   flattened copies (`keccak256` match or gate-subgraph match above a threshold).
   Surface provenance cards (same data model as `nr-oath-provenance` `[REPO]`).
4. **Settlement/incentive policy** (explicitly *not* prevention): e.g. licensed
   circuits earn a "compliant" badge + revenue share in *our* marketplace; disputes
   resolved by evidence (original `TapedOut` block height decides priority — an
   objective on-chain timestamp). Optional staking/slashing lives entirely in our
   contracts and only affects participants who opted in.

### 7.2 Explicit non-goals (would be security theater)

- No "license check inside tape-out": impossible without changing the official
  contracts.
- No "REF allowlist enforced by our contract on Alice's behalf": our contract is not
  in Bob's call path.
- No reliance on official-frontend behavior (L2 REF block, vault warnings) for any
  guarantee — all APPLICATION ENFORCED.
- No custom factory fork.

### 7.3 Why this is still worth building

What users get is *verifiable compliance as an asset*: integrators who license via
the router hold an on-chain `LicensedTapeout` proof chain (valuable for procurement,
grants, hackathon judging, marketplace ranking), while unlicensed use is detectable,
attributable, and timestamp-ordered. That is the maximum the protocol permits — and
it is genuinely useful, provided we never market it as prevention.

---

## 8. Deployment Information

### 8.1 Network (all `[RPC]` unless noted)

| Item | Value |
|---|---|
| Network | X Layer mainnet |
| Chain ID | 196 (`0xc4`) |
| Gas token | OKB (18 decimals) |
| RPC (verified working 2026-09-26) | `https://xlayerrpc.okx.com` |
| RPC (used by builder repos; DNS failed from this environment) | `https://rpc.xlayer.tech` `[REPO]` |
| Explorer | `https://www.okx.com/explorer/xlayer` and `https://www.oklink.com/xlayer/` |
| Block time / TPS / avg fee | ~1 s / ~5,000 TPS / ~$0.0005 per tx (OKX marketing figures, unverified here) |
| X Layer testnet (chain 195) | Faucet/bridge via `web3.okx.com/xlayer`; **no TapeOut factory address found** — Section 9 |

> `eth_getCode`/`eth_call` require browser-like headers on `xlayerrpc.okx.com`
> (bare `urllib` requests got HTTP 403; adding `Origin: https://www.okx.com` fixed it).
> `rpc.xlayer.tech` did not resolve from this network. Phase 1 tooling should support
> multiple RPCs with fallback (the repos already do: `["https://xlayerrpc.okx.com",
> "https://rpc.xlayer.tech"]` `[REPO]`).

### 8.2 Contract addresses (X Layer mainnet)

| Role | Address | Evidence |
|---|---|---|
| Factory | `0x1f09daefa827f02cbb40967cc91b259763760761` | `[RPC]` (`cpuCount`=247; `cpuAt(0)`=`0x839b…5411b`; `isCPU`=true ×4) |
| TRACE processor | `0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a` | `[RPC][REPO]` |
| TRACE transistors | `0x9F842F33147E477e1219e753e2929e1DFc0Fe16C` | `[RPC][REPO]` |
| Nandverse processor (idx 231) | `0x57E9e1111f42F448126A9F12b2b3f99a79dd1A44` | `[RPC][REPO]` |
| Nandverse material (NDVR) | `0x911d63D068C05e7741fD507517c3aC7793c35bE2` | `[RPC][REPO]` |
| IGNIX processor | `0x2DA2c22C6a01cec71D283ea25BcF20c36fA0fbb0` | `[RPC][REPO]` |
| IGNIX BurstCell | `0x9D00C7b04d023de46A45137F75540AA24904E815` | `[REPO]` |
| Interlock processor | `0x163C980ee0E9eccc142fED1dfdbb962e89da9814` | `[RPC][REPO]` |

Key transactions/blocks: creation `0x34c4d8e…c4d769f` (block `0x444cd6f`);
TRACE tape-out `0xf93f880…e8510c` (block `0x444ff48` = 71630664 decimal `[REPO]`);
Nandverse creation `0x0621daf…30fc309b`, 11 tape-out txs in `docs/XLAYER-MAINNET.md` `[REPO]`.

### 8.3 Fees (live, wei-exact `[RPC]`)

| Fee | Amount | Notes |
|---|---|---|
| `deployFee` (createCPU) | 6,600,000,000,000,000 wei = **0.0066 OKB** | flat, per processor |
| `protocolFee` (per `mint` call) | 660,000,000,000,000 wei = **0.00066 OKB** | per call, not per unit — batch mints |
| `TAPEOUT_FEE` (per circuit, X Layer) | 1,300,000,000,000,000 wei = **0.0013 OKB** | flat; asserted exact by X Layer adapter |
| `mintPrice` | per-processor, immutable | TRACE 0.00001 OKB/u; Nandverse 0.0005 OKB/u |
| TRACE 8-NAND first-circuit material | 8×0.00001 + 0.00066 = **0.00074 OKB** | 0.00008 → creator (`owed`), 0.00066 → protocol |
| Illustrative TRACE total (create + mint8 + tape-out, excl. gas) | 0.0066 + 0.00074 + 0.0013 = **0.00864 OKB** | cheapest realistic end-to-end |

### 8.4 Gas (observed `[RPC]`; relay-routed txs, see caveat)

| Operation | Gas used | Notes |
|---|---|---|
| `createCPU` (TRACE, via relay) | 931,943 | includes both contract deployments; relay overhead included |
| `mint(0, 8)` (`eth_estimateGas`) | 96,747 | pure mint, no relay |
| mint-8 + tape-out-8 batch (TRACE actual tx) | 338,109 | ≈ 240k attributable to tape-out of 56 B / 8 gates |
| `eval` / `step` / `netlist` / `circuitInfo` | 0 (view calls) | free; `eval` selector `0x934d06ea` verified live |

Caveats: observed txs report `effectiveGasPrice 0x0` (relayed/sponsored path) — do not
assume zero gas price generally. Tape-out gas scales with netlist bytes; the ~40 kB
single-tx ceiling (`[BUNDLE]`) is the binding constraint for large circuits, and REF
composition is the intended escape hatch. Per-gate gas curve for X Layer is unmeasured —
Section 9.

### 8.5 ABIs (from official frontend bundle `[BUNDLE]`, signatures live-confirmed `[RPC]`)

Factory: `createCPU(string,string,string,uint256,uint256) payable → (address,address)`,
`cpuCount()`, `cpuAt(uint256)`, `isCPU(address)`, `deployFee()`, `protocolFee()`,
`protocolWallet()`, `isSealed()`, `owner()`, `owed(address)`, `setDeployFee`,
`setProtocolFee`, `setProtocolWallet`, `withdraw()`, `seal()`,
`event CPUCreated(circuits▾, transistors▾, creator▾, string name, uint256 supply, uint256 mintPrice)`.

Circuits (X Layer): `transistors()`, `name()`, `symbol()`, `nextId()`, `factory()`,
`tapeout(bytes,uint32,uint32) payable → uint256`, `eval(uint256,bytes) → bytes`,
`step(uint256,bytes,bytes) → (bytes,bytes)`, `circuitInfo(uint256) →
(uint32 nIn,uint32 nOut,uint32 nState,uint32 gateCount)`, `ownerOf(uint256)`,
`safeTransferFrom(address,address,uint256)`, `netlist(uint256) → bytes`,
`TAPEOUT_FEE()`, `event TapedOut(circuitId▾, author▾, uint32 gateCount, uint32 nState)`.

Transistors (ERC-1155, id 0=NAND, 1=LATCH): `NAND()`, `LATCH()`, `mintPrice()`,
`protocolFee()`, `supplyCap()`, `minted()`, `creator()`, `circuits()`, `cpuName()`,
`cpuSymbol()`, `story()`, `balanceOf(address,uint256)`, `isApprovedForAll`,
`setApprovalForAll`, `mint(uint256,uint256) payable`, `safeTransferFrom`,
`owed(address)`, `withdraw()`, `event Minted(to▾, id▾, amount, paid)`.

Selectors independently verified live: `eval` = `0x934d06ea` (known-good encapsulation
from `dist/chain.js` `[REPO]`, confirmed against chain `[RPC]`); `ownerOf` =
`0x6352211e` (keccak check in probe).

---

## 9. Open Questions (must resolve experimentally before Phase 1 builds on them)

1. **Broadcast REF tape-out on X Layer.** `eth_call` simulation succeeds (returns new
   ID), but no state-changing REF tape-out has been broadcast here. Test: tape out a
   tiny REF circuit on X Layer mainnet (or testnet if a factory is found) and confirm
   `TapedOut`, `circuitInfo`, and `eval` recursion through the reference.
2. **On-chain REF edge behavior.** Cyclic REF graphs, excessive depth/fan-out,
   dangling `(cpu, circuitId)`, pin-count mismatch, and >255 pins: does `tapeout`
   revert (with which error), or OOG? Determines router validation requirements.
3. **Revert taxonomy.** Name and args of `0x03dee4c5…` (observed on material-short
   tape-out) and any REF errors. Needs verified contract source (BscScan/OKLink
   source lookup for the factory or a processor implementation) or systematic
   `eth_call` probing.
4. **Processor proxy structure.** All four X Layer processors return short,
   near-identical runtime bytecode (clone/proxy pattern). Identify the implementation
   contract (EIP-1967 slot / factory deployment trace) and confirm there is no
   upgrade path that could obsolete Phase 1 assumptions.
5. **Circuit containers on X Layer.** Confirm the per-circuit container address
   derivation, its ABI (open/inspect/send/withdraw states per `l2a.*` strings), and
   that licensing-relevant accounting never depends on container contents.
6. **X Layer testnet factory.** Chain 195 RPC/faucet exist; no TapeOut factory address
   found. If none exists, Phase 1 testing must use mainnet micro-circuits (≈0.009 OKB
   end-to-end, Section 8.3) or deploy a throwaway factory (losing `isCPU` trust).
7. **Gas schedule.** Per-byte/per-gate tape-out gas curve on X Layer; `mint` vs
   `tapeout` split for 1-NAND minimal circuit (our minimal tape-out estimate reverted
   on material — repeat with funded balance); typical (non-relayed) gas price.
8. **Dotted-ID decoding.** Confirm what the middle field of `A.B.C` tape IDs means
   (hypothesis: chain code, X Layer = 2) and whether any registry should store it.
9. **`nextId`/circuit-0 semantics.** Confirm IDs start at 1 and `nextId` = count
   (probe `circuitInfo(0)` / `netlist(0)` / `ownerOf(0)` revert behavior).
10. **MEV/commit-reveal on X Layer.** BNB frontend has opt-in `commitDesign`
    protection; confirm whether the X Layer factory/processors support it and whether
    pre-tapeout netlist privacy is achievable at all.
11. **Cross-chain REF.** Confirm expected revert (and its gas/material side effects)
    for an X Layer REF pointing at BNB, so the router can reject it with a clear error
    instead of learning from a failed user tx.
12. **Mining/registry coupling.** `circuitBurn`, `processorMultiplier`, mining tasks,
    and the `Behemoth`/certified lists are BNB-centric in the bundle; confirm what, if
    anything, they mean on X Layer before referencing them in licensing UX.

## Completion checklist (Phase 0 criteria)

- [x] Factory flow understood end-to-end (create → economics → registry), live-verified.
- [x] REF understood byte-exactly (opcode `0x02` layout, pin rules, resolution, costs).
- [x] REF dependencies are observable: deterministically, on-chain, via `netlist()`
      (+ `circuitInfo`/`TapedOut`); Solidity inspection is possible (parse `0x02`
      records), gas-bounded for small circuits.
- [x] Licensing enforceability adjudicated per step (Section 5): prevention is
      **NOT ENFORCEABLE**; opt-in atomicity **CONTRACT ENFORCED**; lineage
      **PROTOCOL RECORDED**; frontend checks **APPLICATION ENFORCED**.
- [x] Bypass answered explicitly (Section 6): yes, Bob bypasses trivially, four ways.
- [x] X Layer deployment path recorded with live addresses, fees, gas, ABIs (Section 8).
- [x] This document is sufficient to start Phase 1 without guessing, with unknowns
      fenced in Section 9. Do not build prevention; build attribution + settlement.
