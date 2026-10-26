import { decrypt } from "./utils/aes.ts";
import OpenAI from "@openai/openai";
import prisma from "./db.ts";
import { loadAgentConfig } from "./config/agentConfig.ts";

const encoder = new TextEncoder();

try {
  const agentConfig = loadAgentConfig("lys");
  console.log(`Loaded agent config: ${JSON.stringify(agentConfig)}`);

  const provider = await prisma.provider.findFirst({
    where: { name: agentConfig.provider },
    include: { apiKey: true },
  });
  if (!provider) {
    throw new Error("No provider found");
  }

  console.log(`Using provider: ${provider.name} (${provider.id})`);

  const decryptedApiKey = await decrypt(provider.apiKey.value);

  const openai = new OpenAI({
    baseURL: provider.host,
    apiKey: decryptedApiKey,
  });

  const request = {
    model: agentConfig.model,
    messages: [{
      role: "system" as const,
      content: agentConfig.systemPrompt,
    }, {
      role: "user" as const,
      content:
        "Hello, this is a test message to check the LLM provider's response.",
    }],
    stream: true as const,
    stream_options: { include_usage: true },
  };

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
      Deno.stdout.writeSync(encoder.encode(delta));
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
        request,
        response: { content, lastChunk: JSON.parse(JSON.stringify(lastChunk)) },
      },
    });
  } catch (err) {
    await prisma.llmCall.create({
      data: {
        providerId: provider.id,
        model: request.model,
        trigger: "test",
        status: "Error",
        latencyMs: Math.round(performance.now() - start),
        request,
        error: String(err),
      },
    });
    throw err;
  }
} finally {
  await prisma.$disconnect();
}
