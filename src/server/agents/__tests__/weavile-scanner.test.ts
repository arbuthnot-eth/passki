/**
 * Weavile Pursuit — scanner DO + derivation tests (#198).
 *
 * Covers:
 *   - deriveStealthForEvent secp256k1 happy path (EIP-5564 sender round-trip)
 *   - deriveStealthForEvent secp256k1 view-tag mismatch fast-path skip
 *   - deriveStealthForEvent ed25519 happy path (SKI-native: scalar·point ECDH + SHA-256 tweak)
 *   - WeavileScannerAgent.subscribe + onAnnouncementEvent enqueues match
 *   - WeavileScannerAgent.onAnnouncementEvent skips mismatched view-tag
 *   - WeavileScannerAgent.tick() drains pendingStealths in batches
 *
 * Test vectors are computed inline using @noble/curves sender math so
 * the scanner's derivation is validated against the reference
 * implementation (ECDH(v,E) === ECDH(e,V), then HKDF/SHA-256 tweak,
 * stealth_pub = spend_pub + s·G). See `src/server/agents/weavile-scanner.md`
 * §Derivation and EIP-5564 §Naïve implementation for the spec.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

beforeAll(() => {
  mock.module('agents', () => ({
    Agent: class AgentStub<_E, S> {
      state: S;
      name = 'test';
      ctx: { storage: { setAlarm: (ms: number) => void } };
      env: unknown;
      initialState!: S;
      constructor(_ctx: unknown, env: unknown) {
        this.env = env;
        this.ctx = { storage: { setAlarm: () => {} } };
        setTimeout(() => { this.state = this.initialState; }, 0);
      }
      setState(s: S) { this.state = s; }
      alarm = async () => {};
    },
    callable: () => (_target: unknown, _prop: unknown, desc: PropertyDescriptor) => desc,
  }));
});

// ─── Helpers (sender-side math for test vectors) ────────────────────

function toHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function senderSecp256k1(
  spendPriv: Uint8Array, viewPriv: Uint8Array, ephPriv: Uint8Array,
) {
  const spendPub = secp256k1.getPublicKey(spendPriv, true);
  const viewPub = secp256k1.getPublicKey(viewPriv, true);
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  // ECDH(eph_priv, view_pub) — sender side (scanner runs ECDH(view_priv, eph_pub)).
  const shared = secp256k1.getSharedSecret(ephPriv, viewPub, true);
  const xOnly = shared.slice(1); // strip compression prefix, X-coord only
  const s = hkdf(sha256, xOnly, new Uint8Array(0), new Uint8Array(0), 32);
  const viewTag = s[0];
  let sScalar = 0n;
  for (const b of s) sScalar = (sScalar << 8n) | BigInt(b);
  sScalar = sScalar % secp256k1.Point.Fn.ORDER;
  const stealthPub = secp256k1.Point.fromBytes(spendPub)
    .add(secp256k1.Point.BASE.multiply(sScalar))
    .toBytes(true);
  return { spendPub, viewPub, ephPub, viewTag, stealthPub, tweak: s };
}

function senderEd25519(
  spendSeed: Uint8Array, viewSeed: Uint8Array, ephSeed: Uint8Array,
) {
  const spendPub = ed25519.getPublicKey(spendSeed);
  const viewPub = ed25519.getPublicKey(viewSeed);
  const ephPub = ed25519.getPublicKey(ephSeed);
  // Sender: shared = eph_scalar · view_pub_point
  const ephExt = ed25519.utils.getExtendedPublicKey(ephSeed);
  const shared = ed25519.Point.fromBytes(viewPub).multiply(ephExt.scalar).toBytes();
  const s = sha256(shared);
  const viewTag = s[0];
  let sScalar = 0n;
  for (let i = s.length - 1; i >= 0; i--) sScalar = (sScalar << 8n) | BigInt(s[i]);
  sScalar = sScalar % ed25519.Point.Fn.ORDER;
  const stealthPub = ed25519.Point.fromBytes(spendPub)
    .add(ed25519.Point.BASE.multiply(sScalar))
    .toBytes();
  return { spendPub, viewPub, ephPub, viewTag, stealthPub, tweak: s };
}

// ─── deriveStealthForEvent unit tests ───────────────────────────────

describe('deriveStealthForEvent — secp256k1', () => {
  test('happy path: scanner re-derives sender stealth_pub from view_priv', async () => {
    const { deriveStealthForEvent } = await import('../weavile-stealth-derive.js');
    // Fixed seeds so the vector is stable across runs. EIP-5564 §Naïve
    // impl reference: HKDF-SHA256 over ECDH(v,E) X-coord, first byte is
    // view_tag, stealth_pub = spend_pub + s·G.
    const spendPriv = new Uint8Array(32); spendPriv[31] = 0x11;
    const viewPriv = new Uint8Array(32); viewPriv[31] = 0x22;
    const ephPriv = new Uint8Array(32); ephPriv[31] = 0x33;
    const v = senderSecp256k1(spendPriv, viewPriv, ephPriv);

    const result = deriveStealthForEvent({
      ephemeralPub: v.ephPub,
      viewTag: v.viewTag,
      viewPriv,
      spendPub: v.spendPub,
      curve: 'secp256k1',
    });
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error('unreachable');
    expect(toHex(result.stealthPub)).toBe(toHex(v.stealthPub));
    expect(result.tweakHex).toBe(toHex(v.tweak));
    expect(result.derivedViewTag).toBe(v.viewTag);
  });

  test('view-tag mismatch: returns { matched: false } after fast-path skip', async () => {
    const { deriveStealthForEvent } = await import('../weavile-stealth-derive.js');
    const spendPriv = new Uint8Array(32); spendPriv[31] = 0x11;
    const viewPriv = new Uint8Array(32); viewPriv[31] = 0x22;
    const ephPriv = new Uint8Array(32); ephPriv[31] = 0x33;
    const v = senderSecp256k1(spendPriv, viewPriv, ephPriv);

    const result = deriveStealthForEvent({
      ephemeralPub: v.ephPub,
      viewTag: (v.viewTag + 1) & 0xff, // deliberate mismatch
      viewPriv,
      spendPub: v.spendPub,
      curve: 'secp256k1',
    });
    expect(result.matched).toBe(false);
    // derivedViewTag is still reported so callers can log the real tag
    // for debugging (e.g. "scanner thought it was 0x9b, event said 0x9c").
    expect(result.derivedViewTag).toBe(v.viewTag);
  });
});

describe('deriveStealthForEvent — ed25519', () => {
  test('happy path: scanner re-derives sender stealth_pub (SKI-native vector)', async () => {
    const { deriveStealthForEvent } = await import('../weavile-stealth-derive.js');
    const spendSeed = new Uint8Array(32); spendSeed[0] = 0x99;
    const viewSeed = new Uint8Array(32); viewSeed[0] = 0x2a;
    const ephSeed = new Uint8Array(32); ephSeed[0] = 0x07;
    const v = senderEd25519(spendSeed, viewSeed, ephSeed);

    const result = deriveStealthForEvent({
      ephemeralPub: v.ephPub,
      viewTag: v.viewTag,
      viewPriv: viewSeed,
      spendPub: v.spendPub,
      curve: 'ed25519',
    });
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error('unreachable');
    expect(toHex(result.stealthPub)).toBe(toHex(v.stealthPub));
    expect(result.tweakHex).toBe(toHex(v.tweak));
  });
});

// ─── Scanner DO tests ───────────────────────────────────────────────

function adminAuthSkip() {
  // No auth supplied → onAnnouncementEvent bypasses the admin gate
  // (webhook fan-in path). We still want subscribe() to accept the
  // operation under test, so we monkeypatch _requireAdmin via a
  // subclass that always passes. Simpler: grant via mock below.
}
void adminAuthSkip;

describe('WeavileScannerAgent', () => {
  test('subscribe + onAnnouncementEvent enqueues matching stealth', async () => {
    const mod = await import('../weavile-scanner.js');
    const { WeavileScannerAgent } = mod;
    const agent = new WeavileScannerAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    agent.state = { scanners: [], pendingStealths: [], completedSweeps: [] };
    // Stub admin gate — not under test here.
    (agent as unknown as { _requireAdmin: () => Promise<null> })._requireAdmin = async () => null;

    const spendPriv = new Uint8Array(32); spendPriv[31] = 0xaa;
    const viewPriv = new Uint8Array(32); viewPriv[31] = 0xbb;
    const ephPriv = new Uint8Array(32); ephPriv[31] = 0xcc;
    const v = senderSecp256k1(spendPriv, viewPriv, ephPriv);

    const sub = await agent.subscribe({
      recipientSuiAddr: '0xRECIPIENT',
      viewKeyShares: { eth: toHex(viewPriv) },
      spendPubkeys: { eth: toHex(v.spendPub) },
      auth: { adminAddress: 'x', signature: 'x', message: 'x' },
    });
    expect(sub.success).toBe(true);
    expect(agent.state.scanners.length).toBe(1);

    const r = await agent.onAnnouncementEvent({
      event: {
        chain: 'eth',
        ephemeralPubHex: toHex(v.ephPub),
        stealthAddr: '0xSTEALTH_ADDR_MOCK',
        viewTag: v.viewTag,
        schemeId: 0,
        announcementDigest: '0xDIGEST',
        announcedMs: 0,
      },
    });
    expect(r.matched).toBe(1);
    expect(r.skipped).toBe(0);
    expect(agent.state.pendingStealths.length).toBe(1);
    expect(agent.state.pendingStealths[0].tweakHex).toBe(toHex(v.tweak));
    expect(agent.state.pendingStealths[0].chain).toBe('eth');
  });

  test('onAnnouncementEvent for mismatched view-tag does not enqueue', async () => {
    const mod = await import('../weavile-scanner.js');
    const { WeavileScannerAgent } = mod;
    const agent = new WeavileScannerAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    agent.state = { scanners: [], pendingStealths: [], completedSweeps: [] };
    (agent as unknown as { _requireAdmin: () => Promise<null> })._requireAdmin = async () => null;

    const spendPriv = new Uint8Array(32); spendPriv[31] = 0xaa;
    const viewPriv = new Uint8Array(32); viewPriv[31] = 0xbb;
    const ephPriv = new Uint8Array(32); ephPriv[31] = 0xcc;
    const v = senderSecp256k1(spendPriv, viewPriv, ephPriv);

    await agent.subscribe({
      recipientSuiAddr: '0xRECIPIENT',
      viewKeyShares: { eth: toHex(viewPriv) },
      spendPubkeys: { eth: toHex(v.spendPub) },
      auth: { adminAddress: 'x', signature: 'x', message: 'x' },
    });

    const r = await agent.onAnnouncementEvent({
      event: {
        chain: 'eth',
        ephemeralPubHex: toHex(v.ephPub),
        stealthAddr: '0xSTEALTH',
        viewTag: (v.viewTag + 1) & 0xff, // wrong tag
        schemeId: 0,
        announcementDigest: '0xDIGEST',
        announcedMs: 0,
      },
    });
    expect(r.matched).toBe(0);
    expect(r.skipped).toBe(1);
    expect(agent.state.pendingStealths.length).toBe(0);
  });

  test('tick() processes pendingStealths in batches with jitter', async () => {
    const mod = await import('../weavile-scanner.js');
    const { WeavileScannerAgent } = mod;
    const agent = new WeavileScannerAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    // Seed 40 pending stealths; TICK_BATCH_MAX = 32.
    const pending = Array.from({ length: 40 }, (_, i) => ({
      recipientSuiAddr: '0xRECIPIENT',
      chain: 'eth',
      stealthAddr: `0xS${i}`,
      ephemeralPubHex: '0xEPH',
      tweakHex: '0xTWEAK',
      announcementDigest: `0xD${i}`,
      detectedMs: 0,
      schemeId: 0,
    }));
    agent.state = { scanners: [], pendingStealths: pending, completedSweeps: [] };
    // Swap in no-op sources so tick doesn't call the real ones.
    agent.setEventSources([]);

    const r = await agent.tick();
    expect(r.polled).toBe(0);
    // Batch size capped at TICK_BATCH_MAX=32.
    expect(r.batchSize).toBe(32);
    expect(r.processed).toBe(32);
    // Jitter in [30s, 30min].
    expect(r.jitterMs).toBeGreaterThanOrEqual(30_000);
    expect(r.jitterMs).toBeLessThanOrEqual(30 * 60 * 1000);
    // Metal Claw stubs: batch is re-queued (no real sweep yet), so
    // pendingStealths.length stays 40.
    expect(agent.state.pendingStealths.length).toBe(40);
  });
});

describe('parseEthAnnouncementLog', () => {
  test('parses real ERC-5564 log shape', async () => {
    const { parseEthAnnouncementLog, ERC5564_ANNOUNCEMENT_TOPIC0 } = await import('../weavile-scanner.js');
    // Shape hand-built to match the canonical EIP-5564 Announcement event
    // layout (schemeId, stealthAddress, caller indexed; ephemeralPubkey
    // + metadata non-indexed bytes). Real Announcer tx example:
    // https://etherscan.io/address/0x55649e01b5df198d18d95b5cc5051630cfd45564#events
    const schemeId = '00'.repeat(31) + '00'; // uint256 = 0
    const stealth = '0x' + '00'.repeat(12) + 'deadbeef'.repeat(5); // 32-byte padded addr
    const caller  = '0x' + '00'.repeat(12) + 'cafecafe'.repeat(5);
    // data: two offsets (0x40, 0x80), then ephPub (len 33, padded to 64),
    // then metadata (len 1 = single view_tag byte, padded to 32).
    const ephPayload = '02' + 'ab'.repeat(32); // 33 bytes
    const ephPadded = ephPayload + '00'.repeat(32 - (33 % 32));
    const metadataPayload = '9b'; // view tag = 0x9b
    const metaPadded = metadataPayload + '00'.repeat(32 - 1);
    const data = '0x'
      + '0000000000000000000000000000000000000000000000000000000000000040' // eph offset = 64
      + '00000000000000000000000000000000000000000000000000000000000000a0' // meta offset = 160 (64 + 32 len + 64 padded payload)
      + '0000000000000000000000000000000000000000000000000000000000000021' // 33
      + ephPadded
      + '0000000000000000000000000000000000000000000000000000000000000001' // 1
      + metaPadded;
    const parsed = parseEthAnnouncementLog({
      address: '0x55649e01b5df198d18d95b5cc5051630cfd45564',
      topics: [ERC5564_ANNOUNCEMENT_TOPIC0, '0x' + schemeId, stealth, caller],
      data,
      blockNumber: '0x1234567',
      transactionHash: '0xabc',
    });
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error('unreachable');
    expect(parsed.chain).toBe('eth');
    expect(parsed.schemeId).toBe(0);
    expect(parsed.viewTag).toBe(0x9b);
    expect(parsed.ephemeralPubHex.length).toBe(2 + 33 * 2);
    expect(parsed.stealthAddr).toBe('0x' + 'deadbeef'.repeat(5));
    expect(parsed.announcementDigest).toBe('0xabc');
  });

  test('rejects log with wrong topic0', async () => {
    const { parseEthAnnouncementLog } = await import('../weavile-scanner.js');
    expect(parseEthAnnouncementLog({
      address: '0x55649e01b5df198d18d95b5cc5051630cfd45564',
      topics: ['0xDEADBEEF', '0x00', '0x00', '0x00'],
      data: '0x',
      blockNumber: '0x0',
      transactionHash: '0x',
    })).toBeNull();
  });
});

describe('SuiAnnouncerSource', () => {
  test('parses stealth_announcer event from GraphQL shape', async () => {
    const { SuiAnnouncerSource } = await import('../weavile-scanner.js');
    // Mock fetch to return a well-formed events query response.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      json: async () => ({
        data: { events: { nodes: [{
          sequenceNumber: '42',
          timestamp: '1713398400000',
          contents: { json: {
            announcer: '0xAAA',
            ephemeral_pubkey: Array.from({ length: 32 }, (_, i) => i),
            stealth_addr: '0xBEEF',
            view_tag: 0x42,
            metadata: [],
            scheme_id: 1,
            announced_ms: '1713398400000',
          } },
          transactionBlock: { digest: 'digestX' },
        }] } },
      }),
    })) as typeof fetch;
    const src = new SuiAnnouncerSource('0xPKG');
    const events = await src.pollSince(0);
    globalThis.fetch = origFetch;
    expect(events.length).toBe(1);
    expect(events[0].chain).toBe('sui');
    expect(events[0].schemeId).toBe(1);
    expect(events[0].viewTag).toBe(0x42);
    expect(events[0].stealthAddr).toBe('0xBEEF');
    expect(events[0].announcementDigest).toBe('digestX');
    expect(events[0].ephemeralPubHex.length).toBe(2 + 32 * 2);
  });

  test('returns empty when pkgId is null (pre-deploy)', async () => {
    const { SuiAnnouncerSource } = await import('../weavile-scanner.js');
    const src = new SuiAnnouncerSource(null);
    expect(await src.pollSince(0)).toEqual([]);
  });
});

describe('webhook HMAC verification', () => {
  test('correct Alchemy-style signature verifies', async () => {
    // Reuse eth-inbound.verifyAlchemySignature — same function the
    // weavile webhook calls. Separate unit test to seed that the guard
    // fires on bad inputs before we trust the router.
    const { verifyAlchemySignature } = await import('../../eth-inbound.js');
    const secret = 'test-secret';
    const body = '{"logs":[]}';
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(await verifyAlchemySignature(body, hex, secret)).toBe(true);
  });

  test('wrong Alchemy-style signature is rejected', async () => {
    const { verifyAlchemySignature } = await import('../../eth-inbound.js');
    expect(await verifyAlchemySignature('{}', 'deadbeef'.repeat(8), 'secret')).toBe(false);
    expect(await verifyAlchemySignature('{}', null, 'secret')).toBe(false);
  });
});

describe('pickScanJitterMs', () => {
  test('returns values in [30s, 30min]', async () => {
    const { pickScanJitterMs } = await import('../weavile-scanner.js');
    for (let i = 0; i < 50; i += 1) {
      const j = pickScanJitterMs();
      expect(j).toBeGreaterThanOrEqual(30_000);
      expect(j).toBeLessThanOrEqual(30 * 60 * 1000);
    }
  });
});
