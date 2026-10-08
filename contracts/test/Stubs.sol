// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice TEST-ONLY stubs mimicking the verified TapeOut interfaces
/// (docs/PROTOCOL.md section 8.5) for in-process EVM tests. NOT for deployment.
/// Divergences from the real contracts are marked [STUB].

/// @dev Factory stub: permissionless registration of known CPUs.
contract StubFactory {
    mapping(address => bool) public cpu;

    function addCpu(address a) external {
        cpu[a] = true;
    }

    function isCPU(address a) external view returns (bool) {
        return cpu[a];
    }
}

/// @dev Transistors stub: per-call protocol fee, balances, burner role.
/// [STUB] Real mint economics identical in shape (n*price + fee per call).
contract StubTransistors {
    uint256 public mintPrice;
    uint256 public protocolFee;
    mapping(address => mapping(uint256 => uint256)) public bal;
    address public burner;
    bool public failMint;

    constructor(uint256 mp, uint256 pf) {
        mintPrice = mp;
        protocolFee = pf;
    }

    function setBurner(address b) external {
        burner = b;
    }

    function setFailMint(bool f) external {
        failMint = f;
    }

    function balanceOf(address a, uint256 id) external view returns (uint256) {
        return bal[a][id];
    }

    function mint(uint256 id, uint256 amount) external payable {
        if (failMint) revert("stub: mint boom");
        require(msg.value == amount * mintPrice + protocolFee, "stub: bad mint value");
        bal[msg.sender][id] += amount;
    }

    function burn(address from, uint256 id, uint256 amount) external {
        require(msg.sender == burner, "stub: not burner");
        require(bal[from][id] >= amount, "stub: material short");
        bal[from][id] -= amount;
    }
}

/// @dev Processor stub: burn-counted tapeout, stored netlists, minimal NFT.
/// [STUB] Real execution semantics richer; shapes used by the router
/// (transistors/TAPEOUT_FEE/tapeout/netlist/circuitInfo/ownerOf/safeTransferFrom)
/// match the verified interface. No ERC721Receiver check on transfers [STUB].
contract StubProcessor {
    StubTransistors public mat;
    uint256 public constant TAPEOUT_FEE_VALUE = 1300000000000000;
    uint256 public nextId = 1;
    bool public failTapeout;
    mapping(uint256 => bytes) public blob;
    mapping(uint256 => address) public own;
    mapping(uint256 => uint32) public nin;
    mapping(uint256 => uint32) public nout;
    mapping(uint256 => uint32) public gates;

    constructor(address m) {
        mat = StubTransistors(m);
    }

    function setFailTapeout(bool f) external {
        failTapeout = f;
    }

    function transistors() external view returns (address) {
        return address(mat);
    }

    function TAPEOUT_FEE() external pure returns (uint256) {
        return TAPEOUT_FEE_VALUE;
    }

    function tapeout(bytes calldata b, uint32 i, uint32 o) external payable returns (uint256) {
        if (failTapeout) revert("stub: tapeout boom");
        require(msg.value == TAPEOUT_FEE_VALUE, "stub: bad tapeout fee");
        (uint256 n, uint256 l, uint32 g) = _count(b);
        if (n > 0) {
            require(mat.balanceOf(msg.sender, 0) >= n, "stub: nand short");
            mat.burn(msg.sender, 0, n);
        }
        if (l > 0) {
            require(mat.balanceOf(msg.sender, 1) >= l, "stub: latch short");
            mat.burn(msg.sender, 1, l);
        }
        uint256 id = nextId++;
        blob[id] = b;
        own[id] = msg.sender;
        nin[id] = i;
        nout[id] = o;
        gates[id] = g;
        return id;
    }

    function netlist(uint256 id) external view returns (bytes memory) {
        require(own[id] != address(0), "stub: no circuit");
        return blob[id];
    }

    function circuitInfo(uint256 id)
        external
        view
        returns (uint32, uint32, uint32, uint32)
    {
        require(own[id] != address(0), "stub: no circuit");
        return (nin[id], nout[id], 0, gates[id]);
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(own[id] != address(0), "stub: no circuit");
        return own[id];
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(msg.sender == from && from == own[id], "stub: not owner");
        own[id] = to;
    }

    function _count(bytes calldata b) internal pure returns (uint256 n, uint256 l, uint32 g) {
        uint256 p = 0;
        while (p < b.length) {
            uint8 op = uint8(b[p]);
            if (op == 0x00) {
                n++;
                g++;
                p += 7;
            } else if (op == 0x01) {
                l++;
                g++;
                p += 4;
            } else if (op == 0x02) {
                g++;
                uint8 nIns = uint8(b[p + 29]);
                p += 31 + uint256(nIns) * 3;
            } else {
                revert("stub: bad opcode");
            }
        }
    }
}

/// @dev Payee that tries to reenter the router from its receive/fallback.
contract ReenteringPayee {
    address public router;
    bytes public payload;
    uint256 public value;

    constructor(address r) {
        router = r;
    }

    function arm(bytes calldata p, uint256 v) external {
        payload = p;
        value = v;
    }

    receive() external payable {
        (bool ok, ) = router.call{ value: value }(payload);
        ok; // result ignored: outer call must fail regardless
        revert("griefer: always reverts");
    }
}

/// @dev Payee whose fallback always reverts (griefing / PayFailed path).
contract RevertingPayee {
    receive() external payable {
        revert("griefer: no thanks");
    }
}
