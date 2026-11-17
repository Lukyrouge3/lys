import { assertEquals, assertRejects } from "@std/assert";
import prisma from "@/db.ts";
import { getAgent } from "@/config/agentConfig.ts";

Deno.test({
  name: "getAgent",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE "Agent", "Provider", "Secret" CASCADE`,
    );
    const secret = await prisma.secret.create({
      data: { name: "test-key", value: "unused" },
    });
    const provider = await prisma.provider.create({
      data: { name: "test", host: "http://fake", apiKeyId: secret.id },
    });
    await prisma.agent.create({
      data: {
        name: "lys",
        model: "test-model",
        systemPrompt: "custom",
        providerId: provider.id,
      },
    });

    await t.step(
      "returns the agent with its provider and API key",
      async () => {
        const agent = await getAgent("lys");
        assertEquals(agent.model, "test-model");
        assertEquals(agent.systemPrompt, "custom");
        assertEquals(agent.contextWindow, 8192);
        assertEquals(agent.maxReplyTokens, 1024);
        assertEquals(agent.provider.name, "test");
        assertEquals(agent.provider.apiKey.name, "test-key");
      },
    );

    await t.step("throws for an unknown agent", async () => {
      await assertRejects(
        () => getAgent("nope"),
        Error,
        "Agent nope not found",
      );
    });

    await prisma.$disconnect();
  },
});
