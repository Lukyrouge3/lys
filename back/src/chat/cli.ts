import { createChatSession } from "@/chat/session.ts";

export async function cliChat(
  agentName: string,
  options?: { messageCount?: number },
) {
  const session = await createChatSession(agentName, {
    trigger: "cli",
    conversationName: "Cli Conversation",
    messageCount: options?.messageCount,
  });

  for (const msg of session.history) {
    if (msg.role === "assistant" && msg.toolCalls.length > 0) {
      continue;
    }
    console.log(`[${msg.role}] ${msg.content}`);
  }

  const encoder = new TextEncoder();
  while (true) {
    const input = prompt("[user] ");
    if (!input) break;
    if (input.toLocaleLowerCase() === "/new") {
      console.clear();
      await session.newConversation();
      continue;
    }

    await session.send(input, {
      onChunk: (chunk) => Deno.stdout.writeSync(encoder.encode(chunk)),
      onTurnStart: () => Deno.stdout.writeSync(encoder.encode("[assistant] ")),
      onTurnEnd: () => Deno.stdout.writeSync(encoder.encode("\n")),
    });
  }
}
