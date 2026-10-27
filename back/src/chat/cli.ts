import { loadAgentConfig } from "@/config/agentConfig.ts";
import { logger } from "@/utils/logger.ts";
import { getOpenAIClient, getProvider } from "@/llm/provider.ts";
import { generateStreamRequest, streamResponse } from "@/llm/stream.ts";
import { createConversation, getLastConversation } from "@/llm/conversation.ts";
import { createAssistantMessage, createUserMessage } from "@/llm/message.ts";

export async function cliChat(
  agentName: string,
  options?: { messageCount?: number },
) {
  const agentConfig = loadAgentConfig(agentName);
  logger.info(`Loaded agent config: ${agentConfig.name}`);

  const provider = await getProvider(agentConfig.provider);
  logger.info(`Using provider: ${provider.name} (${provider.id})`);

  let conversation = await getLastConversation(options?.messageCount);
  logger.info(`Using conversation: ${conversation.name} (${conversation.id})`);
  const openai = await getOpenAIClient(provider);
  const messages = conversation.messages.reverse().map((msg) =>
    msg.modelMessage
  );

  for (const msg of conversation.messages) {
    console.log(`[${msg.role}] ${msg.content}`);
  }

  while (true) {
    const input = prompt("[user] ");
    if (!input) break;
    if (input.toLocaleLowerCase() === "/new") {
      conversation = await createConversation("Test Conversation");
      console.clear();
      logger.info(
        `Created new conversation: ${conversation.name} (${conversation.id})`,
      );
      messages.length = 0;
      continue;
    }

    const msg = await createUserMessage(input, conversation.id);
    messages.push(msg.modelMessage);

    const request = generateStreamRequest(agentConfig, messages);

    const encoder = new TextEncoder();
    Deno.stdout.writeSync(encoder.encode("[assistant] "));
    const { content: answer, llmCallId } = await streamResponse(
      openai,
      conversation.id,
      "test",
      request,
      provider,
      (chunk: string) => Deno.stdout.writeSync(encoder.encode(chunk)),
    );

    const assistantMsg = await createAssistantMessage(
      answer,
      conversation.id,
      llmCallId,
    );
    messages.push(assistantMsg.modelMessage);
  }
}
