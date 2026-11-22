// The DM that asks for one tap: the summary of what the agent would move, an
// approve and a deny button, and the handler behind them. Approving claims the
// proposal atomically, so a double click can never move the mail twice.
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  MessageFlags,
} from "discord.js";
import prisma from "@/db.ts";
import { applyMoves, type MoveResult } from "@/mail/imapMove.ts";
import { parseMoves } from "@/mail/sort.ts";
import { logger } from "@/utils/logger.ts";

/** Prefix of the two buttons; `sort:<proposalId>:<approve|deny>`. */
export const SORT_PREFIX = "sort:";

export type ProposalAction = "approve" | "deny";

export function proposalText(summary: string): string {
  return `📬 Mail sorting proposal\n${summary}`;
}

/** The row of buttons a proposal DM carries. */
export function proposalButtons(
  proposalId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success)
      .setCustomId(`${SORT_PREFIX}${proposalId}:approve`),
    new ButtonBuilder()
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setCustomId(`${SORT_PREFIX}${proposalId}:deny`),
  );
}

export function buildProposalMessage(
  proposalId: string,
  summary: string,
): MessageCreateOptions {
  return {
    content: proposalText(summary),
    components: [proposalButtons(proposalId)],
  };
}

/** True for a button this module owns, wherever it is clicked. */
export function isSortButton(customId: string): boolean {
  return customId.startsWith(SORT_PREFIX);
}

export function parseSortButton(
  customId: string,
): { id: string; action: ProposalAction } | null {
  const [prefix, id, action] = customId.split(":");
  if (`${prefix}:` !== SORT_PREFIX || !id) return null;
  if (action !== "approve" && action !== "deny") return null;
  return { id, action };
}

/** "Moved 12, skipped 2, failed 0" — the one line the DM ends with. */
export function resultLine(results: MoveResult[]): string {
  const count = (outcome: MoveResult["outcome"]) =>
    results.filter((result) => result.outcome === outcome).length;
  return `Moved ${count("moved")}, skipped ${count("skipped")}, failed ${
    count("failed")
  }`;
}

export type ProposalDependencies = {
  /** Injected in tests so no test opens a mailbox. */
  apply?: typeof applyMoves;
  /** Injected in tests; production reads `DISCORD_OWNER_ID`. */
  ownerId?: string;
};

function alreadyDecided(status: string | undefined): string {
  const what = status ? ` (${status})` : "";
  return `This sorting proposal was already decided${what}. Nothing was moved again.`;
}

/**
 * Approve or deny. The owner check is here too, because these buttons live in
 * a DM and never pass the guild interaction handler. The claim is one
 * conditional update, so two clicks cannot both run the moves.
 */
export async function handleProposalInteraction(
  interaction: ButtonInteraction,
  deps: ProposalDependencies = {},
): Promise<void> {
  const ownerId = deps.ownerId ?? Deno.env.get("DISCORD_OWNER_ID");
  if (!ownerId || interaction.user.id !== ownerId) {
    logger.warn(
      `Ignoring sorting button from ${interaction.user.id}: not the owner`,
    );
    return;
  }

  const button = parseSortButton(interaction.customId);
  if (!button) {
    logger.warn(`Unusable sorting button ${interaction.customId}`);
    return;
  }

  // Discord wants an answer within 3s; the moves may take longer.
  await interaction.deferUpdate();

  const apply = deps.apply ?? applyMoves;
  const claimed = await prisma.mailProposal.updateMany({
    where: { id: button.id, status: "pending" },
    data: {
      status: button.action === "approve" ? "approved" : "denied",
      decidedAt: new Date(),
    },
  });

  if (claimed.count === 0) {
    const existing = await prisma.mailProposal.findUnique({
      where: { id: button.id },
    });
    await interaction.editReply({
      content: alreadyDecided(existing?.status),
      components: [],
    });
    return;
  }

  const proposal = await prisma.mailProposal.findUnique({
    where: { id: button.id },
  });
  const summary = proposal?.summary ?? "";

  if (button.action === "deny") {
    await interaction.editReply({
      content: `${proposalText(summary)}\n\nDenied. Nothing moved.`,
      components: [],
    });
    return;
  }

  let results: MoveResult[] = [];
  try {
    results = await apply(parseMoves(proposal?.moves));
  } catch (err) {
    logger.error(`Applying sorting proposal ${button.id} failed: ${err}`);
  }

  // Failed only when every single move failed; a partial run is still applied.
  const status = results.length > 0 &&
      results.every((result) => result.outcome === "failed")
    ? "failed"
    : "applied";

  await prisma.mailProposal.update({
    where: { id: button.id },
    data: { status },
  });

  await interaction.editReply({
    content: `${proposalText(summary)}\n\n${resultLine(results)}`,
    components: [],
  });
}

/** Ephemeral error reply, also after a deferred click. */
export async function reportProposalError(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload: InteractionReplyOptions = {
    content: "Something went wrong, check the logs.",
    flags: MessageFlags.Ephemeral,
  };
  const send = interaction.deferred || interaction.replied
    ? interaction.followUp(payload)
    : interaction.reply(payload);
  await send.catch(() => {});
}
