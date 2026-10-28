import { getAgent } from "@/config/agentConfig.ts";
import { logger } from "@/utils/logger.ts";
import { getOpenAIClient } from "@/llm/provider.ts";
import { createConversation, getLastConversation } from "@/llm/conversation.ts";
import { createUserMessage, toModelMessage } from "@/llm/message.ts";
import { generateToolRequest } from "@/tools/tool.ts";
import { runAgent } from "@/agent/agent.ts";

const tools = generateToolRequest();

// What each chat app implements to display the agent's answer
export type ChatAdapter = {
  onChunk: (chunk: string) => void;
  onTurnStart?: () => void;
  onTurnEnd?: () => void;
};

export type ChatSessionOptions = {
  trigger: string;
  conversationName: string;
  messageCount?: number;
};

export async function createChatSession(
  agentName: string,
  { trigger, conversationName, messageCount }: ChatSessionOptions,
) {
  const agentConfig = await getAgent(agentName);
  logger.info(`Loaded agent config: ${agentConfig.name}`);

  const provider = agentConfig.provider;
  logger.info(`Using provider: ${provider.name} (${provider.id})`);

  let conversation = await getLastConversation(messageCount);
  logger.info(`Using conversation: ${conversation.name} (${conversation.id})`);
  const openai = await getOpenAIClient(provider);
  const history = conversation.messages.reverse();
  const messages = history.map((msg) => toModelMessage(msg)).flat();

  return {
    // Messages loaded on start, oldest first
    history,

    async newConversation() {
      conversation = await createConversation(conversationName);
      messages.length = 0;
      logger.info(
        `Created new conversation: ${conversation.name} (${conversation.id})`,
      );
    },

    async send(input: string, adapter: ChatAdapter) {
      const msg = await createUserMessage(input, conversation.id);
      messages.push(...toModelMessage(msg));

      await runAgent({
        openai,
        agentConfig,
        tools,
        messages,
        conversationId: conversation.id,
        trigger,
        provider,
        streamHandler: adapter.onChunk,
        onTurnStart: adapter.onTurnStart,
        onTurnEnd: adapter.onTurnEnd,
      });
    },
  };
}
