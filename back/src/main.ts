import { discordChat } from "@/chat/discord/index.ts";
import { logger } from "@/utils/logger.ts";
import { cliChat } from "@/chat/cli.ts";

const args = Deno.args;

if (args.includes("--discord")) {
  logger.info("Starting Discord bot");
  await discordChat("lys");
} else {
  logger.info("Starting CLI chat");
  await cliChat("lys");
}
