import { AgentConfigWithProvider, getAgent } from "@/config/agentConfig.ts";
import { logger } from "@/utils/logger.ts";
import { getOpenAIClient } from "@/llm/provider.ts";
import {
  ConversationWithMessages,
  getLastConversation,
} from "@/llm/conversation.ts";
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
  messageCount?: number;
};

export async function createChatSession(
  agentName: string,
  { trigger, messageCount }: ChatSessionOptions,
): Promise<ChatSession> {
  const agentConfig = await getAgent(agentName);
  logger.info(`Loaded agent config: ${agentConfig.name}`);

  const provider = agentConfig.provider;
  logger.info(`Using provider: ${provider.name} (${provider.id})`);

  const conversation = await getLastConversation(messageCount);
  logger.info(`Using conversation: ${conversation.name} (${conversation.id})`);

  return getChatSession(agentConfig, conversation, trigger);
}

export type ChatSession = {
  history: ConversationWithMessages["messages"];
  send: (input: string, adapter: ChatAdapter) => Promise<void>;
};

export async function getChatSession(
  agent: AgentConfigWithProvider,
  conversation: ConversationWithMessages,
  trigger: string,
): Promise<ChatSession> {
  const provider = agent.provider;
  const history = conversation.messages.reverse();
  const messages = history.map((msg) => toModelMessage(msg)).flat();
  const openai = await getOpenAIClient(provider);

  return {
    // Messages loaded on start, oldest first
    history,
    async send(input: string, adapter: ChatAdapter) {
      const msg = await createUserMessage(input, conversation.id);
      messages.push(...toModelMessage(msg));

      await runAgent({
        openai,
        agentConfig: agent,
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
