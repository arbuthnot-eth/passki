/**
 * Quick test: can IKA WASM load and run basic functions in a CF Worker?
 *
 * Tests:
 * 1. Can we import the WASM module?
 * 2. Can we call UserShareEncryptionKeys.fromRootSeedKey?
 * 3. Can we call decryptUserShare-related functions?
 *
 * Exposed as GET /api/test-ika-wasm
 */

// @ts-ignore — wrangler resolves .wasm imports to pre-compiled WebAssembly.Module at deploy time
import ikaWasmModule from '../../node_modules/@ika.xyz/ika-wasm/dist/web/dwallet_mpc_wasm_bg.wasm';

export async function testIkaWasm(): Promise<{
  wasmLoads: boolean;
  manualInitWorks: boolean;
  encryptionKeysWork: boolean;
  ikaClientLoads: boolean;
  signingFnExists: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let wasmLoads = false;
  let manualInitWorks = false;
  let encryptionKeysWork = false;
  let ikaClientLoads = false;
  let signingFnExists = false;
  let wasmMod: any = null;

  // Test 1: Can we import the WASM module through the SDK's own import path?
  try {
    wasmMod = await import('@ika.xyz/ika-wasm');
    wasmLoads = true;

    // Check what's available on the module
    const keys = Object.keys(wasmMod).slice(0, 20);
    errors.push(`WASM module keys: ${keys.join(', ')}`);

    // Use the statically imported WASM module (pre-compiled at deploy time by wrangler)
    try {
      errors.push(`Static import type: ${typeof ikaWasmModule}, constructor: ${ikaWasmModule?.constructor?.name}, isModule: ${ikaWasmModule instanceof WebAssembly.Module}`);

      (wasmMod as any).initSync({ module: ikaWasmModule });
      manualInitWorks = true;
      signingFnExists = typeof (wasmMod as any).create_sign_centralized_party_message === 'function';
    } catch (e) {
      errors.push(`initSync with static module failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    errors.push(`WASM import failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: After manual init, do encryption keys work?
  // The SDK's wasm-loader has its own init path that fails in Workers.
  // Try calling the SDK's initializeWasm after we've already initialized the raw module.
  if (manualInitWorks) {
    try {
      // The raw WASM module is already initialized via initSync above.
      // The SDK's wasm-loader will try its own init — patch by calling generate_secp_cg_keypair_from_seed
      // to prove the WASM functions work, then try encryption keys.
      const testFn = (wasmMod as any).generate_secp_cg_keypair_from_seed;
      if (typeof testFn === 'function') {
        const testSeed = new Uint8Array(32);
        crypto.getRandomValues(testSeed);
        const result = testFn(1, testSeed); // curve 1 = secp256k1
        errors.push(`Direct WASM call works: result length = ${result?.length ?? 'null'}`);
      }

      // Now try the SDK path — this will fail because the SDK's wasm-loader
      // has its own initialization that's separate from the raw module.
      const { UserShareEncryptionKeys, Curve } = await import('@ika.xyz/sdk');
      const seed = new Uint8Array(32);
      crypto.getRandomValues(seed);
      const keys = await UserShareEncryptionKeys.fromRootSeedKey(seed, Curve.ED25519);
      encryptionKeysWork = !!keys;
    } catch (e) {
      errors.push(`Encryption keys failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 3: IKA client with GraphQL
  try {
    const { IkaClient } = await import('@ika.xyz/sdk');
    const { SuiGraphQLClient } = await import('@mysten/sui/graphql');
    const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });
    const client = new IkaClient({ suiClient: gql as never });
    ikaClientLoads = !!client;
  } catch (e) {
    errors.push(`IKA client failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { wasmLoads, manualInitWorks, encryptionKeysWork, ikaClientLoads, signingFnExists, errors };
}
