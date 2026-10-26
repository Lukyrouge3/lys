import { PrismaClient } from "./generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { decrypt, encrypt } from "./utils/aes.ts";
import OpenAI from "@openai/openai";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Deno.env.get("DATABASE_URL") }),
});
try {
  const provider = await prisma.provider.findFirst({
    include: { apiKey: true },
  });
  if (!provider) {
    throw new Error("No provider found");
  }

  const decryptedApiKey = await decrypt(provider.apiKey.value);

  const openai = new OpenAI({
    baseURL: provider.host,
    apiKey: decryptedApiKey,
  });

  const stream = await openai.chat.completions.create({
    model: "qwen3-4b",
    messages: [{ role: "user", content: "Explain the capital of France." }],
    stream: true,
  });
  for await (const chunk of stream) {
    Deno.stdout.writeSync(
      new TextEncoder().encode(chunk.choices[0]?.delta?.content ?? ""),
    );
  }

  console.log("\n");
} finally {
  await prisma.$disconnect();
}
