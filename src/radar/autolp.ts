/**
 * Autonomous LP: candidate → radar verdict → (many gates) → auto-open a position.
 *
 * ⚠️ This SPENDS REAL FUNDS with no human tap. Every gate below must pass, and it's OFF
 * by default with conservative caps. Defense in depth: the LLM verdict is necessary but
 * NOT sufficient — hard on-chain/GMGN filters + rate/size/count caps sit in front of it.
 * Single-side mode by default = rug-safe (parks ETH, buys token only if price enters range).
 */
import { cfg } from "../config.js";
import { findPools, findStableQuotePools, pickLpPool } from "../chain/pools.js";
import { openPosition, openV3StableInRange, openV3StableSingleSide, listPositions } from "../chain/positions.js";
import { balances } from "../chain/holdings.js";
import { natSym, parseNat, fmtNat, natAmountStr, hasWrapped, gasReserveNat, gasReserveWei, reserveForGas } from "../chain/currency.js";
import { acquireWallet, releaseWallet } from "../chain/txlock.js";
import { gmgnSupported } from "./gmgn.js";
import { inOorCooldown, oorCooldownLeftMin } from "./oorcool.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { Candidate, Verdict } from "./radar.js";

const log = logger("autolp");
const STATE_FILE = dataPath("autolp-state.json");

/**
 * A cap of 0 means UNLIMITED, not "zero allowed".
 *
 * The operator asked explicitly not to be capped — their deposit is the control — and every one of
 * maxOpen / maxPerHour / dailyCapEth used to be a bare `>=` with no escape value, so "no limit"
 * was unexpressible. This is the escape. It does NOT touch the gas reserve, which is a floor in
 * the other direction and stays enforced: unlimited SIZE is the operator's call, but a position
 * that cannot pay for its own close is not a position, it's a trap.
 */
const capOff = (n: number): boolean => !(n > 0);

let lastPolicy = "";
/**
 * Say out loud which caps are disabled and what the gas floor is. Re-logged whenever the policy
 * STRING changes, not just once at boot: `/set alpmaxopen 0` is the operator turning a spend limit
 * off on a live bot, and that belongs in the log at the moment it takes effect, not only in
 * whatever scrollback existed when the process started.
 */
function logPolicyOnce(a: typeof cfg.autoLp): void {
  const off = [capOff(a.maxOpen) ? "maxOpen" : null, capOff(a.maxPerHour) ? "maxPerHour" : null, capOff(a.dailyCapEth) ? "dailyCap" : null].filter(Boolean);
  const line =
    `auto-LP policy: ${off.length ? `cap MATI (unlimited): ${off.join(", ")}` : "semua cap aktif"} · ` +
    `cadangan gas ${gasReserveNat()} ${natSym()} ditahan (FLOOR, bukan cap)` +
    (gmgnSupported() ? "" : ` · GMGN nggak ada di chain ini → gate honeypot/tax TIDAK dievaluasi`);
  if (line === lastPolicy) return;
  lastPolicy = line;
  log.info(line);
}

// Common shape of a v3 OpenResult and a v4 V4OpenResult, so auto-open can return either.
type OpenLike = {
  tokenId: string | null;
  txHash: string;
  tickLower: number;
  tickUpper: number;
  depositEth?: string;
  mode?: string;
  side?: string;
  entryMcap?: number;
  swapHash?: string;
};

interface OpenRecord {
  ts: number;
  token: string;
  sizeEth: number;
  tokenId: string | null;
}
interface State {
  opens: OpenRecord[];
}

const load = (): State => readJson<State>(STATE_FILE, { opens: [] });
const save = (s: State): void => writeJson(STATE_FILE, s);

export interface AutoLpResult {
  opened: boolean;
  reason: string; // why skipped, or "opened"
  token: string;
  symbol: string;
  sizeEth?: number;
  result?: OpenLike;
  /** Safety gates that were NEVER EVALUATED for this token (no GMGN on this chain). */
  unchecked?: string[];
}

/** Run the full gate chain; open a position only if ALL pass. Returns null if disabled. */
export async function maybeAutoLp(candidate: Candidate, verdict: Verdict | null): Promise<AutoLpResult | null> {
  const a = cfg.autoLp;
  if (!a.enabled) return null;
  logPolicyOnce(a);
  const unchecked = verdict?.unchecked ?? [];

  const skip = (reason: string): AutoLpResult => {
    log.info(`skip ${candidate.symbol}: ${reason}`);
    return { opened: false, reason, token: candidate.token, symbol: candidate.symbol };
  };

  // 1. source allowed
  if (!a.sources.includes(candidate.source)) return skip(`source ${candidate.source} tidak diizinkan`);

  // 1b. OOR cooldown (#2) — skip a token that's been OOR-closed too many times (never fills)
  if (inOorCooldown(candidate.token)) return skip(`OOR cooldown ${oorCooldownLeftMin(candidate.token)}m (kebuka-tutup terus)`);

  // 2. LLM verdict gate — action is a THRESHOLD (ape > watch > skip), not an exact match, so
  //    requireAction="watch" accepts watch-or-better (an "ape" also passes).
  if (a.requireLlm) {
    if (!verdict?.llm) return skip("tidak ada verdict LLM");
    const rank = (x: string): number => (x === "ape" ? 2 : x === "watch" ? 1 : 0);
    if (rank(verdict.llm.action) < rank(a.requireAction)) return skip(`action ${verdict.llm.action} < ${a.requireAction}`);
    if (verdict.llm.score < a.minScore) return skip(`skor ${verdict.llm.score} < ${a.minScore}`);
  }

  // 3. GMGN hard filters (defense beyond the LLM)
  //
  // On a chain GMGN doesn't index, `requireGmgn` is forced OFF: left on it would wedge auto-LP
  // shut forever, which is not a safety posture, it's a dead feature. What must NOT happen is the
  // quiet alternative — running the honeypot/tax checks against undefineds, where `?? 0` turns
  // "never measured" into "0% tax, clean" and the token clears a gate it was never tested against.
  // So the gate is SKIPPED and the skip is RECORDED in `unchecked`, all the way to the alert.
  const g = verdict?.gmgn ?? null;
  const requireGmgn = a.requireGmgn && gmgnSupported();
  if (requireGmgn && !g) return skip("GMGN wajib tapi tidak tersedia");
  if (g) {
    if (g.isHoneypot === "yes" || (g.isHoneypot as unknown) === true) return skip("GMGN honeypot");
    const tax = Math.max((g.buyTax ?? 0) * 100, (g.sellTax ?? 0) * 100);
    if (tax > a.maxTaxPct) return skip(`tax ${tax.toFixed(1)}% > ${a.maxTaxPct}%`);
  } else if (a.requireGmgn) {
    log.warn(`${candidate.symbol}: requireGmgn dipaksa OFF (chain tanpa GMGN) — gate honeypot/tax ${a.maxTaxPct}% TIDAK dijalankan`);
  }

  // 4. liquidity floor
  const liq = g?.liquidityUsd ?? candidate.liq ?? 0;
  if (liq < a.minLiqUsd) return skip(`likuiditas $${liq.toFixed(0)} < $${a.minLiqUsd}`);

  // 5. caps: concurrent, per-hour, daily
  const now = Date.now();
  const st = load();
  st.opens = st.opens.filter((o) => now - o.ts < 24 * 3600_000); // prune >24h
  // count BOTH v3 and v4 — auto-add now opens v4 (3-5%) pools, so a v3-only count let maxOpen leak.
  const [v3rows, v4rows] = await Promise.all([
    listPositions().catch(() => []),
    import("../chain/v4/list.js").then((m) => m.listV4Positions()).catch(() => []),
  ]);
  const openPositions = v3rows.length + v4rows.length;
  // 5a. ONE position per token — don't stack duplicates (VEX was opening every hunt cycle → #381105 +
  //     #381146). Check the on-chain holdings by tokenAddr, PLUS tokens opened in the last 15 min (the
  //     list lags a bit after a mint, so a fast re-fire wouldn't see the just-opened position yet).
  const tok = candidate.token.toLowerCase();
  const held = [...v3rows, ...v4rows].some((r) => ((r as { tokenAddr?: string }).tokenAddr ?? "").toLowerCase() === tok);
  const justOpened = st.opens.some((o) => o.token.toLowerCase() === tok && now - o.ts < 15 * 60_000);
  if (held || justOpened) return skip(`sudah ada posisi ${candidate.symbol} — 1 token = 1 posisi`);
  // Each cap is skipped entirely at 0 (see capOff). The per-token dedup above is NOT a cap and has
  // no off switch — two positions in one token is a mistake at any deposit size.
  if (!capOff(a.maxOpen) && openPositions >= a.maxOpen) return skip(`posisi terbuka ${openPositions} ≥ maxOpen ${a.maxOpen}`);
  const lastHour = st.opens.filter((o) => now - o.ts < 3600_000).length;
  if (!capOff(a.maxPerHour) && lastHour >= a.maxPerHour) return skip(`${lastHour} open/jam ≥ maxPerHour ${a.maxPerHour}`);
  const spentToday = st.opens.reduce((s, o) => s + o.sizeEth, 0);
  if (!capOff(a.dailyCapEth) && spentToday + a.sizeEth > a.dailyCapEth)
    return skip(`cap harian: ${spentToday.toFixed(4)}+${a.sizeEth} > ${a.dailyCapEth} ${natSym()}`);

  // 6. wallet has funds — with the GAS RESERVE held back (chain profile `native.gasReserve`).
  //
  // This replaced a hardcoded 0.0004, which was an ETH-shaped number: on Arc it is 0.0004 USDC,
  // four ten-thousandths of a dollar, on a chain where the native balance IS the LP capital and
  // also the only thing that can pay for the close. The reserve is a FLOOR (reserveForGas), never
  // a size cap; on a chain with a wrapped native the LP budget comes from WETH so the native leg
  // is purely the gas float — which is exactly what the floor protects.
  const b = await balances().catch(() => null);
  if (b) {
    const natWei = parseNat(b.eth);
    const wrappedWei = parseNat(b.weth); // 0 where there is no wrapped native
    const wantWei = parseNat(natAmountStr(a.sizeEth));
    const spendableWei = reserveForGas(natWei) + wrappedWei;
    if (spendableWei < wantWei)
      return skip(`saldo bisa dipakai ${fmtNat(spendableWei)} ${natSym()} < size ${a.sizeEth} (cadangan gas ${gasReserveNat()} ditahan)`);
    if (natWei < gasReserveWei()) return skip(`${natSym()} native < cadangan gas ${gasReserveNat()}`);
  }

  // Serialize the tx sequence on the shared wallet: take the wallet lock BEFORE qualify + the multi-tx
  // open, release in finally. Blocks the nonce collision (two opens 2s apart shared a nonce → "nonce
  // has already been used" / revert, token already bought = stuck). Also mutually excludes auto-close.
  if (!acquireWallet()) return skip("wallet lagi kirim tx lain (serialize anti nonce-collision)");
  try {
    // 7. prefer a FARMABLE 3-5% pool
    const { qualifyCandidate } = await import("../chain/candidate.js");
    const q = await qualifyCandidate(candidate.token).catch(() => null);

    // 8. OPEN. Mode via cfg.autoLp.mode (/set alpmode single|inrange): "single" = park the quote asset
    //    (rug-safe) · "inrange" = both-sided NOW (fee langsung, holds token → rug = loss).
    const inRange = a.mode === "inrange";
    const modeLabel = inRange ? "in-range" : "single-side";
    const size = natAmountStr(a.sizeEth);
    // Every AUTO-OPEN line carries the unchecked gates. An operator reading the log must be able to
    // see that a position was opened WITHOUT a tax/honeypot verdict, not infer it from the chain.
    const uncheckedTag = unchecked.length ? ` · ⚠️ belum dicek: ${unchecked.join(",")}` : "";
    let result: OpenLike;
    if (q) {
      const m = await import("../chain/v4/mint.js");
      // volatility-adaptive range width (calculate_new_range(price, volatility) idea): wider when the
      // token moved a lot (stays in range → earns fees → hits TP), narrow when calm (concentrated
      // fees). q.volPct = |1h/6h price change|. Only for in-range (single-side parks don't need it).
      // q.volPct is 0 where no indexer supplies price change → the BASE width (8sp), not a guess.
      const width = Math.max(6, Math.min(24, Math.round(8 + q.volPct / 5)));
      log.info(
        `AUTO-OPEN ${candidate.symbol} ${size} ${natSym()} ${modeLabel} v4 ${q.quote} fee ${q.fee}${inRange ? ` · vol ${q.volPct.toFixed(0)}% → width ${width}sp` : ""}${uncheckedTag}`,
      );
      if (q.quote === "usd") {
        result = inRange ? await m.openV4StableInRange(q.v4, size, { widthSpacings: width }) : await m.openV4StableSingleSide(q.v4, size);
      } else {
        result = inRange
          ? await m.openV4InRange(candidate.token, size, { fee: q.fee, widthSpacings: width })
          : await m.openV4SingleSide(candidate.token, size, { fee: q.fee });
      }
    } else if (hasWrapped()) {
      const pools = await findPools(candidate.token).catch(() => []);
      const pool = pickLpPool(pools);
      if (!pool) return skip(`tidak ada pool 3-5% (v4) / v3 fee ≥ ${(cfg.lp.minFeePpm / 10000).toFixed(2)}%`);
      log.info(`AUTO-OPEN ${candidate.symbol} ${size} ${natSym()} ${modeLabel} v3 fee ${pool.fee}${uncheckedTag}`);
      result = await openPosition(candidate.token, pool.pool, size, { mode: inRange ? "inrange" : "single" });
    } else {
      // No wrapped native (Arc) → a native-paired v3 pool CANNOT exist, so findPools() is empty by
      // construction and the only v3 shape on the chain is token/<stable>. Robinhood keeps the
      // WETH-only branch above: adding stable pools there would silently widen what auto-LP opens.
      const pools = await findStableQuotePools(candidate.token).catch(() => []);
      const pool = pickLpPool(pools);
      if (!pool) return skip(`tidak ada pool 3-5% (v4) / v3 fee ≥ ${(cfg.lp.minFeePpm / 10000).toFixed(2)}%`);
      log.info(`AUTO-OPEN ${candidate.symbol} ${size} ${natSym()} ${modeLabel} v3 stable fee ${pool.fee}${uncheckedTag}`);
      result = inRange ? await openV3StableInRange(pool, size) : await openV3StableSingleSide(pool, size);
    }
    st.opens.push({ ts: now, token: candidate.token, sizeEth: a.sizeEth, tokenId: result.tokenId });
    save(st);
    return { opened: true, reason: "opened", token: candidate.token, symbol: candidate.symbol, sizeEth: a.sizeEth, result, unchecked };
  } catch (e) {
    return skip(`open gagal: ${(e as Error).message.slice(0, 100)}`);
  } finally {
    releaseWallet();
  }
}

/**
 * #1 rebalance: re-open a v4 position on `token`, recentered on the CURRENT price, after an OOR close.
 * Respects the configured mode (inrange/single) + volatility-adaptive width. Returns null (→ stay
 * closed) if the token no longer qualifies (pool dried / rug) or the wallet is short on funds. Records
 * the open in state so autolp's per-token dedup + rate caps account for it too. Caller holds the wallet
 * lock (rebalance runs inside doClose, right after the close, so the sequence is atomic on the wallet).
 */
export async function reopenRecentered(token: string, symbol: string): Promise<OpenLike | null> {
  const a = cfg.autoLp;
  const { qualifyCandidate } = await import("../chain/candidate.js");
  const q = await qualifyCandidate(token).catch(() => null);
  if (!q) return null; // no farmable 3-5% pool anymore → don't redeploy into a dead token
  // Same gas-reserve FLOOR as the open path: the close that just ran consumed gas, so re-opening
  // with the whole remaining balance is exactly how the next close ends up unaffordable.
  const b = await balances().catch(() => null);
  if (b) {
    const spendableWei = reserveForGas(parseNat(b.eth)) + parseNat(b.weth);
    if (spendableWei < parseNat(natAmountStr(a.sizeEth))) return null; // close proceeds not enough to re-open at size
  }
  const inRange = a.mode === "inrange";
  const m = await import("../chain/v4/mint.js");
  const size = natAmountStr(a.sizeEth);
  const width = Math.max(6, Math.min(24, Math.round(8 + q.volPct / 5)));
  log.info(
    `REBALANCE ${symbol} ${size} ${natSym()} ${inRange ? "in-range" : "single-side"} v4 ${q.quote} fee ${q.fee}${inRange ? ` · vol ${q.volPct.toFixed(0)}% → width ${width}sp` : ""}`,
  );
  let result: OpenLike;
  if (q.quote === "usd") {
    result = inRange ? await m.openV4StableInRange(q.v4, size, { widthSpacings: width }) : await m.openV4StableSingleSide(q.v4, size);
  } else {
    result = inRange ? await m.openV4InRange(token, size, { fee: q.fee, widthSpacings: width }) : await m.openV4SingleSide(token, size, { fee: q.fee });
  }
  const st = load();
  st.opens.push({ ts: Date.now(), token, sizeEth: a.sizeEth, tokenId: result.tokenId });
  save(st);
  return result;
}

/** Snapshot for /auto status. */
export function autoLpStatus(): { spentToday: number; opensToday: number; lastHour: number } {
  const now = Date.now();
  const st = load();
  const today = st.opens.filter((o) => now - o.ts < 24 * 3600_000);
  return {
    spentToday: today.reduce((s, o) => s + o.sizeEth, 0),
    opensToday: today.length,
    lastHour: today.filter((o) => now - o.ts < 3600_000).length,
  };
}
