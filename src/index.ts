/**
 * Entrypoint. Validates secrets, takes a single-instance lock, wires graceful shutdown,
 * then starts the Telegram loop.
 *
 * Run (Robinhood — the default, RH_CHAIN unset):
 *   node --env-file=.env --import tsx src/index.ts       (or `npm start`)
 * Run (Arc — a SECOND, fully separate process with its own .env, bot token and data dir):
 *   node --env-file=.env.arc --import tsx src/index.ts   (RH_CHAIN=arc lives in .env.arc)
 *
 * One process drives exactly ONE chain: RH_CHAIN selects chains/<key>.json, data/<key>/ and the
 * lock file, so the two never touch each other's positions. The banner below names the chain
 * because the two processes otherwise log identically — and mixing up which terminal is holding
 * which chain's positions is how you close the wrong one.
 */
import { assertSecrets } from "./config.js";
import { acquireLock, CHAIN_KEY, DATA_DIR } from "./util/files.js";
import { CHAIN } from "./chain/profile.js";
import { logger } from "./util/log.js";
import { run, stop } from "./telegram/bot.js";

const log = logger("main");

async function main(): Promise<void> {
  assertSecrets();
  log.info(
    `chain ${CHAIN.name} (RH_CHAIN=${CHAIN_KEY}, id ${CHAIN.chainId}) · native ${CHAIN.native.symbol} · data ${DATA_DIR}`,
  );
  const release = acquireLock();

  const shutdown = (sig: string) => {
    log.info(`${sig} — shutting down cleanly…`);
    stop();
    release();
    // give in-flight Telegram calls a beat, then exit
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => log.error("uncaughtException", e));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));

  await run();
  release();
}

main().catch((e) => {
  log.error(String(e?.message ?? e));
  process.exit(1);
});
