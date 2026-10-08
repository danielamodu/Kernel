# Submission checklist (mapped to implementation — no invented evidence)

## Processor deployed

- PENDING MAINNET ACTIVATION (ours). Reference evidence of the flow working on
  X Layer: TRACE processor `0x7761…1274a` (creation tx `0x34c4d8e…c4d769f`,
  `docs/PROTOCOL.md` §2.2). Our `create-processor` script + dry-run
  (`gasEstimate 774,733`) are tested; our processor deploys at activation.

## Transistor supply / price / cap

- Protocol-verified live (`supplyCap`, `mintPrice`, `protocolFee`,
  `minted`, creator `owed`) — `docs/PROTOCOL.md` §2.3, re-read live by every
  dry-run. Our processor proposal: supply 100, 1e12 wei/u (`P1_*` env).
  PENDING MAINNET ACTIVATION for our own values.

## Circuit taped out

- PENDING MAINNET ACTIVATION (ours). Live reference: TRACE circuit #1
  (56 B, 8 NAND, 16/16 eval rows verified in Phase 1). Our demo root (43 B
  single-REF) is PREPARED (`fixtures/final/demo-root.json`), execution-tested
  in-process end to end.

## Real use case

- Computational IP attribution + voluntary licensed manufacturing for
  composable (REF-based) on-chain circuits. Demo: Alice registers TRACE #1,
  Bob's REF-root pays 0.0005 OKB and manufactures through the router with proof.

## X Layer integration

- Chain 196 throughout: live reads in every dry-run (chainId assertions),
  OKB-denominated math, OKLink explorer URLs in all reports. No other chain
  assumed anywhere (registry is chain-agnostic by `chainId` data, default 196).

## TapeOut integration depth

- Byte-level: opcodes/NAND/LATCH/REF layouts from the official bundle,
  cross-checked against live `netlist()` bytes (TRACE 56 B gate-for-gate;
  Nandverse #1 keccak matches the published column).
- Interface-level: only verified selectors/ABIs (`docs/PROTOCOL.md` §8.5);
  client fragments cross-checked against solc builds in tests.
- Execution-level: full licensed flow proven in-process against interface-
  faithful stubs; live execution awaits activation.

## Product completeness

- Complete backend: parse → resolve → register → preflight → pay → mint →
  tapeout → prove → verify, each with CLI + JSON + docs. Deliberately no
  frontend (no foundation existed; CLI/demo preferred over half-built UI —
  `docs/ARCHITECTURE.md`).

## Asset issuance / economics

- No token issued (out of scope, correctly). Economics documented, not
  invented: creation 0.0066, mint formula, tapeout 0.0013, demo total 0.0018
  OKB + gas (all live-quoted in dry-runs). Price is recorded wei, settled
  natively; no float, no ERC20.

## Security

- `docs/SECURITY.md`: 14 findings, all evidenced (bypass model, assertion
  trust, atomicity + reentrancy proven in-process, exact-value policy, caps,
  no-trap accounting). No audit claims beyond what tests + review show.

## Growth potential

- Honest statement: registry + router compose with any TapeOut processor
  (chain-agnostic slots), marketplace/licensing UX can build on the JSON every
  script prints, recursive-router and flattened-copy detection are scoped
  future work. No users, no traction, no revenue claimed.
