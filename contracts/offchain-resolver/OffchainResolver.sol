// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IExtendedResolver} from "@ensdomains/ens-contracts/contracts/resolvers/profiles/IExtendedResolver.sol";
import {SignatureVerifier} from "@ensdomains/ens-contracts/contracts/utils/SignatureVerifier.sol";

/// @title OffchainResolver
/// @notice ENSIP-10 wildcard resolver that redirects lookups to an off-chain
///         gateway (sui.ski Cloudflare Worker). Every resolved answer carries
///         a secp256k1 signature from one of the allowlisted `signers`; the
///         Worker derives the signature from ENS_SIGNER_PRIVATE_KEY, and the
///         ultron IKA dWallet's ETH address stands by as a co-signer of record.
///
///         The contract itself holds no secret — compromise of the hot signer
///         only lets an attacker forge answers until `rotateSigners` lands a
///         new set. ultron's threshold-signed authority is the backstop.
///
/// @dev    Binds per-parent via ENS Registry: `ENS.setResolver(namehash('<parent>.eth'), address(this))`.
///         This project binds whelm.eth first (2026-04-17 pivot); waap.eth joins
///         automatically once whelmed. Single deployed contract, many parents —
///         the gateway demultiplexes by DNS-encoded name inside `name`.
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
    event GatewayUrlUpdated(string url);
    event AdminUpdated(address admin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "OffchainResolver: not admin");
        _;
    }

    /// @param _url      Gateway URL template (e.g. "https://sui.ski/ens-resolver/{sender}/{data}.json").
    /// @param _signers  Addresses allowed to sign gateway responses. First deploy ships with
    ///                  [ENS_SIGNER_PRIVATE_KEY addr, ultron ETH dWallet addr].
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

    /// @notice Admin can rotate the signer set (hot-key compromise recovery) and the URL
    ///         (gateway migration). Intent: admin becomes the ultron IKA dWallet after
    ///         first deploy so rotation is threshold-gated, not hot-key gated.
    function rotateSigners(address[] calldata toAdd, address[] calldata toRemove) external onlyAdmin {
        for (uint256 i = 0; i < toAdd.length; i++) signers[toAdd[i]] = true;
        for (uint256 i = 0; i < toRemove.length; i++) signers[toRemove[i]] = false;
        emit NewSigners(toAdd);
    }

    function setUrl(string calldata _url) external onlyAdmin {
        url = _url;
        emit GatewayUrlUpdated(_url);
    }

    function setAdmin(address _admin) external onlyAdmin {
        admin = _admin;
        emit AdminUpdated(_admin);
    }

    /// @inheritdoc IExtendedResolver
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
    /// @param response  Gateway's signed response (result bytes + expiry + signature).
    /// @param extraData The `(name, data)` tuple from the triggering `resolve` call.
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "OffchainResolver: invalid signer");
        return result;
    }

    /// @inheritdoc IExtendedResolver
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IExtendedResolver).interfaceId || // 0x9061b923
            interfaceId == 0x01ffc9a7; // ERC-165
    }
}
