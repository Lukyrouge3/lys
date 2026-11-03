import OpenAI from "@openai/openai";
import { AgentConfig } from "@/config/agentConfig.ts";
import { ApprovalStatus, Provider } from "@/generated/prisma/client.ts";
import { generateStreamRequest, streamResponse } from "@/llm/stream.ts";
import { createAssistantMessage, toModelMessage } from "@/llm/message.ts";
import { runTool } from "@/tools/tool.ts";
import prisma from "@/db.ts";
import { logger } from "@/utils/logger.ts";
import { EmitEvent } from "@/agent/events.ts";

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_CALLS_PER_RESPONSE = 5;

export type RunAgentOptions = {
  openai: OpenAI;
  agentConfig: AgentConfig;
  tools: OpenAI.Chat.ChatCompletionTool[];
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  conversationId: string;
  trigger: string;
  provider: Provider;
  emit: EmitEvent;
};

export async function runAgent({
  openai,
  agentConfig,
  tools,
  messages,
  conversationId,
  trigger,
  provider,
  emit,
}: RunAgentOptions) {
  for (let iteration = 0;; iteration++) {
    // Once the cap is hit, call without tools to force a text answer
    const request = generateStreamRequest(
      agentConfig,
      iteration < MAX_TOOL_ROUNDS ? tools : [],
      messages,
    );

    emit({ type: "turnStart" });
    const { content, llmCall, toolCalls } = await streamResponse(
      openai,
      conversationId,
      trigger,
      request,
      provider,
      (text) => {
        if (text) emit({ type: "chunk", text });
      },
    );
    emit({ type: "turnEnd" });

    // Extra calls are dropped before being stored, so a runaway response
    // can't flood the history
    if (toolCalls.length > MAX_TOOL_CALLS_PER_RESPONSE) {
      logger.warn(
        `Dropped ${
          toolCalls.length - MAX_TOOL_CALLS_PER_RESPONSE
        } of ${toolCalls.length} tool calls`,
      );
      toolCalls.length = MAX_TOOL_CALLS_PER_RESPONSE;
    }

    const assistantMsg = await createAssistantMessage(
      content,
      conversationId,
      llmCall.id,
      toolCalls,
    );

    for (const toolCall of toolCalls) {
      const result = await runTool(
        toolCall.name,
        { conversationId, approval: ApprovalStatus.pending, emit },
        toolCall.arguments,
      );

      const text = result.status === "ok"
        ? result.content
        : result.status === "error"
        ? `Error: ${result.content}`
        : `Not run yet: the user now sees Approve / Reject buttons for this call. Tell \
        them in one short sentence what it will do. Don't ask them to confirm in text, the buttons do that.`;

      const storedCall = assistantMsg.toolCalls.find((call) =>
        call.apiId === toolCall.id
      )!;
      storedCall.result = text;
      await prisma.toolCall.update({
        where: { id: storedCall.id },
        data: {
          result: text,
          approval: result.status === "pendingApproval"
            ? ApprovalStatus.pending
            : null,
        },
      });

      if (result.status === "pendingApproval") {
        emit({
          type: "approvalRequested",
          approvalId: storedCall.id,
          tool: toolCall.name,
          summary: toolCall.arguments,
        });
      }

      emit({
        type: "toolCall",
        name: toolCall.name,
        arguments: toolCall.arguments,
        result: text,
      });
      logger.debug(`Tool call result for ${toolCall.name}: ${text}`);
    }
    messages.push(...toModelMessage(assistantMsg));
    if (toolCalls.length == 0) break;
  }
}
