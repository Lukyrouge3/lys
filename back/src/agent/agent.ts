import OpenAI from "@openai/openai";
import { AgentConfig } from "@/config/agentConfig.ts";
import { ApprovalStatus, Provider } from "@/generated/prisma/client.ts";
import { generateStreamRequest, streamResponse } from "@/llm/stream.ts";
import { createAssistantMessage, toModelMessage } from "@/llm/message.ts";
import { runTool, ToolRegistry } from "@/tools/tool.ts";
import prisma from "@/db.ts";
import { logger } from "@/utils/logger.ts";
import { EmitEvent } from "@/agent/events.ts";

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_CALLS_PER_RESPONSE = 5;

export type RunAgentOptions = {
  openai: OpenAI;
  agentConfig: AgentConfig;
  tools: OpenAI.Chat.ChatCompletionTool[];
  /** Which tools a call may reach; production unless a test injects its own. */
  registry?: ToolRegistry;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  conversationId: string;
  trigger: string;
  provider: Provider;
  emit: EmitEvent;
  /** Remembered facts for this turn, injected as a second system message */
  memoryContext?: string;
  /** Native attachment upload, when the chat supports one */
  sendFile?: (file: { name: string; data: Uint8Array }) => Promise<void>;
};

export async function runAgent({
  openai,
  agentConfig,
  tools,
  registry,
  messages,
  conversationId,
  trigger,
  provider,
  emit,
  memoryContext = "",
  sendFile,
}: RunAgentOptions) {
  for (let iteration = 0;; iteration++) {
    // Once the cap is hit, call without tools to force a text answer
    const request = generateStreamRequest(
      agentConfig,
      iteration < MAX_TOOL_ROUNDS ? tools : [],
      messages,
      memoryContext,
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

    let paused = false;
    for (const toolCall of toolCalls) {
      const result = await runTool(
        toolCall.name,
        {
          conversationId,
          approval: ApprovalStatus.pending,
          emit,
          sendFile,
          contextWindow: agentConfig.contextWindow,
        },
        toolCall.arguments,
        registry,
      );

      const text = result.status === "ok"
        ? result.content
        : result.status === "error"
        ? `Error: ${result.content}`
        : "Not run yet: waiting for the user to approve or reject it.";
      if (result.status === "pendingApproval") paused = true;

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
    if (toolCalls.length == 0 || paused) break;
  }
}
