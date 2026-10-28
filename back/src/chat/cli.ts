import { createChatSession } from "@/chat/session.ts";

export async function cliChat(
  agentName: string,
  options?: { messageCount?: number },
) {
  const session = await createChatSession(agentName, {
    trigger: "cli",
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
      // await session.newConversation(); TODO: repair lol
      continue;
    }

    await session.send(input, {
      onEvent: (event) => {
        switch (event.type) {
          case "chunk":
            Deno.stdout.writeSync(encoder.encode(event.text));
            break;
          case "turnStart":
            Deno.stdout.writeSync(encoder.encode("[assistant] "));
            break;
          case "turnEnd":
            Deno.stdout.writeSync(encoder.encode("\n"));
            break;
        }
      },
    });
  }
}
