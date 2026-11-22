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
import { startMailNotifications } from "@/chat/discord/mail.ts";
import { dmOwner } from "@/chat/discord/notify.ts";
import { startJobServer } from "@/jobs/server.ts";

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

  // Handle one message at a time so turns never interleave
  let queue = Promise.resolve();

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (message.author.id !== ownerId) return;
    if (!message.inGuild() || !message.channel.isTextBased()) return;

    queue = queue.then(() => handle(message)).catch((err) => {
      logger.error(`Failed to handle Discord message: ${err}`);
      if (message.channel.isSendable()) {
        message.channel.send("Something went wrong, check the logs.").catch(
          () => {},
        );
      }
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== ownerId) return;
    const channel = interaction.channel;
    if (!interaction.inGuild() || !channel?.isTextBased()) return;
    if (channel.isDMBased()) return;

    // Same queue as messages: a click can start a run too
    queue = queue.then(() =>
      handleInteraction(interaction, channel, {
        agent,
        messageCount: options?.messageCount,
      })
    ).catch((err) => {
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
    // The extension posts here; the pings go out as DMs like the mail notices
    startJobServer({ notify: (text) => dmOwner(client, text) }).catch((err) => {
      logger.error(`Jobs API failed to start: ${err}`);
    });
  });

  await client.login(token);
}
