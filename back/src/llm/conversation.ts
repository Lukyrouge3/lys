import prisma from "@/db.ts";
import {
  Conversation,
  Message,
  Platform,
  ToolCall,
} from "@/generated/prisma/client.ts";

export type ConversationWithMessages = Conversation & {
  messages: (Message & { toolCalls: ToolCall[] })[];
};

export async function getLastConversation(
  messageCount = 10,
): Promise<
  ConversationWithMessages
> {
  const conversation = await prisma.conversation.findFirst({
    // Conversations tied to a platform (e.g. a Discord thread) aren't picked up here
    where: { platform: null },
    orderBy: { createdAt: "desc" },
    include: {
      messages: {
        take: messageCount,
        orderBy: { createdAt: "desc" },
        include: { toolCalls: true },
      },
    },
  });
  if (!conversation) {
    return await createConversation("Test Conversation");
  }

  return conversation;
}

export async function createConversation(
  name: string,
  platform?: Platform,
  externalId?: string,
): Promise<
  ConversationWithMessages
> {
  const conversation = await prisma.conversation.create({
    data: { name, platform, externalId },
    include: {
      messages: {
        include: { toolCalls: true },
      },
    },
  });
  return conversation;
}

export async function getConversation(
  platform: Platform,
  externalId: string,
  messageCount = 10,
): Promise<ConversationWithMessages | null> {
  return await prisma.conversation.findUnique({
    where: { platform_externalId: { platform, externalId } },
    include: {
      messages: {
        take: messageCount,
        orderBy: { createdAt: "desc" },
        include: { toolCalls: true },
      },
    },
  });
}
