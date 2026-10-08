// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title AttributionRegistry
/// @notice Application-level attribution records for reusable TapeOut computations.
///
/// A record binds a TapeOut circuit slot — (chainId, processor, circuitId) — to the
/// observed netlistHash plus economic terms (payee, price, termsHash). Reads are
/// permissionless; each record is writable only by its original registrant.
///
/// @dev What this contract DOES NOT do (by design, see docs/PROTOCOL.md sections 5-6):
///  - it cannot prevent copying, REF reuse, reimplementation, or direct factory calls;
///  - it pays nobody and enforces no royalties (price is recorded, settlement is later);
///  - the TapeOut factory never consults it.
///  It is an evidence log: "who registered this computation, under what terms, at
///  what price." Consumers verify records against live chain state (netlistHash).
///
/// Key design: slotKey = keccak256(abi.encode(chainId, processor, circuitId)).
/// The netlistHash is BOUND DATA (not part of the key) so a later observation with
/// a different hash for the same slot yields an explicit MISMATCH instead of a
/// silent second record. chainId is data, not a restriction: any chain's slots can
/// be registered (the registry is chain-agnostic; it does not check block.chainid).
contract AttributionRegistry {
    struct Record {
        bytes32 netlistHash;
        address payee;
        uint256 price;
        bytes32 termsHash;
        uint64 registeredAt;
        address registeredBy;
        bool active;
        // @dev Explicit existence flag. registeredAt != 0 would also work on any
        //  live chain (timestamp > 0), but block.timestamp is 0 in test/genesis
        //  environments — an in-process EVM run caught this. Never rely on time
        //  as an existence proof.
        bool exists;
    }

    mapping(bytes32 => Record) private _records;

    event Registered(
        bytes32 indexed key,
        uint256 chainId,
        address indexed processor,
        uint256 indexed circuitId,
        bytes32 netlistHash,
        address payee,
        uint256 price,
        bytes32 termsHash,
        address registeredBy
    );
    event TermsUpdated(
        bytes32 indexed key,
        bytes32 netlistHash,
        address payee,
        uint256 price,
        bytes32 termsHash
    );
    event Deactivated(bytes32 indexed key);

    error AlreadyRegistered(bytes32 key);
    error NotRegistered(bytes32 key);
    error NotRegistrant(bytes32 key, address caller);
    error InactiveRecord(bytes32 key);
    error InvalidParam(string what);

    /// @notice Canonical slot key. Off-chain twin: src/registry keyHashFor().
    function slotKey(
        uint256 chainId,
        address processor,
        uint256 circuitId
    ) public pure returns (bytes32) {
        if (chainId == 0) revert InvalidParam("chainId");
        if (processor == address(0)) revert InvalidParam("processor");
        if (circuitId == 0) revert InvalidParam("circuitId");
        return keccak256(abi.encode(chainId, processor, circuitId));
    }

    /// @notice Register a slot. Caller becomes the sole registrant. One-shot per slot.
    /// @dev price MAY be 0 (gratis). termsHash MAY be 0 (terms not published).
    ///  netlistHash and payee must be nonzero (almost certainly a caller mistake).
    function register(
        uint256 chainId,
        address processor,
        uint256 circuitId,
        bytes32 netlistHash,
        address payee,
        uint256 price,
        bytes32 termsHash
    ) external returns (bytes32 key) {
        if (netlistHash == bytes32(0)) revert InvalidParam("netlistHash");
        if (payee == address(0)) revert InvalidParam("payee");
        key = slotKey(chainId, processor, circuitId);
        if (_records[key].exists) revert AlreadyRegistered(key);
        _records[key] = Record({
            netlistHash: netlistHash,
            payee: payee,
            price: price,
            termsHash: termsHash,
            registeredAt: uint64(block.timestamp),
            registeredBy: msg.sender,
            active: true,
            exists: true
        });
        emit Registered(
            key, chainId, processor, circuitId, netlistHash, payee, price, termsHash, msg.sender
        );
    }

    /// @notice Replace the bound terms. Registrant only, active records only.
    /// @dev netlistHash is correctable here (with an event) because the registry is an
    ///  assertion log: only the registrant can speak for the slot, and every change is
    ///  permanently evented. Consumers treat a changed hash as a flag, not proof.
    function updateTerms(
        bytes32 key,
        bytes32 netlistHash,
        address payee,
        uint256 price,
        bytes32 termsHash
    ) external {
        Record storage r = _records[key];
        if (!r.exists) revert NotRegistered(key);
        if (r.registeredBy != msg.sender) revert NotRegistrant(key, msg.sender);
        if (!r.active) revert InactiveRecord(key);
        if (netlistHash == bytes32(0)) revert InvalidParam("netlistHash");
        if (payee == address(0)) revert InvalidParam("payee");
        r.netlistHash = netlistHash;
        r.payee = payee;
        r.price = price;
        r.termsHash = termsHash;
        emit TermsUpdated(key, netlistHash, payee, price, termsHash);
    }

    /// @notice Permanently deactivate a record. Registrant only, one-way.
    /// @dev One-way by design: deactivation is a tombstone. A live record must be
    ///  unambiguous; flip-flopping active flags would make "registered" meaningless.
    function deactivate(bytes32 key) external {
        Record storage r = _records[key];
        if (!r.exists) revert NotRegistered(key);
        if (r.registeredBy != msg.sender) revert NotRegistrant(key, msg.sender);
        if (!r.active) revert InactiveRecord(key);
        r.active = false;
        emit Deactivated(key);
    }

    /// @notice Full record; reverts for unknown keys (use isRegistered for checks).
    function getRegistration(bytes32 key) external view returns (Record memory) {
        Record memory r = _records[key];
        if (!r.exists) revert NotRegistered(key);
        return r;
    }

    /// @notice True only for records that exist AND are active.
    function isRegistered(bytes32 key) external view returns (bool) {
        Record memory r = _records[key];
        return r.exists && r.active;
    }
}


