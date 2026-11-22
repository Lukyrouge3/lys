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
  if (budget <= 0) {
    throw new Error(
      `Context window ${contextWindow} is too small: the system prompt and ` +
        `${tools.length} tool schemas take about ${
          estimateTokens(system) + estimateTokens(tools)
        } tokens, and the reply needs ${maxReplyTokens}. Raise the agent's ` +
        `contextWindow or lower maxReplyTokens.`,
    );
  }

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

// A hung provider call would stall the whole assistant (and the mail watcher
// shares the process), so every request gets a deadline. Override it with
// LLM_TIMEOUT_MS when a slower model legitimately needs more than two minutes.
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export function llmTimeoutMs(): number {
  const raw = Deno.env.get("LLM_TIMEOUT_MS");
  if (!raw) return DEFAULT_LLM_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_LLM_TIMEOUT_MS;
}

function isTimeout(error: unknown): boolean {
  // The SDK sometimes wraps fetch errors, so follow the cause chain as well.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const name = (current as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type StreamResponse = OpenAI.Chat.Completions.ChatCompletionChunk;

export type StreamedToolCall = { id: string; name: string; arguments: string };

export function addToolCallDeltas(
  toolCalls: StreamedToolCall[],
  deltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] =
    [],
) {
  for (const toolCall of deltas) {
    // A provider may skip an index (or announce one it never finishes), so the
    // array is filled up to the index: iterating it must never yield undefined.
    const index = toolCall.index ?? toolCalls.length;
    while (toolCalls.length <= index) {
      toolCalls.push({ id: "", name: "", arguments: "" });
    }
    const call = toolCalls[index];
    if (toolCall.id) call.id = toolCall.id;
    if (toolCall.function?.name) call.name = toolCall.function.name;
    if (toolCall.function?.arguments) {
      call.arguments += toolCall.function.arguments;
    }
  }
}

/**
 * The calls worth storing. One without an id cannot be answered, and one
 * without a name cannot be run; either would produce an invalid next request.
 */
export function usableToolCalls(
  toolCalls: StreamedToolCall[],
): StreamedToolCall[] {
  return toolCalls.filter((call) => call.id !== "" && call.name !== "");
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
  const timeoutMs = llmTimeoutMs();

  try {
    const stream = await openai.chat.completions.create(request, {
      signal: AbortSignal.timeout(timeoutMs),
    });

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
    return { content, llmCall, toolCalls: usableToolCalls(toolCalls) };
  } catch (err) {
    dump({ error: String(err) });
    const timedOut = isTimeout(err);
    await prisma.llmCall.create({
      data: {
        providerId: provider.id,
        model: request.model,
        trigger,
        status: "Error",
        latencyMs: Math.round(performance.now() - start),
        request: request as unknown as Prisma.InputJsonValue,
        error: timedOut
          ? `timeout: no answer from the provider within ${timeoutMs} ms (${
            String(err)
          })`
          : String(err),
        conversationId: conversationId,
      },
    });
    if (timedOut) {
      throw new Error(
        `The model did not answer within ${timeoutMs} ms; the request was aborted (timeout).`,
        { cause: err },
      );
    }
    throw err;
  }
}
