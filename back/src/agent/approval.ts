import OpenAI from "@openai/openai";
import prisma from "@/db.ts";
import { ApprovalStatus, ToolCall } from "@/generated/prisma/client.ts";
import { runTool } from "@/tools/tool.ts";
import { EmitEvent } from "@/agent/events.ts";

const REJECTED_RESULT =
  "Rejected by the user. Don't retry it unless they ask again.";

export async function canResume(
  call: ToolCall,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<boolean> {
  if (messages.at(-1)?.role !== "tool") return false;
  const stillPending = await prisma.toolCall.count({
    where: { messageId: call.messageId, approval: ApprovalStatus.pending },
  });
  return stillPending === 0;
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
): Promise<ToolCall | null> {
  // Claiming it in one update is what makes a second click a no-op
  const claimed = await prisma.toolCall.updateMany({
    where: {
      id: toolCallId,
      approval: ApprovalStatus.pending,
      message: { conversationId },
    },
    data: {
      approval: approved ? ApprovalStatus.approved : ApprovalStatus.denied,
      decidedAt: new Date(),
    },
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
    data: { result },
  });
}
