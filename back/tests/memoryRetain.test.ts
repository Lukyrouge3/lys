import { assertEquals, assertExists } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import { retainConversation, saveMemory } from "@/memory.ts";
import {
  HindsightClient,
  HindsightError,
} from "@vectorize-io/hindsight-client";

// The real client is never called: these tests only care about what the memory
// layer sends and what it marks in Postgres.
const originalRetain = HindsightClient.prototype.retain;

type RetainCall = {
  bankId: string;
  content: string;
  options?: Record<string, unknown>;
};

function captureRetain(
  calls: RetainCall[],
  impl?: () => Promise<never>,
) {
  HindsightClient.prototype.retain =
    ((bankId: string, content: string, options?: Record<string, unknown>) => {
      calls.push({ bankId, content, options });
      return impl ? impl() : Promise.resolve({} as never);
    }) as unknown as typeof originalRetain;
}

const t0 = new Date("2026-11-15T10:00:00Z");

async function setupConversation() {
  await truncate("ToolCall", "Message", "LlmCall", "Conversation");
  return await prisma.conversation.create({ data: { name: "memory test" } });
}

function addMessage(
  conversationId: string,
  role: "user" | "assistant" | "system",
  content: string,
  minutes: number,
) {
  return prisma.message.create({
    data: {
      conversationId,
      role,
      content,
      createdAt: new Date(t0.getTime() + minutes * 60_000),
    },
  });
}

Deno.test({
  name: "retainConversation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Without this the memory layer silently no-ops and every step fails
    if (!Deno.env.get("HINDSIGHT_BASE_URL")) {
      throw new Error(
        "these tests need HINDSIGHT_BASE_URL in .env.test (the URL is never contacted)",
      );
    }
    try {
      await t.step(
        "new messages replace the document and are marked",
        async () => {
          const conversation = await setupConversation();
          await addMessage(conversation.id, "user", "I hate mushrooms", 0);
          // Tool-call-only turns carry nothing to remember
          await addMessage(conversation.id, "assistant", "", 1);
          await addMessage(conversation.id, "user", "Duly noted", 2);

          const calls: RetainCall[] = [];
          captureRetain(calls);
          await retainConversation(conversation.id);

          assertEquals(calls.length, 1);
          assertEquals(calls[0].bankId, "Lys");
          assertEquals(calls[0].options?.documentId, conversation.id);
          assertEquals(calls[0].options?.updateMode, "replace");
          assertEquals(calls[0].options?.async, true);
          assertEquals(JSON.parse(calls[0].content), [
            {
              role: "user",
              content: "I hate mushrooms",
              timestamp: "2026-11-15T10:00:00.000Z",
            },
            {
              role: "user",
              content: "Duly noted",
              timestamp: "2026-11-15T10:02:00.000Z",
            },
          ]);

          // The empty assistant turn is marked too, so it is never re-read
          const unmarked = await prisma.message.count({
            where: { conversationId: conversation.id, retainedAt: null },
          });
          assertEquals(unmarked, 0);
        },
      );

      await t.step("later turns append only what is new", async () => {
        const conversation = await setupConversation();
        await addMessage(conversation.id, "user", "I hate mushrooms", 0);

        const calls: RetainCall[] = [];
        captureRetain(calls);
        await retainConversation(conversation.id);

        await addMessage(conversation.id, "assistant", "Understood", 1);
        await addMessage(conversation.id, "user", "Also no olives", 2);
        await retainConversation(conversation.id);

        assertEquals(calls.length, 2);
        assertEquals(calls[1].options?.updateMode, "append");
        assertEquals(
          JSON.parse(calls[1].content).map((m: { content: string }) =>
            m.content
          ),
          ["Understood", "Also no olives"],
        );
      });

      await t.step("nothing new means no request", async () => {
        const conversation = await setupConversation();
        await addMessage(conversation.id, "user", "hi", 0);

        const calls: RetainCall[] = [];
        captureRetain(calls);
        await retainConversation(conversation.id);
        await retainConversation(conversation.id);

        assertEquals(calls.length, 1);
      });

      await t.step("an empty conversation is skipped", async () => {
        const conversation = await setupConversation();
        const calls: RetainCall[] = [];
        captureRetain(calls);
        await retainConversation(conversation.id);
        assertEquals(calls.length, 0);
      });

      await t.step("a turn paused on approval is not retained", async () => {
        const conversation = await setupConversation();
        await addMessage(conversation.id, "user", "Send the mail", 0);
        const assistant = await addMessage(conversation.id, "assistant", "", 1);
        const call = await prisma.toolCall.create({
          data: {
            messageId: assistant.id,
            apiId: "api-1",
            name: "fake_send_email",
            arguments: "{}",
            approval: "pending",
          },
        });
        // Typing while the button is waiting must not count as the turn ending
        await addMessage(conversation.id, "user", "are you there?", 2);

        const calls: RetainCall[] = [];
        captureRetain(calls);
        await retainConversation(conversation.id);

        assertEquals(calls.length, 0);
        assertEquals(
          await prisma.message.count({
            where: { conversationId: conversation.id, retainedAt: null },
          }),
          3,
        );

        // Once decided, the finished turn is retained on the next call
        await prisma.toolCall.update({
          where: { id: call.id },
          data: { approval: "approved" },
        });
        await retainConversation(conversation.id);
        assertEquals(calls.length, 1);
        assertEquals(
          JSON.parse(calls[0].content).map((m: { content: string }) =>
            m.content
          ),
          ["Send the mail", "are you there?"],
        );
      });

      await t.step("a backlog is spread over several batches", async () => {
        const conversation = await setupConversation();
        await addMessage(conversation.id, "user", "a".repeat(4000), 0);
        await addMessage(conversation.id, "assistant", "b".repeat(4000), 1);
        await addMessage(conversation.id, "user", "c".repeat(4000), 2);

        const calls: RetainCall[] = [];
        captureRetain(calls);

        await retainConversation(conversation.id);
        await retainConversation(conversation.id);
        await retainConversation(conversation.id);

        assertEquals(calls.length, 3);
        assertEquals(
          calls.map((call) => call.options?.updateMode),
          ["replace", "append", "append"],
        );
        assertEquals(
          calls.map((call) => JSON.parse(call.content)[0].content[0]),
          ["a", "b", "c"],
        );
      });

      await t.step("concurrent calls share one request", async () => {
        const conversation = await setupConversation();
        await addMessage(conversation.id, "user", "hi", 0);

        const calls: RetainCall[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        HindsightClient.prototype.retain = ((
          bankId: string,
          content: string,
          options?: Record<string, unknown>,
        ) => {
          calls.push({ bankId, content, options });
          return gate.then(() => ({} as never));
        }) as unknown as typeof originalRetain;

        const first = retainConversation(conversation.id);
        const second = retainConversation(conversation.id);
        release();
        await Promise.all([first, second]);

        assertEquals(calls.length, 1);
      });

      await t.step(
        "messages arriving mid-retain trigger another run",
        async () => {
          const conversation = await setupConversation();
          await addMessage(conversation.id, "user", "first", 0);

          const calls: RetainCall[] = [];
          let release!: () => void;
          const gate = new Promise<void>((resolve) => (release = resolve));
          HindsightClient.prototype.retain = ((
            bankId: string,
            content: string,
            options?: Record<string, unknown>,
          ) => {
            calls.push({ bankId, content, options });
            return gate.then(() => ({} as never));
          }) as unknown as typeof originalRetain;

          const first = retainConversation(conversation.id);
          await addMessage(conversation.id, "user", "second", 1);
          const second = retainConversation(conversation.id);
          release();
          await Promise.all([first, second]);

          assertEquals(calls.length, 2);
          assertEquals(calls[1].options?.updateMode, "append");
          assertEquals(JSON.parse(calls[1].content)[0].content, "second");
        },
      );

      await t.step(
        "a rejected batch is dropped, not retried forever",
        async () => {
          const conversation = await setupConversation();
          await addMessage(conversation.id, "user", "hi", 0);

          const calls: RetainCall[] = [];
          captureRetain(
            calls,
            () =>
              Promise.reject(new HindsightError("bad request", 400)) as Promise<
                never
              >,
          );
          await retainConversation(conversation.id);

          assertEquals(calls.length, 1);
          assertEquals(
            await prisma.message.count({
              where: { conversationId: conversation.id, retainedAt: null },
            }),
            0,
          );

          // A client error must not pause memory: the next message is attempted
          await addMessage(conversation.id, "user", "again", 1);
          captureRetain(calls);
          await retainConversation(conversation.id);
          assertEquals(calls.length, 2);
        },
      );

      await t.step(
        "saveMemory stores one trimmed note as its own document",
        async () => {
          await setupConversation();
          const calls: RetainCall[] = [];
          captureRetain(calls);

          await saveMemory("  The user's sister is called Ana.  ");

          assertEquals(calls.length, 1);
          assertEquals(calls[0].content, "The user's sister is called Ana.");
          assertEquals(
            String(calls[0].options?.documentId).startsWith("note-"),
            true,
          );
          assertExists(calls[0].options?.timestamp);
        },
      );

      await t.step("saveMemory rejects empty content", async () => {
        await setupConversation();
        const calls: RetainCall[] = [];
        captureRetain(calls);

        let failed = false;
        try {
          await saveMemory("   ");
        } catch {
          failed = true;
        }
        assertEquals(failed, true);
        assertEquals(calls.length, 0);
      });

      // Last: a failure starts a 60s cooldown that would skip the steps above
      await t.step(
        "a failed retain leaves messages for the next turn",
        async () => {
          const conversation = await setupConversation();
          await addMessage(conversation.id, "user", "hi", 0);

          const calls: RetainCall[] = [];
          captureRetain(calls, () => Promise.reject(new Error("down")));
          await retainConversation(conversation.id);

          assertEquals(calls.length, 1);
          assertEquals(
            await prisma.message.count({
              where: { conversationId: conversation.id, retainedAt: null },
            }),
            1,
          );

          // While cooling down, no further attempts are made
          await retainConversation(conversation.id);
          assertEquals(calls.length, 1);
        },
      );
    } finally {
      HindsightClient.prototype.retain = originalRetain;
      await closeDb();
    }
  },
});
