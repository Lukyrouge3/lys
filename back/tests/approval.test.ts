import { assertEquals } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import { canResume, resolveApproval } from "@/agent/approval.ts";
import {
  EXPIRED_RESULT,
  expirePendingApprovals,
  INTERRUPTED_RESULT,
  recoverInterruptedRuns,
  undecidedCount,
} from "@/agent/pending.ts";

const HOUR = 60 * 60 * 1000;

// A conversation with one assistant message, which is where tool calls hang.
async function setup() {
  await truncate("ToolCall", "Message", "LlmCall", "Conversation");
  const conversation = await prisma.conversation.create({
    data: { name: "approval test" },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      createdAt: new Date("2026-11-18T10:00:00Z"),
    },
  });
  return { conversationId: conversation.id, messageId: message.id };
}

function toolCall(
  messageId: string,
  data: { approval?: "pending" | "executing" | "approved"; ago?: number } = {},
) {
  const { approval, ago = 0 } = data;
  return prisma.toolCall.create({
    data: {
      messageId,
      apiId: crypto.randomUUID(),
      name: "set_title",
      arguments: "{}",
      approval,
      createdAt: new Date(Date.now() - ago),
    },
  });
}

Deno.test({
  name: "pending approvals",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    try {
      await t.step(
        "a forgotten request expires instead of holding the turn open",
        async () => {
          const { messageId } = await setup();
          const call = await toolCall(messageId, {
            approval: "pending",
            ago: 25 * HOUR,
          });
          assertEquals(await undecidedCount(messageId), 1);

          assertEquals(await expirePendingApprovals(), 1);

          const after = await prisma.toolCall.findUniqueOrThrow({
            where: { id: call.id },
          });
          assertEquals(after.approval, "denied");
          assertEquals(after.result, EXPIRED_RESULT);
          assertEquals(await undecidedCount(messageId), 0);
        },
      );

      await t.step("a fresh request keeps waiting", async () => {
        const { messageId } = await setup();
        const call = await toolCall(messageId, { approval: "pending" });

        assertEquals(await expirePendingApprovals(), 0);

        const after = await prisma.toolCall.findUniqueOrThrow({
          where: { id: call.id },
        });
        assertEquals(after.approval, "pending");
      });

      await t.step(
        "an interrupted run is reported, not left looking decided",
        async () => {
          const { messageId } = await setup();
          const call = await toolCall(messageId, { approval: "executing" });

          assertEquals(await recoverInterruptedRuns(), 1);

          const after = await prisma.toolCall.findUniqueOrThrow({
            where: { id: call.id },
          });
          assertEquals(after.approval, "failed");
          assertEquals(after.result, INTERRUPTED_RESULT);
        },
      );

      await t.step("a claimed run cannot be claimed again", async () => {
        const { conversationId, messageId } = await setup();
        const call = await toolCall(messageId, { approval: "executing" });

        // Clicking again while this is running must not run it twice
        assertEquals(
          await resolveApproval(call.id, conversationId, true, () => {}),
          null,
        );
      });

      await t.step(
        "the turn can resume while the tool result is the last word",
        async () => {
          const { conversationId, messageId } = await setup();
          const call = await toolCall(messageId, { approval: "approved" });

          assertEquals(await canResume(call, conversationId), true);
        },
      );

      await t.step("a later message stops the resume", async () => {
        const { conversationId, messageId } = await setup();
        const call = await toolCall(messageId, { approval: "approved" });
        await prisma.message.create({
          data: {
            conversationId,
            role: "user",
            content: "never mind",
            createdAt: new Date("2026-11-18T11:00:00Z"),
          },
        });

        assertEquals(await canResume(call, conversationId), false);
      });

      await t.step("an undecided sibling stops the resume", async () => {
        const { conversationId, messageId } = await setup();
        const call = await toolCall(messageId, { approval: "approved" });
        await toolCall(messageId, { approval: "pending" });

        assertEquals(await canResume(call, conversationId), false);
      });
    } finally {
      await closeDb();
    }
  },
});
