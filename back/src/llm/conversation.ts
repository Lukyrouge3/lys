import prisma from "@/db.ts";

export async function getLastConversation(messageCount = 10) {
  const conversation = await prisma.conversation.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      messages: {
        take: messageCount,
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!conversation) {
    return await createConversation("Test Conversation");
  }

  return conversation;
}

export async function createConversation(name: string) {
  const conversation = await prisma.conversation.create({
    data: { name },
    include: { messages: true },
  });
  return conversation;
}
