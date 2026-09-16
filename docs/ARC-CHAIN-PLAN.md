# Arc chain support — implementation plan

Goal: run the same LP bot on **Arc** (Circle's stablecoin chain) with full feature parity —
manual LP, hunt, auto-open, auto-manage, ledger, cards — without disturbing the live
Robinhood Chain bot.

---

## STATUS — what is built, what is not

| phase | status | notes |
|---|---|---|
| **P0** probe script | ✅ written, ❌ **never run against a live node** | `src/scripts/probe-arc.ts` · `npm run probe:arc`. The sandbox it was written in has no egress to either RPC (proxy 403), so **every "unverified" below is still unverified.** |
| **P1** chain profiles + data isolation | ✅ done | `src/chain/profile.ts`, `chains/{robinhood,arc}.json`, per-chain `DATA_DIR`, `.env.arc.example` |
| **P2** currency + quote abstraction | ✅ done | `src/chain/currency.ts`; the USDG path is generalised to a profile "stable quote" |
| **P3** Arc venue adapters | ✅ done | `src/chain/router.ts` + v4 ERC-20↔ERC-20 swap; gas policy, poll cadence, fast-submit all profile-driven |
| **P4** indexer/volume without third parties | ✅ done | `src/chain/indexer.ts`, `src/chain/volume.ts`; every feature degrades, none crash |
| **P5** hunt + auto-LP on Arc | ✅ done | on-chain candidate sources, GMGN-free screening, `0 = unlimited` caps |
| **P6** UX + docs | ✅ done | chain name + native symbol everywhere, Arc sections in both READMEs |
| **first live round-trip on Arc** | ❌ **not done** | see [§12](#12-what-is-still-open) — this is the gate before `/auto on` |

**Read §12 before pointing real money at Arc.** The code path is complete; the chain has not
been touched.

---

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
| aggregator | KyberSwap (`robinhood`) | Kyber Arc support **still unverified** → shipped `kyberChain: null`, `router: "uniswap"` |
| screener | DexScreener `robinhood`, GMGN `robinhood` | DexScreener slug **still unverified** → shipped `volumeSource: "onchain"`. GMGN: shipped `gmgn: false` |

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

The **Uniswap** addresses below are now resolved in full, read out of
`@uniswap/sdk-core` 7.19.2's `ARC_ADDRESSES` and `@uniswap/universal-router-sdk` 5.11.5 —
**not** from a doc page. Cross-check that held: the same maps reproduce this repo's existing
Robinhood addresses exactly, which is how they were validated. They still **must be
code-checked by the probe (§3) before any money moves** — an SDK map can list an address
before it is deployed.

Note the repo does **not** depend on those SDK versions: `@uniswap/sdk-core` stays at `^5.9.0`
(no Arc entry, which is fine) and every Arc address is hardcoded in `chains/arc.json`.
`new Token(chainId, …)` already accepts an arbitrary chain id.

| contract | address | status |
|---|---|---|
| USDC ERC-20 predeploy | `0x3600000000000000000000000000000000000000` | **confirmed** (Circle SDK) — decimals 6 |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | **confirmed** (Circle SDK) |
| CCTP v2 TokenMessenger | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | **confirmed** (Circle SDK) |
| CCTP v2 MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | **confirmed** (Circle SDK) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical |
| Multicall3 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | **corrected** — Arc's is NOT the canonical `0xcA11bde…` this plan first assumed |
| v2 factory | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` | resolved (SDK) — verify with `getCode` |
| v3 factory | `0xf0db7b58379503491d857db50ac9ece64c653918` | resolved (SDK) — verify with `getCode` |
| v3 SwapRouter02 | `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` | **resolved** |
| v3 NonfungiblePositionManager | `0x39654a85a4c05127f5fd6ed22caec077a0fb1377` | **resolved** |
| v3 Quoter(V2) | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` | **resolved** |
| v3 TickLens | `0x9eb8600665b55d10c1eb2316ca5127a9ca6e2e76` | **resolved** (new — not in the first draft) |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | same address as Robinhood (CREATE2) |
| v4 PositionManager | `0x6049c9a0e26405c0985f9e3685c87d0ae917f82b` | resolved (SDK) |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | **resolved** |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | **resolved** |
| UniversalRouter | `0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1` | **resolved (V2_1_1, creationBlock 1950059)** — the first draft's `0x0A122717…` was wrong |

All of the above live in `chains/arc.json`. `creationBlock 1950059` is the source of
`discovery.v4FromBlock`, so v4 log discovery starts there instead of genesis.

Note: Circle's docs live at **docs.arc.network** (the SDK's own doc links point there), with
the contract reference at `/arc/references/contract-addresses` — that page and `arc.io` are
blocked by this session's egress policy, so nothing in this plan depends on them.

Resolution order (this is what was actually done): (a) read `ARC_ADDRESSES` out of a
side-installed `@uniswap/sdk-core` 7.19.2 + `@uniswap/universal-router-sdk` 5.11.5 — **done**,
and the same maps reproduced this repo's Robinhood addresses exactly, which validated them;
(b) explorer fallback — not needed; (c) confirm each with `eth_getCode` + one live call —
**still outstanding, that is the probe's job.** `discovery.v4FromBlock` is the UniversalRouter's
`creationBlock` (1950059), which is the floor for v4 log discovery.

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
later. The token-acquisition leg for LP stays Kyber-or-Uniswap as in §6 — App Kits do not
change it.

**Status: NOT built, and deliberately so.** No Circle package is a dependency of this repo.
Funding is a manual CCTP step the operator takes from their own machine, which keeps the bot's
signing surface limited to LP transactions. `/fund` and `/drain` stay backlog (§12).

## 3. P0 — probe script (read-only, run on the VPS) — ✅ WRITTEN, ❌ NOT YET RUN

`src/scripts/probe-arc.ts`, wired as `npm run probe:arc`. Run it as
`RH_CHAIN=arc npm run probe:arc` so the report lands in `data/arc/arc-probe.json` rather than
the Robinhood data dir. No keys spent — the private key is read only to derive an address, and
nothing is ever signed. Prints a go/no-go report:

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

Output feeds `chains/arc.json` and the capability flags in §4. Concretely:

| probe finding | flag to flip in `chains/arc.json` | effect |
|---|---|---|
| `dexscreenerArc: true` | `data.volumeSource` → `"dexscreener"` | volume from the indexer instead of Swap-event derivation |
| `kyberArc: true` | `data.kyberChain` → `"arc"` **and** `data.router` → `"kyber"` | venue order flips to `kyber → uniswap` with no code change. Setting only `kyberChain` leaves Kyber as a fallback *behind* Uniswap, which is also valid |
| Blockscout v1/v2 responds | `explorer.kind` → `"blockscout"` | unlocks `/pnl` capital flow, ledger backfill, holdings history, NFT mint timestamps |
| earliest v4 `Initialize` block | `discovery.v4FromBlock` | keeps getLogs off genesis |

**The probe has never reached a live node** — the environment it was written in cannot reach
`rpc.mainnet.arc.io` (proxy 403). Everything marked "unverified" in §1 is therefore still
unverified, and every flag above ships at its conservative default.

## 4. P1 — chain profiles + data isolation (no behaviour change on Robinhood) — ✅ DONE

`src/chain/profile.ts` (zod) + `chains/robinhood.json`, `chains/arc.json`. The shipped shape,
with the fields that were added beyond this first draft marked:

```jsonc
{
  "key": "arc", "name": "Arc", "chainId": 5042,
  "rpcUrl": "https://rpc.mainnet.arc.io",
  "blockTimeMs": 500,              // ADDED — real cadence, for block↔time maths in the log scanner
  "pollMs": 250,                   // ADDED — tx-receipt polling (~½ block). Robinhood pinned at 350
  //                                  so the live poll cadence is bit-for-bit what it was.
  "explorer": { "url": "https://explorer.arc.io", "api": "https://explorer.arc.io/api/eth-rpc",
                "kind": "rpc" },   // CORRECTED — the enum is "blockscout" | "rpc", never "none";
  //                                  "rpc" means "no indexer, fall back to bounded getLogs"
  "sequencer": null,
  "native": { "symbol": "USDC", "decimals": 18, "stable": true, "wrapped": null, "gasReserve": 2.0 },
  "quotes": [{ "kind": "erc20", "address": "0x3600…0000", "symbol": "USDC", "decimals": 6, "class": "usd" }],
  "contracts": { "...": "§2 — plus optional permit2 / multicall / tickLens / cctpTokenMessenger" },
  "gas": { "mode": "eip1559", "priorityGwei": 5, "multiplier": 1.5,
           "fixedGwei": 20 },      // ADDED — Arc's base fee is a CONSTANT, so this is exact,
  //                                  not a guess. 0 = no fallback (use the legacy gasPrice read).
  "venues": { "v2": true, "v3": true, "v4": true, "v4NativeCurrency": false },
  "data": { "dexscreener": "arc", "kyberChain": null, "gmgn": false,
            "volumeSource": "onchain",
            "router": "uniswap" }, // ADDED — which venue buys the token side (§6)
  "discovery": { "v4FromBlock": 1950059 }  // CORRECTED — UniversalRouter creationBlock, not 0
}
```

- `RH_CHAIN=arc` selects the profile; unset = `robinhood`, so **the live bot keeps its
  current config.json, its `data/` dir and its behaviour bit-for-bit**.
- `config.json` keeps strategy tunables only; per-chain overrides in `config.arc.json`.
- `DATA_DIR` becomes `data/<chainKey>/` for non-default chains → positions, ledger,
  autolp-state, feed-seen, lock file are isolated. (v3/v4 tokenIds collide across chains;
  this is the cheap fix.) New records carry `nat` + `chainId` (the plan said `chain`; the
  native SYMBOL turned out to be the useful field, since it is what the renderer needs).
  Nothing existing is migrated — an entry with no `nat` is by definition pre-multi-chain.
- Second process: `.env.arc` with its own `RH_TG_TOKEN`, same `RH_WALLET_KEY`, same owner
  chat. The per-chain lock file lets both run side by side.
- Gate: `npm run typecheck` + Robinhood bot runs a full open/close cycle unchanged.

Decided during implementation, beyond the plan:

- **RH_* RPC vars are ignored on non-default chains** (with a warning, not silently). Arc reads
  `ARC_RPC_URL` / `ARC_WATCH_RPC_URL` / `ARC_LOGS_RPC_URL`. The provider is built with a static
  network, so ethers would *not* catch an Arc process pointed at a chainId-4663 node.
- **`RH_CHAIN` is slug-restricted** (`[a-z0-9-]+`) — it names a directory under `data/`, so a
  path-traversal there would be a real one.
- **The profile asserts `profile.key === CHAIN_KEY`** on load. A copy-pasted `chains/arc.json`
  that still said `"robinhood"` would otherwise point the Arc process at Robinhood's
  PositionManager.
- **`C.weth` is the ZERO ADDRESS on Arc** so the type stays `string` and no module needed a
  signature change. Nothing may compare against it directly — `hasWrapped()` /
  `isWrappedNative()` are the real guards, because `0x0` is *also* the v4 native sentinel and a
  bare `addr === C.weth` comparison starts matching pool currencies there.

## 5. P2 — currency + quote abstraction (the core refactor) — ✅ DONE

- `src/chain/currency.ts`: `nat()` (symbol/decimals/stable), `fmtNat`/`parseNat`,
  `natSym()`, and `nativeUsd()` — returns `ethUsd()` on Robinhood, **1.0 on Arc**.
  Replaces the 51 `ethUsd()` call sites mechanically.
- Native amounts stay 18-dec on both chains, so the ~70 `formatEther/parseEther` sites are
  semantically fine; they get renamed to `fmtNat/parseNat` for clarity, not re-mathed.
  **Only the ERC-20 (6-dec) side needs real care** — it already goes through
  `formatUnits(x, 6)` in the USDG path.
- Ledger/position field names (`depEth`, `valEth`, `pnlEth`) keep their names but mean
  "native units"; entries gain `nat: "ETH" | "USDC"`. No migration of existing files.
- Generalise the USDG path into a **quote asset** concept. Shipped names (every old name is
  kept as an exported alias, so no caller outside the renamed module had to change):

  | old | new |
  |---|---|
  | `pools.USDG` | `pools.STABLE_QUOTE` |
  | `pools.findUsdgPools` | `pools.findStableQuotePools` |
  | `positions.openV3Usdg{InRange,SingleSide}` | `openV3Stable{InRange,SingleSide}` |
  | `positions.closeV3UsdgPosition` (private) | `closeV3StablePosition` (now exported) |
  | `positions.usdgPositionRow` (private) | `stableQuotePositionRow` |
  | `v4/discover.discoverV4UsdgPools` | `discoverV4StablePools` |
  | `v4/mint.openV4Usdg{InRange,SingleSide}` | `openV4Stable{InRange,SingleSide}` |
  | `v4/poolkey.ethPoolKey` | `nativePoolKey` (throws where `0x0` is forbidden) |

  Robinhood resolves the stable to USDG (unchanged behaviour), Arc to the USDC ERC-20.
- Wrapped-native guards: when `native.wrapped === null`, `ensureNativeEth`, WETH balance
  reads, the v4 unwrap pre-step and the WETH-paired `findPools` are skipped, and
  `balances()` reports native only.
- Funding flow on Arc (assuming the §3 parity assertion holds): **no wrap, no ETH→stable
  swap** — the wallet's balance *is* USDC, so an in-range mint only needs the
  stable→token leg for the token side.

One real bug was found while building this: `(0.015).toFixed(18)` is `"0.014999999999999999"`,
so the first `gasReserveWei()` came out a wei short. It now goes through a `decimalString()`
helper (shortest round-trip `String(n)`) — a float artefact leaking into on-chain money maths
is exactly the class of bug this module exists to stop.

## 6. P3 — Arc venue adapters — ✅ DONE

- **Sizing / gas reserve.** Sizing is `min(requested, balance − gasReserve)`; the reserve is
  a floor, never a ceiling — no daily/per-position cap is imposed. `maxOpen`, `maxPerHour`
  and `dailyCapEth` gain **`0 = unlimited`** semantics (today they are hard `>=` checks with
  no escape) and ship as `0` in the Arc profile, so what you deposit is the only limit.
- **Swap router**: `router: "kyber" | "uniswap"` per profile, implemented as
  `src/chain/router.ts` — `quoteBest()` (best-of across venues) and `swapBest()`
  (**first-wins in profile order**, not best-of; re-quoting every venue before each buy would
  double the latency of every open, and first-wins is what the live bot already does).
  `swapWethToTokenBest` is generalised to `swapQuoteToTokenBest(quote, …)`; `swapTokenToQuote`
  is the quote-parameterised sell. A Kyber failure — **including a security-gate rejection** —
  logs and falls through to Uniswap; routing suspicious aggregator calldata ourselves is the
  safe response, not aborting a half-finished open. All four Kyber gates are untouched.
- **`kyberEnabled()` is chain-gated**: it now requires `data.kyberChain !== null`, so a
  hand-set `KYBERSWAP_ROUTER_ADDRESS` cannot re-enable Kyber on a chain it has no route API
  for. Config also drops the router address to `""` there, so no calldata can be fired at
  another chain's router.
- **Two new money guards added, none removed**: a v3 swap now `staticCall`-simulates before it
  sends, and the "nothing quoted" case no longer falls through to a `fee 10000`,
  `amountOutMinimum: 0` swap (a free sandwich into a pool the Quoter had just called empty).
- **Gas policy** from the profile (EIP-1559, constant 20 gwei base + 5 gwei priority,
  1.5× buffer) instead of the Robinhood-tuned `gasPrice * 3`.
- **Fast-submit off** on Arc (`sequencer: null` → plain `JsonRpcProvider`); `pollingInterval`
  ~250ms to match 500ms blocks; `waitTx` cap unchanged.
- **v4 on Arc**: same PoolManager address, different PositionManager; Permit2 canonical, so
  the existing approve→permit2→modifyLiquidities flow carries over with
  `v4NativeCurrency: false` (ERC-20 USDC on both sides of the pool key). `v4/swap.ts` gained a
  direction-generic ERC-20↔ERC-20 path whose approvals target the **UniversalRouter**, not the
  PositionManager — approving the wrong one reverts inside `SETTLE_ALL` with a bare
  "execution reverted". Both ERC-20 mint paths now assert the SDK asked for `value === 0`
  before sending, so a native-value settle can never leak out of an all-ERC-20 mint.
- **Operator note — two one-off approvals appear on Arc**, both automatic and idempotent:
  token→Permit2 (`MaxUint256`, once per token ever) and Permit2→UniversalRouter (`uint160` max,
  30-day expiry, *read before written* and renewed only when short or expiring within the
  hour). Nothing needs a manual approval, but the wallet must hold the gas reserve **before**
  the first swap, since the approvals are themselves transactions.

## 7. P4 — data layer without Blockscout/GMGN/DexScreener guarantees — ✅ DONE

- `src/chain/indexer.ts` interface with two impls: `blockscout` (today's) and `rpc`
  (bounded `getLogs` against the archival endpoint) for lifetime PnL, wallet holdings,
  ledger backfill and mint timestamps. Profile picks one; features degrade, never crash.
  **The load-bearing contract: `null` means "this chain can't tell me", `[]` means "genuinely
  empty".** They are not interchangeable — a throttled REST call read as `[]` is how a funded
  wallet becomes "capital in = 0". `getLogsChunked` scans newest-window-first so a budget cut
  loses the oldest blocks, and adapts its chunk size when a node rejects a span.
- What degrades on Arc until `explorer.kind` flips: `/pnl` capital in/out (native transfers
  emit no log — the one thing `getLogs` genuinely cannot do, so `capKnown: false` and the rows
  print `n/a`, never a fabricated 0); "lifetime" becomes the `RH_INDEX_HOURS` window
  (`partial: true`); ledger backfill's *driver* (though its parser works); price-change / FDV
  read 0 on on-chain rows, which lands autolp on its base range width rather than a fabricated
  one.
- `src/chain/volume.ts`: on-chain 1h/24h pool volume from Swap/v4 events, used when
  `volumeSource: "onchain"`. This also replaces DexScreener's `volH1`/`vol24h` inputs to the
  spike/fade/fee-yield gates, so hunt and the fee-velocity exit keep working on Arc.
- Honeypot sim: unchanged logic, Arc quoter address from the profile.
- The `p.chainId !== "robinhood"` filter in `watch/scanner.ts` becomes the profile slug.

## 8. P5 — hunt + auto-LP on Arc — ✅ DONE

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

How "unknown" is represented, which is the part that matters:

- `gmgnAvailable()` returns false on `!CHAIN.data.gmgn` **without spawning the CLI**
  (`gmgn-cli config --check` only validates the local keypair, so it would have succeeded and
  let `--chain arc` return an empty row that reads as "no flags = safe").
- `Verdict` gained `gmgnStatus` (`ok | unsupported | unavailable | off`) and `unchecked: string[]`.
  The LLM payload's `gmgn` field is no longer the string `"unavailable"` but
  `{status, note: "…were NEVER CHECKED (unknown, not 0)"}`, and both radar prompts carry a
  `dataCaveat()` naming what is missing on this chain.
- `ScreenResult` gained `unchecked` and a `community: "unknown"` grade distinct from
  `thin`/`sus`. The on-chain path calls `onchainSanity()`, which awards **0 points for anything
  tax/honeypot-related**: max on-chain score is **70** vs 100 for a GMGN-screened row. The
  asymmetry is deliberate.
- Every surface says so out loud: the hunt alert's `flags[0]`, `radarLines()` in
  `telegram/notify.ts`, the AUTO-OPEN line, and `/hunt` status.

**Caps.** `maxOpen`, `maxPerHour` and `dailyCapEth` now take `0 = unlimited` (`capOff(n) = !(n > 0)`).
The per-token dedup ("1 token = 1 position") has **no** off switch — it is not a cap. The gas
reserve is enforced in both `maybeAutoLp` and `reopenRecentered`, in bigint, plus a hard
`natWei < gasReserveWei()` refusal.

## 9. P6 — UX + docs — ✅ DONE

`profile.name` and `natSym()` replace hardcoded "Robinhood Chain" / "ETH" / "Ξ" / "WETH" /
"USDG" in handlers, menus, cards and the briefing prompt; amount prompts read "Ketik jumlah
USDC" on Arc; both READMEs and ROADMAP get an Arc section and the two-process run instructions.

The display labels live in `src/telegram/format.ts` (`CHAIN_NAME`, `NAT_SYM`, `NAT_TAG`,
`STABLE_SYM`, `WRAP_SYM`, `ROUTER_LABEL`, `NAT_IS_USD`) rather than in `chain/currency.ts`,
because they are a rendering decision, not a money one: **"Ξ" means ether specifically**, so it
is used only when the native symbol is `ETH` and every other chain prints its symbol. That file
imports `chain/profile.ts` alone — no provider, no wallet.

The chain name appears in `/start`, `/list`, `/wallet`, `/pnl`, `/settings`, `/hunt`, the
briefing header, the profit-card tagline and the startup banner, so two bots in two chats can
never be mistaken for one another.

Also made chain-honest rather than merely re-labelled: `/feed` refuses on a chain with no
sequencer instead of enabling a monitor that can never start; `/screen` says GMGN does not cover
the chain instead of "GMGN nggak balikin data" (which reads as a transient outage); `/swap`
distinguishes "the aggregator has no route API here" from "the router address isn't configured";
`/pnl` prints `n/a` instead of `0.00000` where capital flow is unknowable; the `/auto` cap line
prints `∞` instead of a bare `0`.

## 10. Risks

1. **Decimal confusion (18 native vs 6 ERC-20)** — the chain's own documented top
   integration risk. Mitigated by using the ERC-20 everywhere a pool currency appears, the
   §3 parity assertion, and never passing the `0x0` native sentinel on Arc.
2. **Unverified addresses** — *resolved in full* from the Uniswap SDK maps (§2), but **none has
   been `getCode`-checked against the live chain**, because the probe has never run. An SDK map
   can list an address before it is deployed. P0 still gates the first transaction.
3. **Day-one liquidity** — Arc mainnet opened 2026-09-16. High-fee 3-5% pools may not exist
   yet; hunt may legitimately find nothing for a while. Not a bug.
4. **Kyber / DexScreener / GMGN / Blockscout gaps** — each is behind a capability flag with an
   on-chain fallback, so a missing third party degrades one signal instead of breaking the bot.
   All four ship at their conservative setting. The GMGN gap is the one that costs *safety*
   rather than convenience: the honeypot/tax/holder gates do not run, and the whole
   `unchecked` machinery in §8 exists so that never reads as a clean bill of health.
5. **Gas and capital are one balance** — the reserve (§6) is what keeps a position closable.
6. **Two processes, one wallet** — both sign with the same key on different chains. Nonces
   are per-chain so they cannot collide, but the `txlock` is per-process; nothing shared. The
   Telegram tokens, however, **must** differ: one token polled twice is a `409 Conflict` and
   commands can land on the wrong chain.
7. **The v4 ERC-20 Permit2-settle leg has never touched a node** (§12.2). It is the single
   least-exercised money path in the whole change.

## 11. Order of work

Planned: P0 probe → P1 profiles/isolation (Robinhood regression gate) → P2 currency/quote →
P3 Arc venues → first manual mint + close round-trip on Arc → P4 data layer →
P5 hunt/auto → P6 polish.

Actual: P1 → P2 → P3 → P4 → P5 → P6, with P0 **written but never executed** and the live
round-trip still pending. The code was built ahead of the chain because the probe's egress was
blocked, not because the round-trip stopped mattering — see §12.

---

## 12. What is still open

Ordered by what blocks what. Nothing below is a refactor; each is a decision or a live check.

**Before any real money moves on Arc**

1. **Run the probe.** `RH_CHAIN=arc npm run probe:arc` on the VPS, read
   `data/arc/arc-probe.json`, flip the flags per §3. The `native/ERC-20 parity` assertion is the
   one that can invalidate the design: if native ≠ ERC-20 × 1e12, the sizing model in §6 changes
   and nothing should be deployed until it is reworked.
2. **One small live `swapV4Single` (ERC-20 → ERC-20) on Arc.** The v4 encoding is the same
   `buildSwapCalldata` already proven on chain 4663 and changed only in direction-genericity —
   but **the Permit2-settle leg has never run against a node.** Do this before a mint.
3. **One manual mint + close round-trip**, then `/auto on` — not the other way round.
4. **Create `config.arc.json`.** It does not exist. Without it Arc inherits
   `autoLp.sizeEth = 0.001` (= $0.001) and `dailyCapEth = 0.01` (= $0.01), so **nothing can
   open at all**. It needs at minimum a real USDC size plus `maxOpen`/`maxPerHour`/`dailyCapEth`
   set to `0`. Also look at `watch.minLiqUsd` / `minVol5m` / `minVol1h`: the defaults
   (150k/300k) are Robinhood-sized and will filter out everything on a young chain, and v4
   on-chain liquidity reads 0 by construction.

**Known gaps in the shipped code**

5. **`.gitignore` will swallow `.env.arc.example`.** Line 3 is `.env.*` and only `!.env.example`
   is negated. It needs `!.env.arc.example` (or `!.env.*.example`) or the file is silently lost
   on commit. Flagged in every stage since P1; still not fixed.
6. **`src/config.ts` `ScanSchema` has no `sources` key**, so zod strips `cfg.scan.sources` from
   `config.json`. `scanSources()` reads it forward-compatibly and `RH_SCAN_SOURCES` works today,
   but the config-file path is dead until the schema gains
   `sources: z.array(z.enum([...])).optional()`.
7. **`positions.ts` `openV3StableInRange` still refuses unless `kyberEnabled()`**, which is false
   on Arc. `mode=single` works (`nativeIsStableQuote()` exempts it); `mode=inrange` on a v3
   stable pool will throw there until that gate moves to the stage-3 router.
8. **Manual `/swap` is unavailable on a chain without Kyber.** `holdings.walletTokens()` is
   gated on `kyberEnabled()`, so the token picker is empty on Arc. Routing it through
   `chain/router.ts` is the fix; it was out of scope for the UX stage. LP itself is unaffected.
9. **`automanage` VFADE stays v4-only** because `listPositions()` rows carry no pool address. On
   Arc, where v3/stable pools are likely common, volume-fade will not cover them until
   `PositionRow` gains one.
10. **`v4/swap.ts` still sends an unprotected swap when the v4 Quoter returns 0** (`minOut` 0).
    Pre-existing on the native path; now loudly `log.warn`ed. Making it a hard failure is a
    product decision (it would kill an open on every Quoter hiccup), not a refactor.

**Intentional behaviour changes on the LIVE Robinhood bot** (all strictly more conservative;
no guard was removed, no slippage widened)

11. The auto-LP funds preflight and the Telegram open/add flows now hold back
    `native.gasReserve` (0.015 ETH) instead of the old hardcoded `0.0004`. This can skip an
    open the old code would have taken when the native float sits between the two. It matches
    `cfg.lp.nativeTargetEth`, which is the level the bot tops native back up to on close.
12. A v3 swap now simulates before it sends; a "nothing quoted" sell is handed to the router
    instead of firing a floorless swap; `analytics` no longer counts ERC-721 rows in the stuck-
    token graveyard; the scanner no longer caches an empty token list for 30 minutes after a
    total fetch failure.
