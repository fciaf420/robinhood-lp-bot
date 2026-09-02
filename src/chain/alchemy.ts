/** Small Alchemy Data API helper used when the public explorer index is unavailable. */

export function alchemyNftOwnerUrl(rpcUrl: string, owner: string, contract: string): string | null {
  try {
    const u = new URL(rpcUrl);
    // The key is already present in the configured Alchemy RPC URL. Do not log or expose it.
    const match = u.pathname.match(/^\/v2\/([^/]+)\/?$/);
    if (!match || !/\.g\.alchemy\.com$/i.test(u.hostname)) return null;
    const params = new URLSearchParams({ owner, "contractAddresses[]": contract, withMetadata: "false", pageSize: "100" });
    return `${u.protocol}//${u.host}/nft/v3/${match[1]}/getNFTsForOwner?${params.toString()}`;
  } catch {
    return null;
  }
}

export function parseAlchemyOwnedNftIds(body: unknown, contract: string): string[] {
  if (!body || typeof body !== "object") return [];
  const items = (body as { ownedNfts?: unknown }).ownedNfts;
  if (!Array.isArray(items)) return [];
  const contractLower = contract.toLowerCase();
  return items
    .filter((item): item is { contract?: { address?: unknown }; tokenId?: unknown } => !!item && typeof item === "object")
    // Alchemy omits contract.address when the request already includes a
    // contractAddresses[] filter. Treat that response as already scoped.
    .filter((item) => !item.contract?.address || String(item.contract.address).toLowerCase() === contractLower)
    .map((item) => String(item.tokenId ?? "").trim())
    .filter((id) => /^\d+$/.test(id));
}

export async function alchemyOwnedNftIds(rpcUrl: string, owner: string, contract: string): Promise<string[]> {
  const url = alchemyNftOwnerUrl(rpcUrl, owner, contract);
  if (!url) return [];
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return [];
    return parseAlchemyOwnedNftIds(await response.json().catch(() => null), contract);
  } catch {
    return [];
  }
}
