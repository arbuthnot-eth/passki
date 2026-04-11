/**
 * DappKitSigner — adapts wallet signPersonalMessage into Signer interface.
 * Ported from MystenLabs/sui-stack-messaging chat-app.
 */
import { Signer, parseSerializedSignature } from '@mysten/sui/cryptography';
import type { PublicKey, SignatureScheme } from '@mysten/sui/cryptography';
import { publicKeyFromSuiBytes } from '@mysten/sui/verify';
import { toBase64 } from '@mysten/sui/utils';

export type SignPersonalMessageFn = (args: {
  message: Uint8Array;
}) => Promise<{ signature: string }>;

/** Injected by the caller so the signer can delegate transaction
 *  signing through the wallet-standard path instead of needing a
 *  local private key. Required for SDK calls like
 *  client.messaging.sendMessage that internally invoke
 *  signer.signAndExecuteTransaction (e.g. attachment uploads). */
export type SignAndExecuteTransactionFn = (txBytesOrTx: unknown) => Promise<{ digest: string; effects?: unknown }>;

export class DappKitSigner extends Signer {
  readonly #address: string;
  #publicKey: PublicKey | null;
  readonly #signPersonalMessage: SignPersonalMessageFn;
  readonly #signAndExecute: SignAndExecuteTransactionFn | null;

  constructor(opts: {
    address: string;
    publicKeyBytes?: Uint8Array;
    signPersonalMessage: SignPersonalMessageFn;
    /** Optional: wallet-standard signAndExecuteTransaction passthrough.
     *  Required for SDK calls that internally call
     *  signer.signAndExecuteTransaction — notably the attachments
     *  path in client.messaging.sendMessage. */
    signAndExecuteTransaction?: SignAndExecuteTransactionFn;
  }) {
    super();
    this.#address = opts.address;
    this.#publicKey = opts.publicKeyBytes?.length
      ? publicKeyFromSuiBytes(opts.publicKeyBytes)
      : null;
    this.#signPersonalMessage = opts.signPersonalMessage;
    this.#signAndExecute = opts.signAndExecuteTransaction ?? null;
  }

  async sign(_bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error('DappKitSigner.sign() not supported — use signPersonalMessage() or signAndExecuteTransaction()');
  }

  /** Override the base-class default which calls this.sign() (which
   *  we throw on). Delegates to the injected wallet signAndExecute
   *  passthrough so the SDK's internal sendMessage / editMessage /
   *  deleteMessage paths can post their txs through any connected
   *  wallet (WaaP, Backpack, Phantom, Suiet, …) without needing a
   *  local Ed25519 key. */
  override async signAndExecuteTransaction({ transaction, client }: {
    transaction: { setSenderIfNotSet: (a: string) => void };
    client: unknown;
  }): Promise<unknown> {
    if (!this.#signAndExecute) {
      throw new Error('DappKitSigner.signAndExecuteTransaction() requires signAndExecuteTransaction passthrough in constructor');
    }
    transaction.setSenderIfNotSet(this.#address);
    // Pass the unbuilt Transaction through — our wallet path
    // decides whether to pre-build (Phantom/Backpack/Suiet) or
    // hand it to the iframe (WaaP) per our stack's rules.
    // Pre-building here can land us in the WaaP BCS-reserialize
    // trap where v1/v2 BCS divergence invalidates the signature.
    const r = await this.#signAndExecute(transaction);
    // Reshape into the SDK's internal #executeTransaction consumer
    // shape: result.Transaction.{digest, status.success, effects}.
    // Mark success=true — the wallet path awaits confirmation
    // before resolving, so any real failure throws before we get
    // here.
    void client;
    return {
      Transaction: {
        digest: r.digest,
        status: { success: true, error: undefined as string | undefined },
        effects: r.effects ?? {},
      },
    };
  }

  override async signPersonalMessage(bytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const { signature } = await this.#signPersonalMessage({ message: bytes });
    if (!this.#publicKey) {
      try {
        const parsed = parseSerializedSignature(signature);
        if ('publicKey' in parsed && parsed.publicKey) {
          const { publicKeyFromRawBytes } = await import('@mysten/sui/verify');
          this.#publicKey = publicKeyFromRawBytes(parsed.signatureScheme, parsed.publicKey);
        }
      } catch { /* will resolve on next call */ }
    }
    return { bytes: toBase64(bytes), signature };
  }

  getKeyScheme(): SignatureScheme {
    if (!this.#publicKey) return 'ED25519';
    const flag = this.#publicKey.flag();
    if (flag === 0x00) return 'ED25519';
    if (flag === 0x01) return 'Secp256k1';
    return 'Secp256r1';
  }

  getPublicKey(): PublicKey {
    if (!this.#publicKey) throw new Error('Public key not yet available — sign a message first');
    return this.#publicKey;
  }

  override toSuiAddress(): string {
    return this.#address;
  }
}
