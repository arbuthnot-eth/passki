# Prism Media — Dataful Thunder Messages

> Thunder signals that carry data. MP3s, images, video, documents — encrypted, ownable, playable.

## The Idea

A Prism is a Thunder signal that refracts into layers. One of those layers can be **data** — any file, encrypted and stored on Walrus, with ownership tracked as a compressed P-token on Solana.

When you send a Thunder with an MP3 attached:
- The MP3 lives on Walrus (permanent, decentralized)
- A P-token on Solana proves you own/sent it
- The Thunder payload carries the encrypted blob ID
- The recipient decrypts → fetches → plays it in the idle overlay

## Architecture

```
Sender                         Walrus           Solana              Sui
  │                              │                │                  │
  ├── upload MP3 ───────────────►│                │                  │
  │◄── blob ID ─────────────────│                │                  │
  │                              │                │                  │
  ├── mint P-token ─────────────────────────────►│                  │
  │   (compressed, metadata =    │                │                  │
  │    blobId + mimeType + size) │                │                  │
  │                              │                │                  │
  ├── Thunder signal ───────────────────────────────────────────────►│
  │   (encrypted: blobId +       │                │                  │
  │    P-token ref + message)    │                │                  │
  │                              │                │                  │

Recipient
  │
  ├── Quest (decrypt Thunder) ──────────────────────────────────────►│
  │◄── decrypted payload ────────────────────────────────────────────│
  │                              │                │                  │
  ├── fetch blob ───────────────►│                │                  │
  │◄── MP3 data ────────────────│                │                  │
  │                              │                │                  │
  ├── verify P-token ───────────────────────────►│                  │
  │◄── ownership confirmed ─────────────────────│                  │
  │                              │                │                  │
  └── plays in idle overlay      │                │                  │
```

## Prism Payload Extension

Current Thunder payload:
```ts
{
  v: 5,
  sender: "brando.sui",
  senderAddress: "0x...",
  message: "what up dinggong",
  timestamp: "...",
}
```

Dataful Prism payload:
```ts
{
  v: 5,
  sender: "brando.sui",
  senderAddress: "0x...",
  message: "check this track",
  timestamp: "...",
  // New: media attachment
  media: {
    blobId: "walrus:abc123...",          // Walrus blob ID (encrypted in Thunder)
    mimeType: "audio/mpeg",              // MP3, image/png, video/mp4, etc.
    size: 3_400_000,                     // bytes
    duration: 180,                       // seconds (audio/video)
    title: "Thunder Storm",             // optional metadata
    ptoken: {                           // Solana P-token reference
      mint: "So1ana...",                // compressed token mint
      treeAddress: "Tree...",           // Merkle tree
      leafIndex: 42,                    // leaf in tree
    },
  },
}
```

## Supported Media Types

| Type | MIME | Playback | Notes |
|------|------|----------|-------|
| Audio | `audio/mpeg`, `audio/wav` | HTML5 `<audio>` in overlay | Visualizer waveform optional |
| Image | `image/png`, `image/jpeg`, `image/webp` | `<img>` in overlay | Lightbox on tap |
| Video | `video/mp4`, `video/webm` | HTML5 `<video>` in overlay | Thumbnail preview |
| Document | `application/pdf` | Link to download | Preview first page |
| Data | `application/json` | Rendered as formatted JSON | For agent-to-agent payloads |

## P-token Ownership

Every media attachment is a compressed P-token on Solana:

- **Transferable**: Recipient can forward the P-token to someone else (re-gift the song)
- **Tradeable**: List on a marketplace (rare Prisms = collectibles)
- **Provenance**: Compressed Merkle tree tracks full chain: creator → sender → recipient → ...
- **Royalty**: Original creator's address in metadata. Future marketplace can enforce creator royalties.
- **Scribe-logged**: Every transfer recorded as compressed state by micro quest Scribes

### Why P-tokens, Not NFTs?

- Compressed = 95% cheaper to mint than standard NFTs
- No rent — Merkle leaves don't pay Solana rent
- Batch operations — send 100 Prism media attachments in one tx
- Decompress to standard SPL NFT anytime (permissionless upgrade)

## Idle Overlay Playback

When recipient quests a Prism with media:

1. Thunder bubble shows media type icon (🎵 for audio, 📷 for image, etc.)
2. Tapping the bubble:
   - Fetches Walrus blob via `https://aggregator.walrus.site/v1/{blobId}`
   - Decrypts if encrypted layer present
   - **Audio**: inline player appears below the bubble. Play/pause. Waveform.
   - **Image**: expands in the convo area. Tap to fullscreen.
   - **Video**: inline player. Tap to fullscreen.
3. P-token badge on the bubble shows ownership status (green = you own it)

## Upload Flow

Sender side in the Thunder input:

1. Tap 📎 attachment button (new, next to send ⚡)
2. File picker opens
3. Selected file uploads to Walrus via `PUT /v1/store`
4. P-token minted on Solana (compressed, micro quest t2000 handles this)
5. Blob ID + P-token ref encrypted into Thunder payload
6. Send as normal Thunder signal

### Size Limits

- Walrus blob: no hard limit (paid by epoch storage)
- Practical limit: 10MB for audio, 5MB for images, 50MB for video
- Encoding: raw bytes for media, JSON envelope for metadata

## Cost

| Operation | Cost |
|-----------|------|
| Walrus store (1MB, 1 epoch) | ~0.01 WAL |
| P-token mint (compressed) | ~5,000 CU (~$0.000001) |
| Thunder signal on Sui | ~0.001 SUI |
| **Total per Prism with MP3** | **~$0.01** |

A dollar buys 100 media Prisms. An MP3 message costs a penny.

## Privacy Stack

1. **Walrus blob**: content is public if you know the blob ID — but encrypted if sender encrypted it
2. **Thunder payload**: blob ID encrypted with recipient's key — only they know what to fetch
3. **P-token metadata**: can be encrypted (compressed account data field)
4. **On-chain**: observers see a Thunder signal + a compressed token transfer. They don't know what's inside either.

For maximum privacy: encrypt the MP3 before storing on Walrus, encrypt the blob ID in the Thunder payload, encrypt the P-token metadata. Three layers of encryption. Recipient peels each one during quest.

## Future: Prism Playlists

Multiple media P-tokens in a single Thunder = a playlist. The idle overlay queues them and plays sequentially. A Thunder chat between two people becomes a shared music library — every song is an ownable P-token, every play is verified, every share is tracked.
