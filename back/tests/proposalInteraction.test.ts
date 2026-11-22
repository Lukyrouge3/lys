import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ButtonInteraction } from "discord.js";
import prisma from "@/db.ts";
import {
  handleProposalInteraction,
  isSortButton,
  parseSortButton,
} from "@/chat/discord/proposal.ts";
import type { MailMove } from "@/mail/sort.ts";
import type { MoveResult } from "@/mail/imapMove.ts";
import { closeDb, truncate } from "./db.ts";

const OWNER = "owner-1";

const MOVES: MailMove[] = [
  {
    accountId: "acc-1",
    folder: "INBOX",
    uid: 1,
    target: "Admin",
    subject: "Invoice 1",
    from: "Ana <ana@example.com>",
  },
  {
    accountId: "acc-1",
    folder: "INBOX",
    uid: 2,
    target: "Newsletters",
    subject: "Weekly digest",
    from: "news@example.com",
  },
];

type Edit = { content?: string; components?: unknown[] };

type FakeClick = {
  customId: string;
  user: { id: string };
  deferred: boolean;
  replied: boolean;
  inGuild: () => boolean;
  channel: { isDMBased: () => boolean };
  deferUpdate: () => Promise<void>;
  editReply: (payload: Edit) => Promise<unknown>;
  reply: (payload: unknown) => Promise<unknown>;
  followUp: (payload: unknown) => Promise<unknown>;
  isRepliable: () => boolean;
};

/** A DM button, which is where these two live. */
function fakeInteraction(customId: string, userId = OWNER) {
  const edits: Edit[] = [];
  const click: FakeClick = {
    customId,
    user: { id: userId },
    deferred: false,
    replied: false,
    inGuild: () => false,
    channel: { isDMBased: () => true },
    deferUpdate: () => {
      click.deferred = true;
      return Promise.resolve();
    },
    editReply: (payload) => {
      edits.push(payload);
      return Promise.resolve({});
    },
    reply: () => Promise.resolve({}),
    followUp: () => Promise.resolve({}),
    isRepliable: () => true,
  };
  return { interaction: click as unknown as ButtonInteraction, edits, click };
}

async function proposal(status = "pending") {
  return await prisma.mailProposal.create({
    data: {
      status,
      summary: "2 → Admin, 1 stay",
      moves: MOVES,
    },
  });
}

function outcome(
  moves: MailMove[],
  results: Array<MoveResult["outcome"]>,
): MoveResult[] {
  return moves.map((move, index) => ({ move, outcome: results[index] }));
}

Deno.test("sorting buttons are recognised wherever they are clicked", () => {
  assertEquals(isSortButton("sort:abc:approve"), true);
  assertEquals(isSortButton("sort:abc:deny"), true);
  assertEquals(isSortButton("approval:approve:abc"), false);
  assertEquals(isSortButton("something else"), false);

  assertEquals(parseSortButton("sort:abc:approve"), {
    id: "abc",
    action: "approve",
  });
  assertEquals(parseSortButton("sort:abc:deny"), {
    id: "abc",
    action: "deny",
  });
  assertEquals(parseSortButton("sort:abc"), null);
  assertEquals(parseSortButton("sort::approve"), null);
  assertEquals(parseSortButton("sort:abc:maybe"), null);
  assertEquals(parseSortButton("approval:abc:approve"), null);
});

Deno.test({
  name: "a sorting proposal is approved or denied by its owner",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await truncate("MailProposal");

    try {
      await t.step(
        "approve moves the mail and records the result",
        async () => {
          const row = await proposal();
          const { interaction, edits, click } = fakeInteraction(
            `sort:${row.id}:approve`,
          );
          const applied: MailMove[][] = [];

          await handleProposalInteraction(interaction, {
            ownerId: OWNER,
            apply: (moves) => {
              applied.push(moves);
              return Promise.resolve(
                outcome(moves, ["moved", "skipped"]),
              );
            },
          });

          assertEquals(click.deferred, true, "the click is acknowledged first");
          assertEquals(applied.length, 1);
          assertEquals(applied[0].length, 2);

          const after = await prisma.mailProposal.findUniqueOrThrow({
            where: { id: row.id },
          });
          assertEquals(after.status, "applied");
          assert(after.decidedAt !== null);

          assertEquals(edits.length, 1);
          assertStringIncludes(edits[0].content ?? "", "2 → Admin, 1 stay");
          assertStringIncludes(
            edits[0].content ?? "",
            "Moved 1, skipped 1, failed 0",
          );
          assertEquals(edits[0].components, []);
        },
      );

      await t.step("a second click cannot move the mail again", async () => {
        const row = await proposal();
        let applied = 0;
        const first = fakeInteraction(`sort:${row.id}:approve`);
        const second = fakeInteraction(`sort:${row.id}:approve`);

        const apply = (moves: MailMove[]) => {
          applied += 1;
          return Promise.resolve(outcome(moves, ["moved", "moved"]));
        };

        await handleProposalInteraction(first.interaction, {
          ownerId: OWNER,
          apply,
        });
        // The keyed queue serialises them, so the second one is a fresh click.
        await handleProposalInteraction(second.interaction, {
          ownerId: OWNER,
          apply,
        });

        assertEquals(applied, 1);
        assertStringIncludes(
          second.edits[0].content ?? "",
          "already decided (applied)",
        );
        assertEquals(second.edits[0].components, []);
        const after = await prisma.mailProposal.findUniqueOrThrow({
          where: { id: row.id },
        });
        assertEquals(after.status, "applied");
      });

      await t.step("deny moves nothing", async () => {
        const row = await proposal();
        let applied = 0;
        const { interaction, edits } = fakeInteraction(
          `sort:${row.id}:deny`,
        );

        await handleProposalInteraction(interaction, {
          ownerId: OWNER,
          apply: (moves) => {
            applied += 1;
            return Promise.resolve(outcome(moves, ["moved", "moved"]));
          },
        });

        assertEquals(applied, 0);
        assertStringIncludes(edits[0].content ?? "", "Denied. Nothing moved.");
        const after = await prisma.mailProposal.findUniqueOrThrow({
          where: { id: row.id },
        });
        assertEquals(after.status, "denied");
        assert(after.decidedAt !== null);
      });

      await t.step("only the owner may press", async () => {
        const row = await proposal();
        let applied = 0;
        const { interaction, edits, click } = fakeInteraction(
          `sort:${row.id}:approve`,
          "someone-else",
        );

        await handleProposalInteraction(interaction, {
          ownerId: OWNER,
          apply: (moves) => {
            applied += 1;
            return Promise.resolve(outcome(moves, ["moved", "moved"]));
          },
        });

        assertEquals(applied, 0);
        assertEquals(edits, []);
        assertEquals(click.deferred, false);
        const after = await prisma.mailProposal.findUniqueOrThrow({
          where: { id: row.id },
        });
        assertEquals(after.status, "pending");
      });

      await t.step("the owner id also comes from the environment", async () => {
        const saved = Deno.env.get("DISCORD_OWNER_ID");
        Deno.env.set("DISCORD_OWNER_ID", OWNER);
        try {
          const row = await proposal();
          const { interaction } = fakeInteraction(`sort:${row.id}:deny`);

          await handleProposalInteraction(interaction, {
            apply: (moves) =>
              Promise.resolve(outcome(moves, ["moved", "moved"])),
          });

          const after = await prisma.mailProposal.findUniqueOrThrow({
            where: { id: row.id },
          });
          assertEquals(after.status, "denied");
        } finally {
          if (saved === undefined) Deno.env.delete("DISCORD_OWNER_ID");
          else Deno.env.set("DISCORD_OWNER_ID", saved);
        }
      });

      await t.step(
        "when every move fails, the proposal is failed",
        async () => {
          const row = await proposal();
          const { interaction, edits } = fakeInteraction(
            `sort:${row.id}:approve`,
          );

          await handleProposalInteraction(interaction, {
            ownerId: OWNER,
            apply: (moves) =>
              Promise.resolve(outcome(moves, ["failed", "failed"])),
          });

          assertStringIncludes(
            edits[0].content ?? "",
            "Moved 0, skipped 0, failed 2",
          );
          const after = await prisma.mailProposal.findUniqueOrThrow({
            where: { id: row.id },
          });
          assertEquals(after.status, "failed");
        },
      );

      await t.step("a partially failed run is still applied", async () => {
        const row = await proposal();
        const { interaction } = fakeInteraction(`sort:${row.id}:approve`);

        await handleProposalInteraction(interaction, {
          ownerId: OWNER,
          apply: (moves) =>
            Promise.resolve(outcome(moves, ["moved", "failed"])),
        });

        const after = await prisma.mailProposal.findUniqueOrThrow({
          where: { id: row.id },
        });
        assertEquals(after.status, "applied");
      });

      await t.step(
        "a proposal that no longer exists is reported, not moved",
        async () => {
          await prisma.mailProposal.deleteMany();
          const { interaction, edits } = fakeInteraction("sort:gone:approve");
          let applied = 0;

          await handleProposalInteraction(interaction, {
            ownerId: OWNER,
            apply: (moves) => {
              applied += 1;
              return Promise.resolve(outcome(moves, []));
            },
          });

          assertEquals(applied, 0);
          assertStringIncludes(edits[0].content ?? "", "already decided");
        },
      );
    } finally {
      await closeDb();
    }
  },
});
