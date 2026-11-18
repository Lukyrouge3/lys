import prisma from "@/db.ts";
import { ApprovalStatus, ToolCall } from "@/generated/prisma/client.ts";
import { defaultTools, runTool, ToolRegistry } from "@/tools/tool.ts";
import { EmitEvent } from "@/agent/events.ts";
import { expirePendingApprovals, undecidedCount } from "@/agent/pending.ts";

const REJECTED_RESULT =
  "Rejected by the user. Don't retry it unless they ask again.";

/**
 * Whether the model can be asked to continue after a decision: nothing else in
 * that response is undecided, and nothing was said after the tool result. Both
 * come from the database, so a restart does not change the answer.
 */
export async function canResume(
  call: ToolCall,
  conversationId: string,
): Promise<boolean> {
  const [undecided, latest] = await Promise.all([
    undecidedCount(call.messageId),
    prisma.message.findFirst({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
  ]);
  return undecided === 0 && latest?.id === call.messageId;
}

// Runs or rejects a tool call that was waiting for approval, and stores the outcome.
// Returns null if the call isn't pending in this conversation (unknown id,
// already decided, double click...), so it never runs twice.
export async function resolveApproval(
  toolCallId: string,
  conversationId: string,
  approved: boolean,
  emit: EmitEvent,
  sendFile?: (file: { name: string; data: Uint8Array }) => Promise<void>,
  registry: ToolRegistry = defaultTools,
): Promise<ToolCall | null> {
  await expirePendingApprovals();

  // Claiming it in one update is what makes a second click a no-op. It is a
  // claim, not the decision: if the process dies while the tool runs, the row
  // stays "executing" and startup reports it instead of pretending it ran.
  const claimed = await prisma.toolCall.updateMany({
    where: {
      id: toolCallId,
      approval: ApprovalStatus.pending,
      message: { conversationId },
    },
    data: { approval: ApprovalStatus.executing },
  });
  if (claimed.count === 0) return null;

  const call = await prisma.toolCall.findUniqueOrThrow({
    where: { id: toolCallId },
  });

  let result = REJECTED_RESULT;
  if (approved) {
    const toolResult = await runTool(
      call.name,
      { conversationId, approval: ApprovalStatus.approved, emit, sendFile },
      call.arguments,
      registry,
    );
    result = toolResult.status === "ok"
      ? toolResult.content
      : toolResult.status === "error"
      ? `Error: ${toolResult.content}`
      : REJECTED_RESULT;
  }

  emit({
    type: "toolCall",
    name: call.name,
    arguments: call.arguments,
    result,
  });

  return await prisma.toolCall.update({
    where: { id: toolCallId },
    data: {
      approval: approved ? ApprovalStatus.approved : ApprovalStatus.denied,
      decidedAt: new Date(),
      result,
    },
  });
}
