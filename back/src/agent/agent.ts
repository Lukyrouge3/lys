import OpenAI from "@openai/openai";
import { AgentConfig } from "@/config/agentConfig.ts";
import { Provider } from "@/generated/prisma/client.ts";
import { generateStreamRequest, streamResponse } from "@/llm/stream.ts";
import { createAssistantMessage, toModelMessage } from "@/llm/message.ts";
import { runTool } from "@/tools/tool.ts";
import prisma from "@/db.ts";
import { logger } from "@/utils/logger.ts";
import { EmitEvent } from "@/agent/events.ts";

const MAX_TOOL_ROUNDS = 5;

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

    const assistantMsg = await createAssistantMessage(
      content,
      conversationId,
      llmCall.id,
      toolCalls,
    );

    for (const toolCall of toolCalls) {
      let toolResponse = "";
      try {
        toolResponse = await runTool(
          toolCall.name,
          { conversationId, emit },
          JSON.parse(toolCall.arguments),
        );
      } catch (error: unknown) {
        toolResponse = `Error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }

      const storedCall = assistantMsg.toolCalls.find((call) =>
        call.apiId === toolCall.id
      )!;
      storedCall.result = toolResponse;
      await prisma.toolCall.update({
        where: { id: storedCall.id },
        data: { result: toolResponse },
      });

      emit({
        type: "toolCall",
        name: toolCall.name,
        arguments: toolCall.arguments,
        result: toolResponse,
      });
      logger.debug(`Tool call result for ${toolCall.name}: ${toolResponse}`);
    }
    messages.push(...toModelMessage(assistantMsg));
    if (toolCalls.length == 0) break;
  }
}
