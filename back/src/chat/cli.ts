import { loadAgentConfig } from "@/config/agentConfig.ts";
import { logger } from "@/utils/logger.ts";
import { getOpenAIClient, getProvider } from "@/llm/provider.ts";
import { createConversation, getLastConversation } from "@/llm/conversation.ts";
import { createUserMessage, toModelMessage } from "@/llm/message.ts";
import { generateToolRequest } from "@/tools/tool.ts";
import { runAgent } from "@/agent/agent.ts";

const tools = generateToolRequest();

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
    toModelMessage(msg)
  ).flat();

  for (const msg of conversation.messages) {
    if (msg.role === "assistant" && msg.toolCalls.length > 0) {
      continue;
    }
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
    messages.push(...toModelMessage(msg));

    const encoder = new TextEncoder();
    await runAgent({
      openai,
      agentConfig,
      tools,
      messages,
      conversationId: conversation.id,
      trigger: "test",
      provider,
      streamHandler: (chunk: string) =>
        Deno.stdout.writeSync(encoder.encode(chunk)),
      onTurnStart: () => Deno.stdout.writeSync(encoder.encode("[assistant] ")),
    });
  }
}
