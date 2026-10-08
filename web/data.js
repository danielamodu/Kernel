'use strict';
/* Kernel UI dataset — every value recorded from the X Layer mainnet activation.
 * Fields marked snapshotBlock were read live at that block; the app re-verifies
 * them against the RPC when online and labels any stale/unreachable value
 * honestly instead of inventing data. See tests/ui/snapshot.test.js. */
const KERNEL_SNAPSHOT = Object.freeze({
  chain: Object.freeze({ name: 'X Layer', id: 196, currency: 'OKB', decimals: 18 }),
  rpc: 'https://xlayerrpc.okx.com',
  explorer: 'https://www.oklink.com/xlayer',
  snapshotBlock: 72687121,
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  registry: Object.freeze({
    address: '0x34cDa4B9668609FC7EF62c6f84058B68894c6bBa',
    deployTx: '0xd6989bacf9046718250a6da4b02667c378c500f0f9eb6d0d4b18ca380fddc60c',
    deployBlock: 72686810,
  }),
  trace: Object.freeze({
    processor: '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a',
    transistors: '0x9F842F33147E477e1219e753e2929e1DFc0Fe16C',
    label: 'TRACE',
  }),
  ip: Object.freeze({
    // Canonical registered computational IP: TRACE circuit #1.
    demoName: 'TRACE Core v1',
    demoDescription: 'Turns public pool observations into transparent presentation milestones: a discovery entry and a public-progress showcase. 8 NAND gates, 4 inputs, 2 outputs.',
    processor: '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a',
    circuitId: '1',
    slotKey: 'tapeout:v1:196:0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a:1',
    keyHash: '0x1101b7fda93495f606b4ee008f95a1fff76ccf12ad790a308810118e93a06c9b',
    netlistHash: '0x0ea38cb443c03f7f3f45d3239687851ff653fdc0257a057af8abdf6b91ff0942',
    // Demo identity: the on-chain owner/deployer is shown as-is (truncated).
    // "Alice" is used ONLY as the demo narrator in copy, never as an on-chain claim.
    payee: '0x1d207352Dd708498caDA1524eB4b36B5fa178886',
    priceWei: '500000000000000',
    priceOKB: '0.0005',
    termsHash: '0xd8e97954e72ecc3b4ce037e45269320757712ae48d2cdcce22e40bea72e946f2',
    terms: Object.freeze({
      version: 1, model: 'single-license', priceWei: '500000000000000',
      currency: 'OKB', attributionRequired: true,
      note: 'Canonical demo: TRACE circuit #1 via licensed-router path.',
    }),
    registrationTx: '0xab74807ef7c17eaba61c7771f5e4aed52614ed645562477ea73334c9669fc655',
    registrationBlock: 72686876,
    nIn: 4, nOut: 2, nState: 0, gateCount: 8,
  }),
  router: Object.freeze({
    address: '0x2bbd57Fc7b84e1a90451C8a0Ed499234aE0a4d6D',
    deployTx: '0x2ad03d6ac7b52ab05a90c16c72f7c0b5a6679db3c10812ff1e7aa9b5198f5895',
    deployBlock: 72686947,
  }),
  composition: Object.freeze({
    // The demo root: 43-byte pure-REF netlist (PREPARED bytes; circuit #2 on-chain).
    demoName: 'Proof Machine',
    netlist: '0x027761ce17a2e75c6910f1d5a77e6f66cd9ca1274a00000000000000010402000002000003000004000005',
    nIn: 4, nOut: 2,
    netlistKeccak: '0x046f2badd2b6700e531cbd0ea2ab68a6dde05131f8098aecfa1e07426066da8e',
    lineageHash: '0x02335455db6d818f112813e1141b01d8d5130df5edc41c690704dd5c031af82f',
    calldata: '0xb2705e800000000000000000000000007761ce17a2e75c6910f1d5a77e6f66cd9ca1274a000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000002b027761ce17a2e75c6910f1d5a77e6f66cd9ca1274a00000000000000010402000002000003000004000005000000000000000000000000000000000000000000',
    valueWei: '1800000000000000',
    licenseWei: '500000000000000',
    tapeoutFeeWei: '1300000000000000',
  }),
  result: Object.freeze({
    circuitId: '2',
    tx: '0x17aad8c2a3aec1d050966e5ff87cabf235c1cfd2b309f8058f08978d5f7a775f',
    block: 72687060,
    gasUsed: '345004',
    payer: '0xFc67dC934Ad4537c8ce287011DBC023409001222',
    payeeDeltaWei: '500000000000000',
  }),
});

/* Function selectors (verified: ethers-computed, licenseAndTapeout matches live calldata). */
const KERNEL_SELECTORS = Object.freeze({
  circuitInfo: '0x084d60f1',
  netlist: '0x3fc4be56',
  ownerOf: '0x6352211e',
  nextId: '0x61b8ce8c',
  transistors: '0x6fbd1719',
  TAPEOUT_FEE: '0xadfb2b69',
  isCPU: '0x5f5a364f',
  getRegistration: '0x9dccc5bf',
  isRegistered: '0x27258b22',
  mintPrice: '0x6817c76c',
  protocolFee: '0xb0e21e8a',
  minted: '0x4f02c420',
  licenseAndTapeout: '0xb2705e80',
});
