import { ButtonInteraction, GuildTextBasedChannel } from "discord.js";
import { logger } from "@/utils/logger.ts";
import { AgentConfigWithProvider } from "@/config/agentConfig.ts";
import { handleApprovalClick } from "@/chat/discord/approval.ts";

export type InteractionContext = {
  agent: AgentConfigWithProvider;
  messageCount?: number;
};

type InteractionHandler = (
  interaction: ButtonInteraction,
  channel: GuildTextBasedChannel,
  args: string[],
  ctx: InteractionContext,
) => Promise<void>;

// Button customIds look like "<prefix>:<args...>", the prefix picks the handler
const handlers: Record<string, InteractionHandler> = {
  "approval": handleApprovalClick,
};

export async function handleInteraction(
  interaction: ButtonInteraction,
  channel: GuildTextBasedChannel,
  ctx: InteractionContext,
) {
  const [prefix, ...args] = interaction.customId.split(":");
  const handler = handlers[prefix];
  if (!handler) {
    logger.warn(`No handler for button ${interaction.customId}`);
    return;
  }
  await handler(interaction, channel, args, ctx);
}
