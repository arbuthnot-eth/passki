# Thunder Image Attachments + Quick Share — Design Spec

## Overview

Two features sharing one upload pipeline: (1) encrypted image attachments in Thunder signals stored on Walrus, decrypted via Seal threshold encryption, and (2) public quick-share links for screenshots/images with no encryption.

## Upload Flow (shared)

1. User taps share button in idle overlay → file picker opens (`accept="image/*"`, camera on mobile)
2. Browser compresses image client-side: canvas resize to max 1200px longest side, JPEG quality 0.7, target <1MB
3. `POST /api/share` → Worker validates size (<1MB), proxies to Walrus mainnet publisher
4. Walrus returns blobId → two paths diverge based on context

## Public Share Path

When no recipient name is in the overlay input:

- Worker returns `https://sui.ski/w/{blobId}`
- Auto-copy link to clipboard, show toast
- `GET /w/:blobId` redirects to `aggregator.walrus-mainnet.walrus.space/v1/blobs/{blobId}`
- No encryption — blob is publicly readable on Walrus

## Encrypted Attachment Path

When a recipient SuiNS name is in the overlay input:

1. Compress image client-side (<1MB)
2. Seal-encrypt the image bytes using recipient's SuiNS NFT as the access policy (2-of-3 threshold: Overclock, NodeInfra, Studio Mirai)
3. Upload the Seal ciphertext (not the raw image) to Walrus → get blobId
4. Send Thunder signal with extended payload:

```json
{
  "v": 1,
  "sender": "alice.sui",
  "senderAddress": "0x...",
  "message": "",
  "timestamp": "2026-03-30T...",
  "attachment": {
    "blobId": "abc123...",
    "mimeType": "image/jpeg",
    "encrypted": true
  }
}
```

The image bytes on Walrus are opaque ciphertext — knowing the blobId reveals nothing. Only the recipient's NFT owner can Seal-decrypt the content.

## Decryption on Recipient Side

1. `decryptAndQuest` parses the signal, sees `attachment` field with `encrypted: true`
2. Text signal encryption (AES-256-GCM with XOR-masked key) decrypts the payload JSON as usual
3. Fetch Seal-encrypted blob from Walrus aggregator using `attachment.blobId`
4. Call Seal key servers with NFT ownership proof to decrypt the blob → get raw image bytes
5. Create object URL from decrypted bytes, render inline in thunder conversation as `<img>`

## Encryption Model

- **Text signals**: Keep existing AES-256-GCM with XOR-masked key (fast, works offline, ephemeral)
- **Image attachments**: Seal threshold encryption (stronger, worth it for persistent Walrus data)
- **Public shares**: No encryption

Rationale: text signals are ephemeral (quested and deleted from Storm). Walrus blobs are permanent — without Seal, anyone with the blobId + NFT object ID could reconstruct the AES key and decrypt. Seal's 2-of-3 threshold means the key never exists in one place.

## Image Compression

Client-side canvas compression before upload:

- Max dimension: 1200px on longest side (proportional scaling)
- Format: JPEG, quality 0.7
- Hard limit: reject if still >1MB after compression
- No server-side processing — Worker just validates size and proxies

## Worker Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `POST /api/share` | POST | Accept image, validate <1MB, proxy to Walrus publisher, return `{ blobId, url }` |
| `GET /w/:blobId` | GET | Redirect to Walrus aggregator `https://aggregator.walrus-mainnet.walrus.space/v1/blobs/:blobId` |

## UI

Share button in the idle overlay, positioned outside the thunder input row. Context-aware:

- **No name in input** → tap → file picker → compress → upload → copy public link
- **Name in input** → tap → file picker → compress → upload → Seal encrypt → send as Thunder signal with attachment

## File Changes

| File | Change |
|------|--------|
| `src/server/index.ts` | `POST /api/share` route + `GET /w/:blobId` redirect |
| `src/client/thunder.ts` | Seal encrypt attachment blobId, include in signal payload |
| `src/client/thunder.ts` | Decrypt attachment on quest via Seal key servers, fetch blob |
| `src/client/thunder-types.ts` | Add `attachment?: { blobId: string; mimeType: string; encrypted: boolean }` to `ThunderPayload` |
| `src/ui.ts` | Share button in overlay, file picker, canvas compression, inline image render in convo |

## Security

- Public shares are intentionally unencrypted — user explicitly chooses public
- Encrypted attachments use Seal (2-of-3 threshold) — stronger than the text signal AES path
- Worker validates content-type and size before proxying to Walrus
- Rate limiting on `/api/share` to prevent abuse
- BlobIds in Seal ciphertext are opaque — knowing the blobId without Seal decryption is useless (blob content is raw image bytes, not meaningful without context, but still viewable if someone has the blobId)

Encrypted path uploads Seal ciphertext to Walrus, not raw image bytes. The blob content is opaque — discovering the blobId reveals nothing without Seal decryption via the NFT owner's key servers.
