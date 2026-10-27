import prisma from "@/db.ts";
import { Conversation, Message, ToolCall } from "@/generated/prisma/client.ts";

export async function getLastConversation(
  messageCount = 10,
): Promise<
  Conversation & { messages: (Message & { toolCalls: ToolCall[] })[] }
> {
  const conversation = await prisma.conversation.findFirst({
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
): Promise<
  Conversation & { messages: (Message & { toolCalls: ToolCall[] })[] }
> {
  const conversation = await prisma.conversation.create({
    data: { name },
    include: {
      messages: {
        include: { toolCalls: true },
      },
    },
  });
  return conversation;
}
