import { discordChat } from "@/chat/discord/index.ts";
import { logger } from "@/utils/logger.ts";
import { cliChat } from "@/chat/cli.ts";
import {
  expirePendingApprovals,
  recoverInterruptedRuns,
} from "@/agent/pending.ts";

// A run interrupted by the last shutdown is reported, not left looking
// approved, and buttons nobody pressed stop holding turns open.
const interrupted = await recoverInterruptedRuns();
if (interrupted > 0) {
  logger.warn(
    `Closed ${interrupted} interrupted tool run(s); their results are unknown`,
  );
}
const expired = await expirePendingApprovals();
if (expired > 0) {
  logger.info(`Expired ${expired} approval request(s) nobody answered`);
}

const args = Deno.args;

if (args.includes("--discord")) {
  logger.info("Starting Discord bot");
  await discordChat("lys");
} else {
  logger.info("Starting CLI chat");
  await cliChat("lys");
}
