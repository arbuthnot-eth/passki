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

/** Round timestamp to 10s bucket + add ±5s uniform noise. Preserves order via the monotonic `order` field. */
function jitterTs(ms: number): number {
  const bucket = Math.floor(ms / 10_000) * 10_000;
  const noise = Math.floor((Math.random() - 0.5) * 10_000);
  return bucket + noise;
}

export class TimestreamAgent extends Agent<Env, TimestreamState> {
  initialState: TimestreamState = {
    messages: [],
    nextOrder: 1,
    participants: [],
  };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split('/').pop() || '';

    try {
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
      if (request.method === 'POST' && path === 'add-participant') {
        return this._handleAddParticipant(request);
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  /** Check if an address is a participant (can read/write). */
  private _isParticipant(address: string): boolean {
    if (!address) return false;
    const norm = normAddr(address);
    // Empty participants list = open (backward compat for existing DOs)
    if (this.state.participants.length === 0) return true;
    return this.state.participants.some(p => normAddr(p) === norm);
  }

  /** Add an address as a participant. */
  private _addParticipant(address: string) {
    if (!address) return;
    const norm = normAddr(address);
    if (!this.state.participants.some(p => normAddr(p) === norm)) {
      this.setState({ ...this.state, participants: [...this.state.participants, address] });
    }
  }

  /** Return the index of an address in participants, adding it if absent. Returns -1 for empty input. */
  private _participantIndex(address: string): number {
    if (!address) return -1;
    const norm = normAddr(address);
    let idx = this.state.participants.findIndex(p => normAddr(p) === norm);
    if (idx >= 0) return idx;
    const participants = [...this.state.participants, address];
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
      attachments?: unknown[];
    };

    // P1.4 — reject messages with attachments. Our transport does not
    // round-trip attachments; silently accepting them would risk leaking
    // blob IDs outside the Seal envelope.
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      return Response.json({ error: 'Attachments not supported by this transport' }, { status: 400 });
    }

    // Auth: sender must be a participant (or first sender auto-joins).
    if (this.state.participants.length > 0 && !this._isParticipant(body.senderAddress)) {
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
    };

    const messages = [...this.state.messages, msg];
    this.setState({ ...this.state, messages, nextOrder: order + 1 });

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
    if (this.state.participants.length > 0) {
      if (!body.address || !this._isParticipant(body.address)) {
        return Response.json({ error: 'Not a participant' }, { status: 403 });
      }
    }

    let msgs = this.state.messages.filter(m => !m.isDeleted);
    if (body.afterOrder !== undefined) msgs = msgs.filter(m => m.order > body.afterOrder!);
    if (body.beforeOrder !== undefined) msgs = msgs.filter(m => m.order < body.beforeOrder!);
    msgs.sort((a, b) => a.order - b.order);

    const limit = body.limit ?? 50;
    const hasNext = msgs.length > limit;
    const page = msgs.slice(0, limit);

    return Response.json({ messages: page, hasNext, participants: this.state.participants });
  }

  private async _handleFetchOne(request: Request): Promise<Response> {
    const body = await request.json() as { messageId: string; address?: string };
    if (this.state.participants.length > 0 && body.address && !this._isParticipant(body.address)) {
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

    return Response.json({ messageId: updated.messageId });
  }

  private async _handleDelete(request: Request): Promise<Response> {
    const body = await request.json() as { messageId: string; senderAddress?: string };

    const idx = this.state.messages.findIndex(m => m.messageId === body.messageId);
    if (idx < 0) return Response.json({ error: 'Not found' }, { status: 404 });

    // Any participant can delete (both sides can remove messages)
    if (body.senderAddress && !this._isParticipant(body.senderAddress)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }

    const messages = [...this.state.messages];
    messages[idx] = { ...messages[idx], isDeleted: true, updatedAt: jitterTs(Date.now()) };
    this.setState({ ...this.state, messages });

    return Response.json({ deleted: true });
  }

  private async _handleAddParticipant(request: Request): Promise<Response> {
    const body = await request.json() as { address: string; addedBy?: string };

    // Only existing participants can add new ones
    if (this.state.participants.length > 0 && body.addedBy && !this._isParticipant(body.addedBy)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }

    this._addParticipant(body.address);
    return Response.json({ added: true, participants: this.state.participants.length });
  }
}
