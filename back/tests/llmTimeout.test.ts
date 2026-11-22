import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import OpenAI from "@openai/openai";
import prisma from "@/db.ts";
import { AgentConfig } from "@/config/agentConfig.ts";
import {
  generateStreamRequest,
  llmTimeoutMs,
  streamResponse,
} from "@/llm/stream.ts";

const agentConfig: AgentConfig = {
  name: "test",
  model: "test-model",
  systemPrompt: "You are a test.",
  contextWindow: 8192,
  maxReplyTokens: 1024,
};

function hangingOpenAI(): OpenAI {
  return {
    chat: {
      completions: {
        create: (
          _request: unknown,
          options?: { signal?: AbortSignal },
        ) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal!.reason),
              { once: true },
            );
          }),
      },
    },
  } as unknown as OpenAI;
}

function withTimeoutEnv(value: string | undefined): () => void {
  const previous = Deno.env.get("LLM_TIMEOUT_MS");
  if (value === undefined) Deno.env.delete("LLM_TIMEOUT_MS");
  else Deno.env.set("LLM_TIMEOUT_MS", value);
  return () => {
    if (previous === undefined) Deno.env.delete("LLM_TIMEOUT_MS");
    else Deno.env.set("LLM_TIMEOUT_MS", previous);
  };
}

Deno.test("the timeout defaults to two minutes and ignores junk", () => {
  const restore = withTimeoutEnv(undefined);
  try {
    assertEquals(llmTimeoutMs(), 120_000);
    Deno.env.set("LLM_TIMEOUT_MS", "not a number");
    assertEquals(llmTimeoutMs(), 120_000);
    Deno.env.set("LLM_TIMEOUT_MS", "5000");
    assertEquals(llmTimeoutMs(), 5000);
  } finally {
    restore();
  }
});

Deno.test({
  name: "a provider timeout is stored as an error and ends the turn",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const restoreEnv = withTimeoutEnv("25");
    const suffix = crypto.randomUUID();
    const secret = await prisma.secret.create({
      data: { name: `timeout-key-${suffix}`, value: "unused" },
    });
    const provider = await prisma.provider.create({
      data: {
        name: `timeout-${suffix}`,
        host: "http://fake",
        apiKeyId: secret.id,
      },
    });
    const conversation = await prisma.conversation.create({
      data: { name: `timeout-${suffix}` },
    });

    try {
      const request = streamResponse(
        hangingOpenAI(),
        conversation.id,
        "test",
        generateStreamRequest(
          agentConfig,
          [],
          [{ role: "user", content: "hi" }],
        ),
        provider,
        () => {},
      );

      const err = await assertRejects(
        () => request,
        Error,
        "did not answer within 25 ms",
      );
      assertStringIncludes(err.message, "timeout");

      const row = await prisma.llmCall.findFirstOrThrow({
        where: { conversationId: conversation.id },
      });
      assertEquals(row.status, "Error");
      assertStringIncludes(row.error!, "timeout");
      assertEquals(row.error!.startsWith("timeout"), true);
    } finally {
      await prisma.llmCall.deleteMany({
        where: { conversationId: conversation.id },
      });
      await prisma.conversation.delete({ where: { id: conversation.id } });
      await prisma.provider.delete({ where: { id: provider.id } });
      await prisma.secret.delete({ where: { id: secret.id } });
      restoreEnv();
    }
  },
});
