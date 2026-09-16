# Robinhood LP Bot — Peta Lengkap & Roadmap

> Multi-chain sejak stage Arc: **Robinhood Chain** (default) + **Arc** (Circle L1, chainId 5042).
> `RH_CHAIN` milih profil chain-nya. Dikosongin = Robinhood, kelakuan bit-for-bit kayak dulu.

Bot LP Uniswap **v3 + v4** di Robinhood Chain (EVM, chainId 4663), dikendalikan lewat
Telegram. Deteksi token real-time dari sequencer feed, screening LLM+GMGN, dan (opsional)
buka posisi otomatis. TypeScript, ethers v6, `@uniswap/v3-sdk` + `@uniswap/v4-sdk`.

---

## 1. Arsitektur

```
src/
├── index.ts              entrypoint: validasi secret, lock, graceful shutdown
├── config.ts             load+validasi config.json (zod) + secret dari .env
├── types.ts              tipe domain bersama
│
├── chain/                — semua urusan blockchain —
│   ├── profile.ts        ⭐ PROFIL CHAIN (zod) — baca chains/<key>.json, dipilih RH_CHAIN.
│   │                       Isinya: chainId, RPC, explorer+kind, sequencer, native (symbol/
│   │                       decimals/stable/wrapped/gasReserve), quotes, contracts, gas policy,
│   │                       venues, flag data (dexscreener/kyberChain/gmgn/volumeSource/router)
│   ├── currency.ts       ⭐ native vs quote asset — natSym/fmtNat/parseNat, nativeUsd (=1 kalau
│   │                       native-nya stable), gasReserveWei/budgetForOpen (LANTAI gas),
│   │                       hasWrapped, stableAddr/stableSym, natWeiToStableRaw (rescale 1e12)
│   ├── router.ts         ⭐ pilih venue swap per profil: kyber | v3 | v4. quoteBest = best-of,
│   │                       swapBest = first-wins urutan profil (Kyber gagal → fallback Uniswap)
│   ├── indexer.ts        ⭐ abstraksi indexer: blockscout REST | getLogs RPC berbatas.
│   │                       null = "chain ini nggak bisa jawab", [] = "emang kosong" — beda
│   ├── volume.ts         ⭐ volume pool 1h/24h/5m: DexScreener atau Swap event on-chain
│   ├── client.ts         provider (Alchemy read + SequencerRoutingProvider fast-submit), wallet,
│   │                       pollingInterval + gas overrides dari profil (eip1559 | legacy)
│   ├── sequencer.ts      broadcast eth_sendRawTransaction langsung ke sequencer (Ohio);
│   │                       sequencerEnabled() false kalau profil-nya "sequencer": null
│   ├── abis.ts           ABI v3 minimal
│   ├── tokens.ts         metadata token + builder SDK Token
│   ├── pools.ts          findPools (v3), findStableQuotePools, poolState, range math, pickLpPool
│   ├── positions.ts      open/list/close v3 (single-side + in-range) + path token/stable
│   ├── swaps.ts          quote + swap v3 (slippage-protected) + swapTokenToQuote ber-quote,
│   │                       ensureNativeEth (top-up gas; no-op kalau nggak ada wrapped native)
│   ├── holdings.ts       saldo + jual-semua-token
│   ├── ledger.ts         ledger permanen + rebuild on-chain (bounded)
│   ├── analytics.ts      PnL seumur hidup (cached 2m, paralel) + capKnown/partial
│   ├── price.ts          ETH/USD multi-source
│   ├── blockscout.ts     helper REST Blockscout
│   └── v4/               — Uniswap v4 —
│       ├── poolkey.ts    PoolKey, poolId (keccak abi.encode), tickSpacing=fee/50
│       ├── abis.ts       StateView, V4Quoter, v4 PositionManager
│       ├── discover.ts   discoverV4Pools (native) + discoverV4StablePools, pickV4Pool
│       ├── swap.ts       swap via UniversalRouter (V4_SWAP) — native↔token DAN ERC-20↔ERC-20
│       ├── mint.ts       openV4SingleSide + openV4InRange + openV4Stable* (swap→Permit2→mint)
│       ├── close.ts      closeV4Position (removeCallParameters + burn)
│       └── list.ts       listV4Positions (baca v4-positions.json + on-chain)
│
├── radar/                — layer konfirmasi kandidat —
│   ├── openrouter.ts     skoring LLM via OpenRouter
│   ├── gmgn.ts           enrichment via gmgn-cli (chain robinhood)
│   ├── radar.ts          orchestrator: on-chain + GMGN → verdict (+ gmgnStatus & unchecked[])
│   ├── screen.ts         /screen (GMGN) + screenOnchainCandidates (skor mentok 70 tanpa GMGN)
│   ├── scanLoop.ts       hunter — source per chain: gmgn-trending | onchain-new | volume-spike
│   ├── automanage.ts     auto-close TP/SL/OOR/VFADE + rebalance + compound
│   ├── oorcool.ts        OOR cooldown
│   └── autolp.ts         AUTO-LP: candidate → verdict → gate berlapis → open otomatis
│                           (maxOpen/maxPerHour/dailyCapEth: 0 = TANPA BATAS; gas reserve = lantai)
│
├── feed/                 — monitor sequencer real-time (Nitro) —
│   ├── decode.ts         frame Nitro → signed tx
│   ├── listener.ts       WS reconnect + IP-pin (bypass DNS hijack)
│   ├── swapdecode.ts     extract swap Uniswap dari tx
│   ├── lpdecode.ts       extract mint/pool-baru dari tx (v3)
│   └── monitor.ts        new-token detector + position out-of-range monitor
│
├── telegram/
│   ├── tg.ts             transport + AUTH boundary (owner-only)
│   ├── bot.ts            long-poll loop + routing
│   ├── handlers.ts       semua command/tombol
│   ├── pipeline.ts       candidate → score → notify → auto-LP
│   ├── notify.ts         notif spike / token baru / out-of-range / auto-LP
│   ├── watchLoop.ts      timer scanner volume
│   ├── feedLoop.ts       lifecycle feed monitor
│   ├── briefing.ts       briefing harian 07:00 WIB (prompt LLM nyebut chain dari profil)
│   ├── card.ts           kartu profit PNG (tagline bawa nama chain)
│   ├── calendar.ts       profit calendar bulanan (PNG)
│   ├── menu.ts           reply keyboard bawah (menu tetap)
│   └── format.ts         escape, padding, emoji per-token + ⭐ label chain/currency:
│                           CHAIN_NAME · NAT_SYM · NAT_TAG (Ξ / " USDC") · STABLE_SYM ·
│                           WRAP_SYM · ROUTER_LABEL · NAT_IS_USD
│
├── scripts/probe-arc.ts  ⭐ preflight Arc READ-ONLY (npm run probe:arc) — nggak pernah kirim tx
├── watch/scanner.ts      scan volume (DexScreener atau on-chain) + uji honeypot (v3 Quoter)
└── util/                 log, atomic file write + lock, formatter
                            + ⭐ CHAIN_KEY / DEFAULT_CHAIN / DATA_DIR per chain
```

Di luar `src/`:

```
chains/robinhood.json     ⭐ profil chain default (nilainya = config.json lama, jangan diubah)
chains/arc.json           ⭐ profil chain Arc + flag kemampuan (default konservatif)
config.json               tunable strategi (chain-agnostic)
config.arc.json           ⭐ opsional — nimpa config.json CUMA buat proses Arc
.env / .env.arc           ⭐ secret per proses (.env.arc bawa RH_CHAIN=arc + token bot kedua)
data/ · data/arc/         ⭐ state runtime terisolasi per chain (positions, ledger, lock)
docs/ARC-CHAIN-PLAN.md    ⭐ rencana + status implementasi Arc
```

⭐ = ditambahin/diubah buat dukungan multi-chain (Arc).

---

## 2. Instalasi

### Prasyarat
- Node.js **20+**
- Wallet EVM (burner) berisi ETH di Robinhood Chain (dan/atau USDC di Arc — lihat §2b)
- Bot Telegram (dari [@BotFather](https://t.me/BotFather)) + chat id kamu (dari [@userinfobot](https://t.me/userinfobot))
  — **satu bot per chain**, token-nya nggak boleh dipake barengan

### Lokal (dev)
```bash
npm install
cp .env.example .env    # isi secret (lihat §3)
npm run typecheck       # cek tipe
npm start               # jalanin
```
Buka bot di Telegram → `/start`.

### VPS (produksi 24/7) — disaranin us-east-2 (Ohio, sekota sequencer)
```bash
# di server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2
# transfer repo, lalu:
cd ~/Robinhood-LP-Bot && npm install
nano .env               # isi secret
pm2 start ecosystem.config.cjs && pm2 save
sudo env PATH=$PATH pm2 startup systemd -u $USER --hp $HOME   # auto-boot on reboot
pm2 logs robinhood-lp
```

### 2b. Chain kedua: Arc (proses terpisah)

Arc = L1 EVM-nya Circle, chainId **5042**, gas dibayar pakai **USDC**. Jalan sebagai proses
kedua; bot Robinhood nggak kesentuh sama sekali.

```bash
# 1. probe dulu — READ-ONLY, nggak ada tx yang dikirim
RH_CHAIN=arc npm run probe:arc          # laporan → data/arc/arc-probe.json

# 2. flip flag di chains/arc.json sesuai hasil probe:
#      DexScreener index Arc?  → data.volumeSource: "dexscreener"
#      Kyber route Arc?        → data.kyberChain: "arc"  DAN  data.router: "kyber"
#      explorer Blockscout?    → explorer.kind: "blockscout"   (nyalain /pnl arus wallet)
#      blok Initialize v4 awal → discovery.v4FromBlock

# 3. env proses kedua
cp .env.arc.example .env.arc            # RH_CHAIN=arc + TOKEN BOT BARU + key & chat yang sama

# 4. jalanin di samping bot Robinhood
node --env-file=.env.arc --import tsx src/index.ts
# pm2:
pm2 start node --name arc-lp -- --env-file=.env.arc --import tsx src/index.ts && pm2 save
```

Isi wallet: **CCTP v2** (domain Arc **26**, TokenMessenger
`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, fast path 1 konfirmasi). Bot nggak ikut bridge —
sengaja, dia cuma boleh nandatangan tx LP.

> ⚠️ **Di Arc, gas dan modal LP itu saldo yang SAMA.** `chains/arc.json` nahan
> `native.gasReserve = 2.0` USDC. Itu **lantai**, bukan batas ukuran posisi — tanpa itu bot bisa
> buka posisi yang nggak kebeli gas buat nutupnya. Cap `maxOpen`/`maxPerHour`/`dailyCapEth`
> sengaja `0` (tanpa batas) di Arc: yang jadi batas cuma deposit lu.

### GMGN (opsional, buat radar enrichment)
```bash
sudo npm install -g gmgn-cli
gmgn-cli config                 # generate keypair + kasih URL
# buka URL → bikin API key buat public key yg ditampilin, lalu:
gmgn-cli config --apply <API_KEY>
```
> ⚠️ API key GMGN ke-bind ke keypair **per-mesin**. Key dari mesin lain nggak cocok.

---

## 3. Konfigurasi & Secret

### `.env` (RAHASIA — di-gitignore, jangan commit)
| Var | Wajib | Isi |
|---|---|---|
| `RH_CHAIN` | — | **Milih chain.** Kosong = `robinhood` (default, kelakuan lama). `arc` = load `chains/arc.json` + `data/arc/` |
| `RH_WALLET_KEY` | ✅ | Private key wallet burner (0x + 64 hex) |
| `RH_TG_TOKEN` | ✅ | Token bot dari @BotFather |
| `RH_TG_CHAT` | ✅ | Chat id owner — **gerbang keamanan**, cuma chat ini yg bisa nyuruh bot |
| `RH_RPC_URL` | — | RPC Alchemy (kosong = public RPC) |
| `RH_WATCH_RPC_URL` | — | RPC kedua khusus scanner |
| `RH_FAST_SUBMIT` | — | `1` = broadcast langsung ke sequencer Ohio |
| `RH_SEQUENCER_IP` | — | IP-pin sequencer (kalau DNS di-hijack lokal) |
| `RH_FEED_IP` | — | IP-pin feed (Telkomsel dll) — `172.66.147.70` |
| `RH_OPENROUTER_KEY` | — | Key OpenRouter buat radar LLM |
| `RH_OPENROUTER_MODEL` | — | Model (default `openai/gpt-oss-20b:free`) |
| `ARC_RPC_URL` | — | RPC Arc (cuma kebaca kalau `RH_CHAIN=arc`; default profil `rpc.mainnet.arc.io`) |
| `ARC_WATCH_RPC_URL` | — | RPC kedua khusus scanner, di Arc |
| `ARC_LOGS_RPC_URL` | — | RPC archival buat getLogs jauh ke belakang (`explorer.arc.io/api/eth-rpc`) |

> ⚠️ Di chain non-default, `RH_RPC_URL`/`RH_WATCH_RPC_URL` **sengaja diabaikan** (dengan warning). Itu RPC Robinhood — provider dibikin dengan static network, jadi ethers nggak bakal nangkep proses Arc yang nunjuk ke node chainId 4663.

**Secret yang DIJAMIN di-gitignore:** `.env`, **`.env.arc`**, `*.pem` (SSH key), `*.key`,
keypair GMGN (`~/.config/gmgn/`, di luar repo), `data/` + `data/arc/` (posisi + PnL history).
Key GMGN & OpenRouter & private key **tidak pernah** masuk repo.

### `chains/<key>.json` (aman di-commit — FAKTA CHAIN, bukan strategi)
`chainId`, `rpcUrl`, `explorer` (+`kind`), `sequencer`, `native` (symbol/decimals/stable/
wrapped/**gasReserve**), `quotes`, `contracts` (v2+v3+v4+Permit2/UniversalRouter/CCTP),
`gas` policy, `venues`, `data` (dexscreener/kyberChain/gmgn/volumeSource/router), `discovery`.
Dipilih `RH_CHAIN`. **`chains/robinhood.json` nilainya sama persis kayak `config.json` lama** —
jangan diubah tanpa alasan, bot itu lagi jalan dengan posisi kebuka.

### `config.json` (aman di-commit — tunable, bukan secret)
`lp` (width, slippage, minFeePpm, feeTiers), `watch`, `feed`, `radar`, `autoLp`, `scan`.
**Strategi doang** — fakta chain-nya pindah ke `chains/`. Diubah lewat `/set` di Telegram.
`config.<chainKey>.json` (mis. `config.arc.json`) nimpa file ini cuma buat proses chain itu.

---

## 4. Fitur & Command

| Command | Fungsi |
|---|---|
| paste `0x…` | Cari pool **v3+v4** → pilih → LP |
| `/list` | Posisi terbuka v3+v4 + PnL + close |
| `/ledger` | Riwayat LP ditutup (realized) |
| `/pnl` | PnL seumur hidup (cached) |
| `/watch` `/scan` | Scanner volume + honeypot |
| `/feed on` | Monitor sequencer real-time (token baru + out-of-range) |
| `/auto on` | Auto-LP (radar → buka otomatis, guardrail ketat) |
| `/v4 <ca>` | Cek pool v4 fee-tinggi sebuah token |
| `/v4lp <ca> <eth>` `/v4close <id>` | LP v4 manual |
| `/closeall` `/sell` `/wallet` `/settings` `/set` | Aksi & setting |

Menu cepat ada di **reply keyboard bawah** (tap, nggak perlu ketik).

**Layer keamanan/otomasi:** owner-only auth · slippage di semua swap · atomic file write ·
single-instance lock · graceful shutdown · fast-submit ke sequencer · honeypot sim on-chain ·
radar LLM+GMGN · auto-LP dengan cap (ukuran/jumlah/harian) + hard-filter.

---

## 5. Roadmap (status)

### ✅ Selesai
- Rebuild TS + Uniswap SDK, struktur modular, security hardening
- LP **v3** (single-side + in-range), /list, /ledger, /pnl, close, auto top-up gas
- **Feed monitor** real-time (token baru + out-of-range), IP-pin bypass DNS hijack
- **Radar** LLM (OpenRouter) + **GMGN** enrichment
- **Auto-LP** dengan guardrail berlapis (default OFF)
- **Fast-submit** ke sequencer Ohio
- **v4**: discovery, mint single-side + in-range (farming), close, /list, unified pick v3+v4
- Menu bawah, /pnl cache, deploy VPS + pm2
- **Multi-chain (Arc)** — profil chain + isolasi data, layer currency/quote, router swap
  per-chain, layer indexer+volume dengan fallback, hunt/auto tanpa GMGN, UX + docs.
  Detail & status per fase: [`docs/ARC-CHAIN-PLAN.md`](docs/ARC-CHAIN-PLAN.md).

### ⏳ In progress / Next
- **Probe Arc di VPS** (`RH_CHAIN=arc npm run probe:arc`) → flip flag di `chains/arc.json`
  (dexscreener / kyberChain+router / explorer.kind / v4FromBlock). **Belum pernah dijalanin
  ke node beneran** — sandbox-nya diblok proxy.
- **Round-trip pertama di Arc**: satu `swapV4Single` ERC-20↔ERC-20 kecil + satu mint/close
  manual, SEBELUM `/auto on`. Leg Permit2-settle-nya belum pernah nyentuh node.
- **`config.arc.json`** — `autoLp.sizeEth` ukuran USDC beneran + `maxOpen`/`maxPerHour`/
  `dailyCapEth` = 0. Tanpa itu, default-nya kekecilan buat kebuka sama sekali di Arc.
- **v4 auto-scan** — watch scanner deteksi spike pool v4 otomatis (safetyCheck fallback ke V4Quoter)
- **Tes in-range v4 real** end-to-end (komponen sudah verified via staticCall)

### 📋 Backlog
- v4 di ledger/PnL (fee tracking presisi v4)
- Multi-wallet
- Impermanent loss display
- Test suite
- `/swap` manual di chain tanpa Kyber (perlu `walletTokens()` lewat router internal)
- VFADE buat posisi v3 (butuh `PositionRow` bawa alamat pool)
- `/fund` + `/drain` lewat CCTP Bridge Kit (opsional, lihat plan §2b)

---

## 6. Catatan operasional
- **Fee tier**: v3 mentok 1%; farming fee-tinggi (3-25%) ada di **v4** (pair native ETH di
  Robinhood, pair USDC ERC-20 di Arc).
- **Wallet**: pakai burner. Kalau share sama bot lain yang jalan bareng **di chain yang sama** →
  risiko nonce-conflict. Robinhood + Arc pakai key yang sama itu aman: nonce kepisah per chain.
- **Dua proses**: token Telegram-nya WAJIB beda (satu token = satu poller, `409 Conflict`).
  Lock file per chain (`data/bot.lock` vs `data/arc/bot.lock`) emang dibikin biar boleh bareng.
- **`/pnl`**: berat kalau wallet punya banyak history tx (di-cache 2 menit). Di chain tanpa
  indexer (`explorer.kind: "rpc"`), baris arus wallet nulis `n/a` — bukan 0.
- **Arc: gas = modal LP.** `native.gasReserve` (2.0 USDC) itu LANTAI, bukan cap. Diturunin ke 0 =
  bisa buka posisi yang nggak kebeli gas buat nutupnya.
- **Arc tanpa GMGN**: gate honeypot/tax/holder **nggak dievaluasi**. Skor kandidat mentok 70 dan
  tiap alert bawa `⚠️ belum dicek: …`. Unknown ≠ lulus.
- **DNS hijack**: sebagian ISP (Telkomsel) hijack domain feed/sequencer — pakai `RH_FEED_IP`/`RH_SEQUENCER_IP`. Di VPS US nggak perlu. Nggak relevan di Arc (nggak ada sequencer).

MIT. Pakai risiko sendiri — ini bot degen, bukan nasihat finansial.
