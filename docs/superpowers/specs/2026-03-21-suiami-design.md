# SuiAMI — Sui Authenticated Message Identity

## Overview

SuiAMI is a cryptographic identity proof system. When the balance section is collapsed, the green arrow button becomes a SuiAMI sign button. Clicking it creates a signed message proving the user owns their primary SuiNS name, bundled into a shareable proof token.

## Message Format

```json
{
  "protocol": "suiami",
  "version": 1,
  "state": "I am brando",
  "name": "brando",
  "network": "sui",
  "address": "0x2b35...a7ee28",
  "nftId": "0xabc...def",
  "timestamp": 1711022400000
}
```

- `protocol` — always `"suiami"`
- `version` — protocol version, currently `1`
- `state` — human-readable statement: `"I am ${name}"`
- `name` — bare SuiNS name without `.sui`
- `network` — always `"sui"`
- `address` — full wallet address (0x-prefixed, 64 hex chars)
- `nftId` — SuiNS registration NFT object ID
- `timestamp` — Unix milliseconds at sign time

## Proof Token Format

```
suiami:<base64_message>.<base64_signature>
```

Single string, URL-safe, parseable by any verifier. The `suiami:` prefix identifies the protocol.

## User Flow

1. User has balance section collapsed (swap/chips hidden)
2. Green arrow button shows as SuiAMI sign button (different icon/style)
3. Click → resolve NFT ID from owned domains cache, fallback to live SuiNS query
4. Build JSON message → `signPersonalMessage` → get `{ bytes, signature }`
5. Bundle into proof token
6. Simultaneously:
   - Copy proof to clipboard
   - Emit `suiami:signed` custom event on `window` with proof payload
   - POST to `/api/suiami/verify` for server-side validation and storage
   - Show toast with success

## Components

### `src/suiami.ts` (new)

- `buildSuiamiMessage(name, address, nftId)` — constructs the JSON message
- `createSuiamiProof(message, signature)` — bundles into `suiami:` token
- `parseSuiamiProof(token)` — decodes a proof token back into message + signature
- `verifySuiamiProof(token)` — verifies signature matches address (client-side)

### `src/ui.ts` (modify)

- When `coinChipsOpen === false` AND user has a SuiNS name:
  - Send button changes to SuiAMI mode (different icon/title)
  - Click handler calls SuiAMI flow instead of send/swap
- NFT ID resolution: check `fetchOwnedDomains` cache first, fallback to live query

### `src/server/index.ts` (modify)

- `POST /api/suiami/verify` — validates proof, stores in D1 or KV
  - Verify signature cryptographically
  - Verify address owns the NFT on-chain
  - Verify NFT resolves to the claimed domain
  - Return verification result

### Custom Event

```ts
window.dispatchEvent(new CustomEvent('suiami:signed', {
  detail: { proof, message, signature, name, address }
}));
```

dApps embedding SKI can listen for `suiami:signed` to consume the identity proof.

## Verification (any consumer)

1. Decode the base64 message from the proof token
2. Verify the signature against the address using Sui's `verifyPersonalMessageSignature`
3. Verify the address owns the NFT (on-chain lookup)
4. Verify the NFT resolves to the claimed domain name
5. Check timestamp freshness (optional, consumer-defined)

## Button Behavior

| State | Button | Action |
|-------|--------|--------|
| Balance expanded (coinChipsOpen=true) | Green → send/swap | Normal send/swap flow |
| Balance collapsed + has SuiNS name | SuiAMI sign button | Sign identity proof |
| Balance collapsed + no SuiNS name | Disabled/hidden | No action |
