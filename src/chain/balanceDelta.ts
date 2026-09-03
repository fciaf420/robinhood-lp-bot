/** Return only funds received during an operation; pre-existing wallet funds are excluded. */
export function positiveBalanceDelta(after: bigint, before: bigint): bigint {
  return after > before ? after - before : 0n;
}
