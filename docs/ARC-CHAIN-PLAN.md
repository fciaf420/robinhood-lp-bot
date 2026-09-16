# Arc chain support — implementation plan

Goal: run the same LP bot on **Arc** (Circle's stablecoin chain) with full feature parity —
manual LP, hunt, auto-open, auto-manage, ledger, cards — without disturbing the live
Robinhood Chain bot.

Decisions taken (owner):
- **Chain profiles + a second process.** Arc runs as its own bot process with its own
  Telegram token and its own `data/` dir. Robinhood keeps running untouched.
- **Full parity on Arc** — hunt + auto-open included, not just manual LP.
- **Mainnet only**, no testnet profile.
- **No imposed size caps.** Deposit size is the control. The only enforced floor is a
  native gas reserve (see §6) — without it the bot cannot pay gas to *close* a position.

---

## 1. What Arc is, and why it is not a drop-in

Arc is a **Layer-1** (not an L2), EVM, opened mainnet 2026-09-16.

| | Robinhood Chain | Arc |
|---|---|---|
| chainId | 4663 | **5042** |
| RPC | rpc.mainnet.chain.robinhood.com | **rpc.mainnet.arc.io** (archival: explorer.arc.io/api/eth-rpc) |
| native gas | ETH (18 dec) | **USDC — 18-dec native repr, 6-dec ERC-20 predeploy `0x3600…0000`** |
| wrapped native | WETH `0x0bd7…ad73` | **none — no WETH9 exists** |
| stable quote | USDG (6 dec) | USDC ERC-20 `0x3600…0000` (6 dec) — same asset as gas |
| second stable | — | EURC `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` (6 dec); no USDT |
| explorer | Blockscout | explorer.arc.io (`/tx/{hash}`) |
| funding | bridge in | **CCTP v2, domain 26, 1 conf** (see §2b) |
| block time | sub-second (sequencer) | ~500ms, Malachite BFT, 1 conf = final |
| gas price | floating base fee | **constant 20 gwei base fee**, EIP-1559 type-2, ~5 gwei priority |
| fast submit | sequencer endpoint | none (validator set, no sequencer) |
| venues | Uni v2/v3/v4 | Uni v2/v3/v4, Curve, Aerodrome |
| aggregator | KyberSwap (`robinhood`) | Kyber Arc support **unverified** — needs fallback |
| screener | DexScreener `robinhood`, GMGN `robinhood` | DexScreener slug **unverified**, GMGN **almost certainly absent** |

Three consequences drive the whole design:

1. **Gas and LP capital are the same balance.** Spending everything into an LP leaves
   nothing to close it with. Gas reserve is mandatory.
2. **No wrapped native.** Every wrap/unwrap path (`ensureNativeEth`, `swapWethToToken`,
   the v4 "unwrap WETH → native" pre-step) is a no-op on Arc. v3 pools cannot be
   native-paired, so **every Arc pool is token/USDC-ERC20** — which is exactly the shape
   of the existing USDG code path. That path becomes the primary Arc path.
3. **18 vs 6 decimals for the same asset** is the #1 hazard on this chain. Uniswap's own
   Arc playbook warns integrators to reject the native `0x0` sentinel for this reason.
   v1 therefore uses the **6-dec ERC-20 USDC everywhere a pool currency is needed**, and
   native only for gas.

## 2. Address book (verify before use)

Chain-level values are **confirmed first-party**: `@circle-fin/bridge-kit` (npm) ships the
canonical Arc chain definition — chainId 5042, RPC `https://rpc.mainnet.arc.io/`, explorer
`https://explorer.arc.io/tx/{hash}`, native USDC at 18 decimals with the 6-decimal ERC-20
predeploy, EURC, no USDT, CCTP domain 26. That registry is a better source than any
third-party page and should be the probe script's cross-check.

The **Uniswap** addresses below come from the Uniswap sdk-core Arc config, Uniswap's Arc
playbook and DefiLlama's Arc adapter. Several are truncated in public sources and **must be
resolved + code-checked by the probe script (§3) before any money moves**.

| contract | address | status |
|---|---|---|
| USDC ERC-20 predeploy | `0x3600000000000000000000000000000000000000` | **confirmed** (Circle SDK) — decimals 6 |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | **confirmed** (Circle SDK) |
| CCTP v2 TokenMessenger | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | **confirmed** (Circle SDK) |
| CCTP v2 MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | **confirmed** (Circle SDK) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical |
| Multicall3 | `0xcA11bde05977b3631167028862be2a173976ca11` | canonical |
| v2 factory | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` | verify |
| v3 factory | `0xf0db7b58379503491d857db50ac9ece64c653918` | verify |
| v3 SwapRouter02 | `0x53bf…6f77` | **truncated — resolve** |
| v3 NonfungiblePositionManager | — | **unknown — resolve** |
| v3 Quoter(V2) | — | **unknown — resolve** |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | same address as Robinhood (CREATE2) |
| v4 PositionManager | `0x6049c9a0e26405c0985f9e3685c87d0ae917f82b` | verify |
| v4 StateView | — | **unknown — resolve** |
| v4 Quoter | `0x8dc1…8f94` | **truncated — resolve** |
| UniversalRouter | `0x0A122717…` | **truncated — resolve** |

Note: Circle's docs live at **docs.arc.network** (the SDK's own doc links point there), with
the contract reference at `/arc/references/contract-addresses` — that page and `arc.io` are
blocked by this session's egress policy, so nothing in this plan depends on them.

Resolution order: (a) bump/side-install `@uniswap/sdk-core` to a version shipping
`ChainId.ARC = 5042` and read `CHAIN_TO_ADDRESSES_MAP[5042]`; (b) else read them off the
explorer; (c) confirm each with `eth_getCode` + one live call. Uniswap deploys on Arc date
from ~2026-05-28 — that block is the `fromBlock` floor for v4 log discovery.

## 2b. Funding the Arc wallet (CCTP) + what Circle's App Kits are good for

Arc has no faucet path for mainnet and the wallet needs native USDC before anything else
works. Circle's **App Kits** (`@circle-fin/app-kit` and the individual kits on npm) cover
that:

- **Bridge Kit** (`@circle-fin/bridge-kit`) — CCTP v2 USDC from Ethereum/Base/etc. into Arc
  (domain 26, 1 confirmation, fast path). This is the funding and the drain-back path, and
  its chain registry doubles as the address source of truth above.
- **Swap Kit** (`@circle-fin/swap-kit`) — routes **registered** tokens only (USDC, USDT,
  EURC and other listed tokens) through Circle's stablecoin swap service, and needs a Circle
  API key. It is **not** a KyberSwap substitute: the LP flow has to buy arbitrary
  memecoin-tier ERC-20s, which this will not route. Useful for USDC↔EURC FX if we ever open
  EURC-quoted pools, nothing more.
- **`@circle-fin/adapter-ethers-v6`** exists, so if we do adopt a kit it drops into this
  bot's ethers v6 wallet without a viem migration.

Verdict for the plan: adopt Bridge Kit **optionally**, as a `/fund` and `/drain` convenience
later (P6). The token-acquisition leg for LP stays Kyber-or-Uniswap as in §6 — App Kits do
not change it.

## 3. P0 — probe script (read-only, run on the VPS)

`scripts/probe-chain.ts` — no keys spent, prints a go/no-go report:

- `eth_chainId == 5042`, block time sample, `getFeeData()` (cross-check every chain-level
  value against `@circle-fin/bridge-kit`'s Arc definition rather than a web page)
- `getCode()` non-empty for every address in §2
- USDC predeploy: `decimals()==6`, and the parity assertion
  **`balanceOf(me) * 1e12 == getBalance(me)`** — proves native and ERC-20 are one balance
  (if false, a wrap/convert step is needed and §6 sizing changes)
- v3 `factory.getPool(USDC, X, fee)` and v4 `PoolManager` Initialize-log scan → do pools
  exist yet, at which fee tiers
- quoter round-trip (buy→sell sim) on a live pool — the honeypot test primitive
- `GET {kyber}/arc/api/v1/routes` → is the aggregator live on Arc
- `GET api.dexscreener.com/latest/dex/tokens/{USDC}` → does it return `chainId: "arc"` pairs
- `explorer.arc.io` API shape → Blockscout-compatible or not

Output feeds `chains/arc.json` and the capability flags in §4.

## 4. P1 — chain profiles + data isolation (no behaviour change on Robinhood)

New `src/chain/profile.ts` (zod) + `chains/robinhood.json`, `chains/arc.json`:

```jsonc
{
  "key": "arc", "name": "Arc", "chainId": 5042,
  "rpcUrl": "https://rpc.mainnet.arc.io",
  "explorer": { "url": "https://explorer.arc.io", "api": "https://explorer.arc.io", "kind": "blockscout|none" },
  "sequencer": null,
  "native": { "symbol": "USDC", "decimals": 18, "stable": true, "wrapped": null, "gasReserve": 2.0 },
  "quotes": [{ "kind": "erc20", "address": "0x3600…0000", "symbol": "USDC", "decimals": 6, "class": "usd" }],
  "contracts": { "...": "§2" },
  "gas": { "mode": "eip1559", "priorityGwei": 5, "multiplier": 1.5 },
  "venues": { "v2": true, "v3": true, "v4": true, "v4NativeCurrency": false },
  "data": { "dexscreener": "arc", "kyberChain": null, "gmgn": false, "volumeSource": "onchain" },
  "discovery": { "v4FromBlock": 0 }
}
```

- `RH_CHAIN=arc` selects the profile; unset = `robinhood`, so **the live bot keeps its
  current config.json, its `data/` dir and its behaviour bit-for-bit**.
- `config.json` keeps strategy tunables only; per-chain overrides in `config.arc.json`.
- `DATA_DIR` becomes `data/<chainKey>/` for non-default chains → positions, ledger,
  autolp-state, feed-seen, lock file are isolated. (v3/v4 tokenIds collide across chains;
  this is the cheap fix.) New records also carry `chain`/`chainId` for a future merge.
- Second process: `.env.arc` with its own `RH_TG_TOKEN`, same `RH_WALLET_KEY`, same owner
  chat. The per-chain lock file lets both run side by side.
- Gate: `npm run typecheck` + Robinhood bot runs a full open/close cycle unchanged.

## 5. P2 — currency + quote abstraction (the core refactor)

- `src/chain/currency.ts`: `nat()` (symbol/decimals/stable), `fmtNat`/`parseNat`,
  `natSym()`, and `nativeUsd()` — returns `ethUsd()` on Robinhood, **1.0 on Arc**.
  Replaces the 51 `ethUsd()` call sites mechanically.
- Native amounts stay 18-dec on both chains, so the ~70 `formatEther/parseEther` sites are
  semantically fine; they get renamed to `fmtNat/parseNat` for clarity, not re-mathed.
  **Only the ERC-20 (6-dec) side needs real care** — it already goes through
  `formatUnits(x, 6)` in the USDG path.
- Ledger/position field names (`depEth`, `valEth`, `pnlEth`) keep their names but mean
  "native units"; entries gain `nat: "ETH" | "USDC"`. No migration of existing files.
- Generalise the USDG path into a **quote asset** concept: `USDG` const → `stable()` from
  the profile, `findUsdgPools` → `findStablePools`, and `openV3Usdg*` / `openV4Usdg*` /
  `usdgPositionRow` / `closeV3UsdgPosition` take the quote asset from the profile. Robinhood
  passes USDG (unchanged behaviour), Arc passes USDC.
- Wrapped-native guards: when `native.wrapped === null`, `ensureNativeEth`, WETH balance
  reads, the v4 unwrap pre-step and the WETH-paired `findPools` are skipped, and
  `balances()` reports native only.
- Funding flow on Arc (assuming the §3 parity assertion holds): **no wrap, no ETH→stable
  swap** — the wallet's balance *is* USDC, so an in-range mint only needs the
  stable→token leg for the token side.

## 6. P3 — Arc venue adapters

- **Sizing / gas reserve.** Sizing is `min(requested, balance − gasReserve)`; the reserve is
  a floor, never a ceiling — no daily/per-position cap is imposed. `maxOpen`, `maxPerHour`
  and `dailyCapEth` gain **`0 = unlimited`** semantics (today they are hard `>=` checks with
  no escape) and ship as `0` in the Arc profile, so what you deposit is the only limit.
- **Swap router**: `router: "kyber" | "uniswap"` per profile. If the §3 probe shows Kyber
  has no Arc route API, Arc uses the existing UniversalRouter/v4-quoter and v3
  SwapRouter02 paths; `swapWethToTokenBest`'s per-fee-tier fallback is generalised to
  `swapQuoteToTokenBest(quote, …)`.
- **Gas policy** from the profile (EIP-1559, constant 20 gwei base + 5 gwei priority,
  1.5× buffer) instead of the Robinhood-tuned `gasPrice * 3`.
- **Fast-submit off** on Arc (`sequencer: null` → plain `JsonRpcProvider`); `pollingInterval`
  ~250ms to match 500ms blocks; `waitTx` cap unchanged.
- **v4 on Arc**: same PoolManager address, different PositionManager; Permit2 canonical, so
  the existing approve→permit2→modifyLiquidities flow carries over with
  `v4NativeCurrency: false` (ERC-20 USDC on both sides of the pool key).

## 7. P4 — data layer without Blockscout/GMGN/DexScreener guarantees

- `src/chain/indexer.ts` interface with two impls: `blockscout` (today's) and `rpc`
  (bounded `getLogs` against the archival endpoint) for lifetime PnL, wallet holdings,
  ledger backfill and mint timestamps. Profile picks one; features degrade, never crash.
- `src/chain/volume.ts`: on-chain 1h/24h pool volume from Swap/v4 events, used when
  `volumeSource: "onchain"`. This also replaces DexScreener's `volH1`/`vol24h` inputs to the
  spike/fade/fee-yield gates, so hunt and the fee-velocity exit keep working on Arc.
- Honeypot sim: unchanged logic, Arc quoter address from the profile.
- The `p.chainId !== "robinhood"` filter in `watch/scanner.ts` becomes the profile slug.

## 8. P5 — hunt + auto-LP on Arc

GMGN is the current candidate source and won't cover Arc, so Arc's hunt gets its own
sources behind `scan.sources`:

- **on-chain new pools** — v4 `Initialize` + v3 `PoolCreated` logs (the existing
  `v4/discover.ts` generalises; `feed/listener.ts` is Robinhood-sequencer-WS specific and is
  replaced on Arc by `eth_subscribe`/polled `getLogs`);
- **volume spike** over discovered pools using §7's on-chain volume;
- **DexScreener trending for `arc`** if the probe shows coverage.

Screening keeps the same shape (fee band, fee-yield, anti-wash, spike) minus the GMGN-only
gates (tax %, holder stats), with `requireGmgn: false` forced on Arc and the LLM verdict
still available. Auto-open/auto-manage (TP/SL, OOR close/rebalance, vol-fade, fee-velocity)
are chain-agnostic once P2 lands — they run per process against that chain's state.

## 9. P6 — UX + docs

`profile.name` and `natSym()` replace hardcoded "Robinhood Chain" / "ETH" / "Ξ" in
handlers, menus, cards, briefing prompt; amount prompts read "Input USDC" on Arc; README +
ROADMAP get an Arc section and the two-process run instructions.

## 10. Risks

1. **Decimal confusion (18 native vs 6 ERC-20)** — the chain's own documented top
   integration risk. Mitigated by using the ERC-20 everywhere a pool currency appears, the
   §3 parity assertion, and never passing the `0x0` native sentinel on Arc.
2. **Unverified addresses** — four are truncated/unknown in public sources; P0 gates P3.
3. **Day-one liquidity** — Arc mainnet opened 2026-09-16. High-fee 3-5% pools may not exist
   yet; hunt may legitimately find nothing for a while. Not a bug.
4. **Kyber / DexScreener / GMGN gaps** — each is behind a capability flag with an on-chain
   fallback, so a missing third party degrades one signal instead of breaking the bot.
5. **Gas and capital are one balance** — the reserve (§6) is what keeps a position closable.
6. **Two processes, one wallet** — both sign with the same key on different chains. Nonces
   are per-chain so they cannot collide, but the `txlock` is per-process; nothing shared.

## 11. Order of work

P0 probe → P1 profiles/isolation (Robinhood regression gate) → P2 currency/quote →
P3 Arc venues → first manual mint + close round-trip on Arc → P4 data layer →
P5 hunt/auto → P6 polish.
