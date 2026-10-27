import prisma from "./db.ts";
import { loadAgentConfig } from "./config/agentConfig.ts";
import { getOpenAIClient, getProvider } from "./llm/provider.ts";
import { generateStreamRequest, streamResponse } from "./llm/stream.ts";

try {
  const agentConfig = loadAgentConfig("lys");
  // console.log(`Loaded agent config: ${JSON.stringify(agentConfig)}`);

  const provider = await getProvider(agentConfig.provider);
  console.log(`Using provider: ${provider.name} (${provider.id})`);

  let conversation = await prisma.conversation.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      messages: {
        take: 10,
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { name: "Test Conversation" },
      include: { messages: true },
    });
  }

  console.log(`Using conversation: ${conversation.name} (${conversation.id})`);

  const openai = await getOpenAIClient(provider);
  const messages = conversation.messages.reverse().map((msg) =>
    msg.modelMessage
  );

  for (const msg of conversation.messages) {
    console.log(`[${msg.role}] ${msg.content}`);
  }

  while (true) {
    const input = prompt("[user] ");
    if (!input) break;
    if (input.toLocaleLowerCase() === "/new") {
      conversation = await prisma.conversation.create({
        data: { name: "Test Conversation" },
        include: { messages: true },
      });
      console.clear();
      console.log(
        `Created new conversation: ${conversation.name} (${conversation.id})`,
      );
      messages.length = 0;
      continue;
    }

    const msg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: `${input}`,
      },
    });
    messages.push(msg.modelMessage);

    const request = generateStreamRequest(agentConfig, messages);

    const encoder = new TextEncoder();
    Deno.stdout.writeSync(encoder.encode("[assistant] "));
    const { content: answer, llmCallId } = await streamResponse(
      openai,
      conversation.id,
      "test",
      request,
      provider,
      (chunk: string) => Deno.stdout.writeSync(encoder.encode(chunk)),
    );

    const assistantMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: `${answer}`,
        llmCallId: llmCallId,
      },
    });
    messages.push(assistantMsg.modelMessage);
  }
} finally {
  await prisma.$disconnect();
}
