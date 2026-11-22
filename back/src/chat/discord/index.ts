import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
} from "discord.js";
import { logger } from "@/utils/logger.ts";
import { getAgent } from "@/config/agentConfig.ts";
import { getSession } from "@/chat/discord/session.ts";
import { DiscordReply } from "@/chat/discord/reply.ts";
import { handleInteraction } from "@/chat/discord/interaction.ts";
import {
  handleProposalInteraction,
  isSortButton,
  reportProposalError,
} from "@/chat/discord/proposal.ts";
import { startMailNotifications } from "@/chat/discord/mail.ts";
import { createKeyedQueue } from "@/chat/discord/queue.ts";
import { startJobServer } from "@/jobs/server.ts";
import { startScheduler } from "@/scheduler/start.ts";

export async function discordChat(
  agentName: string,
  options?: { messageCount?: number },
) {
  const token = Deno.env.get("DISCORD_TOKEN");
  const ownerId = Deno.env.get("DISCORD_OWNER_ID");
  if (!token || !ownerId) {
    throw new Error("DISCORD_TOKEN and DISCORD_OWNER_ID must be set");
  }

  const agent = await getAgent(agentName);

  async function handle(message: Message<true>) {
    const channel = message.channel;
    if (!channel.isSendable()) return;

    const reply = new DiscordReply(channel);
    await reply.start();
    try {
      const session = await getSession(channel, agent, options?.messageCount);
      await session.send(message.content, reply);
    } finally {
      await reply.done();
    }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // One turn at a time per channel/thread; different conversations run
  // concurrently. A click uses the same chain so it cannot overtake a turn.
  const queue = createKeyedQueue();

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (message.author.id !== ownerId) return;
    if (!message.inGuild() || !message.channel.isTextBased()) return;

    const channel = message.channel;
    queue.run(channel.id, () => handle(message)).catch((err) => {
      logger.error(`Failed to handle Discord message: ${err}`);
      if (channel.isSendable()) {
        channel.send("Something went wrong, check the logs.").catch(() => {});
      }
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== ownerId) return;

    // The sorting proposal lives in the owner's DMs, which have no guild
    // channel: it is routed before the guild guard below. The handler checks
    // the owner again, and the same per-channel chain serialises the clicks.
    if (isSortButton(interaction.customId)) {
      queue.run(
        interaction.channelId,
        () => handleProposalInteraction(interaction),
      ).catch((err) => {
        logger.error(`Failed to handle Discord sorting button: ${err}`);
        reportProposalError(interaction).catch(() => {});
      });
      return;
    }

    const channel = interaction.channel;
    if (!interaction.inGuild() || !channel?.isTextBased()) return;
    if (channel.isDMBased()) return;

    // Same chain as messages: a click can start a run too
    queue.run(channel.id, () =>
      handleInteraction(interaction, channel, {
        agent,
        messageCount: options?.messageCount,
      })).catch((err) => {
        logger.error(`Failed to handle Discord interaction: ${err}`);
        if (interaction.isRepliable()) {
          interaction.reply({
            content: "Something went wrong, check the logs.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }
      });
  });

  client.once(Events.ClientReady, (ready) => {
    logger.info(`Logged in to Discord as ${ready.user.tag}`);
    startMailNotifications(client);
    startJobServer().catch((err) => {
      logger.error(`Jobs API failed to start: ${err}`);
    });

    const stopScheduler = startScheduler(client);
    // discord.js v14 has no "client destroyed" event; wrapping destroy() is
    // the best-effort way to stop the daily timers when the client goes away.
    const destroy = client.destroy.bind(client);
    client.destroy = () => {
      stopScheduler();
      return destroy();
    };
  });

  await client.login(token);
}
