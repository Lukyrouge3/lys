import { GuildTextBasedChannel } from "discord.js";
import { logger } from "@/utils/logger.ts";
import { ChatSession, getChatSession } from "@/chat/session.ts";
import { AgentConfigWithProvider } from "@/config/agentConfig.ts";
import { createConversation, getConversation } from "@/llm/conversation.ts";

const sessions = new Map<string, ChatSession>();

// One session per channel/thread, backed by the conversation linked to it
export async function getSession(
  channel: GuildTextBasedChannel,
  agent: AgentConfigWithProvider,
  messageCount?: number,
): Promise<ChatSession> {
  let session = sessions.get(channel.id);
  if (session) return session;

  logger.debug(`Cache miss for channel ${channel.id}`);
  let conversation = await getConversation("discord", channel.id, messageCount);
  if (!conversation) {
    conversation = await createConversation(
      channel.name || "Discord Conversation",
      "discord",
      channel.id,
    );
    logger.info(
      `Created new conversation: ${conversation.name} (${conversation.id})`,
    );
  }

  session = await getChatSession(agent, conversation, "discord");
  sessions.set(channel.id, session);
  return session;
}
