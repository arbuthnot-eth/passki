/**
 * Sui JSON-RPC compatibility shim.
 *
 * Public Sui JSON-RPC is gone (Mysten, publicnode and BlockVision all
 * answer "deprecated, use gRPC"). passki still has ~100 JSON-RPC call
 * sites, so instead of rewriting each one, this module answers the
 * JSON-RPC methods passki uses with gRPC-Web (SuiGrpcClient — works in
 * Workers, verified on workerd) and Sui GraphQL, returning results in the
 * JSON-RPC response shapes callers already parse.
 *
 * Object content is rebuilt from GraphQL's `json` + type `layout` into
 * JSON-RPC's MoveValue shape: structs → { type, fields }, enums →
 * { type?, variant, fields }, UID → { id }, ID / String / Balance → string,
 * Option → value | null, vector<u8> → number[], u8–u32 → number,
 * u64+ → string.
 *
 * Unsupported methods return a JSON-RPC error rather than guessing.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { fromBase64, toBase64, normalizeSuiAddress } from '@mysten/sui/utils';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const GRPC_URLS = ['https://fullnode.mainnet.sui.io:443', 'https://rpc-mainnet.suiscan.xyz:443'];

export class RpcMethodError extends Error {
  constructor(message: string, public code = -32000) { super(message); }
}

// ─── Transports ──────────────────────────────────────────────────────

let grpcClients: SuiGrpcClient[] | null = null;
function grpcs(): SuiGrpcClient[] {
  if (!grpcClients) grpcClients = GRPC_URLS.map(baseUrl => new SuiGrpcClient({ network: 'mainnet', baseUrl }));
  return grpcClients;
}

/** First backend to answer wins. */
async function grpcAny<T>(fn: (c: SuiGrpcClient) => Promise<T>): Promise<T> {
  try {
    return await Promise.any(grpcs().map(fn));
  } catch (err) {
    const first = (err as AggregateError).errors?.[0];
    const msg = first instanceof Error ? first.message : String(first ?? err);
    let decoded = msg;
    try { decoded = decodeURIComponent(msg); } catch { /* keep raw */ }
    throw new RpcMethodError(decoded);
  }
}

async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (j.errors?.length) throw new RpcMethodError(`GraphQL: ${j.errors[0].message}`);
  if (!j.data) throw new RpcMethodError(`GraphQL HTTP ${res.status}`);
  return j.data;
}

// ─── Type / value conversion ─────────────────────────────────────────

/** JSON-RPC prints framework addresses short (0x1, 0x2, 0x3); GraphQL prints them long. */
export function shortType(t: string): string {
  return t.replace(/0x0{63}([123])(?=::)/g, '0x$1');
}

type Layout = string | { struct?: { type: string; fields: Array<{ name: string; layout: Layout }> }; enum?: { type?: string; variants: Array<{ name: string; layout: Array<{ name: string; layout: Layout }> }> }; vector?: Layout };

const SMALL_INTS = new Set(['u8', 'u16', 'u32']);
const BIG_INTS = new Set(['u64', 'u128', 'u256']);

/**
 * Convert a GraphQL MoveValue json into JSON-RPC shape.
 * mode 'content' → object content (structs wrapped in {type, fields});
 * mode 'plain'   → event parsedJson (structs are plain objects).
 */
export function toRpcValue(json: unknown, layout: Layout, mode: 'content' | 'plain'): unknown {
  if (typeof layout === 'string') {
    if (SMALL_INTS.has(layout)) return json === null || json === undefined ? json : Number(json);
    if (BIG_INTS.has(layout)) return json === null || json === undefined ? json : String(json);
    if (layout === 'bool') return json === true || json === 'true' || json === 'True';
    if (layout === 'address' || layout === 'signer') return typeof json === 'string' ? normalizeSuiAddress(json) : json;
    return json;
  }
  if (layout.vector !== undefined) {
    if (layout.vector === 'u8' && typeof json === 'string') return Array.from(fromBase64(json));
    if (!Array.isArray(json)) return json;
    return json.map(v => toRpcValue(v, layout.vector as Layout, mode));
  }
  if (layout.enum) {
    const rec = (json ?? {}) as Record<string, unknown>;
    const name = String(rec['@variant'] ?? '');
    const variant = layout.enum.variants.find(v => v.name === name);
    const fields: Record<string, unknown> = {};
    for (const f of variant?.layout ?? []) fields[f.name] = toRpcValue(rec[f.name], f.layout, mode);
    return {
      ...(layout.enum.type ? { type: shortType(layout.enum.type) } : {}),
      variant: name,
      fields,
    };
  }
  if (layout.struct) {
    const type = shortType(layout.struct.type);
    const base = type.split('<')[0];
    if (base === '0x2::object::UID') return { id: typeof json === 'string' ? normalizeSuiAddress(json) : (json as any)?.id };
    if (base === '0x2::object::ID') return typeof json === 'string' ? normalizeSuiAddress(json) : json;
    if (base === '0x1::string::String' || base === '0x1::ascii::String' || base === '0x2::url::Url') return json;
    if (base === '0x2::balance::Balance') return json === null || json === undefined ? json : String((json as any)?.value ?? json);
    if (base === '0x1::option::Option') {
      if (json === null || json === undefined || json === 'None') return null;
      const inner = layout.struct.fields[0]?.layout;
      const innerLayout = inner && typeof inner !== 'string' && inner.vector !== undefined ? inner.vector as Layout : undefined;
      return innerLayout ? toRpcValue(json, innerLayout, mode) : json;
    }
    const rec = (json ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const f of layout.struct.fields) fields[f.name] = toRpcValue(rec[f.name], f.layout, mode);
    return mode === 'content' ? { type, fields } : fields;
  }
  return json;
}

function rpcOwner(o: any): unknown {
  switch (o?.__typename) {
    case 'AddressOwner': return { AddressOwner: normalizeSuiAddress(o.address?.address) };
    case 'ObjectOwner': return { ObjectOwner: normalizeSuiAddress(o.address?.address) };
    case 'Shared': return { Shared: { initial_shared_version: Number(o.initialSharedVersion) } };
    case 'Immutable': return 'Immutable';
    case 'ConsensusAddressOwner': return { ConsensusAddressOwner: { start_version: Number(o.startVersion), owner: normalizeSuiAddress(o.address?.address) } };
    default: return null;
  }
}

const OWNER_SEL = `owner { __typename
  ... on AddressOwner { address { address } }
  ... on ObjectOwner { address { address } }
  ... on Shared { initialSharedVersion }
  ... on ConsensusAddressOwner { startVersion address { address } } }`;

const MOVE_OBJECT_SEL = `address version digest ${OWNER_SEL} previousTransaction { digest }
  hasPublicTransfer contents { type { repr layout } json }`;

type ObjOptions = { showType?: boolean; showOwner?: boolean; showContent?: boolean; showPreviousTransaction?: boolean; showBcs?: boolean; showDisplay?: boolean; showStorageRebate?: boolean };

function rpcObject(node: any, opts: ObjOptions = {}): Record<string, unknown> {
  const type = node?.contents?.type?.repr ? shortType(node.contents.type.repr) : undefined;
  const data: Record<string, unknown> = {
    objectId: normalizeSuiAddress(node.address),
    version: String(node.version),
    digest: node.digest,
  };
  if (opts.showType && type) data.type = type;
  if (opts.showOwner) data.owner = rpcOwner(node.owner);
  if (opts.showPreviousTransaction) data.previousTransaction = node.previousTransaction?.digest ?? null;
  if (opts.showContent && node.contents) {
    const v = toRpcValue(node.contents.json, node.contents.type.layout, 'content') as { fields?: unknown };
    data.content = { dataType: 'moveObject', type, hasPublicTransfer: !!node.hasPublicTransfer, fields: v?.fields ?? v };
  }
  return data;
}

// ─── Methods ─────────────────────────────────────────────────────────

async function getObjects(ids: string[], opts: ObjOptions): Promise<unknown[]> {
  if (!ids.length) return [];
  const q = `query { ${ids.map((id, i) => `o${i}: object(address: "${normalizeSuiAddress(id)}") { address version digest asMoveObject { ${MOVE_OBJECT_SEL} } asMovePackage { address } }`).join('\n')} }`;
  const d = await gql<Record<string, any>>(q);
  return ids.map((id, i) => {
    const o = d[`o${i}`];
    if (!o) return { error: { code: 'notExists', object_id: normalizeSuiAddress(id) } };
    if (o.asMoveObject) return { data: rpcObject(o.asMoveObject, opts) };
    return { data: { objectId: normalizeSuiAddress(o.address), version: String(o.version), digest: o.digest, ...(opts.showType ? { type: 'package' } : {}) } };
  });
}

function encodeFieldName(name: { type: string; value: unknown }): string {
  const t = shortType(name.type);
  const v = name.value as any;
  switch (t) {
    case 'address': case '0x2::object::ID': return toBase64(bcs.Address.serialize(v).toBytes());
    case 'u8': return toBase64(bcs.u8().serialize(v).toBytes());
    case 'u16': return toBase64(bcs.u16().serialize(v).toBytes());
    case 'u32': return toBase64(bcs.u32().serialize(v).toBytes());
    case 'u64': return toBase64(bcs.u64().serialize(v).toBytes());
    case 'u128': return toBase64(bcs.u128().serialize(v).toBytes());
    case 'bool': return toBase64(bcs.bool().serialize(v).toBytes());
    case '0x1::string::String': case '0x1::ascii::String': return toBase64(bcs.string().serialize(v).toBytes());
    case 'vector<u8>': return toBase64(bcs.vector(bcs.u8()).serialize(v).toBytes());
    default: throw new RpcMethodError(`getDynamicFieldObject: unsupported name type ${name.type}`);
  }
}

const TX_SEL = `digest sender { address }
  gasInput { gasSponsor { address } gasBudget gasPrice gasPayment { nodes { address version digest } } }
  effects { status timestamp executionError { message } checkpoint { sequenceNumber }
    gasEffects { gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee } }
    balanceChanges(first: 50) { nodes { owner { address } amount coinType { repr } } }
    objectChanges(first: 50) { nodes { address idCreated idDeleted
      inputState { version digest }
      outputState { version digest ${OWNER_SEL} asMoveObject { contents { type { repr } } } } } }
    events(first: 50) { nodes { sender { address } contents { type { repr layout } json } transactionModule { name package { address } } } } }`;

type TxOptions = { showInput?: boolean; showEffects?: boolean; showEvents?: boolean; showObjectChanges?: boolean; showBalanceChanges?: boolean; showRawInput?: boolean };

function rpcTransaction(t: any, opts: TxOptions): Record<string, unknown> {
  const e = t.effects ?? {};
  const ok = e.status === 'SUCCESS';
  const changes: any[] = e.objectChanges?.nodes ?? [];
  const ref = (c: any) => ({ objectId: normalizeSuiAddress(c.address), version: Number(c.outputState?.version ?? c.inputState?.version), digest: c.outputState?.digest ?? c.inputState?.digest });
  const out: Record<string, unknown> = {
    digest: t.digest,
    timestampMs: e.timestamp ? String(Date.parse(e.timestamp)) : undefined,
    checkpoint: e.checkpoint?.sequenceNumber !== undefined ? String(e.checkpoint.sequenceNumber) : undefined,
  };
  if (opts.showInput) {
    out.transaction = { data: {
      sender: t.sender?.address ? normalizeSuiAddress(t.sender.address) : undefined,
      gasData: {
        owner: t.gasInput?.gasSponsor?.address ? normalizeSuiAddress(t.gasInput.gasSponsor.address) : undefined,
        budget: String(t.gasInput?.gasBudget ?? ''),
        price: String(t.gasInput?.gasPrice ?? ''),
        payment: (t.gasInput?.gasPayment?.nodes ?? []).map((p: any) => ({ objectId: p.address, version: Number(p.version), digest: p.digest })),
      },
    } };
  }
  if (opts.showEffects !== false) {
    const g = e.gasEffects?.gasSummary ?? {};
    out.effects = {
      status: ok ? { status: 'success' } : { status: 'failure', error: e.executionError?.message ?? 'unknown' },
      transactionDigest: t.digest,
      gasUsed: { computationCost: String(g.computationCost ?? 0), storageCost: String(g.storageCost ?? 0), storageRebate: String(g.storageRebate ?? 0), nonRefundableStorageFee: String(g.nonRefundableStorageFee ?? 0) },
      created: changes.filter(c => c.idCreated && !c.idDeleted).map(c => ({ owner: rpcOwner(c.outputState?.owner), reference: ref(c) })),
      mutated: changes.filter(c => !c.idCreated && !c.idDeleted && c.outputState).map(c => ({ owner: rpcOwner(c.outputState?.owner), reference: ref(c) })),
      deleted: changes.filter(c => c.idDeleted).map(c => ref(c)),
    };
  }
  if (opts.showEvents) {
    out.events = (e.events?.nodes ?? []).map((ev: any, i: number) => ({
      id: { txDigest: t.digest, eventSeq: String(i) },
      packageId: ev.transactionModule?.package?.address,
      transactionModule: ev.transactionModule?.name,
      sender: ev.sender?.address ? normalizeSuiAddress(ev.sender.address) : undefined,
      type: shortType(ev.contents?.type?.repr ?? ''),
      parsedJson: ev.contents ? toRpcValue(ev.contents.json, ev.contents.type.layout, 'plain') : undefined,
    }));
  }
  if (opts.showBalanceChanges) {
    out.balanceChanges = (e.balanceChanges?.nodes ?? []).map((b: any) => ({
      owner: { AddressOwner: normalizeSuiAddress(b.owner?.address) },
      coinType: shortType(b.coinType?.repr ?? ''),
      amount: String(b.amount),
    }));
  }
  if (opts.showObjectChanges) {
    out.objectChanges = changes.map(c => {
      const objectType = c.outputState?.asMoveObject?.contents?.type?.repr;
      const base = { sender: t.sender?.address, objectId: normalizeSuiAddress(c.address), ...(objectType ? { objectType: shortType(objectType) } : {}) };
      if (c.idDeleted) return { type: 'deleted', ...base, version: String(c.inputState?.version ?? '') };
      return { type: c.idCreated ? 'created' : 'mutated', ...base, owner: rpcOwner(c.outputState?.owner), version: String(c.outputState?.version), digest: c.outputState?.digest };
    });
  }
  return out;
}

async function getTransaction(digest: string, opts: TxOptions, waitMs = 0): Promise<Record<string, unknown>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const d = await gql<{ transaction: any }>(`query($d: String!) { transaction(digest: $d) { ${TX_SEL} } }`, { d: digest });
    if (d.transaction?.effects) return rpcTransaction(d.transaction, opts);
    if (Date.now() >= deadline) throw new RpcMethodError(`Could not find the referenced transaction [TransactionDigest(${digest})].`);
    await new Promise(r => setTimeout(r, 750));
  }
}

// GraphQL OpenMoveType signature → JSON-RPC SuiMoveNormalizedType
const PRIMS: Record<string, string> = { u8: 'U8', u16: 'U16', u32: 'U32', u64: 'U64', u128: 'U128', u256: 'U256', bool: 'Bool', address: 'Address', signer: 'Signer' };
function normBody(b: any): unknown {
  if (typeof b === 'string') return PRIMS[b] ?? b;
  if (b?.vector !== undefined) return { Vector: normBody(b.vector) };
  if (b?.typeParameter !== undefined) return { TypeParameter: b.typeParameter };
  if (b?.datatype) return { Struct: {
    address: shortType(normalizeSuiAddress(b.datatype.package) + '::').replace(/::$/, ''),
    module: b.datatype.module, name: b.datatype.type,
    typeArguments: (b.datatype.typeParameters ?? []).map(normBody),
  } };
  return b;
}
function normType(sig: any): unknown {
  const inner = normBody(sig?.body);
  if (sig?.ref === '&') return { Reference: inner };
  if (sig?.ref === '&mut') return { MutableReference: inner };
  return inner;
}
const ABILITY: Record<string, string> = { COPY: 'Copy', DROP: 'Drop', STORE: 'Store', KEY: 'Key' };

// gRPC (SuiClientTypes) effects → JSON-RPC TransactionEffects
const DELETED_DIGEST = '7gyGAp71YXQRoxmFBaHxofQXAipvgHyBKPyxmdSJxyvz';
function grpcOwner(o: any): unknown {
  if (!o) return null;
  if (o.AddressOwner) return { AddressOwner: o.AddressOwner };
  if (o.ObjectOwner) return { ObjectOwner: o.ObjectOwner };
  if (o.Shared) return { Shared: { initial_shared_version: Number(o.Shared.initialSharedVersion ?? o.Shared.initial_shared_version) } };
  if (o.ConsensusAddressOwner) return { ConsensusAddressOwner: { start_version: Number(o.ConsensusAddressOwner.startVersion), owner: o.ConsensusAddressOwner.owner } };
  if (o.$kind === 'Immutable' || o.Immutable) return 'Immutable';
  return o;
}
function grpcEffectsToRpc(e: any, executedEpoch?: unknown): Record<string, unknown> {
  const changed: any[] = e?.changedObjects ?? [];
  const ref = (c: any) => ({ objectId: c.objectId, version: Number(c.outputVersion), digest: c.outputDigest });
  const st = e?.status;
  const g = e?.gasObject;
  return {
    messageVersion: 'v1',
    status: st?.success ? { status: 'success' } : { status: 'failure', error: st?.error?.message ?? (typeof st?.error === 'string' ? st.error : 'execution failed') },
    executedEpoch: executedEpoch !== undefined && executedEpoch !== null ? String(executedEpoch) : '0',
    gasUsed: {
      computationCost: String(e?.gasUsed?.computationCost ?? 0), storageCost: String(e?.gasUsed?.storageCost ?? 0),
      storageRebate: String(e?.gasUsed?.storageRebate ?? 0), nonRefundableStorageFee: String(e?.gasUsed?.nonRefundableStorageFee ?? 0),
    },
    modifiedAtVersions: changed.filter(c => c.inputState === 'Exists').map(c => ({ objectId: c.objectId, sequenceNumber: String(c.inputVersion) })),
    sharedObjects: [],
    transactionDigest: e?.transactionDigest,
    created: changed.filter(c => c.idOperation === 'Created').map(c => ({ owner: grpcOwner(c.outputOwner), reference: ref(c) })),
    mutated: changed.filter(c => c.idOperation === 'None' && c.outputState === 'ObjectWrite').map(c => ({ owner: grpcOwner(c.outputOwner), reference: ref(c) })),
    deleted: changed.filter(c => c.idOperation === 'Deleted').map(c => ({ objectId: c.objectId, version: Number(e?.lamportVersion ?? 0), digest: DELETED_DIGEST })),
    wrapped: [], unwrapped: [], unwrappedThenDeleted: [],
    gasObject: g ? { owner: grpcOwner(g.outputOwner), reference: { objectId: g.objectId, version: Number(g.outputVersion), digest: g.outputDigest } } : undefined,
    eventsDigest: e?.eventsDigest ?? undefined,
    dependencies: e?.dependencies ?? [],
  };
}
function grpcObjectChanges(e: any, objectTypes: Record<string, string> | undefined, sender: string | undefined): unknown[] {
  return (e?.changedObjects ?? []).map((c: any) => {
    const objectType = objectTypes?.[c.objectId] ? shortType(objectTypes[c.objectId]) : undefined;
    if (c.idOperation === 'Deleted') return { type: 'deleted', sender, objectType, objectId: c.objectId, version: String(e?.lamportVersion ?? '') };
    return { type: c.idOperation === 'Created' ? 'created' : 'mutated', sender, owner: grpcOwner(c.outputOwner), objectType, objectId: c.objectId, version: String(c.outputVersion), digest: c.outputDigest };
  });
}

export async function handleSuiJsonRpc(method: string, params: any[] = []): Promise<unknown> {
  switch (method) {
    case 'sui_getObject': {
      const [r] = await getObjects([params[0]], params[1] ?? {});
      return r;
    }
    case 'sui_multiGetObjects':
      return getObjects(params[0] ?? [], params[1] ?? {});

    case 'suix_getOwnedObjects': {
      const [owner, query = {}, cursor = null, limit = 50] = params;
      const type = query?.filter?.StructType;
      if (query?.filter && !type) throw new RpcMethodError('suix_getOwnedObjects: only StructType filters are supported');
      const d = await gql<{ address: any }>(
        `query($a: SuiAddress!, $first: Int, $after: String, $f: ObjectFilter) { address(address: $a) { objects(first: $first, after: $after, filter: $f) { pageInfo { hasNextPage endCursor } nodes { ${MOVE_OBJECT_SEL} } } } }`,
        { a: owner, first: Math.min(limit ?? 50, 50), after: cursor, f: type ? { type } : null },
      );
      const objs = d.address?.objects;
      return {
        data: (objs?.nodes ?? []).map((n: any) => ({ data: rpcObject(n, query?.options ?? {}) })),
        nextCursor: objs?.pageInfo?.endCursor ?? null,
        hasNextPage: !!objs?.pageInfo?.hasNextPage,
      };
    }

    case 'suix_getCoins':
    case 'sui_getCoins': {
      const [owner, coinType = '0x2::sui::SUI', cursor = null, limit] = params;
      const r: any = await grpcAny(c => c.listCoins({ owner, coinType: coinType ?? '0x2::sui::SUI', cursor: cursor ?? undefined, limit: limit ?? undefined }));
      return {
        data: (r.objects ?? []).map((o: any) => ({
          coinType: shortType(o.type?.match(/<(.+)>$/)?.[1] ?? coinType),
          coinObjectId: o.objectId, version: String(o.version), digest: o.digest, balance: String(o.balance),
        })),
        nextCursor: r.cursor ?? null,
        hasNextPage: !!r.hasNextPage,
      };
    }
    case 'suix_getBalance':
    case 'sui_getBalance': {
      const [owner, coinType = '0x2::sui::SUI'] = params;
      const r: any = await grpcAny(c => c.getBalance({ owner, coinType: coinType ?? '0x2::sui::SUI' }));
      const b = r.balance ?? r;
      return { coinType: shortType(b.coinType ?? coinType), coinObjectCount: 0, totalBalance: String(b.balance ?? '0'), lockedBalance: {} };
    }
    case 'suix_getAllBalances': {
      const r: any = await grpcAny(c => c.listBalances({ owner: params[0] }));
      return (r.balances ?? []).map((b: any) => ({ coinType: shortType(b.coinType), coinObjectCount: 0, totalBalance: String(b.balance), lockedBalance: {} }));
    }
    case 'suix_getReferenceGasPrice':
    case 'sui_getReferenceGasPrice': {
      const r: any = await grpcAny(c => c.getReferenceGasPrice());
      return String(r.referenceGasPrice ?? r);
    }
    case 'suix_getCoinMetadata': {
      const d = await gql<{ coinMetadata: any }>(`query($t: String!) { coinMetadata(coinType: $t) { decimals name symbol description iconUrl address } }`, { t: params[0] });
      const m = d.coinMetadata;
      return m ? { decimals: m.decimals, name: m.name, symbol: m.symbol, description: m.description ?? '', iconUrl: m.iconUrl || null, id: m.address } : null;
    }
    case 'suix_resolveNameServiceAddress': {
      const d = await gql<{ address: any }>(`query($n: String!) { address(name: $n) { address } }`, { n: params[0] });
      return d.address?.address ? normalizeSuiAddress(d.address.address) : null;
    }
    case 'suix_resolveNameServiceNames': {
      const d = await gql<{ address: any }>(`query($a: SuiAddress!) { address(address: $a) { defaultNameRecord { domain } } }`, { a: params[0] });
      const name = d.address?.defaultNameRecord?.domain;
      return { data: name ? [name] : [], nextCursor: null, hasNextPage: false };
    }
    case 'suix_getDynamicFields': {
      const [parent, cursor = null, limit = 50] = params;
      const d = await gql<{ address: any }>(
        `query($a: SuiAddress!, $first: Int, $after: String) { address(address: $a) { dynamicFields(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { address name { type { repr layout } json bcs } value { __typename ... on MoveObject { address version digest contents { type { repr } } } ... on MoveValue { type { repr } } } } } } }`,
        { a: parent, first: Math.min(limit ?? 50, 50), after: cursor },
      );
      const df = d.address?.dynamicFields;
      return {
        data: (df?.nodes ?? []).map((n: any) => {
          const isObj = n.value?.__typename === 'MoveObject';
          return {
            name: { type: shortType(n.name.type.repr), value: toRpcValue(n.name.json, n.name.type.layout, 'plain') },
            bcsName: n.name.bcs,
            type: isObj ? 'DynamicObject' : 'DynamicField',
            objectType: shortType(isObj ? n.value.contents?.type?.repr ?? '' : n.value?.type?.repr ?? ''),
            objectId: normalizeSuiAddress(isObj ? n.value.address : n.address),
            version: isObj ? Number(n.value.version) : undefined,
            digest: isObj ? n.value.digest : undefined,
          };
        }),
        nextCursor: df?.pageInfo?.endCursor ?? null,
        hasNextPage: !!df?.pageInfo?.hasNextPage,
      };
    }
    case 'suix_getDynamicFieldObject': {
      const [parent, name] = params;
      const nameArg = { type: name.type, bcs: encodeFieldName(name) };
      const d = await gql<{ address: any }>(
        `query($a: SuiAddress!, $n: DynamicFieldName!) { address(address: $a) {
          dof: dynamicObjectField(name: $n) { address value { ... on MoveObject { ${MOVE_OBJECT_SEL} } } }
          df: dynamicField(name: $n) { address name { type { repr layout } json } value { ... on MoveValue { type { repr layout } json } } } } }`,
        { a: parent, n: nameArg },
      );
      const opts = { showType: true, showOwner: true, showContent: true };
      if (d.address?.dof?.value?.address) return { data: rpcObject(d.address.dof.value, opts) };
      const df = d.address?.df;
      if (!df) return { error: { code: 'dynamicFieldNotFound', parent_object_id: normalizeSuiAddress(parent) } };
      const k = shortType(df.name.type.repr);
      const v = shortType(df.value?.type?.repr ?? '');
      const fieldType = `0x2::dynamic_field::Field<${k}, ${v}>`;
      const obj = await getObjects([df.address], { showType: true, showOwner: true });
      const base = (obj[0] as any)?.data ?? { objectId: normalizeSuiAddress(df.address) };
      return { data: {
        ...base,
        type: fieldType,
        content: { dataType: 'moveObject', type: fieldType, hasPublicTransfer: false, fields: {
          id: { id: normalizeSuiAddress(df.address) },
          name: toRpcValue(df.name.json, df.name.type.layout, 'content'),
          value: df.value ? toRpcValue(df.value.json, df.value.type.layout, 'content') : null,
        } },
      } };
    }

    case 'sui_getTransactionBlock':
      return getTransaction(params[0], params[1] ?? {});
    case 'sui_multiGetTransactionBlocks':
      return Promise.all((params[0] ?? []).map((dg: string) => getTransaction(dg, params[1] ?? {})));

    case 'sui_executeTransactionBlock': {
      const [txB64, signatures, options = {}] = params;
      const sigs: string[] = Array.isArray(signatures) ? signatures : [signatures];
      const r: any = await grpcAny(c => c.core.executeTransaction({ transaction: fromBase64(txB64), signatures: sigs, include: { effects: true } } as any));
      const inner = r.$kind === 'Transaction' ? r.Transaction : r.FailedTransaction ?? r.Transaction;
      const digest: string = inner?.digest;
      if (!digest) throw new RpcMethodError('Execution returned no digest');
      const effects = grpcEffectsToRpc(inner?.effects, inner?.epoch);
      const wantsDetail = options.showEvents || options.showObjectChanges || options.showBalanceChanges || options.showInput;
      if (wantsDetail) {
        try {
          const full = await getTransaction(digest, options, 8_000);
          return { ...full, effects, confirmedLocalExecution: true };
        } catch { /* indexer lag — fall through with the gRPC effects */ }
      }
      return { digest, effects, confirmedLocalExecution: true };
    }
    case 'sui_dryRunTransactionBlock': {
      const r: any = await grpcAny(c => c.simulateTransaction({ transaction: fromBase64(params[0]), include: { effects: true, balanceChanges: true, objectTypes: true } } as any));
      const inner = r.$kind === 'Transaction' ? r.Transaction : r.FailedTransaction;
      const sender = inner?.transaction?.sender;
      return {
        effects: grpcEffectsToRpc(inner?.effects, inner?.epoch),
        events: [],
        objectChanges: grpcObjectChanges(inner?.effects, inner?.objectTypes, sender),
        balanceChanges: (inner?.balanceChanges ?? []).map((b: any) => ({ owner: { AddressOwner: b.address }, coinType: shortType(b.coinType), amount: String(b.amount) })),
        input: {},
      };
    }
    case 'sui_getNormalizedMoveFunction': {
      const [pkg, mod, fn] = params;
      const d = await gql<{ package: any }>(
        `query($p: SuiAddress!, $m: String!, $f: String!) { package(address: $p) { module(name: $m) { function(name: $f) { visibility isEntry typeParameters { constraints } parameters { signature } return { signature } } } } }`,
        { p: pkg, m: mod, f: fn },
      );
      const f = d.package?.module?.function;
      if (!f) throw new RpcMethodError(`No function ${pkg}::${mod}::${fn}`);
      const vis = String(f.visibility ?? 'PUBLIC');
      return {
        visibility: vis.charAt(0) + vis.slice(1).toLowerCase(),
        isEntry: !!f.isEntry,
        typeParameters: (f.typeParameters ?? []).map((t: any) => ({ abilities: (t.constraints ?? []).map((c: string) => ABILITY[c] ?? c) })),
        parameters: (f.parameters ?? []).map((p: any) => normType(p.signature)),
        return: (f.return ?? []).map((p: any) => normType(p.signature)),
      };
    }
    case 'suix_getLatestSuiSystemState': {
      const r: any = await grpcAny(c => c.core.getCurrentSystemState());
      const st = r.systemState ?? {};
      const str = (v: unknown) => (v === null || v === undefined ? v : String(v));
      return {
        systemStateVersion: str(st.systemStateVersion), epoch: str(st.epoch), protocolVersion: str(st.protocolVersion),
        referenceGasPrice: str(st.referenceGasPrice), epochStartTimestampMs: str(st.epochStartTimestampMs),
        safeMode: !!st.safeMode,
        safeModeStorageRewards: str(st.safeModeStorageRewards), safeModeComputationRewards: str(st.safeModeComputationRewards),
        safeModeStorageRebates: str(st.safeModeStorageRebates), safeModeNonRefundableStorageFee: str(st.safeModeNonRefundableStorageFee),
        epochDurationMs: str(st.parameters?.epochDurationMs), stakeSubsidyStartEpoch: str(st.parameters?.stakeSubsidyStartEpoch),
        maxValidatorCount: str(st.parameters?.maxValidatorCount), minValidatorJoiningStake: str(st.parameters?.minValidatorJoiningStake),
        validatorLowStakeThreshold: str(st.parameters?.validatorLowStakeThreshold), validatorLowStakeGracePeriod: str(st.parameters?.validatorLowStakeGracePeriod),
        storageFundTotalObjectStorageRebates: str(st.storageFund?.totalObjectStorageRebates), storageFundNonRefundableBalance: str(st.storageFund?.nonRefundableBalance),
        stakeSubsidyBalance: str(st.stakeSubsidy?.balance), stakeSubsidyDistributionCounter: str(st.stakeSubsidy?.distributionCounter),
        stakeSubsidyCurrentDistributionAmount: str(st.stakeSubsidy?.currentDistributionAmount), stakeSubsidyPeriodLength: str(st.stakeSubsidy?.stakeSubsidyPeriodLength),
        stakeSubsidyDecreaseRate: st.stakeSubsidy?.stakeSubsidyDecreaseRate,
        activeValidators: [],
      };
    }
    case 'sui_getCheckpoint': {
      const id = params[0];
      const isSeq = /^\d+$/.test(String(id));
      const d = await gql<{ checkpoint: any }>(
        `query($s: UInt53, $d: String) { checkpoint(sequenceNumber: $s, digest: $d) { digest sequenceNumber timestamp previousCheckpointDigest networkTotalTransactions epoch { epochId } } }`,
        isSeq ? { s: Number(id) } : { d: String(id) },
      );
      const c = d.checkpoint;
      if (!c) throw new RpcMethodError(`Checkpoint ${id} not found`);
      return {
        digest: c.digest, sequenceNumber: String(c.sequenceNumber), epoch: String(c.epoch?.epochId ?? ''),
        timestampMs: c.timestamp ? String(Date.parse(c.timestamp)) : undefined,
        previousDigest: c.previousCheckpointDigest ?? undefined,
        networkTotalTransactions: String(c.networkTotalTransactions ?? ''),
        transactions: [], checkpointCommitments: [], validatorSignature: '',
      };
    }
    case 'sui_getChainIdentifier':
      return '35834a8a';
    default:
      throw new RpcMethodError(`Method not supported by passki's JSON-RPC shim: ${method}`, -32601);
  }
}

/** Handle a raw JSON-RPC request body (single or batch). */
export async function handleSuiJsonRpcBody(body: any): Promise<unknown> {
  const one = async (req: any) => {
    try {
      return { jsonrpc: '2.0', id: req?.id ?? null, result: await handleSuiJsonRpc(req?.method, req?.params ?? []) };
    } catch (err) {
      const code = err instanceof RpcMethodError ? err.code : -32000;
      return { jsonrpc: '2.0', id: req?.id ?? null, error: { code, message: err instanceof Error ? err.message : String(err) } };
    }
  };
  return Array.isArray(body) ? Promise.all(body.map(one)) : one(body);
}
