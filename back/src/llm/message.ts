import prisma from "@/db.ts";
import { Message, ToolCall } from "@/generated/prisma/client.ts";
import OpenAI from "@openai/openai";

export async function createUserMessage(
  content: string,
  conversationId: string,
): Promise<Message & { toolCalls: ToolCall[] }> {
  return await prisma.message.create({
    data: {
      conversationId: conversationId,
      role: "user",
      content: content,
    },
    include: {
      toolCalls: true,
    },
  });
}

export async function createAssistantMessage(
  answer: string,
  conversationId: string,
  llmCallId: string,
  toolCalls: { id: string; name: string; arguments: string }[] = [],
): Promise<Message & { toolCalls: ToolCall[] }> {
  return await prisma.message.create({
    data: {
      conversationId: conversationId,
      role: "assistant",
      content: answer,
      llmCallId: llmCallId,
      toolCalls: {
        create: toolCalls.map((call) => ({
          apiId: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      },
    },
    include: {
      toolCalls: true,
    },
  });
}

// Truncated calls (e.g. cut off by the context limit) have broken JSON,
// which makes llama.cpp's template fail on every later request
function validArguments(args: string): string {
  try {
    JSON.parse(args);
    return args;
  } catch {
    return "{}";
  }
}

export function toModelMessage(
  msg: Message & { toolCalls: ToolCall[] },
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const { role, content, createdAt, toolCalls } = msg;
  if (role === "user") {
    return [{
      role: "user",
      content: `[${createdAt.toLocaleString()}] ${content}`,
    }];
  }
  if (toolCalls.length === 0) {
    return [{ role, content }];
  }
  return [
    {
      role: "assistant",
      content: content || "",
      tool_calls: toolCalls.map((c) => ({
        id: c.apiId,
        type: "function" as const,
        function: { name: c.name, arguments: validArguments(c.arguments) },
      })),
    },
    ...toolCalls.map((c) => ({
      role: "tool" as const,
      tool_call_id: c.apiId,
      content: c.result ?? "",
    })),
  ];
}
