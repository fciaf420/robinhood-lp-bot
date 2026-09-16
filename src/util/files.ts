/**
 * Atomic JSON persistence + a process lock.
 *
 * Why atomic: the ledger (lp-ledger.json) and positions.json are the ONLY record of
 * realized PnL. A plain fs.writeFileSync that is interrupted mid-write (crash, SIGKILL,
 * disk full) leaves a truncated, unparseable file → history gone. We write to a temp
 * file and rename() over the target — rename is atomic on the same filesystem, so a
 * reader always sees either the old or the new whole file, never a half.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (one level up from src/util). All state files live under data/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Chain whose state lives directly in data/ — the original layout, never migrated. */
export const DEFAULT_CHAIN = "robinhood";

/**
 * Which chain this process runs (RH_CHAIN; unset = robinhood). Read here — the lowest-level
 * module — instead of from the chain profile, because profile.ts needs ROOT from this file and
 * a two-way import would deadlock the ESM init order.
 *
 * Slug-restricted on purpose: this string is a PATH SEGMENT below, so RH_CHAIN=../../etc would
 * otherwise point the state directory anywhere on disk.
 */
export const CHAIN_KEY = ((): string => {
  const raw = (process.env.RH_CHAIN || "").trim().toLowerCase();
  if (!raw) return DEFAULT_CHAIN;
  if (!/^[a-z0-9-]+$/.test(raw)) throw new Error(`RH_CHAIN "${raw}" invalid — cuma huruf kecil, angka, strip.`);
  return raw;
})();

/**
 * State directory. The LIVE Robinhood bot keeps data/ exactly where it is (positions, ledger
 * and PnL history are irreplaceable — nothing is moved or migrated); any other chain gets
 * data/<chainKey>/. They must stay separate: v3/v4 tokenIds are per-chain counters that
 * collide across chains, so one shared positions.json would mix two chains' NFTs.
 */
export const DATA_DIR = CHAIN_KEY === DEFAULT_CHAIN ? path.join(ROOT, "data") : path.join(ROOT, "data", CHAIN_KEY);

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Absolute path for a state file name (e.g. "positions.json"). */
export function dataPath(name: string): string {
  return path.join(DATA_DIR, name);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file + rename. Never leaves a partial file behind. */
export function writeJson(file: string, value: unknown): void {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Single-instance lock. Two bot processes polling the same Telegram token fight over
 * getUpdates (409 Conflict) and can double-close positions. acquireLock() refuses to
 * start a second instance unless the lock is stale (previous process is gone).
 * Returns a release() to call on shutdown.
 *
 * The lock lives in DATA_DIR, i.e. PER CHAIN — the Robinhood and Arc bots are two processes
 * with two Telegram tokens and two state dirs, so they must be allowed to run side by side.
 * Two processes on the SAME chain are still refused, which is the case that corrupts state.
 */
export function acquireLock(name = "bot.lock"): () => void {
  ensureDataDir();
  const file = dataPath(name);
  const existing = readJson<{ pid: number } | null>(file, null);
  if (existing && isAlive(existing.pid) && existing.pid !== process.pid) {
    throw new Error(
      `Instance lain lagi jalan (pid ${existing.pid}). Matiin dulu, atau hapus ${file} kalau yakin mati.`,
    );
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return () => {
    try {
      const cur = readJson<{ pid: number } | null>(file, null);
      if (cur?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}
