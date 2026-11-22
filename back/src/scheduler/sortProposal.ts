// The daily proposal: what the agent would move, sent as one DM with two
// buttons. Nothing moves here; approving is handled in chat/discord/proposal.
import type { Client, MessageCreateOptions } from "discord.js";
import prisma from "@/db.ts";
import { buildProposalMessage } from "@/chat/discord/proposal.ts";
import {
  buildProposal,
  collectCandidates,
  movesJson,
  type SortDecision,
  type SortMail,
  sortMails,
} from "@/mail/sort.ts";
import { logger } from "@/utils/logger.ts";

/** The `ScheduledRun` row that dates the daily sorting run. */
export const SORT_JOB = "mail-sort";

export const DEFAULT_SORT_TIME = "18:00";

/** A proposal nobody answered holds its mail for this long. */
export const PROPOSAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** "MAIL_SORT=0" switches the daily sorting proposal off. */
export function sortEnabled(): boolean {
  return Deno.env.get("MAIL_SORT")?.trim() !== "0";
}

/** Local time of the sorting proposal, from `SORT_TIME` ("HH:MM"). */
export function sortTime(): string {
  return Deno.env.get("SORT_TIME")?.trim() || DEFAULT_SORT_TIME;
}

/**
 * A pending proposal older than three days is denied, so its mail becomes
 * available again instead of waiting forever for a tap that never comes.
 */
export async function expireProposals(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PROPOSAL_TTL_MS);
  const { count } = await prisma.mailProposal.updateMany({
    where: { status: "pending", createdAt: { lt: cutoff } },
    data: { status: "denied", decidedAt: now },
  });
  return count;
}

export type SortRunDependencies = {
  now?: Date;
  /** Injected in tests: no provider call. */
  collect?: (now: Date) => Promise<SortMail[]>;
  decide?: (mails: SortMail[]) => Promise<SortDecision[]>;
  /** Injected in tests: no Discord client. */
  send?: (payload: MessageCreateOptions) => Promise<void>;
};

async function sendProposal(
  client: Client,
  payload: MessageCreateOptions,
  send?: (payload: MessageCreateOptions) => Promise<void>,
): Promise<void> {
  if (send) return await send(payload);

  const ownerId = Deno.env.get("DISCORD_OWNER_ID");
  if (!ownerId) throw new Error("DISCORD_OWNER_ID must be set");
  const owner = await client.users.fetch(ownerId);
  await owner.send(payload);
}

/**
 * One run: expire what nobody answered, stay quiet while a proposal is still
 * pending, otherwise propose and DM it. Returns the summary when a proposal
 * was sent, null when nothing was worth sending.
 */
export async function runSortProposal(
  client: Client,
  deps: SortRunDependencies = {},
): Promise<string | null> {
  const now = deps.now ?? new Date();

  const expired = await expireProposals(now);
  if (expired > 0) {
    logger.info(`scheduler: ${expired} old mail sorting proposal(s) expired`);
  }

  const pending = await prisma.mailProposal.count({
    where: { status: "pending" },
  });
  if (pending > 0) {
    logger.info(
      "scheduler: a mail sorting proposal is still waiting; not proposing another",
    );
    return null;
  }

  const candidates = await (deps.collect ?? collectCandidates)(now);
  if (candidates.length === 0) {
    logger.info("scheduler: no mail to sort");
    return null;
  }

  const proposal = buildProposal(await (deps.decide ?? sortMails)(candidates));
  if (proposal.moves.length === 0) {
    logger.info(
      `scheduler: nothing to move today (${proposal.summary})`,
    );
    return null;
  }

  const row = await prisma.mailProposal.create({
    data: {
      status: "pending",
      moves: movesJson(proposal.moves),
      summary: proposal.summary,
    },
  });

  await sendProposal(
    client,
    buildProposalMessage(row.id, row.summary),
    deps.send,
  );
  logger.info(
    `scheduler: mail sorting proposal sent (${proposal.moves.length} moves)`,
  );
  return row.summary;
}
