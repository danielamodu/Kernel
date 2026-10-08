// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title LicensedTapeoutRouter
/// @notice Voluntary application-level licensed path for TapeOut manufacturing.
///
/// Flow (single atomic transaction): validate REF lineage against the
/// AttributionRegistry → pay each UNIQUE dependency's payee → mint required
/// material → tapeout on the target processor → forward the circuit NFT to the
/// payer → emit LicensedTapeout. Any failure reverts everything (EVM rollback:
/// no partial payment, no proof without manufacture).
///
/// @dev Explicitly NOT protocol enforcement. The TapeOut factory is permissionless;
/// anyone calling it directly bypasses this router entirely (see docs/PROTOCOL.md
/// sections 5-6). "Licensed" below means ONLY "manufactured through this router
/// with registry-verified payments". Economic model: ONE payment per UNIQUE
/// dependency slot (not per REF gate occurrence).
///
/// Interfaces used are the verified ones (docs/PROTOCOL.md section 8.5):
/// factory.isCPU, circuits.{transistors,TAPEOUT_FEE,tapeout,netlist,circuitInfo,
/// safeTransferFrom}, transistors.{mintPrice,protocolFee,mint},
/// registry.{slotKey,getRegistration}.

interface IAttributionRegistry {
    struct Record {
        bytes32 netlistHash;
        address payee;
        uint256 price;
        bytes32 termsHash;
        uint64 registeredAt;
        address registeredBy;
        bool active;
        bool exists;
    }
    function slotKey(uint256 chainId, address processor, uint256 circuitId)
        external
        pure
        returns (bytes32);
    function getRegistration(bytes32 key) external view returns (Record memory);
}

interface ITapeOutFactory {
    function isCPU(address cpu) external view returns (bool);
}

interface ICircuits {
    function transistors() external view returns (address);
    function TAPEOUT_FEE() external view returns (uint256);
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut)
        external
        payable
        returns (uint256);
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id)
        external
        view
        returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
    function safeTransferFrom(address from, address to, uint256 id) external;
}

interface ITransistors {
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function mint(uint256 id, uint256 amount) external payable;
}

contract LicensedTapeoutRouter {
    IAttributionRegistry public immutable REGISTRY;
    ITapeOutFactory public immutable FACTORY;

    /// @dev DoS/griefing bounds for the on-chain netlist walk (demo scale).
    uint256 public constant MAX_NETLIST_BYTES = 8192;
    uint256 public constant MAX_REFS = 16;

    bool private _locked;

    struct Dep {
        address cpu;
        uint64 circuitId;
        uint8 nIns;
        uint8 nOut;
    }

    event LicensePaid(
        bytes32 indexed key,
        address indexed payee,
        uint256 price,
        bytes32 termsHash
    );
    /// @dev Proof of "a tape-out performed through our licensed router" — nothing more.
    event LicensedTapeout(
        address indexed targetCpu,
        uint256 indexed newCircuitId,
        bytes32 lineageHash,
        uint256 totalPriceWei,
        uint256 depCount,
        address indexed payer
    );

    error ZeroAddress();
    error Reentrant();
    error NotFactoryCpu(address cpu);
    error NetlistTooLarge(uint256 size);
    error TooManyRefs(uint256 count);
    error MalformedNetlist(string what);
    error UnregisteredDep(bytes32 key);
    error InactiveDep(bytes32 key);
    error MissingTerms(bytes32 key);
    error ZeroPayee(bytes32 key);
    error MissingDependency(address cpu, uint256 circuitId);
    error PinMismatch(address cpu, uint256 circuitId);
    error NetlistMismatch(bytes32 key);
    error WrongValue(uint256 required, uint256 sent);
    error PayFailed(address payee, uint256 amount);
    error MintFailed();
    error TapeoutFailed();
    error TransferFailed();

    constructor(address registry, address factory) {
        if (registry == address(0) || factory == address(0)) revert ZeroAddress();
        REGISTRY = IAttributionRegistry(registry);
        FACTORY = ITapeOutFactory(factory);
    }

    /// @notice License (pay unique registered deps), manufacture, and prove.
    /// @dev Economic scope: DIRECT dependencies only (REF records in the submitted
    ///  netlist), one payment per UNIQUE slot. Transitive deps (deps-of-deps) are
    ///  NOT paid here; they remain attributable via the Phase 3 lineage join, and
    ///  were licensable at the time THEIR parent was taped. A recursive router is
    ///  future work, not a silent omission.
    ///  msg.value must EXACTLY equal licenseTotal + mintValue + tapeoutFee.
    ///  Exact-match = no refund path = no trapped funds. No receive/fallback:
    ///  direct transfers revert (selfdestruct-forced dust is the accepted residual).
    ///  Reverts roll back storage, so the mutex needs no manual reset on failures.
    function licenseAndTapeout(
        address targetCpu,
        bytes calldata nl,
        uint32 nIn,
        uint32 nOut
    ) external payable returns (uint256 newCircuitId, bytes32 lineageHash) {
        if (_locked) revert Reentrant();
        _locked = true;

        if (!FACTORY.isCPU(targetCpu)) revert NotFactoryCpu(targetCpu);
        (uint256 nNand, uint256 nLatch, Dep[] memory deps) = _parse(nl);

        // ---- validate unique dependencies BEFORE spending on manufacture.
        // Order = first appearance in netlist = commitment order (see lineageHash).
        bytes32[] memory ukeys = new bytes32[](deps.length);
        bytes32[] memory uhashes = new bytes32[](deps.length);
        address[] memory upayees = new address[](deps.length);
        uint256[] memory uprices = new uint256[](deps.length);
        bytes32[] memory uterms = new bytes32[](deps.length);
        uint256 uniqueCount = 0;
        uint256 licenseTotal = 0;
        for (uint256 i = 0; i < deps.length; i++) {
            bytes32 key = REGISTRY.slotKey(block.chainid, deps[i].cpu, deps[i].circuitId);
            bool dup = false;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (ukeys[j] == key) {
                    dup = true;
                    break;
                }
            }
            if (dup) continue;
            IAttributionRegistry.Record memory r;
            try REGISTRY.getRegistration(key) returns (
                IAttributionRegistry.Record memory rec
            ) {
                r = rec;
            } catch {
                revert UnregisteredDep(key);
            }
            if (!r.exists) revert UnregisteredDep(key);
            if (!r.active) revert InactiveDep(key);
            if (r.termsHash == bytes32(0)) revert MissingTerms(key);
            if (r.payee == address(0)) revert ZeroPayee(key);
            bytes memory refNl;
            try ICircuits(deps[i].cpu).netlist(deps[i].circuitId) returns (
                bytes memory b
            ) {
                refNl = b;
            } catch {
                revert MissingDependency(deps[i].cpu, deps[i].circuitId);
            }
            if (keccak256(refNl) != r.netlistHash) revert NetlistMismatch(key);
            // Pin agreement converts a late post-payment tapeout revert into an
            // early pre-payment one.
            try ICircuits(deps[i].cpu).circuitInfo(deps[i].circuitId) returns (
                uint32 rnIn,
                uint32 rnOut,
                uint32,
                uint32
            ) {
                if (rnIn != deps[i].nIns || rnOut != deps[i].nOut) {
                    revert PinMismatch(deps[i].cpu, deps[i].circuitId);
                }
            } catch {
                revert MissingDependency(deps[i].cpu, deps[i].circuitId);
            }
            ukeys[uniqueCount] = key;
            uhashes[uniqueCount] = r.netlistHash;
            upayees[uniqueCount] = r.payee;
            uprices[uniqueCount] = r.price;
            uterms[uniqueCount] = r.termsHash;
            licenseTotal += r.price;
            uniqueCount++;
        }
        // Trim to unique length without assembly (cap is 16; copy cost is trivial).
        bytes32[] memory tkeys = new bytes32[](uniqueCount);
        bytes32[] memory thashes = new bytes32[](uniqueCount);
        address[] memory tpayees = new address[](uniqueCount);
        uint256[] memory tprices = new uint256[](uniqueCount);
        bytes32[] memory tterms = new bytes32[](uniqueCount);
        for (uint256 i = 0; i < uniqueCount; i++) {
            tkeys[i] = ukeys[i];
            thashes[i] = uhashes[i];
            tpayees[i] = upayees[i];
            tprices[i] = uprices[i];
            tterms[i] = uterms[i];
        }
        lineageHash = keccak256(
            abi.encode(
                targetCpu, nIn, nOut, keccak256(nl),
                tkeys, thashes, tpayees, tprices, tterms
            )
        );

        // ---- manufacturing costs (read live; exact accounting, no leftovers)
        ICircuits cpu = ICircuits(targetCpu);
        ITransistors mat = ITransistors(cpu.transistors());
        uint256 mintPrice = mat.mintPrice();
        uint256 protoFee = mat.protocolFee();
        uint256 mintValue = nNand * mintPrice + nLatch * mintPrice;
        if (nNand > 0) mintValue += protoFee; // one mint() call per nonzero token id
        if (nLatch > 0) mintValue += protoFee;
        uint256 tapeoutFee = cpu.TAPEOUT_FEE();
        uint256 required = licenseTotal + mintValue + tapeoutFee;
        if (msg.value != required) revert WrongValue(required, msg.value);

        // ---- pay (mutex held: reentrant calls revert; zero-price emits, no call)
        for (uint256 i = 0; i < uniqueCount; i++) {
            if (tprices[i] == 0) {
                emit LicensePaid(tkeys[i], tpayees[i], 0, tterms[i]);
                continue;
            }
            (bool ok, ) = tpayees[i].call{ value: tprices[i] }("");
            if (!ok) revert PayFailed(tpayees[i], tprices[i]);
            emit LicensePaid(tkeys[i], tpayees[i], tprices[i], tterms[i]);
        }

        // ---- manufacture (exact forwarded values; any revert unwinds payments too)
        if (nNand > 0) {
            try mat.mint{ value: nNand * mintPrice + protoFee }(0, nNand) {} catch {
                revert MintFailed();
            }
        }
        if (nLatch > 0) {
            try mat.mint{ value: nLatch * mintPrice + protoFee }(1, nLatch) {} catch {
                revert MintFailed();
            }
        }
        try cpu.tapeout{ value: tapeoutFee }(nl, nIn, nOut) returns (uint256 id) {
            newCircuitId = id;
        } catch {
            revert TapeoutFailed();
        }
        // Forward the fresh NFT to the payer (else it would strand on the router).
        // Note: a contract payer must implement onERC721Received, else this reverts
        // (atomically — payment is unwound too).
        try cpu.safeTransferFrom(address(this), msg.sender, newCircuitId) {} catch {
            revert TransferFailed();
        }

        emit LicensedTapeout(
            targetCpu, newCircuitId, lineageHash, licenseTotal, uniqueCount, msg.sender
        );
        _locked = false;
    }

    /// @dev Walk raw netlist bytes; returns own material counts + REF records.
    ///  Lengths: NAND 7B (00||u24||u24), LATCH 4B (01||u24), REF 31+3*nIns.
    ///  Forward-reference checking is tapeout's job; the router needs structure +
    ///  dependency identity (+ pin counts for the early PinMismatch check).
    function _parse(bytes calldata nl)
        internal
        pure
        returns (uint256 nNand, uint256 nLatch, Dep[] memory deps)
    {
        if (nl.length > MAX_NETLIST_BYTES) revert NetlistTooLarge(nl.length);
        bytes memory data = nl; // one copy; unambiguous memory layout below
        uint256 refTotal = 0;
        uint256 p = 0;
        while (p < data.length) {
            uint8 op = uint8(data[p]);
            if (op == 0x00) {
                if (p + 7 > data.length) revert MalformedNetlist("truncated NAND");
                nNand++;
                p += 7;
            } else if (op == 0x01) {
                if (p + 4 > data.length) revert MalformedNetlist("truncated LATCH");
                nLatch++;
                p += 4;
            } else if (op == 0x02) {
                if (p + 31 > data.length) revert MalformedNetlist("truncated REF header");
                uint8 nIns = uint8(data[p + 29]);
                if (p + 31 + uint256(nIns) * 3 > data.length) {
                    revert MalformedNetlist("truncated REF pins");
                }
                refTotal++;
                if (refTotal > MAX_REFS) revert TooManyRefs(refTotal);
                p += 31 + uint256(nIns) * 3;
            } else {
                revert MalformedNetlist("unknown opcode");
            }
        }
        deps = new Dep[](refTotal);
        p = 0;
        uint256 di = 0;
        while (p < data.length) {
            uint8 op = uint8(data[p]);
            if (op == 0x00) {
                p += 7;
            } else if (op == 0x01) {
                p += 4;
            } else {
                uint8 nIns = uint8(data[p + 29]);
                uint8 nOut = uint8(data[p + 30]);
                uint160 a = 0;
                for (uint256 i = 0; i < 20; i++) {
                    a = (a << 8) | uint160(uint8(data[p + 1 + i]));
                }
                uint64 cid = 0;
                for (uint256 i = 0; i < 8; i++) {
                    cid = (cid << 8) | uint64(uint8(data[p + 21 + i]));
                }
                deps[di++] = Dep({
                    cpu: address(a),
                    circuitId: cid,
                    nIns: nIns,
                    nOut: nOut
                });
                p += 31 + uint256(nIns) * 3;
            }
        }
    }

    /// @dev No receive/fallback: direct transfers revert. (Selfdestruct-forced dust
    ///  is the accepted residual risk; exact-value accounting leaves no residuals.)
}
