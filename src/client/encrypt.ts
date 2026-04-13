/**
 * Encrypt client — browser-compatible TypeScript client for the dWallet Encrypt
 * pre-alpha FHE SDK on Solana.
 *
 * Encrypt enables Solana programs to compute on encrypted data (FHE).
 * Protocol flow:
 *   1. Client encrypts inputs via gRPC  (create_input_ciphertext)
 *   2. Executor evaluates computation graph on-chain
 *   3. Results committed on-chain       (commit_ciphertext)
 *   4. Decryption response returned     (respond_decryption)
 *
 * --- PRE-ALPHA CAVEATS ---
 * - NO REAL ENCRYPTION YET — all data is plaintext on-chain in pre-alpha
 * - Data is wiped periodically before Alpha 1
 * - Do NOT submit sensitive or real data
 * - Encryption keys and trust model are not final
 * - SDK surface will change — pin to pre-alpha versions
 * ---
 *
 * Since this runs in the browser (bun build --target browser), direct gRPC
 * (HTTP/2) is not available. All calls go through a CF Worker proxy at
 * `/api/encrypt/*` that bridges HTTP/1.1 JSON → gRPC.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Devnet gRPC endpoint (proxied through CF Worker for browser compat). */
export const ENCRYPT_GRPC_ENDPOINT = 'pre-alpha-dev-1.encrypt.ika-network.net:443';

/** CF Worker proxy base — all browser calls route here. */
const PROXY_BASE = '/api/encrypt';

/** Solana devnet RPC. */
export const SOLANA_RPC = 'https://api.devnet.solana.com';

/** Encrypt program ID on Solana devnet. */
export const ENCRYPT_PROGRAM_ID = '4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8';

// ---------------------------------------------------------------------------
// FHE Types
// ---------------------------------------------------------------------------

/** FHE type discriminants matching the Encrypt protocol. */
export enum FheType {
  Bool   = 0,
  Uint4  = 1,
  Uint8  = 2,
  Uint16 = 3,
  Uint64 = 4,
}

/** An encrypted 64-bit unsigned integer handle. */
export interface EUint64 {
  readonly type: FheType.Uint64;
  /** On-chain ciphertext ID. */
  readonly id: string;
  /** The plaintext value (pre-alpha only — will be removed). */
  readonly _plaintextDebug?: bigint;
}

/** An encrypted boolean handle. */
export interface EBool {
  readonly type: FheType.Bool;
  /** On-chain ciphertext ID. */
  readonly id: string;
  /** The plaintext value (pre-alpha only — will be removed). */
  readonly _plaintextDebug?: boolean;
}

/** Union of all encrypted value handles. */
export type EncryptedValue = EUint64 | EBool;

// ---------------------------------------------------------------------------
// RPC types (mirror the gRPC service shape as JSON)
// ---------------------------------------------------------------------------

export interface CreateInputRequest {
  /** Raw value bytes, base64-encoded. */
  value: string;
  /** FHE type discriminant. */
  fheType: FheType;
  /** Solana program ID that will consume this ciphertext. */
  programId: string;
  /** Network encryption public key, base64-encoded. */
  networkKey: string;
}

export interface CreateInputResponse {
  /** Ciphertext ID assigned by the network. */
  ciphertextId: string;
  /** On-chain transaction signature (Solana). */
  txSignature?: string;
}

export interface DecryptionRequest {
  ciphertextId: string;
}

export interface DecryptionResponse {
  /** Decrypted value bytes, base64-encoded. */
  value: string;
  /** FHE type of the original ciphertext. */
  fheType: FheType;
}

export interface CiphertextInfo {
  id: string;
  fheType: FheType;
  programId: string;
  /** Whether decryption has been responded to. */
  decrypted: boolean;
}

export interface NetworkKeyResponse {
  /** Base64-encoded network encryption public key. */
  key: string;
}

// ---------------------------------------------------------------------------
// EncryptClient
// ---------------------------------------------------------------------------

/**
 * Browser-compatible client for the dWallet Encrypt pre-alpha service.
 *
 * All calls are routed through a CF Worker proxy at `/api/encrypt/*` because
 * browsers cannot speak native gRPC (HTTP/2). The proxy bridges JSON over
 * HTTP/1.1 to the gRPC backend at {@link ENCRYPT_GRPC_ENDPOINT}.
 */
export class EncryptClient {
  private _baseUrl: string;

  constructor(proxyBase?: string) {
    this._baseUrl = proxyBase ?? PROXY_BASE;
  }

  // -- connection -----------------------------------------------------------

  /**
   * Set (or reset) the proxy endpoint.
   * Default: `/api/encrypt` (same-origin CF Worker).
   */
  connect(endpoint?: string): void {
    if (endpoint) this._baseUrl = endpoint;
  }

  // -- core RPC -------------------------------------------------------------

  /**
   * Encrypt a value and submit it as an input ciphertext.
   *
   * Pre-alpha caveat: the value is NOT truly encrypted — it is sent as
   * plaintext to the network. Do not use real/sensitive data.
   */
  async createInput(
    value: bigint | boolean,
    programId: string = ENCRYPT_PROGRAM_ID,
    networkKey?: string,
  ): Promise<CreateInputResponse> {
    const fheType = typeof value === 'boolean' ? FheType.Bool : FheType.Uint64;
    const encoded = _encodeValue(value, fheType);

    // If no networkKey provided, fetch it first.
    const nk = networkKey ?? (await this.getNetworkKey()).key;

    const body: CreateInputRequest = {
      value: encoded,
      fheType,
      programId,
      networkKey: nk,
    };

    return this._post<CreateInputResponse>('/create_input', body);
  }

  /**
   * Request decryption of an output ciphertext by ID.
   * The network will evaluate the computation graph and return the result.
   */
  async requestDecryption(ciphertextId: string): Promise<DecryptionResponse> {
    return this._post<DecryptionResponse>('/decrypt', { ciphertextId });
  }

  /** Fetch metadata for a ciphertext by ID. */
  async getCiphertext(id: string): Promise<CiphertextInfo> {
    return this._get<CiphertextInfo>(`/ciphertext/${id}`);
  }

  /** Fetch the network encryption public key (base64). */
  async getNetworkKey(): Promise<NetworkKeyResponse> {
    return this._get<NetworkKeyResponse>('/network_key');
  }

  // -- internal HTTP --------------------------------------------------------

  private async _post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this._baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Encrypt RPC POST ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async _get<T>(path: string): Promise<T> {
    const res = await fetch(`${this._baseUrl}${path}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Encrypt RPC GET ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

// ---------------------------------------------------------------------------
// PC-Token helpers — confidential token operations for iUSD on Solana
// ---------------------------------------------------------------------------

/**
 * Encrypt a token balance for use with Solana confidential tokens (PC-Token).
 *
 * Returns an {@link EUint64} handle whose `.id` can be passed to on-chain
 * instructions that accept encrypted balances.
 *
 * Pre-alpha: the balance is plaintext on-chain. Do not use real funds.
 */
export async function encryptBalance(
  amount: bigint,
  programId: string = ENCRYPT_PROGRAM_ID,
  networkKey?: string,
  client?: EncryptClient,
): Promise<EUint64> {
  const c = client ?? new EncryptClient();
  const res = await c.createInput(amount, programId, networkKey);
  return {
    type: FheType.Uint64,
    id: res.ciphertextId,
    _plaintextDebug: amount,
  };
}

/**
 * Build encrypted inputs for a confidential token transfer.
 *
 * Returns ciphertext IDs for:
 * - `amountCiphertext` — the transfer amount (EUint64)
 *
 * The executor evaluates `sender_balance - amount` and `recipient_balance + amount`
 * on-chain using the FHE computation graph. The returned IDs are passed to the
 * Solana confidential-transfer instruction.
 *
 * Pre-alpha: all values are plaintext. Do not use real funds.
 */
export async function buildTransferInputs(
  _from: string,
  _to: string,
  amount: bigint,
  programId: string = ENCRYPT_PROGRAM_ID,
  networkKey?: string,
  client?: EncryptClient,
): Promise<{
  amountCiphertext: EUint64;
  /** The sender/recipient balance updates are computed on-chain by the executor. */
  note: string;
}> {
  const c = client ?? new EncryptClient();
  const nk = networkKey ?? (await c.getNetworkKey()).key;

  const amountCiphertext = await encryptBalance(amount, programId, nk, c);

  return {
    amountCiphertext,
    note: 'Sender/recipient balance updates are computed on-chain by the Encrypt executor. Submit the amountCiphertext.id to the confidential-transfer instruction.',
  };
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * Encode a plaintext value to base64 for the Encrypt RPC.
 * Pre-alpha: this is trivial encoding, not real FHE encryption.
 */
function _encodeValue(value: bigint | boolean, fheType: FheType): string {
  let bytes: Uint8Array;

  switch (fheType) {
    case FheType.Bool: {
      bytes = new Uint8Array([value ? 1 : 0]);
      break;
    }
    case FheType.Uint64: {
      const bv = BigInt(value);
      bytes = new Uint8Array(8);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, bv, true); // little-endian
      break;
    }
    default: {
      // Future types — encode as raw bigint LE bytes
      const bv = BigInt(value);
      bytes = new Uint8Array(8);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, bv, true);
      break;
    }
  }

  return btoa(String.fromCharCode(...bytes));
}

/**
 * Decode a base64 value from a decryption response.
 */
export function decodeValue(base64: string, fheType: FheType): bigint | boolean {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  switch (fheType) {
    case FheType.Bool:
      return bytes[0] !== 0;
    case FheType.Uint64: {
      const view = new DataView(bytes.buffer);
      return view.getBigUint64(0, true);
    }
    default: {
      const view = new DataView(bytes.buffer);
      return view.getBigUint64(0, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton convenience
// ---------------------------------------------------------------------------

let _defaultClient: EncryptClient | null = null;

/** Get (or create) the default EncryptClient singleton. */
export function getEncryptClient(): EncryptClient {
  if (!_defaultClient) _defaultClient = new EncryptClient();
  return _defaultClient;
}
