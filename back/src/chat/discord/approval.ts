import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  GuildTextBasedChannel,
  MessageCreateOptions,
} from "discord.js";
import { AgentEvent } from "@/agent/events.ts";
import { getSession } from "@/chat/discord/session.ts";
import { DiscordReply } from "@/chat/discord/reply.ts";
import { InteractionContext } from "@/chat/discord/interaction.ts";

const PENDING_COLOR = 0xffa500;
const APPROVED_COLOR = 0x2ecc71;
const REJECTED_COLOR = 0xe74c3c;

export function buildApprovalRequest(
  event: Extract<AgentEvent, { type: "approvalRequested" }>,
): MessageCreateOptions {
  const args = JSON.parse(event.summary) as Record<string, unknown>;
  const embed = new EmbedBuilder()
    .setTitle("Approval Requested")
    .setDescription(
      `The agent wants to call the tool **${event.tool}** with the following arguments:\n${
        Object.entries(args).map(([key, value]) => `- **${key}**: ${value}`)
          .join("\n")
      }`,
    )
    .setColor(PENDING_COLOR)
    .setFooter({ text: "Please approve or reject this request." });

  // customId = "approval:<approve|reject>:<toolCallId>", routed in interaction.ts
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success)
      .setCustomId(`approval:approve:${event.approvalId}`),
    new ButtonBuilder()
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger)
      .setCustomId(`approval:reject:${event.approvalId}`),
  );

  return { embeds: [embed], components: [row] };
}

export async function handleApprovalClick(
  interaction: ButtonInteraction,
  channel: GuildTextBasedChannel,
  [action, toolCallId]: string[],
  ctx: InteractionContext,
) {
  const approved = action === "approve";

  // Discord wants an answer within 3s, and removing the buttons right away
  // means you can't click twice
  await interaction.deferUpdate();
  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(approved ? APPROVED_COLOR : REJECTED_COLOR)
    .setFooter({ text: approved ? "✅ Approved" : "❌ Rejected" });
  await interaction.editReply({ embeds: [embed], components: [] });

  const reply = new DiscordReply(channel);
  await reply.start();
  try {
    const session = await getSession(channel, ctx.agent, ctx.messageCount);
    const resolved = await session.resolveApproval(
      toolCallId,
      approved,
      reply,
    );
    if (!resolved) {
      await interaction.editReply({
        embeds: [embed.setFooter({ text: "Already decided" })],
      });
    }
  } finally {
    await reply.done();
  }
}
