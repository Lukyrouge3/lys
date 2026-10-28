import OpenAI from "@openai/openai";
import { AgentConfig } from "@/config/agentConfig.ts";
import { Provider } from "@/generated/prisma/client.ts";
import { generateStreamRequest, streamResponse } from "@/llm/stream.ts";
import { createAssistantMessage, toModelMessage } from "@/llm/message.ts";
import { runTool } from "@/tools/tool.ts";
import prisma from "@/db.ts";
import { logger } from "@/utils/logger.ts";

const MAX_TOOL_ROUNDS = 5;

export type RunAgentOptions = {
  openai: OpenAI;
  agentConfig: AgentConfig;
  tools: OpenAI.Chat.ChatCompletionTool[];
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  conversationId: string;
  trigger: string;
  provider: Provider;
  streamHandler: (chunk: string) => void;
  onTurnStart?: () => void;
  onTurnEnd?: () => void;
};

export async function runAgent({
  openai,
  agentConfig,
  tools,
  messages,
  conversationId,
  trigger,
  provider,
  streamHandler,
  onTurnStart = () => {},
  onTurnEnd = () => {},
}: RunAgentOptions) {
  for (let iteration = 0;; iteration++) {
    // Once the cap is hit, call without tools to force a text answer
    const request = generateStreamRequest(
      agentConfig,
      iteration < MAX_TOOL_ROUNDS ? tools : [],
      messages,
    );

    onTurnStart();
    const { content, llmCall, toolCalls } = await streamResponse(
      openai,
      conversationId,
      trigger,
      request,
      provider,
      streamHandler,
    );
    onTurnEnd();

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

      logger.debug(`Tool call result for ${toolCall.name}: ${toolResponse}`);
    }
    messages.push(...toModelMessage(assistantMsg));
    if (toolCalls.length == 0) break;
  }
}
