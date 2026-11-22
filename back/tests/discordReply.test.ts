import { assertEquals } from "@std/assert";
import { GuildTextBasedChannel } from "discord.js";
import { DiscordReply, splitMessage } from "@/chat/discord/reply.ts";
import { AgentEvent } from "@/agent/events.ts";

type Channel = GuildTextBasedChannel;

function fakeChannel(send: (payload: unknown) => Promise<unknown>): Channel {
  return {
    id: "channel-1",
    send: (payload: unknown) => send(payload),
    sendTyping: () => Promise.resolve(),
    setName: () => Promise.resolve(),
  } as unknown as Channel;
}

function chunk(text: string): AgentEvent {
  return { type: "chunk", text };
}

Deno.test("a failed send does not stop later sends", async () => {
  const sent: string[] = [];
  let failNext = true;
  const channel = fakeChannel((payload) => {
    sent.push(String(payload));
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("Discord said no"));
    }
    return Promise.resolve({});
  });

  const reply = new DiscordReply(channel);
  reply.onEvent({ type: "turnStart" });
  reply.onEvent(chunk("first"));
  reply.onEvent({ type: "turnEnd" });

  reply.onEvent({ type: "turnStart" });
  reply.onEvent(chunk("second"));
  reply.onEvent({ type: "turnEnd" });

  await reply.done();
  assertEquals(sent, ["first", "second"]);
});

Deno.test("a 1999-character message ending in an emoji is split on the grapheme", () => {
  const text = "a".repeat(1999) + "😀";
  const parts = splitMessage(text);

  assertEquals(parts.join(""), text);
  assertEquals(parts.length, 2);
  for (const part of parts) {
    assertEquals(part.length <= 2000, true);
    const last = part.charCodeAt(part.length - 1);
    // A lone high surrogate would render as a broken character
    assertEquals(last >= 0xd800 && last <= 0xdbff, false);
  }
});

Deno.test("an emoji is never cut even when it straddles the limit", () => {
  const text = "😀".repeat(1500); // 3000 UTF-16 units, 1500 graphemes
  const parts = splitMessage(text);

  assertEquals(parts.join(""), text);
  for (const part of parts) {
    assertEquals(part.length <= 2000, true);
    assertEquals(part.endsWith("\uD83D"), false);
  }
});

Deno.test("a code fence crossing the limit is closed and reopened", () => {
  const text = "intro\n```js\n" + "y".repeat(2100) + "\n```\noutro";
  const parts = splitMessage(text);

  assertEquals(parts.length >= 2, true);
  for (const part of parts) {
    assertEquals(part.length <= 2000, true);
    // Even number of fence markers: every chunk is self-contained markdown
    assertEquals(part.split("```").length % 2, 1);
  }
  assertEquals(parts[0].endsWith("```"), true);
  assertEquals(parts[1].startsWith("```js\n"), true);
});

Deno.test("a short message is one part", () => {
  assertEquals(splitMessage("hello"), ["hello"]);
});
