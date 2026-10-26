import prisma from "./db.ts";
import { loadAgentConfig } from "./config/agentConfig.ts";
import { getOpenAIClient, getProvider } from "./llm/provider.ts";
import { generateStreamRequest, streamResponse } from "./llm/stream.ts";

try {
  const agentConfig = loadAgentConfig("lys");
  console.log(`Loaded agent config: ${JSON.stringify(agentConfig)}`);

  const provider = await getProvider(agentConfig.provider);
  console.log(`Using provider: ${provider.name} (${provider.id})`);

  const openai = await getOpenAIClient(provider);
  const messages = [];
  while (true) {
    const input = prompt("");
    if (!input) break;
    messages.push({
      role: "user" as const,
      content: `[${new Date().toLocaleString()}] ${input}`,
    });

    const request = generateStreamRequest(agentConfig, messages);

    const encoder = new TextEncoder();
    const answer = await streamResponse(
      openai,
      request,
      provider,
      (chunk: string) => Deno.stdout.writeSync(encoder.encode(chunk)),
    );
    messages.push({
      role: "assistant" as const,
      content: `${answer}`,
    });
  }
} finally {
  await prisma.$disconnect();
}
