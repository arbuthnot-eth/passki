# IKA SDK `getProtocolPublicParameters` hangs with `SuiGrpcClient` due to pagination cursor mismatch

## Summary

`IkaClient.getProtocolPublicParameters()` hangs indefinitely when the IKA SDK is initialized with `SuiGrpcClient` (`@mysten/sui` v2.5.0). The same call completes successfully with `SuiJsonRpcClient` and `SuiGraphQLClient`. The root cause is a cursor-handling mismatch between how the gRPC client represents "no more pages" and how the IKA SDK's `fetchAllDynamicFields` loop detects termination.

## Root cause

### The pagination loop in IKA SDK

`fetchAllDynamicFields` in `@ika.xyz/sdk/dist/esm/client/utils.js` (lines 14-28):

```js
async function fetchAllDynamicFields(suiClient, parentId) {
  const allFields = [];
  let cursor = null;
  while (true) {
    const response = await suiClient.core.listDynamicFields({ parentId, cursor });
    allFields.push(...response.dynamicFields);
    if (response.cursor === cursor) {   // <-- termination check
      break;
    }
    cursor = response.cursor;
  }
  return allFields;
}
```

The loop breaks when `response.cursor === cursor` (strict equality). It does **not** check `response.hasNextPage`.

### How each client signals "no more pages"

| Client | `cursor` on last page | `hasNextPage` on last page |
|---|---|---|
| **JSON-RPC** | `null` (from `nextCursor`) | `false` |
| **GraphQL** | `null` (from `endCursor ?? null`) | `false` |
| **gRPC** | `null` *if* `nextPageToken` is `undefined`; **`""` (empty string)** if server sends empty bytes | `false` *if* `undefined`; **`true`** if empty bytes present |

The gRPC client (`SuiGrpcClient.listDynamicFields`, `node_modules/@mysten/sui/src/grpc/client.ts` lines 210-211):

```ts
cursor: response.response.nextPageToken ? toBase64(response.response.nextPageToken) : null,
hasNextPage: response.response.nextPageToken !== undefined,
```

The protobuf definition (`state_service.ts` line 453-455):
```proto
// optional bytes next_page_token = 2;
nextPageToken?: Uint8Array;
```

### The infinite loop (multi-page results)

When there are **2+ pages** of dynamic fields and the gRPC server returns an empty `Uint8Array(0)` for `nextPageToken` on the last page (instead of omitting it entirely):

1. `cursor = null` -- fetch page 1 -- response: `cursor = "AAAB..."` (base64 of real token)
2. `"AAAB..." === null` -- false -- `cursor = "AAAB..."`
3. Fetch page 2 (last page) -- response: `cursor = ""` (base64 of empty bytes)
4. `"" === "AAAB..."` -- false -- `cursor = ""`
5. Fetch with `cursor: ""` -- gRPC client: `"" ? fromBase64("") : undefined` -- **`""` is falsy**, so `pageToken = undefined` -- **returns page 1 again**
6. Response: `cursor = "AAAB..."` (token for page 2)
7. `"AAAB..." === ""` -- false -- `cursor = "AAAB..."`
8. Fetch page 2 again -- `cursor = ""`
9. **GOTO step 4 -- infinite loop**

The loop alternates between `cursor = ""` and `cursor = "AAAB..."` forever, never satisfying `response.cursor === cursor`.

### Even if the server correctly omits `nextPageToken`

If the Sui gRPC server properly omits `nextPageToken` (making it `undefined`), then `cursor = null` and `hasNextPage = false`. In this case `fetchAllDynamicFields` works because `null === null` is true on the first iteration after the last page.

**However**, the `fetchAllDynamicFields` termination logic is still fragile. If the cursor on the last page happens to differ from the cursor sent (which is the normal case -- the server returns a new cursor pointing past the end), the loop would also fail. The only reason it works with JSON-RPC is that JSON-RPC returns `nextCursor: null` on the last page.

## Where this is called

`fetchAllDynamicFields` is called from `fetchEncryptionKeysFromNetwork_fn` (`ika-client.js` line 742):

```js
const reconfigOutputsDFs = await fetchAllDynamicFields(
  this.client,
  keyParsed.reconfiguration_public_outputs.id
);
```

This is part of the `getProtocolPublicParameters` call chain:
1. `getProtocolPublicParameters()` (line 459)
2. `fetchEncryptionKeysFromNetwork_fn()` (line 460/723)
3. `fetchAllDynamicFields()` for reconfiguration outputs (line 742)

The `reconfiguration_public_outputs` table may have multiple pages depending on the number of reconfiguration events.

## `readTableVecAsRawBytes` -- second pagination loop

`readTableVecAsRawBytes` (`ika-client.js` lines 561-609) uses a different loop structure:

```js
do {
  const dynamicFieldPage = await this.client.core.listDynamicFields({ parentId: tableID, cursor });
  // ... push results ...
  cursor = dynamicFieldPage.cursor;
  if (!dynamicFieldPage.hasNextPage) {
    break;
  }
} while (cursor);
```

This loop has **two** termination conditions: `!hasNextPage` and `!cursor` (falsy check on `while`).

- If `cursor = ""` (empty string, falsy) and `hasNextPage = true`: the `while(cursor)` check catches it and breaks. **Terminates correctly but only by accident** (relying on `""` being falsy).
- If `cursor = null` and `hasNextPage = false`: both conditions trigger. **Correct.**
- If `hasNextPage = true` with a valid non-empty cursor when there are really no more pages: **infinite loop** (keeps re-fetching the same last page).

So `readTableVecAsRawBytes` is more resilient than `fetchAllDynamicFields` but still has edge cases.

## Which clients are affected

| Client | `fetchAllDynamicFields` | `readTableVecAsRawBytes` |
|---|---|---|
| **SuiJsonRpcClient** | Works (cursor=null on last page) | Works |
| **SuiGraphQLClient** | Works (cursor=null on last page) | Works |
| **SuiGrpcClient** | **Infinite loop** if server sends empty `nextPageToken` on last page with multi-page results | Works (by accident -- `""` is falsy) |

## Is this an IKA SDK bug, a @mysten/sui gRPC bug, or both?

**Both.**

### IKA SDK bug (primary)
`fetchAllDynamicFields` uses `response.cursor === cursor` as the sole termination condition. This is incorrect -- it should check `hasNextPage` like `readTableVecAsRawBytes` does. The `cursor === cursor` check is not a reliable way to detect end-of-pagination across different client implementations.

### @mysten/sui gRPC bug (secondary)
If the Sui gRPC server sends an empty `next_page_token` bytes field on the last page instead of omitting it, `SuiGrpcClient.listDynamicFields` returns `{ cursor: "", hasNextPage: true }` which is semantically wrong. The `hasNextPage` check (`nextPageToken !== undefined`) should also guard against empty byte arrays:

```ts
// Current (line 211):
hasNextPage: response.response.nextPageToken !== undefined,

// Should be:
hasNextPage: response.response.nextPageToken !== undefined && response.response.nextPageToken.length > 0,
```

And similarly for cursor (line 210):
```ts
// Current:
cursor: response.response.nextPageToken ? toBase64(response.response.nextPageToken) : null,

// toBase64(Uint8Array(0)) returns "" which is falsy, so this line is actually fine
// BUT the truthy check on Uint8Array(0) passes (objects are always truthy),
// so cursor becomes toBase64(Uint8Array(0)) = "" -- an empty string, not null.
// This is inconsistent with JSON-RPC and GraphQL which return null.
```

The `response.response.nextPageToken ?` check is unreliable for `Uint8Array` because **all objects are truthy in JavaScript**, including `new Uint8Array(0)`. The check should be `nextPageToken?.length`.

## Suggested fix

### IKA SDK fix (in `fetchAllDynamicFields`)

```js
async function fetchAllDynamicFields(suiClient, parentId) {
  const allFields = [];
  let cursor = null;
  while (true) {
    const response = await suiClient.core.listDynamicFields({ parentId, cursor });
    allFields.push(...response.dynamicFields);
    if (!response.hasNextPage) {  // Use hasNextPage, not cursor comparison
      break;
    }
    cursor = response.cursor;
  }
  return allFields;
}
```

### @mysten/sui gRPC fix (in `SuiGrpcClient.listDynamicFields` and other paginated methods)

```ts
const hasToken = response.response.nextPageToken !== undefined
    && response.response.nextPageToken.length > 0;

return {
  // ...
  cursor: hasToken ? toBase64(response.response.nextPageToken) : null,
  hasNextPage: hasToken,
};
```

This same pattern should be applied to all paginated gRPC methods in `core.ts` and `client.ts` that check `nextPageToken`.

## Reproduction steps

1. Initialize `IkaClient` with a `SuiGrpcClient`:
   ```ts
   import { SuiGrpcClient } from '@mysten/sui/grpc';
   import { IkaClient, getNetworkConfig } from '@ika.xyz/sdk';

   const grpc = new SuiGrpcClient({
     network: 'mainnet',
     baseUrl: 'https://fullnode.mainnet.sui.io:443',
   });
   const client = new IkaClient({
     config: getNetworkConfig('mainnet'),
     suiClient: grpc,
   });
   await client.initialize();
   ```
2. Call `getProtocolPublicParameters`:
   ```ts
   const params = await client.getProtocolPublicParameters(undefined, Curve.Secp256k1);
   // ^ hangs indefinitely
   ```
3. The call never resolves. Network tab shows repeated `listDynamicFields` gRPC requests cycling through the same pages.

## Versions

- `@ika.xyz/sdk`: 0.3.1
- `@mysten/sui`: 2.5.0
- Environment: Browser (Cloudflare Workers/Pages frontend)

## Workaround

Use `SuiJsonRpcClient` for `IkaClient`. Both `SuiGrpcClient` and `SuiGraphQLClient` hang in practice (GraphQL also fails despite returning `cursor: null` — likely a separate issue in the GraphQL `.core` implementation):

```ts
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const rpc = new SuiJsonRpcClient({
  url: 'https://sui-rpc.publicnode.com',
  network: 'mainnet',
});
const client = new IkaClient({
  config: getNetworkConfig('mainnet'),
  suiClient: rpc as any,
});
```

**This is a ticking time bomb** — Mysten's JSON-RPC sunsets April 2026. The IKA SDK must be fixed to work with gRPC or GraphQL before then.
