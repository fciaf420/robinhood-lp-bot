/** Small Alchemy Data API helper used when the public explorer index is unavailable. */

export interface AlchemyTransfer {
  uniqueId?: string;
  hash?: string;
  from?: string;
  to?: string;
  value?: number;
  asset?: string;
  category?: string;
  rawContract?: { address?: string | null; value?: string | null; decimal?: string | null };
}

/**
 * Call an Alchemy-only JSON-RPC method without routing it through the normal fallback provider.
 * Robinhood supports the Data API methods on its Alchemy endpoint, but the public RPC does not.
 */
export async function alchemyRpc<T = any>(rpcUrl: string, method: string, params: unknown[], timeoutMs = 20_000): Promise<T | null> {
  try {
    const u = new URL(rpcUrl);
    if (!/\.g\.alchemy\.com$/i.test(u.hostname)) return null;
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json().catch(() => null)) as { result?: T; error?: unknown } | null;
    return body && !body.error ? (body.result ?? null) : null;
  } catch {
    return null;
  }
}

/** Fetch paginated wallet transfers. Returns null when the endpoint is unavailable. */
export async function alchemyTransfers(
  rpcUrl: string,
  category: string,
  extra: Record<string, unknown> = {},
): Promise<AlchemyTransfer[] | null> {
  const out: AlchemyTransfer[] = [];
  let pageKey: string | undefined;
  for (;;) {
    const result = await alchemyRpc<{ transfers?: AlchemyTransfer[]; pageKey?: string }>(rpcUrl, "alchemy_getAssetTransfers", [{
      fromBlock: "0x0",
      toBlock: "latest",
      category: [category],
      withMetadata: false,
      excludeZeroValue: true,
      maxCount: "0x3e8",
      ...(pageKey ? { pageKey } : {}),
      ...extra,
    }], 20_000);
    if (!result) return null;
    out.push(...(result.transfers ?? []));
    if (!result.pageKey) return out;
    pageKey = result.pageKey;
  }
}

export async function alchemyTokenBalances(rpcUrl: string, address: string): Promise<Array<{ contractAddress: string; tokenBalance: string }> | null> {
  const result = await alchemyRpc<{ tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }> }>(rpcUrl, "alchemy_getTokenBalances", [address, "erc20"]);
  return result?.tokenBalances ?? null;
}

export async function alchemyTokenMetadata(rpcUrl: string, contractAddress: string): Promise<{ decimals: number; symbol: string; name: string } | null> {
  return alchemyRpc<{ decimals?: number; symbol?: string; name?: string }>(rpcUrl, "alchemy_getTokenMetadata", [contractAddress]).then((m) =>
    m && Number.isFinite(Number(m.decimals)) ? { decimals: Number(m.decimals), symbol: m.symbol || "?", name: m.name || "?" } : null,
  );
}

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
