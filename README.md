<div align="center">

# 🐷 Robinhood LP Bot v2

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![ethers](https://img.shields.io/badge/ethers-v6-2535A0?style=for-the-badge&logo=ethereum&logoColor=white)
![Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-MAINNET-00C805?style=for-the-badge)
![Arc](https://img.shields.io/badge/Arc-MAINNET-2775CA?style=for-the-badge)
<br>
![Uniswap](https://img.shields.io/badge/Uniswap-v2_·_v3_·_v4-FF007A?style=for-the-badge&logo=uniswap&logoColor=white)
![Kyber](https://img.shields.io/badge/Kyber-AGGREGATOR-31CB9E?style=for-the-badge)
![Control](https://img.shields.io/badge/Control-TELEGRAM-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-EAB308?style=for-the-badge)

**LP otomatis di Uniswap v2 · v3 · v4 (Robinhood Chain · Arc) — full kontrol dari Telegram.**

Paste CA → pilih pool → ketik jumlah (ETH di Robinhood, USDC di Arc) → posisi kebuka. Sekarang juga.

[![Bahasa Indonesia](https://img.shields.io/badge/Bahasa_Indonesia-D71920?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzIDIiPjxyZWN0IHdpZHRoPSIzIiBoZWlnaHQ9IjIiIGZpbGw9IiNmZmYiLz48cmVjdCB3aWR0aD0iMyIgaGVpZ2h0PSIxIiBmaWxsPSIjY2UxMTI2Ii8%2BPC9zdmc%2B&logoColor=white)](README.md) [![English](https://img.shields.io/badge/English-2b3137?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI%2BPGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg%2BPHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8%2BPHBhdGggZD0iTTAsMGw2MCwzMG0wLC0zMGwtNjAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8%2BPHBhdGggZD0iTTAsMGw2MCwzMG0wLC0zMGwtNjAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjYzgxMDJlIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzMG0tMzAsLTE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzMG0tMzAsLTE1aDYwIiBzdHJva2U9IiNjODEwMmUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==)](README.en.md)

</div>

---

## About

**Robinhood LP Bot v2** adalah bot liquidity-provider buat **Robinhood Chain** yang dijalanin sepenuhnya dari Telegram. Paste contract address → bot cariin pool paling likuid di **Uniswap v2 / v3 / v4** (termasuk pair **USDG**), beliin token lewat **KyberSwap aggregator** (rute terbaik lintas semua DEX/fee-tier, anti price-impact), terus buka posisi LP. Semua math tick/harga lewat **Uniswap SDK resmi** — nol drift presisi, nggak ada `Math.pow` hand-rolled.

Di atas LP-nya ada layer **deteksi + screening**:

- **Scanner volume on-chain** — nyari token yang volumenya lagi *nanjak* (bukan sekadar tinggi).
- **Feed sequencer Nitro real-time** — deteksi token baru sub-detik, sebelum ke-index DexScreener.
- **Uji honeypot mandiri** — simulasi beli→jual lewat Quoter, nggak percaya reputasi siapa pun.
- **Screening GMGN 24 jam** (`/screen`) — filter thesis: mcap > $500k, vol > $1M, no flap.fun, util > meme.
- **Skoring LLM** (OpenRouter/gateway) — verdict `🟢 APE / 🟡 WATCH / 🔴 SKIP` nempel di tiap notif kandidat.

…dan layer **otomasi farming** (baru):

- **Hunter kandidat** (`/hunt`) — tiap 3 menit scan GMGN trending → screening → cuma lolosin token yang punya **pool fee 3-5% yang rame**, di-rank by **fee-yield** (`vol × fee%`), dalam **band mcap** yang lu set (small-cap = share fee lebih gede buat modal kecil).
- **Auto-farming** (`/auto`) — auto-**add** kandidat yang lolos gate + auto-**close** by TP / SL / out-of-range. Mode `single` (parkir quote asset, rug-safe) atau `inrange` (both-sided, fee langsung) — bisa diganti live.
- **Reuse USDG + sweep balik ETH** — kalau udah ada USDG di wallet, gak swap ulang; tiap close proceeds otomatis di-sweep balik jadi ETH (wallet balik bersih, gas ke-top-up).
- **Kartu profit shareable** — tiap close auto-generate PNG flex (STRIX aesthetic).

Ditulis TypeScript modular, **owner-only auth**, slippage floor di semua swap, atomic ledger write, graceful shutdown, single-instance lock, **serialize tx satu-per-satu** (anti nonce-collision). Jalan di laptop atau VPS 24 jam.

---

## 📸 Kartu profit (auto tiap close)

Tiap posisi ditutup, bot langsung kirim kartu PNG siap-share ke Telegram. Ada juga kartu **portfolio** (`/card`) buat rekap semua, dan kartu **per-posisi** dari `/ledger`.

**Per-close — PROFIT**

![kartu profit](docs/cards/close-profit.png)

**Per-close — LOSS**

![kartu loss](docs/cards/close-loss.png)

**Portfolio — ALL-TIME** (`/card`)

![kartu portfolio](docs/cards/portfolio.png)

> Background bisa lu ganti: kirim foto ke bot (langsung di-set jadi bg kartu) atau taruh `assets/card-bg.jpg`. Brand default `0xRapzz` — ubah via `RH_CARD_BRAND`, tagline via `RH_CARD_TAG`. Font monospace (DejaVu Sans Mono) di-bundle di VPS.

---

## Menu Telegram

Kirim `/start` → muncul menu tombol (reply keyboard) yang persisten, semua fungsi sekali tap:

|  |  |  |
|:--|:--|:--|
| 📋 **Posisi** — `/list` | 📒 **Ledger** — `/ledger` | 💰 **PnL** — `/pnl` |
| 🧪 **Screen** — `/screen` | 🔍 **Scan** — `/scan` | 📸 **Kartu** — `/card` |
| 🔄 **Swap** — `/swap` | 📡 **Feed** — `/feed` | 👁 **Watch** — `/watch` |
| 🤖 **Auto** — `/auto` | 👛 **Wallet** — `/wallet` | ⚙️ **Setting** — `/settings` |
| 🗑 **Close All** — `/closeall` | 💸 **Sell** — `/sell` | ❔ **Help** — `/help` |

---

## Tampilan log

Bersih, timestamped, per-modul. Contoh boot + runtime:

```
[10:01:45] INFO  client   · fast-submit ON → sequencer.mainnet.chain.robinhood.com
[10:01:45] INFO  bot      · Robinhood LP Bot v2 jalan — chain 4663, wallet 0xc017…469e
[10:01:45] INFO  watch    · ON — scan tiap 120s (vol5m ≥ $200k, naik 1.4×)
[10:01:45] INFO  feed     · connect feed.mainnet.chain.robinhood.com
[10:01:45] INFO  feedmon  · ON — newToken=true positionMonitor=true autoClose=false
[10:01:45] INFO  feed     · connected (101)
[10:02:02] INFO  feedmon  · new token NUG ditolak: TIDAK BISA DIJUAL (simulasi revert) — honeypot
[10:14:07] INFO  v4close  · close v4 #177922 WOLVES/USDG — +$0.35 (fee $1.08)
[10:14:08] INFO  card     · close card terkirim
```

Ke VPS: `pm2 logs robinhood-lp`.

---

## Kenapa ada bot ini

Tiga hal yang bikin LP manual nyebelin:

1. **Web Uniswap ngelag** — connect, approve, set range, mint. Tiap langkah loading.
2. **Range-nya bahasa alien** — Uniswap kasih `tick 130400–134400`. Itu artinya apa?
3. **Udah open, untung nggak?** — cuma keliatan "unclaimed fees". Modal awal berapa? Nilainya sekarang berapa? Nggak jelas.

Bot ini jawab ketiganya. Range ditampilin dalam **MCAP** (`$2.64M → $3.94M`), PnL dihitung dari **harga jual asli**, dan semuanya dari Telegram.

---

## Setup (5 menit)

**Butuh:** Node.js 20+ ([download](https://nodejs.org))

```bash
# 1. Masuk foldernya
cd Robinhood-LP-Bot

# 2. Install (narik ethers v6 + @uniswap/{v3,v4}-sdk + @napi-rs/canvas + typescript)
npm install

# 3. Siapin config
cp .env.example .env
```

Sekarang buka `.env`, isi:

| Isi apa | Dapetnya dari mana |
|---|---|
| `RH_RPC_URL` | [alchemy.com](https://alchemy.com) → bikin app → pilih chain **Robinhood** → copy HTTPS URL |
| `RH_WALLET_KEY` | Private key wallet EVM lu. **Pakai wallet baru/burner**, jangan wallet utama |
| `RH_TG_TOKEN` | Chat [@BotFather](https://t.me/BotFather) di Telegram → `/newbot` → copy token |
| `RH_TG_CHAT` | **Owner chat id — GERBANG KEAMANAN.** Chat [@userinfobot](https://t.me/userinfobot) buat dapet id lu. Cuma chat ini yang boleh nyuruh bot |
| `RH_WATCH_RPC_URL` | (opsional) app Alchemy kedua, buat scanner. Kosongin juga nggak apa-apa |
| `RH_OPENROUTER_KEY` | (opsional) [openrouter.ai/keys](https://openrouter.ai/keys) — nyalain radar LLM |
| `KYBERSWAP_*` | (opsional) endpoint aggregator KyberSwap — buat swap rute-terbaik (lihat `.env.example`) |

Bikin wallet baru cepat:
```bash
node -e "const w=require('ethers').Wallet.createRandom();console.log('Address:',w.address);console.log('Key    :',w.privateKey)"
```

Isi wallet itu pakai ETH di **Robinhood Chain** (bridge dari mainnet). Sisain minimal `0.015 ETH` buat gas.

**Jalanin:**
```bash
npm start        # = node --env-file-if-exists=.env --import tsx src/index.ts
```

Buka bot lu di Telegram, kirim `/start`. Kalau dia jawab, beres.

> Pengecekan tipe: `npm run typecheck` · dev auto-reload: `npm run dev`

---

## Cara pakai

### Buka posisi LP

1. **Paste CA token** (`0x…`) ke chat
2. Bot cariin pool-nya di **v2 / v3 / v4** (label `ETH ✅` / `USDG ✅`) → pilih salah satu
3. Ketik jumlah ETH (contoh: `0.05`)
4. Pilih mode:

```
🛡 Single-side ETH — range $2.64M → $3.94M
   0% token. Fee jalan cuma kalau MCAP masuk range. Aman dari rug.

🎯 In-range — range $3.35M → $5.00M
   beliin ~51% modal → token duluan (via Kyber, rute terbaik).
   Fee LANGSUNG jalan, tapi lu langsung pegang token (rug = rugi 51% instan).
```

**Bedanya penting — baca ini:**

| | 🛡 Single-side | 🎯 In-range |
|---|---|---|
| Isi posisi awal | 100% ETH | ~49% ETH + ~51% token |
| Fee | nunggu harga masuk range | jalan dari detik 1 |
| Kalau token rug | rugi kecil (belum kekonversi) | **rugi ~51% instan** |

Uniswap nggak bisa bikin range yang nyebrang harga cuma dengan satu token. Jadi "in-range" artinya bot **beliin tokennya duluan** (lewat KyberSwap aggregator → rute termurah, bukan di pool fee-tinggi yang lu pilih). Pakai buat token yang pool-nya tebel. Token meragukan → tetep single-side.

> **Pair USDG:** sama persis, cuma quote asset-nya USDG (bukan ETH). Single-side USDG = parkir **USDG doang** (rug-safe). Kalau udah ada USDG di wallet, muncul tombol **💵 pakai USDG wallet ($X)** — buka posisi langsung dari USDG itu, **tanpa input jumlah, tanpa swap**. USDG yang udah ada juga otomatis di-**reuse** (gak beli 2×; cuma beli kekurangannya). Buat in-range v4 (yang gak refund kelebihan kayak v3), sisa yang gak kepakai di-**sweep balik ke ETH** biar wallet gak numpuk dust.

### Cek posisi — `/list`

```
📋 Posisi LP · ETH $1844 · 09.44.49

🐷 DATABEAR  ·  fee 1.00%  ·  #86566
   🟢 IN RANGE
   modal     0.060000Ξ    $108.66
   nilai     0.073289Ξ    $132.74
   fee       0.016264Ξ     $29.46
   umur            36m  $48.02/jam
   MCAP         $3.28M  entry $4.20M
   range   $2.69M → $4.02M
   PnL      +0.013289Ξ    +$24.07  +22.1%

🦄 UNISWAP v4 · 2 posisi
   ...
💧 UNISWAP v2 · 1 posisi
   ...

TOTAL 4 posisi  ·  v3 1 · v4 2 · v2 1
modal   0.128000Ξ    $236.03
nilai   0.141813Ξ    $261.50
fee     0.017640Ξ     $32.53
PnL    +0.013813Ξ     +$25.47
```

**`$/jam` itu angka paling berguna di sini.** Umur doang nggak nolong. Yang lu butuh tau: posisi ini masih kerja apa udah nganggur?

- `3h 20m · $2.10/jam` → masih produktif, biarin
- `2d 5h · $0.04/jam` → udah mati, modal nyangkut percuma → tutup, puter ke pool lain

TOTAL (gabung v3+v4+v2) selalu di baris paling bawah. Tombol 🔄 **Refresh** ambil data fresh; `/list` biasa dilayanin dari cache 20 detik (biar instan). Tiap token ada tombol **Close** / **💰 Claim**.

### Tutup posisi

Pencet tombol close → pilih:
- **🔄 Swap token → ETH** — semuanya balik jadi ETH
- **🪙 Simpen token** — LP principal balik ke ETH, tokennya lu tahan

Bot otomatis: tarik likuiditas → klaim fee → burn NFT → (swap) → **isi gas balik ke 0.015 ETH** → kirim **kartu profit**.

Buat token honeypot yang nggak bisa ditarik (transfer revert), bot **force-close**: relakan sisi token yang keblokir, **selametin ETH-nya**.

> ⚠️ **Catatan "Simpen token":** auto-swap pas close nyapu **seluruh saldo token di dompet**, bukan cuma dari posisi itu.

### ➕ Tambah liq ke posisi yang ada (increase)

Udah punya posisi (misal USDG/TACO) terus mau **nambahin** liq? Di `/list` tiap posisi v4 ada tombol **➕ Add** → ketik jumlah ETH → bot **swap ½ token + ½ USDG** lalu masuk ke **posisi yang SAMA** (bukan bikin NFT baru — SDK emit `INCREASE_LIQUIDITY`). Pakai range posisi existing, basis PnL ikut nambah (LP-vs-HODL tetep jujur), reuse USDG di wallet + sweep sisa → ETH. (Pair USDG dulu; ETH-pair nyusul.)

### Riwayat — `/ledger`

Semua posisi ditutup (v3 + v4 + v2, urut terbaru dulu), tombol Next/Back + 📸 kartu per-posisi. Stats gabungan: win rate, modal, fee LP, realized vs nyangkut.

### 📅 Profit Calendar — `/calendar`

Grid kalender bulanan (PNG) — tiap kotak = **PnL realized posisi yang di-close hari itu** (LP-vs-HODL, **fee included**). Ijo profit, merah loss, header "X up · Y down" + total bulan. Tombol **⬅️ Prev / Next ➡️** buat pindah bulan. Hari reset **00:00 UTC = 07:00 WIB**. Background bisa diganti (kirim foto ke bot / `assets/card-bg.jpg` / `RH_CARD_BG` — sama kayak kartu profit).

Ledger direkonstruksi dari **event on-chain** — posisi lama tetep kebaca walau baru install bot-nya. Pair USDG dihitung **LP-vs-HODL** (fee + IL, exclude gerakan harga token) biar konsisten dan jujur.

### Swap — `/swap`

`/swap <jumlah> <dari> <ke>` — swap token apa aja lewat **KyberSwap aggregator** (rute terbaik lintas DEX). `dari`/`ke` = `eth` atau CA. Tampil quote + breakdown rute + slippage → tombol ✅ konfirmasi.

### Screening thesis — `/screen`

Filter GMGN 24 jam pakai playbook operator: mcap > $500k, vol > $1M, **buang flap.fun**, **util diprioritas, meme dipenalti**, cek komunitas + FOMO. Top-10 di-skor LLM. `/screen fast` = tanpa LLM.

### Scanner volume — `/watch`

Jalan otomatis tiap 2 menit. Nyari volume 5-menit yang **NANJAK**, bukan sekadar tinggi. Tiap token diuji honeypot on-chain:

```
DATABEAR  simulasi beli 0.01Ξ → jual balik 0.00980Ξ = 98.0%  ✅ sehat
honeypot  simulasi beli 0.01Ξ → REVERT                       🚨 ditolak
```

Notifnya bawa CA, link DexScreener, dan tombol **🎯 LP** langsung.

### Monitor sequencer real-time — `/feed`

Opt-in (default off): `/feed on`. Dengerin **feed sequencer Nitro** (`wss://feed.mainnet.chain.robinhood.com/feed`) — mempool sub-detik, **sebelum** tx masuk block.

1. **🆕 Token baru** — deteksi pool WETH baru / mint likuiditas pertama, langsung uji honeypot + tombol 1-tap LP.
2. **🔴 Out-of-range** — swap ngenain pool yang lu LP-in → cek tick → alert (opsional auto-close, default off).

> ⚠️ **DNS hijack:** kalau jaringan lu hijack DNS domain feed (mis. Telkomsel "Internet Baik"), set `RH_FEED_IP=172.66.147.70` di `.env`. Di VPS US nggak perlu. Sequencer di AWS Ohio (`us-east-2`).

Toggle: `/set newtoken 1` · `/set posmon 1` · `/set autoclose 0` · `/set minseed 0.02`

### Fast-submit — broadcast langsung ke sequencer

Set `RH_FAST_SUBMIT=1`. Tx dikirim langsung ke sequencer Robinhood (**AWS us-east-2 / Ohio**), skip hop relay. Baca tetep via RPC utama; sequencer error → auto fallback (tx nggak ilang). **Paling ngefek di VPS US.** Lokal + DNS hijack → set `RH_SEQUENCER_IP=3.136.74.196`.

> ⚡ **Deteksi receipt cepat:** block Robinhood sub-detik, tapi ethers default nge-poll receipt tiap 4 detik → close/add/swap multi-tx berasa lama. Bot set `pollingInterval` ke **350ms** (tunable `RH_POLL_MS`), jadi `tx.wait()` balik ~10× lebih cepet.

### Radar LLM + GMGN — layer konfirmasi kandidat

Tiap kandidat (token baru dari feed / spike dari watch) di-skor **LLM lewat OpenRouter** + di-enrich data **GMGN** (smart money, holders, rug ratio, tax, konsentrasi top-10). Verdict (`🟢 APE / 🟡 WATCH / 🔴 SKIP` + skor + alasan) nempel di notif, sebelum lu pencet LP.

```
# nyalain
RH_OPENROUTER_KEY=...        # openrouter.ai/keys
/set radar 1                 # di Telegram
```

GMGN (opsional, enrich): install `gmgn-cli` + config di mesin yang jalanin bot (key GMGN ke-bind ke keypair lokal — lihat `.env.example` §9). GMGN support chain `robinhood`. Nggak dikonfig → radar tetep jalan pakai LLM + data on-chain aja (degrade mulus).

> Semua best-effort: fast-submit / radar / GMGN / Kyber mati sendiri kalau env/tool-nya nggak ada — bot inti tetep jalan.

---

## Auto-farming — hunter + auto-add + auto-close (`/hunt` · `/auto`)

Layer paling atas: bot **cariin, buka, dan tutup posisi sendiri** — lu tinggal set gate-nya.

**1. Hunter (`/hunt`)** — tiap 3 menit: `100 trending → screening (thesis + LLM) → cuma yang punya pool fee 3-5% RAME → kandidat`. Gate kualitasnya (semua tunable via `/set`):

- **Fee-yield** — pool di-rank by fee yang beneran dihasilkan (`vol24h × fee%`), bukan volume mentah. Pool 5% @ $8k vol menang dari 3% @ $9k.
- **Band mcap** — cuma token di rentang mcap yang lu mau. Small-cap = modal kecil lu jadi **share fee lebih gede**.
- **OOR cooldown** — token yang kebuka-tutup out-of-range terus (gak pernah masuk range) di-blacklist sementara → stop buang gas.

**2. Auto-add** — kandidat lolos gate + verdict (`requireAction` ≥ `watch`, skor ≥ `alpscore`) dibuka otomatis. Gate berlapis: source, LLM verdict, GMGN honeypot/tax, likuiditas, **1 token = 1 posisi** (anti dobel), cap concurrent/jam/harian, saldo. Mode:

| | `single` (rug-safe) | `inrange` (agresif) |
|---|---|---|
| Isi posisi | parkir quote asset (USDG/ETH) doang | both-sided (beli token juga) |
| Fee | jalan pas harga **MASUK** range | jalan **LANGSUNG** |
| Kalau rug | aman (0 token) | pegang token → rugi |

`/set alpmode single` atau `/set alpmode inrange` — live, tanpa restart.

**3. Auto-close** — manage loop cek tiap 90 detik: **TP** (PnL ≥ `alptp`%) · **SL** (PnL ≤ −`alpsl`%) · **OOR** (keluar range > `alpgrace` menit). PnL dihitung **LP-vs-HODL** (fee + IL, konsisten sama yang di-realize pas close), bukan budget kotor. Tiap close → **sweep proceeds → ETH** otomatis (token + USDG dijual balik), wallet bersih + gas ke-isi.

> ⚠️ **Pakai dana REAL tanpa konfirmasi manusia.** OFF by default (`/auto on` buat nyalain). Semua cap konservatif; naikin sadar-sadar via `/set alp*`. Wallet-tx di-serialize (satu sekuens per waktu) biar gak nonce-collision.

---

## Semua command

| Command | Fungsi |
|---|---|
| paste `0x…` | Buka posisi LP (v2/v3/v4, auto detect pool) |
| `/list` | Posisi terbuka (v3+v4+v2) + PnL + TOTAL + tombol close |
| `/ledger` | Riwayat posisi ditutup (realized vs nyangkut) + kartu per-posisi |
| `/pnl` | PnL seumur hidup level dompet |
| `/card` | Kartu profit portfolio (PNG shareable) |
| `/calendar` | 📅 Profit calendar — PnL harian (grid bulanan, fee included) |
| `/swap` | Swap token via KyberSwap aggregator (rute terbaik) |
| `/screen` | Screening GMGN 24h (mcap>500k, vol>1M, no flap, util>meme) · `/screen fast` |
| `/watch` | Status scanner + volume tertinggi saat ini |
| `/feed` | Monitor sequencer real-time · `/feed on`/`off` |
| `/scan` | Cek volume sekarang juga (manual) |
| `/hunt` | Hunter kandidat LP (fee 3-5% + tx rame + screening) |
| `/auto` | Auto-farming: auto-add + auto-close · `/auto on`\|`off` · `/auto tp 100` · `/auto sl 30` · `/auto oor on`\|`off` |
| `/v4` | Cek pool Uniswap v4 sebuah token CA |
| `/closeall` | Tutup SEMUA posisi |
| `/sell` | Jual semua token nyangkut → ETH |
| `/wallet` | Saldo hot wallet |
| `/settings` · `/set <key> <angka>` | Lihat / ubah setting |

**Setting yang bisa diubah** (semua live, `/set` langsung apply tanpa restart):
```
LP     : /set width 50 · /set slippage 5 · /set gastarget 0.015

Scanner: /set vol5m 500000 · /set rise 1.4 · /set liq 50000 · /set tax 6
         /set cooldown 60 · /set interval 120

Hunter : /set huntvol 15000       volume pool 24h minimal (USD)
         /set huntfees 400        fee 24h pool minimal = vol × fee% (fee-yield)
         /set huntyield 0         fee/TVL yield harian minimal % (0 = off, TVL v4 sering ke-baca $0)
         /set huntscore 55        skor screening minimal
         /set huntmcapmin 100000  ·  /set huntmcapmax 5000000   band mcap (max 0 = tanpa batas)

Auto-LP: /set alpmode single|inrange   single (rug-safe) / inrange (fee langsung)
         /set alpsize 0.0025      ETH per posisi
         /set alpscore 60         skor minimal buat AUTO-add (beda dari huntscore)
         /set alpmaxopen 5        max posisi barengan
         /set alpperhour 4        ·  /set alpdaily 0.2         cap open/jam & ETH/hari
         /set alpminliq 1000      likuiditas minimal (0 = andelin fee-gate; berguna buat small-cap v4)
         /set alpgrace 30         menit OOR sebelum auto-close
         /set alpclose 1          toggle auto-close OOR (0/1)
         /set alpoorcount 3  ·  /set alpoorhours 12   OOR cooldown: N× OOR → blacklist X jam

Auto-close (via /auto): /auto tp 100  ·  /auto sl 30  ·  /auto oor on|off
Feed   : /set newtoken 1 · /set posmon 1 · /set autoclose 0 · /set minseed 0.02
Radar  : /set radar 1 · /set gmgn 1
```

---

## Jalan 24 jam di VPS

```bash
npm install -g pm2
pm2 start npm --name robinhood-lp -- start   # npm start udah baca .env sendiri
pm2 save
pm2 startup        # ikutin instruksi yang keluar → auto-start abis reboot
```

Cek: `pm2 logs robinhood-lp`

> Kartu profit butuh font: `sudo apt install -y fonts-dejavu-core fonts-dejavu-extra` (canvas render blank text tanpa ini).

> ⚠️ **Jangan jalanin dua proses dengan TOKEN TELEGRAM yang sama.** Dua proses polling token yang sama → rebutan (`409 Conflict`). v2 udah ada **single-instance lock**, dan lock-nya **per chain** (`data/bot.lock` vs `data/arc/bot.lock`) — jadi bot Robinhood + bot Arc boleh jalan bareng **asal token bot-nya beda**. Kalau share wallet sama bot lain **di chain yang sama** → jangan jalan bareng (nonce tabrakan); beda chain aman, nonce-nya kepisah.

---

## 🔵 Arc — chain kedua (proses kedua)

Bot ini bisa jalan di **Arc** (L1 EVM-nya Circle, chainId `5042`, mainnet buka 2026-09-16) **tanpa nyentuh bot Robinhood sama sekali**. Yang milih chain itu satu env var: `RH_CHAIN`. Kalau dikosongin, semuanya persis kayak sekarang (`config.json`, folder `data/`, kelakuan sama).

### Bedanya di mana

| | Robinhood Chain | Arc |
|---|---|---|
| chainId | 4663 | **5042** |
| gas dibayar pakai | ETH | **USDC** (native, 18 desimal) |
| quote LP | USDG (6 dec) | **USDC ERC-20** `0x3600…0000` (6 dec) |
| wrapped native | WETH | **nggak ada** — nggak ada WETH9 di Arc |
| sequencer / fast-submit | ada | **nggak ada** (validator L1, Malachite BFT, 1 konfirmasi = final) |
| aggregator swap | KyberSwap | **Uniswap** (dukungan Kyber di Arc belum kebukti) |
| GMGN | ada | **nggak ada** → gate honeypot/tax/holder **nggak dievaluasi** |
| gas price | floating | **base fee tetap 20 gwei** (EIP-1559) |

> ### ⚠️ Di Arc, duit gas dan modal LP itu SALDO YANG SAMA
> Gas di Arc dibayar pakai USDC — persis aset yang dipake buat LP. Kalau bot deploy 100% saldo ke posisi, **nggak ada sisa buat bayar gas nutup posisi itu**. Makanya `chains/arc.json` nahan `native.gasReserve = 2.0` USDC yang nggak akan pernah kepake buat LP.
>
> Itu **LANTAI, bukan batas ukuran posisi.** Nggak ada cap `maxOpen`/`maxPerHour`/`dailyCapEth` di Arc (semuanya `0` = tanpa batas) — yang jadi batas cuma **deposit lu** dan cadangan gas ini. Cek angkanya kapan aja di `/wallet` dan `/settings`.

### 1. Isi wallet pakai USDC lewat CCTP

Arc nggak punya faucet mainnet, dan wallet-nya **butuh USDC dulu sebelum apa pun jalan** (gas, approve, mint — semua butuh USDC).

- **Jalur**: CCTP v2 dari Ethereum / Base / Arbitrum → Arc. Domain Arc = **26**, `TokenMessenger` = `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, fast path **1 konfirmasi**.
- **Cara gampang**: pakai UI CCTP Circle, atau `@circle-fin/bridge-kit` dari mesin lu sendiri. Bot **nggak** ikut bridge — sengaja: bot cuma boleh nandatangan tx LP.
- **Wallet-nya sama** kayak bot Robinhood (satu private key, dua chain — nonce kepisah per chain, nggak bakal tabrakan).
- **Kirim lebih dari cadangan gas.** `2.0` USDC itu yang ditahan buat gas; deposit `2.0` doang artinya modal LP `0`.

Cek udah nyampe apa belum: `/wallet` di bot Arc.

### 2. Probe dulu, baru nyalain bot

```bash
RH_CHAIN=arc npm run probe:arc
```

Read-only — **nggak ada tx yang dikirim, private key nggak dipake nandatangan**. Laporan lengkapnya mendarat di `data/arc/arc-probe.json`.

Yang dia jawab, dan flag apa yang di-flip di `chains/arc.json`:

| Hasil probe | Flag yang diubah | Efeknya |
|---|---|---|
| `native/ERC-20 parity` ✅ | — (asumsi desain) | native == ERC-20 × 1e12 → deposit LP nggak butuh wrap/swap sama sekali. **Kalau ❌, jangan lanjut** — sizing di §6 plan-nya beda |
| `getCode()` tiap alamat ✅ | — | contract-nya emang udah kedeploy (SDK bisa nyantumin alamat yang belum ada) |
| `v3Pools` / `v4` sample | `discovery.v4FromBlock` = blok `Initialize` paling awal | scan getLogs nggak usah dari genesis tiap kali |
| `DexScreener indexes Arc` ✅ | `data.volumeSource` → `"dexscreener"` | volume 1h/24h dari indexer (lebih cepet). Default `"onchain"` = derive dari Swap event |
| `KyberSwap routes Arc` ✅ | `data.kyberChain` → `"arc"` **dan** `data.router` → `"kyber"` | urutan venue jadi `kyber → uniswap` sendiri, nol perubahan kode. Isi `kyberChain` doang = Kyber jadi cadangan **di belakang** Uniswap |
| `Blockscout v1/v2 API` ✅ | `explorer.kind` → `"blockscout"` | `/pnl` arus wallet (setor/tarik/net), rebuild ledger, riwayat holdings nyala. Default `"rpc"` = fitur-fitur itu jujur bilang `n/a`, bukan nampilin 0 |

**Semua flag itu default-nya KONSERVATIF** (anggap pihak ketiga nggak ada sampai kebukti). Yang nggak ada cuma bikin satu sinyal degrade — bukan bikin bot rusak.

### 3. Jalanin proses keduanya

```bash
cp .env.arc.example .env.arc
# isi: RH_CHAIN=arc · RH_TG_TOKEN (bot BARU) · RH_TG_CHAT (sama) · RH_WALLET_KEY (sama)

node --env-file=.env.arc --import tsx src/index.ts
```

pm2, dua-duanya bareng:
```bash
pm2 start npm --name robinhood-lp -- start                                   # chain Robinhood
pm2 start node --name arc-lp -- --env-file=.env.arc --import tsx src/index.ts # chain Arc
pm2 save
```

**Kenapa harus proses kedua, bukan satu bot dua chain:**
- **Token Telegram harus BEDA.** Satu token cuma boleh di-polling satu proses — kalau dipake barengan, dua-duanya rebutan `getUpdates` (409 Conflict) dan perintah bisa nyasar ke chain yang salah. Bikin bot kedua di @BotFather.
- **State-nya kepisah**: `data/arc/` (positions, ledger, autolp-state, lock). tokenId NFT v3/v4 itu counter per chain — kalau dicampur, posisi antar chain bisa ketuker.
- **Lock file ikut per-chain**, jadi dua proses ini emang boleh jalan bareng.
- Owner chat-nya sama, jadi dua-duanya nge-chat lu. Tiap layar bawa nama chain-nya (`/start`, `/list`, `/wallet`, `/pnl`, kartu profit) biar nggak ketuker.

Tunable khusus Arc (`lp` / `autoLp` / `scan`) taruh di **`config.arc.json`** — file opsional yang nimpa `config.json` cuma buat proses Arc. `config.json` punya bot Robinhood nggak kesentuh.

### 4. Yang beda rasanya di Arc

- **Prompt jumlah baca "Ketik jumlah USDC"**, layar konfirmasi bilang USDC, kartu profit pakai simbol yang bener. Satu code path, dua chain.
- **Single-side "parkir stable"** tetep ada — di Robinhood namanya USDG, di Arc USDC. Sama persis alurnya.
- **`/feed` mati** — nggak ada sequencer buat di-tap. Pakai `/watch` + `/hunt`.
- **`/screen` mati** — itu screener GMGN, dan GMGN nggak nyover Arc.
- **`/hunt` ganti sumber**: `onchain-new` (log `Initialize` v4 + `PoolCreated` v3) + `volume-spike`, bukan GMGN trending.
- **Skor kandidat mentok 70, bukan 100.** Sengaja: gate yang nggak kecek nggak dikasih poin. Tiap alert bawa baris `⚠️ belum dicek: …` yang nyebut gate-nya satu-satu. **Unknown itu bukan lulus.**
- **`/swap` manual belum ada** selama Kyber belum kebukti di Arc (LP-nya jalan normal lewat router internal Uniswap; buat keluar dari token, tutup posisinya lewat `/list`).
- **`/pnl`**: "LP realized" akurat; baris arus wallet (setor/tarik/net) nulis `n/a` sampai `explorer.kind` jadi `blockscout` — transfer native nggak ninggalin log, jadi tanpa indexer angkanya emang nggak kebaca. Lebih baik `n/a` daripada `0.00000` palsu.

---

## Struktur kode (`src/`)

```
src/
├── index.ts              entrypoint — validasi secret, lock, graceful shutdown
├── config.ts             load + validasi config (zod) + secret dari .env
├── types.ts              tipe domain bersama
├── chain/                semua urusan blockchain
│   ├── profile.ts        ⭐ CHAIN PROFILE (zod) — chains/<key>.json, dipilih RH_CHAIN
│   ├── currency.ts       ⭐ native vs quote — natSym, fmtNat, nativeUsd, cadangan gas
│   ├── router.ts         ⭐ pilih venue swap (kyber | v3 | v4) per profil, best-of quote
│   ├── indexer.ts        ⭐ abstraksi indexer — blockscout REST | getLogs RPC (fallback)
│   ├── volume.ts         ⭐ volume pool 1h/24h — DexScreener atau Swap event on-chain
│   ├── client.ts         provider (LP + watch), wallet, gas, fast-submit routing
│   ├── sequencer.ts      broadcast langsung ke sequencer (nolak kalau chain nggak punya)
│   ├── kyber.ts          KyberSwap aggregator (quote + build, 4 security gate)
│   ├── positions.ts      v3 open / list / close + stable single-side & in-range (Uniswap SDK math)
│   ├── pools.ts          findPools, poolState, range math (SDK)
│   ├── swaps.ts          quote + swap v3 (slippage floor) + jual ber-quote
│   ├── candidate.ts      qualifyCandidate — pool 3-5% + fee-yield gate (hunter)
│   ├── dexscreener.ts    volume/liq pool (cached) — sinyal fee-farming
│   ├── txlock.ts         serialize tx wallet (anti nonce-collision)
│   ├── ledger.ts         ledger permanen + rebuild on-chain
│   ├── analytics.ts      PnL seumur hidup (capKnown=false kalau chain tanpa indexer)
│   ├── tokens.ts         metadata token (cached) + SDK Token
│   ├── price.ts          ETH/USD multi-source
│   ├── blockscout.ts     helper REST Blockscout + mapLimit
│   ├── v2/               Uniswap v2 — pair.ts · mint.ts (zap) · list.ts · close.ts
│   └── v4/               Uniswap v4 — discover · mint (single/in-range + reuse stable) · list (PnL LP-vs-HODL) · close (sweep→native) · backfill · swap
├── telegram/
│   ├── tg.ts             transport + AUTH boundary (owner-only)
│   ├── bot.ts            long-poll loop + routing + setMyCommands
│   ├── handlers.ts       semua command/tombol (+ cache /list)
│   ├── menu.ts           reply keyboard persisten
│   ├── card.ts           kartu profit PNG (@napi-rs/canvas, STRIX style)
│   ├── calendar.ts       profit calendar bulanan (PnL/hari, PNG) + bg custom
│   ├── notify.ts         notif spike / token baru / out-of-range
│   ├── watchLoop.ts      timer scanner
│   ├── feedLoop.ts       lifecycle feed monitor
│   └── format.ts         escape, padding, emoji per-token + label chain/currency (NAT_TAG dll)
├── feed/                 monitor sequencer real-time (Nitro)
│   ├── decode · listener (WS + IP-pin) · swapdecode · lpdecode · monitor
├── radar/                screening + auto-farming
│   ├── openrouter.ts · gmgn.ts · screen.ts (/screen thesis) · radar.ts (verdict LLM+GMGN)
│   ├── scanLoop.ts       hunter (/hunt) — trending → screen → kandidat 3-5%
│   ├── autolp.ts         auto-add: gate chain + open (dedup 1 token/posisi + txlock)
│   ├── automanage.ts     auto-close TP/SL/OOR (grace restart-proof)
│   └── oorcool.ts        OOR cooldown (blacklist token yang gak pernah masuk range)
├── scripts/probe-arc.ts  ⭐ preflight Arc READ-ONLY (npm run probe:arc) — nggak ngirim tx
├── watch/scanner.ts      scan volume + uji honeypot on-chain
└── util/                 log, atomic file write + lock, formatter (+ CHAIN_KEY, DATA_DIR per chain)
```

⭐ = file baru buat dukungan multi-chain (Arc).

| File lain | Isinya apa |
|---|---|
| `chains/robinhood.json` | ⭐ Profil chain default — chainId, RPC, explorer, contract, gas policy, flag data. **Nilainya sama persis kayak config.json lama** |
| `chains/arc.json` | ⭐ Profil chain Arc — alamat Uniswap Arc + flag kemampuan (default konservatif, di-flip abis probe) |
| `config.json` | Setting strategi (di-validasi zod pas start) — chain-agnostic |
| `config.arc.json` | ⭐ Opsional. Nimpa `config.json` **cuma** buat proses Arc (`config.<chainKey>.json`) |
| `.env` | **Kunci-kunci. Rahasia.** (gitignored) |
| `.env.arc` | ⭐ Env proses Arc — `RH_CHAIN=arc` + token bot kedua. **Rahasia juga** (gitignored) |
| `assets/card-bg.jpg` | Background kartu profit (opsional) |
| `data/` | State runtime chain default — `positions.json`, `v4-positions.json`, `lp-ledger.json`, `v2-skip.json`, `bot.lock`. **Jangan dihapus** — catatan PnL lu di situ. (gitignored) |
| `data/arc/` | ⭐ State yang sama buat Arc, terisolasi penuh (`data/<chainKey>/` buat tiap chain non-default) |

Ditulis atomik (temp + rename), jadi crash di tengah nulis nggak bikin ledger korup.

---

## Yang perlu lu sadar

**Ini bot buat degen, bukan investasi.** LP di token meme = lu jadi pembeli otomatis pas harganya turun. Itu bukan bug, itu emang cara kerja LP.

**Tes honeypot nangkep honeypot & tax — BUKAN rug.** Dev yang tarik likuiditas besok tetep lolos tes hari ini. Nggak ada tes yang bisa liat masa depan.

**Single-side itu rem alami lu.** Mode in-range ngelepas rem itu (lu pegang token → kena rug). Pilih sadar.

**Auto-farming pakai dana REAL, tanpa nanya.** `/auto on` bikin bot buka + tutup posisi sendiri pakai duit lu. OFF by default, cap konservatif — tapi lu yang set, naikin sadar-sadar.

**PnL di `/list` = LP-vs-HODL** (fee + impermanent loss), bukan perubahan absolut wallet. Ini ngukur performa LP-nya (fee vs IL), konsisten sama yang di-realize pas close. Gerakan harga token = risiko pasar terpisah.

**Di Arc, gas dan modal LP itu saldo yang sama.** Cadangan gas (`native.gasReserve`, default 2.0 USDC) itu satu-satunya yang bikin posisi tetep bisa **ditutup**. Jangan diturunin ke 0.

**Di chain tanpa GMGN (Arc), gate honeypot/tax/holder nggak pernah jalan.** Alert-nya bakal bilang `⚠️ belum dicek: …` dan skornya mentok 70. Itu **unknown, bukan lulus** — jangan dibaca sebagai "bersih".

**Pakai burner wallet.** Private key-nya duduk di `.env` dalam bentuk teks biasa. Jangan taruh duit yang lu nggak siap ilang.

**Set `RH_TG_CHAT`.** Itu gerbang owner — cuma chat lu yang boleh nyuruh bot. Bot megang private key; jangan biarin siapa pun bisa `/closeall` atau mint pakai duit lu.

---

MIT. Pakai risiko sendiri.
