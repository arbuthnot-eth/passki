/**
 * TimestreamAgent — per-group message storage Durable Object.
 *
 * Stores encrypted Thunder Timestream messages. One DO instance per group
 * (keyed by groupId). Implements the server side of the transport protocol.
 *
 * Messages are stored as encrypted blobs — the DO never sees plaintext.
 * Seal threshold encryption happens client-side via the SDK.
 *
 * Auth: only participant addresses can send/fetch. Participants are tracked
 * by the addresses that have sent messages or been added explicitly.
 */

import { Agent } from 'agents';
import type { Connection, ConnectionContext, WSMessage } from 'partyserver';

/** Wire-format attachment record from @mysten/sui-stack-messaging. */
interface StoredAttachment {
  storageId: string;
  nonce: string;
  encryptedMetadata: string;
  metadataNonce: string;
}

interface StoredMessage {
  messageId: string;
  groupId: string;
  order: number;
  encryptedText: string;  // base64 (Seal-encrypted ciphertext)
  nonce: string;          // base64
  keyVersion: string;     // bigint as string
  /** @deprecated post-P1.1 — populated only for legacy rows. New rows use senderIndex. */
  senderAddress: string;
  /** Index into participants[] at write time. -1 for legacy rows. */
  senderIndex: number;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  signature: string;      // hex
  publicKey: string;      // hex
  /** Wire-format attachment records — point to Walrus blob IDs. */
  attachments?: StoredAttachment[];
}

interface TimestreamState {
  messages: StoredMessage[];
  nextOrder: number;
  /** Addresses allowed to read/write. Auto-populated from senders. */
  participants: string[];
}

interface Env {
  Chronicom: DurableObjectNamespace;
  [key: string]: unknown;
}

/** Normalize Sui address for comparison. */
function normAddr(a: string): string {
  return (a || '').replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/**
 * Round timestamp to 10s bucket + add ±5s uniform noise. Preserves
 * order via the monotonic `order` field. Noise source is
 * crypto.getRandomValues (not Math.random) so statistical analysis
 * across many messages can't recover the true send times.
 */
function jitterTs(ms: number): number {
  const bucket = Math.floor(ms / 10_000) * 10_000;
  const r = new Uint32Array(1);
  crypto.getRandomValues(r);
  // r[0] / 2^32 → uniform [0,1); shift to [-0.5, 0.5); scale to ±5000ms.
  const noise = Math.floor((r[0] / 0x100000000 - 0.5) * 10_000);
  return bucket + noise;
}

export class TimestreamAgent extends Agent<Env, TimestreamState> {
  initialState: TimestreamState = {
    messages: [],
    nextOrder: 1,
    participants: [],
  };

  /** Migrate persisted state from pre-P1.1 shape. Adds missing fields with safe defaults. */
  private _ensureState() {
    const s = this.state as Partial<TimestreamState> | undefined;
    if (!s || !Array.isArray(s.messages) || !Array.isArray(s.participants) || typeof s.nextOrder !== 'number') {
      this.setState({
        messages: Array.isArray(s?.messages) ? s!.messages : [],
        nextOrder: typeof s?.nextOrder === 'number' ? s!.nextOrder : 1,
        participants: Array.isArray(s?.participants) ? s!.participants : [],
      });
    }
  }

  // ─── WebSocket subscribe path (Jolteon Lv. 25) ─────────────────────
  // Clients connect to /api/timestream/<gid>/ws and receive real-time
  // thunder events as JSON frames instead of polling. Broadcast helper
  // sends to every open connection on this DO instance. Hibernation
  // is handled by the base Server class — idle sockets don't pin RAM.

  /** Send a JSON event to every connected websocket on this DO. */
  private _broadcast(event: unknown) {
    try {
      this.broadcast(JSON.stringify(event));
    } catch { /* no connections or send failed — best-effort */ }
  }

  onConnect(connection: Connection, _ctx: ConnectionContext) {
    // Send an initial snapshot so the client can paint immediately
    // without a separate fetch round-trip. The receiver decrypts
    // client-side; we only carry ciphertext + metadata.
    try {
      this._ensureState();
      const msgs = this.state.messages
        .filter(m => !m.isDeleted)
        .sort((a, b) => a.order - b.order)
        .slice(-50);
      connection.send(JSON.stringify({
        kind: 'snapshot',
        messages: msgs,
        participants: this._participants,
      }));
    } catch (e) {
      try { connection.send(JSON.stringify({ kind: 'error', error: e instanceof Error ? e.message : String(e) })); } catch {}
    }
  }

  onMessage(_connection: Connection, _message: WSMessage) {
    // Clients are currently pure subscribers — no inbound messages
    // expected over the WS. Sends still go over the existing POST
    // endpoints so the failure / validation / retry story stays
    // uniform across browsers and server agents alike.
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split('/').pop() || '';

    try {
      this._ensureState();
      if (request.method === 'POST' && path === 'send') {
        return this._handleSend(request);
      }
      if (request.method === 'POST' && path === 'fetch') {
        return this._handleFetch(request);
      }
      if (request.method === 'POST' && path === 'fetch-one') {
        return this._handleFetchOne(request);
      }
      if (request.method === 'POST' && path === 'update') {
        return this._handleUpdate(request);
      }
      if (request.method === 'POST' && path === 'delete') {
        return this._handleDelete(request);
      }
      if (request.method === 'POST' && path === 'purge-all') {
        return this._handlePurgeAll(request);
      }
      if (request.method === 'POST' && path === 'rotated') {
        return this._handleRotated(request);
      }
      if (request.method === 'POST' && path === 'add-participant') {
        return this._handleAddParticipant(request);
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  /** Safe participants accessor — returns empty array if state missing. */
  private get _participants(): string[] {
    return Array.isArray(this.state?.participants) ? this.state.participants : [];
  }

  /** Check if an address is a participant (can read/write). */
  private _isParticipant(address: string): boolean {
    if (!address) return false;
    const norm = normAddr(address);
    const ps = this._participants;
    // Empty participants list = open (backward compat for existing DOs)
    if (ps.length === 0) return true;
    return ps.some(p => normAddr(p) === norm);
  }

  /** Add an address as a participant. */
  private _addParticipant(address: string) {
    if (!address) return;
    const norm = normAddr(address);
    const ps = this._participants;
    if (!ps.some(p => normAddr(p) === norm)) {
      this.setState({ ...this.state, participants: [...ps, address] });
    }
  }

  /** Return the index of an address in participants, adding it if absent. Returns -1 for empty input. */
  private _participantIndex(address: string): number {
    if (!address) return -1;
    const norm = normAddr(address);
    const ps = this._participants;
    let idx = ps.findIndex(p => normAddr(p) === norm);
    if (idx >= 0) return idx;
    const participants = [...ps, address];
    this.setState({ ...this.state, participants });
    return participants.length - 1;
  }

  private async _handleSend(request: Request): Promise<Response> {
    const body = await request.json() as {
      groupId: string;
      encryptedText: string;
      nonce: string;
      keyVersion: string;
      senderAddress: string;
      signature?: string;
      publicKey?: string;
      attachments?: StoredAttachment[];
    };

    // Validate attachments shape. Each entry must have the four fields the
    // SDK expects (storageId, nonce, encryptedMetadata, metadataNonce); any
    // extra fields are dropped. Reject anything malformed to keep the store
    // clean and prevent silent data loss.
    let attachments: StoredAttachment[] | undefined;
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      attachments = body.attachments.map(a => ({
        storageId: String(a?.storageId ?? ''),
        nonce: String(a?.nonce ?? ''),
        encryptedMetadata: String(a?.encryptedMetadata ?? ''),
        metadataNonce: String(a?.metadataNonce ?? ''),
      }));
      if (attachments.some(a => !a.storageId || !a.nonce || !a.encryptedMetadata || !a.metadataNonce)) {
        return Response.json({ error: 'Malformed attachment entry' }, { status: 400 });
      }
      if (attachments.length > 8) {
        return Response.json({ error: 'Too many attachments (max 8)' }, { status: 400 });
      }
    }

    // Auth: sender must be a participant (or first sender auto-joins).
    if (this._participants.length > 0 && !this._isParticipant(body.senderAddress)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }

    // P1.1 — resolve the sender to a participant index; blank the stored address.
    const senderIndex = this._participantIndex(body.senderAddress);
    if (senderIndex < 0) return Response.json({ error: 'Invalid sender' }, { status: 400 });

    const messageId = crypto.randomUUID();
    const order = this.state.nextOrder;
    const now = jitterTs(Date.now());

    const msg: StoredMessage = {
      messageId,
      groupId: body.groupId,
      order,
      encryptedText: body.encryptedText,
      nonce: body.nonce,
      keyVersion: body.keyVersion,
      senderAddress: '', // P1.1 — no raw address on new rows.
      senderIndex,
      createdAt: now,
      updatedAt: now,
      isEdited: false,
      isDeleted: false,
      signature: body.signature || '',
      publicKey: body.publicKey || '',
      ...(attachments ? { attachments } : {}),
    };

    const messages = [...this.state.messages, msg];
    this.setState({ ...this.state, messages, nextOrder: order + 1 });
    this._broadcast({ kind: 'thunder', message: msg, participants: this._participants });

    return Response.json({ messageId });
  }

  private async _handleFetch(request: Request): Promise<Response> {
    const body = await request.json() as {
      afterOrder?: number;
      beforeOrder?: number;
      limit?: number;
      /** Required: address requesting the fetch. Must be a participant. */
      address?: string;
    };

    // Auth: require participant address
    if (this._participants.length > 0) {
      if (!body.address || !this._isParticipant(body.address)) {
        return Response.json({ error: 'Not a participant' }, { status: 403 });
      }
    }

    // Self-healing migration: any soft-deleted tombstones lingering from
    // before the hard-delete switch get pruned on first fetch, so the
    // `!isDeleted` filter stops carrying weight once the DO is drained.
    if (this.state.messages.some(m => m.isDeleted)) {
      this.setState({ ...this.state, messages: this.state.messages.filter(m => !m.isDeleted) });
    }
    let msgs = this.state.messages.filter(m => !m.isDeleted);
    if (body.afterOrder !== undefined) msgs = msgs.filter(m => m.order > body.afterOrder!);
    if (body.beforeOrder !== undefined) msgs = msgs.filter(m => m.order < body.beforeOrder!);
    msgs.sort((a, b) => a.order - b.order);

    const limit = body.limit ?? 50;
    const hasNext = msgs.length > limit;
    const page = msgs.slice(0, limit);

    return Response.json({ messages: page, hasNext, participants: this._participants });
  }

  private async _handleFetchOne(request: Request): Promise<Response> {
    const body = await request.json() as { messageId: string; address?: string };
    if (this._participants.length > 0 && body.address && !this._isParticipant(body.address)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }
    const msg = this.state.messages.find(m => m.messageId === body.messageId);
    if (!msg) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(msg);
  }

  private async _handleUpdate(request: Request): Promise<Response> {
    const body = await request.json() as {
      messageId: string;
      encryptedText?: string;
      senderAddress: string;
    };

    if (!this._isParticipant(body.senderAddress)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }

    const idx = this.state.messages.findIndex(m => m.messageId === body.messageId);
    if (idx < 0) return Response.json({ error: 'Not found' }, { status: 404 });

    // Only the original sender can edit — compare by participant index so
    // the senderAddress field on new rows (which is blanked) is irrelevant.
    const callerIdx = this._participantIndex(body.senderAddress);
    const storedIdx = this.state.messages[idx].senderIndex;
    const storedAddr = this.state.messages[idx].senderAddress;
    const matchByIndex = typeof storedIdx === 'number' && storedIdx >= 0 && callerIdx === storedIdx;
    const matchByLegacyAddr = !!storedAddr && normAddr(storedAddr) === normAddr(body.senderAddress);
    if (!matchByIndex && !matchByLegacyAddr) {
      return Response.json({ error: 'Not the sender' }, { status: 403 });
    }

    const updated = { ...this.state.messages[idx] };
    if (body.encryptedText) { updated.encryptedText = body.encryptedText; updated.isEdited = true; }
    updated.updatedAt = jitterTs(Date.now());

    const messages = [...this.state.messages];
    messages[idx] = updated;
    this.setState({ ...this.state, messages });
    this._broadcast({ kind: 'edit', message: updated });

    return Response.json({ messageId: updated.messageId });
  }

  private async _handleDelete(request: Request): Promise<Response> {
    const body = await request.json() as { messageId: string; senderAddress?: string };

    const idx = this.state.messages.findIndex(m => m.messageId === body.messageId);
    if (idx < 0) return Response.json({ error: 'Not found' }, { status: 404 });

    // Any participant can delete — both sides can prune messages.
    if (body.senderAddress && !this._isParticipant(body.senderAddress)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }

    // Hard delete: splice the entry out of DO state entirely. Ciphertext,
    // nonce, key version, and any attachment references are all dropped.
    // Delete-for-everyone is the ONLY delete — no soft-delete tombstones,
    // no recoverable ghosts in persisted DO storage.
    const deletedId = this.state.messages[idx].messageId;
    const messages = this.state.messages.filter((_, i) => i !== idx);
    this.setState({ ...this.state, messages });
    this._broadcast({ kind: 'delete', messageId: deletedId });

    return Response.json({ deleted: true });
  }

  /**
   * Hard-wipe every thunder in this storm. Called from the × purge
   * button. Caller must prove storm membership by sending from an
   * address that either (a) is already in the participants list, or
   * (b) matches the senderAddress on one of the existing messages.
   * Condition (b) handles the "I sent messages to this DO but was
   * never explicitly added as a participant" race where the add-
   * participant call lost to the delete request.
   *
   * Messages array is reset to empty. nextOrder is preserved so new
   * thunders after purge keep strict monotonic order — no replay
   * risk against old message IDs.
   */
  private async _handlePurgeAll(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { senderAddress?: string };
    const addr = body.senderAddress || '';
    if (!addr) return Response.json({ error: 'senderAddress required' }, { status: 400 });

    const isMember = this._isParticipant(addr);
    const hasSentBefore = this.state.messages.some(m => {
      const sa = (m as any).senderAddress;
      if (sa && normAddr(sa) === normAddr(addr)) return true;
      return false;
    });
    if (!isMember && !hasSentBefore) {
      return Response.json({
        error: 'Not authorized',
        debug: {
          addr: normAddr(addr),
          participants: this._participants.map(p => normAddr(p)),
          messageCount: this.state.messages.length,
        },
      }, { status: 403 });
    }
    // Auto-promote a proven sender to a first-class participant so
    // future operations don't need this fallback.
    if (!isMember) this._addParticipant(addr);

    const purgedCount = this.state.messages.length;
    this.setState({ ...this.state, messages: [] });
    this._broadcast({ kind: 'purge', purged: purgedCount });
    return Response.json({ purged: purgedCount });
  }

  /**
   * Key-rotation notification endpoint. Called by the client right
   * after a successful rotateEncryptionKey or removeMembersAndRotateKey
   * on-chain tx lands. The DO doesn't store the key version itself —
   * it just broadcasts a { kind: 'rotated' } event to every open
   * WebSocket subscriber so they can bump their local cache and
   * refetch any stale historical bubbles under the new key.
   *
   * Permissionless from the DO's perspective: the underlying on-chain
   * rotation is already signed by a group admin, and the key version
   * itself is discoverable via GraphQL by any participant, so there's
   * no value in gating this endpoint behind participant auth. Any
   * client observing the on-chain event could call it and produce
   * the same refresh behavior on subscribers.
   */
  private async _handleRotated(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { keyVersion?: string | number; digest?: string };
    const kv = String(body.keyVersion ?? '0');
    this._broadcast({ kind: 'rotated', keyVersion: kv, digest: body.digest || '' });
    return Response.json({ broadcast: true, keyVersion: kv });
  }

  private async _handleAddParticipant(request: Request): Promise<Response> {
    const body = await request.json() as { address: string; addedBy?: string };

    // Only existing participants can add new ones
    if (this._participants.length > 0 && body.addedBy && !this._isParticipant(body.addedBy)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }

    this._addParticipant(body.address);
    return Response.json({ added: true, participants: this._participants.length });
  }
}
