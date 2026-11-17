import OpenAI from "@openai/openai";
import { AgentConfig } from "@/config/agentConfig.ts";
import prisma from "@/db.ts";
import { LlmCall, Prisma, Provider } from "@/generated/prisma/client.ts";
import { startDump } from "@/utils/debugDump.ts";
import { estimateTokens, trimHistory } from "@/llm/trim.ts";

export type StreamRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export function generateStreamRequest(
  agentConfig: AgentConfig,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
  messages: OpenAI.Chat.ChatCompletionMessageParam[] = [],
  memoryContext = "",
): StreamRequest {
  const contextWindow = Math.max(agentConfig.contextWindow, 2048);
  // Never let the reply budget eat the whole window
  const maxReplyTokens = Math.min(
    Math.max(agentConfig.maxReplyTokens, 1),
    contextWindow - 1024,
  );

  const system: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system" as const, content: agentConfig.systemPrompt },
  ];
  if (memoryContext) {
    system.push({ role: "system" as const, content: memoryContext });
  }

  const budget = contextWindow - maxReplyTokens - estimateTokens(system) -
    estimateTokens(tools);

  const request = {
    model: agentConfig.model,
    messages: [...system, ...trimHistory(messages, budget)],
    max_tokens: maxReplyTokens,
    stream: true as const,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
  };

  return request;
}

export type StreamResponse = OpenAI.Chat.Completions.ChatCompletionChunk;

export type StreamedToolCall = { id: string; name: string; arguments: string };

export function addToolCallDeltas(
  toolCalls: StreamedToolCall[],
  deltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] =
    [],
) {
  for (const toolCall of deltas) {
    toolCalls[toolCall.index] ??= { id: "", name: "", arguments: "" };
    const call = toolCalls[toolCall.index];
    if (toolCall.id) call.id = toolCall.id;
    if (toolCall.function?.name) call.name = toolCall.function.name;
    if (toolCall.function?.arguments) {
      call.arguments += toolCall.function.arguments;
    }
  }
}

export async function streamResponse(
  openai: OpenAI,
  conversationId: string | null,
  trigger: string,
  request: StreamRequest,
  provider: Provider,
  streamHandler: (chunk: string) => void,
): Promise<
  {
    content: string;
    llmCall: LlmCall;
    toolCalls: StreamedToolCall[];
  }
> {
  const start = performance.now();
  let content = "";
  let finishReason: string | null = null;
  let lastChunk: OpenAI.Chat.ChatCompletionChunk | null = null;

  const dump = startDump(request);

  try {
    const stream = await openai.chat.completions.create(request);

    const toolCalls: StreamedToolCall[] = [];
    for await (const chunk of stream) {
      dump(chunk);
      lastChunk = chunk;
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const contentDelta = choice?.delta?.content ?? "";
      content += contentDelta;
      streamHandler(contentDelta);

      addToolCallDeltas(toolCalls, choice?.delta?.tool_calls);
    }

    // With include_usage, the last chunk carries the token counts
    const usage = lastChunk?.usage;
    const llmCall = await prisma.llmCall.create({
      data: {
        providerId: provider.id,
        model: request.model,
        trigger,
        status: "Ok",
        finishReason,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
        latencyMs: Math.round(performance.now() - start),
        request: request as unknown as Prisma.InputJsonValue,
        response: { content, lastChunk: JSON.parse(JSON.stringify(lastChunk)) },
        conversationId: conversationId,
      },
    });
    return { content, llmCall, toolCalls };
  } catch (err) {
    dump({ error: String(err) });
    await prisma.llmCall.create({
      data: {
        providerId: provider.id,
        model: request.model,
        trigger,
        status: "Error",
        latencyMs: Math.round(performance.now() - start),
        request: request as unknown as Prisma.InputJsonValue,
        error: String(err),
        conversationId: conversationId,
      },
    });
    throw err;
  }
}
