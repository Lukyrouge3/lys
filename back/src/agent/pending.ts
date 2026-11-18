// Approvals nobody answered, and runs a crash interrupted. Kept apart from
// approval.ts so the memory layer can ask about pending work without importing
// the tool registry.
import prisma from "@/db.ts";
import { ApprovalStatus } from "@/generated/prisma/enums.ts";

/** How long a request waits for a button before it counts as not pressed. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const EXPIRED_RESULT =
  "Expired: nobody decided within 24 hours, so it was not run.";

export const INTERRUPTED_RESULT =
  "Interrupted: the run started but never finished, so it may or may not have happened. Check before retrying.";

/** The states a call sits in before anyone has decided it. */
export const UNDECIDED = [
  ApprovalStatus.pending,
  ApprovalStatus.executing,
] as const;

/** How many calls in this response are still waiting on a decision. */
export function undecidedCount(messageId: string): Promise<number> {
  return prisma.toolCall.count({
    where: { messageId, approval: { in: [...UNDECIDED] } },
  });
}

/**
 * Answers the requests nobody answered, so a forgotten button cannot hold the
 * conversation - or its memory retention - open forever.
 */
export async function expirePendingApprovals(
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - APPROVAL_TTL_MS);
  const { count } = await prisma.toolCall.updateMany({
    where: {
      approval: ApprovalStatus.pending,
      createdAt: { lt: cutoff },
    },
    data: {
      approval: ApprovalStatus.denied,
      decidedAt: now,
      result: EXPIRED_RESULT,
    },
  });
  return count;
}

/**
 * Closes runs that were claimed but never finished. Only correct at startup:
 * while the process is up, an executing row belongs to a live run.
 */
export async function recoverInterruptedRuns(
  now = new Date(),
): Promise<number> {
  const { count } = await prisma.toolCall.updateMany({
    where: { approval: ApprovalStatus.executing },
    data: {
      approval: ApprovalStatus.failed,
      decidedAt: now,
      result: INTERRUPTED_RESULT,
    },
  });
  return count;
}
