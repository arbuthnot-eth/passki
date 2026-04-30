/* tslint:disable */
/* eslint-disable */

export class SetupBundle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly dk: Uint8Array;
    readonly ek: Uint8Array;
    readonly ell: number;
    readonly sk: Uint8Array;
}

export function bench_batch(ell: number): string;

export function decrypt(dk_bytes: Uint8Array, sbk_bytes: Uint8Array, cts_concat: Uint8Array, ell: number): Uint8Array;

export function encrypt(ek_bytes: Uint8Array, pad_bytes: Uint8Array): Uint8Array;

export function pre_decrypt(sk_bytes: Uint8Array, cts_concat: Uint8Array, ell: number): Uint8Array;

/**
 * Generate a fresh GT pad (576 B) — caller hashes this to derive an AES key.
 */
export function random_pad(): Uint8Array;

export function setup(ell: number): SetupBundle;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_setupbundle_free: (a: number, b: number) => void;
    readonly bench_batch: (a: number) => [number, number, number, number];
    readonly decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly encrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly pre_decrypt: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly random_pad: () => [number, number];
    readonly setup: (a: number) => [number, number, number];
    readonly setupbundle_dk: (a: number) => [number, number];
    readonly setupbundle_ek: (a: number) => [number, number];
    readonly setupbundle_ell: (a: number) => number;
    readonly setupbundle_sk: (a: number) => [number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
