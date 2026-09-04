export type PoolInputKind = "address" | "v4-pool-id" | "invalid";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const V4_POOL_ID_RE = /^0x[a-fA-F0-9]{64}$/;

/** Classify pasted pool/token input without making an RPC call. */
export function classifyPoolInput(value: string): PoolInputKind {
  const input = value.trim();
  if (ADDRESS_RE.test(input)) return "address";
  if (V4_POOL_ID_RE.test(input)) return "v4-pool-id";
  return "invalid";
}

export { ADDRESS_RE, V4_POOL_ID_RE };
