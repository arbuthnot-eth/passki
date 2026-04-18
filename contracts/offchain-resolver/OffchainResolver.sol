// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// IExtendedResolver — ENSIP-10 wildcard resolver interface. Inlined to avoid
// an external dependency on ens-contracts (only 1 method, spec'd interfaceId
// is 0x9061b923).
interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @title OffchainResolver
/// @notice ENSIP-10 / EIP-3668 wildcard resolver that redirects lookups to an
///         off-chain gateway (sui.ski Cloudflare Worker). Every resolved answer
///         carries a secp256k1 signature from one of the allowlisted `signers`;
///         the Worker signs with ENS_SIGNER_PRIVATE_KEY, and the ultron IKA
///         dWallet's ETH address stands by as a threshold-signed co-signer of
///         record for rotation.
///
/// @dev    Binds per-parent via ENS Registry:
///           ENS.setResolver(namehash('<parent>.eth'), address(this))
///         whelm.eth binds first (2026-04-17 pivot); waap.eth joins automatically
///         once whelmed. The gateway demultiplexes by DNS-encoded name.
///
///         Signature scheme matches the ENS reference offchain-resolver:
///           sigHash = keccak256(abi.encodePacked(
///             hex"1900", address(this), expires,
///             keccak256(request), keccak256(result)
///           ))
///         Worker signs sigHash with secp256k1; signer must be in `signers`.
contract OffchainResolver is IExtendedResolver {
    string public url;
    mapping(address => bool) public signers;
    address public admin;

    /// @dev Thrown by `resolve` to trigger EIP-3668 off-chain lookup on the client.
    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );

    event NewSigners(address[] signers);
    event RemovedSigners(address[] signers);
    event GatewayUrlUpdated(string url);
    event AdminUpdated(address admin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "OffchainResolver: not admin");
        _;
    }

    /// @param _url      Gateway URL template (e.g. "https://sui.ski/ens-resolver/{sender}/{data}.json").
    /// @param _signers  Addresses allowed to sign gateway responses.
    constructor(string memory _url, address[] memory _signers) {
        url = _url;
        admin = msg.sender;
        for (uint256 i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
        }
        emit NewSigners(_signers);
        emit GatewayUrlUpdated(_url);
        emit AdminUpdated(msg.sender);
    }

    function addSigners(address[] calldata toAdd) external onlyAdmin {
        for (uint256 i = 0; i < toAdd.length; i++) signers[toAdd[i]] = true;
        emit NewSigners(toAdd);
    }

    function removeSigners(address[] calldata toRemove) external onlyAdmin {
        for (uint256 i = 0; i < toRemove.length; i++) signers[toRemove[i]] = false;
        emit RemovedSigners(toRemove);
    }

    function setUrl(string calldata _url) external onlyAdmin {
        url = _url;
        emit GatewayUrlUpdated(_url);
    }

    function setAdmin(address _admin) external onlyAdmin {
        admin = _admin;
        emit AdminUpdated(_admin);
    }

    // IExtendedResolver.resolve
    function resolve(bytes calldata name, bytes calldata data) external view override returns (bytes memory) {
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(
            address(this),
            urls,
            abi.encodeWithSelector(IExtendedResolver.resolve.selector, name, data),
            OffchainResolver.resolveWithProof.selector,
            abi.encode(name, data)
        );
    }

    /// @notice Callback from EIP-3668 client after fetching `url`.
    /// @param response  ABI-encoded (bytes result, uint64 expires, bytes sig).
    /// @param extraData The (name, data) tuple from the triggering `resolve` call.
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        require(expires >= block.timestamp, "OffchainResolver: signature expired");

        // Reproduce sigHash exactly as the Worker signs it.
        bytes32 sigHash = keccak256(abi.encodePacked(
            hex"1900",
            address(this),
            expires,
            keccak256(extraData),
            keccak256(result)
        ));

        address signer = _ecrecover(sigHash, sig);
        require(signer != address(0), "OffchainResolver: bad signature");
        require(signers[signer], "OffchainResolver: signer not allowed");
        return result;
    }

    /// @dev Minimal ecrecover wrapper handling the 65-byte (r||s||v) format
    ///      with v ∈ {27, 28}. Rejects bad-length sigs early.
    function _ecrecover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x9061b923 || // IExtendedResolver
            interfaceId == 0x01ffc9a7;   // ERC-165
    }
}
