import OpenAI from "@openai/openai";
import { AgentConfig } from "../config/agentConfig.ts";
import prisma from "../db.ts";
import { Prisma, Provider } from "../generated/prisma/client.ts";

const encoder = new TextEncoder();

export type StreamRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export function generateStreamRequest(
  agentConfig: AgentConfig,
  messages: { role: "system" | "user" | "assistant"; content: string }[] = [],
): StreamRequest {
  const request = {
    model: agentConfig.model,
    messages: [{
      role: "system" as const,
      content: agentConfig.systemPrompt,
    }, ...messages],
    stream: true as const,
    stream_options: { include_usage: true },
  };

  return request;
}

export type StreamResponse = OpenAI.Chat.Completions.ChatCompletionChunk;

export async function streamResponse(
  openai: OpenAI,
  request: StreamRequest,
  provider: Provider,
  streamHandler: (chunk: string) => void,
): Promise<string> {
  const start = performance.now();
  let content = "";
  let finishReason: string | null = null;
  let lastChunk: OpenAI.Chat.ChatCompletionChunk | null = null;

  try {
    const stream = await openai.chat.completions.create(request);
    for await (const chunk of stream) {
      lastChunk = chunk;
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content ?? "";
      content += delta;
      streamHandler(delta);
    }
    console.log("\n");

    // With include_usage, the last chunk carries the token counts
    const usage = lastChunk?.usage;
    await prisma.llmCall.create({
      data: {
        providerId: provider.id,
        model: request.model,
        trigger: "test",
        status: "Ok",
        finishReason,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
        latencyMs: Math.round(performance.now() - start),
        request: request as unknown as Prisma.InputJsonValue,
        response: { content, lastChunk: JSON.parse(JSON.stringify(lastChunk)) },
      },
    });
    return content;
  } catch (err) {
    await prisma.llmCall.create({
      data: {
        providerId: provider.id,
        model: request.model,
        trigger: "test",
        status: "Error",
        latencyMs: Math.round(performance.now() - start),
        request: request as unknown as Prisma.InputJsonValue,
        error: String(err),
      },
    });
    throw err;
  }
}
