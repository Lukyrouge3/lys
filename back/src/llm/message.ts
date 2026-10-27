import prisma from "@/db.ts";

export async function createUserMessage(
  content: string,
  conversationId: string,
) {
  return await prisma.message.create({
    data: {
      conversationId: conversationId,
      role: "user",
      content: content,
    },
  });
}

export async function createAssistantMessage(
  answer: string,
  conversationId: string,
  llmCallId: string,
) {
  return await prisma.message.create({
    data: {
      conversationId: conversationId,
      role: "assistant",
      content: answer,
      llmCallId: llmCallId,
    },
  });
}
