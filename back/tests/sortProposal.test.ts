import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Client, MessageCreateOptions } from "discord.js";
import prisma from "@/db.ts";
import {
  buildProposal,
  type SortDecision,
  type SortMail,
} from "@/mail/sort.ts";
import {
  DEFAULT_SORT_TIME,
  expireProposals,
  PROPOSAL_TTL_MS,
  runSortProposal,
  SORT_JOB,
  sortEnabled,
  sortTime,
} from "@/scheduler/sortProposal.ts";
import {
  buildMorningMessage,
  MORNING_JOB,
  morningSections,
  renderMorning,
} from "@/scheduler/morning.ts";
import { closeDb, truncate } from "./db.ts";

const NOW = new Date("2026-11-22T17:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const OWNER = "owner-1";

function mail(uid: number): SortMail {
  return {
    accountId: "acc-1",
    folder: "INBOX",
    uid,
    from: "news@example.com",
    subject: `Mail ${uid}`,
    topic: "",
  };
}

function fakeClient(sent: MessageCreateOptions[]): Client {
  return {
    users: {
      fetch: () =>
        Promise.resolve({
          send: (payload: MessageCreateOptions) => {
            sent.push(payload);
            return Promise.resolve({});
          },
        }),
    },
  } as unknown as Client;
}

const candidates = () => Promise.resolve([mail(1), mail(2), mail(3)]);
const decisions: SortDecision[] = [
  { mail: mail(1), target: "Admin" },
  { mail: mail(2), target: "Admin" },
  { mail: mail(3), target: "Keep" },
];
const decide = () => Promise.resolve(decisions);

async function withOwner<T>(work: () => Promise<T>): Promise<T> {
  const saved = Deno.env.get("DISCORD_OWNER_ID");
  Deno.env.set("DISCORD_OWNER_ID", OWNER);
  try {
    return await work();
  } finally {
    if (saved === undefined) Deno.env.delete("DISCORD_OWNER_ID");
    else Deno.env.set("DISCORD_OWNER_ID", saved);
  }
}

Deno.test("SORT_TIME and MAIL_SORT are read from the environment", () => {
  const savedTime = Deno.env.get("SORT_TIME");
  const savedSort = Deno.env.get("MAIL_SORT");
  try {
    Deno.env.delete("SORT_TIME");
    assertEquals(sortTime(), DEFAULT_SORT_TIME);
    assertEquals(DEFAULT_SORT_TIME, "18:00");

    Deno.env.set("SORT_TIME", "18:30");
    assertEquals(sortTime(), "18:30");

    Deno.env.delete("MAIL_SORT");
    assertEquals(sortEnabled(), true);
    Deno.env.set("MAIL_SORT", "0");
    assertEquals(sortEnabled(), false);
    Deno.env.set("MAIL_SORT", "1");
    assertEquals(sortEnabled(), true);
  } finally {
    if (savedTime === undefined) Deno.env.delete("SORT_TIME");
    else Deno.env.set("SORT_TIME", savedTime);
    if (savedSort === undefined) Deno.env.delete("MAIL_SORT");
    else Deno.env.set("MAIL_SORT", savedSort);
  }
});

Deno.test("the morning summary names the proposal that is waiting", () => {
  const summary = "12 → Newsletters, 3 → Admin, 5 stay";
  const message = renderMorning(morningSections({
    since: NOW,
    clicked: [],
    waiting: [],
    importantMail: [],
    otherMail: { normal: 0, noise: 0 },
    sortProposal: { summary },
  }));

  assertStringIncludes(message, "🕒 Waiting for you (1)");
  assertStringIncludes(message, `Mail sorting proposal waiting: ${summary}`);

  const without = renderMorning(morningSections({
    since: NOW,
    clicked: [],
    waiting: [],
    importantMail: [],
    otherMail: { normal: 0, noise: 0 },
  }));
  assert(!without.includes("Mail sorting proposal waiting"));
});

Deno.test({
  name: "runSortProposal",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await truncate(
      "MailProposal",
      "MailNote",
      "MailAccount",
      "Secret",
      "ScheduledRun",
      "Job",
    );

    try {
      await withOwner(async () => {
        const sent: MessageCreateOptions[] = [];
        const client = fakeClient(sent);

        await t.step(
          "a proposal is created and sent with two buttons",
          async () => {
            const summary = await runSortProposal(client, {
              now: NOW,
              collect: candidates,
              decide,
            });

            assertEquals(summary, "2 → Admin, 1 stay");

            const rows = await prisma.mailProposal.findMany();
            assertEquals(rows.length, 1);
            assertEquals(rows[0].status, "pending");
            assertEquals(rows[0].summary, "2 → Admin, 1 stay");
            assertEquals(rows[0].decidedAt, null);
            assertEquals((rows[0].moves as unknown[]).length, 2);

            assertEquals(sent.length, 1);
            assert(sent[0].content?.includes(summary!));
            const payload = JSON.stringify(sent[0].components);
            assertStringIncludes(payload, `sort:${rows[0].id}:approve`);
            assertStringIncludes(payload, `sort:${rows[0].id}:deny`);
          },
        );

        await t.step(
          "while one is pending, no second proposal is sent",
          async () => {
            let asked = 0;
            const counted = () => {
              asked += 1;
              return candidates();
            };
            const summary = await runSortProposal(client, {
              now: NOW,
              collect: counted,
              decide,
            });

            assertEquals(summary, null);
            assertEquals(asked, 0);
            assertEquals(await prisma.mailProposal.count(), 1);
            assertEquals(sent.length, 1);
          },
        );

        await t.step(
          "a proposal nobody answered expires after three days",
          async () => {
            const before = await prisma.mailProposal.findFirstOrThrow();
            await prisma.mailProposal.update({
              where: { id: before.id },
              data: {
                createdAt: new Date(NOW.getTime() - PROPOSAL_TTL_MS - 1),
              },
            });

            const summary = await runSortProposal(client, {
              now: NOW,
              collect: candidates,
              decide,
            });

            // A fresh proposal replaces the expired one, so the day is not lost.
            assertEquals(summary, "2 → Admin, 1 stay");
            const rows = await prisma.mailProposal.findMany({
              orderBy: { createdAt: "asc" },
            });
            assertEquals(rows.length, 2);
            assertEquals(rows[0].status, "denied");
            assert(rows[0].decidedAt !== null);
            assertEquals(rows[1].status, "pending");
            assertEquals(sent.length, 2);
          },
        );

        await t.step("nothing to move means no row and no DM", async () => {
          await truncate("MailProposal");
          const before = sent.length;
          const summary = await runSortProposal(client, {
            now: NOW,
            collect: () => Promise.resolve([mail(9)]),
            decide: () =>
              Promise.resolve(
                [{ mail: mail(9), target: "Keep" }] as SortDecision[],
              ),
          });

          assertEquals(summary, null);
          assertEquals(await prisma.mailProposal.count(), 0);
          assertEquals(sent.length, before);
        });

        await t.step("no candidates means no row and no DM", async () => {
          const summary = await runSortProposal(client, {
            now: NOW,
            collect: () => Promise.resolve([]),
            decide,
          });

          assertEquals(summary, null);
          assertEquals(await prisma.mailProposal.count(), 0);
        });

        await t.step("expiry touches only old pending rows", async () => {
          await truncate("MailProposal");
          const old = new Date(NOW.getTime() - PROPOSAL_TTL_MS - 1);
          await prisma.mailProposal.create({
            data: {
              status: "applied",
              summary: "1 → Admin",
              moves: [],
              createdAt: old,
            },
          });
          await prisma.mailProposal.create({
            data: {
              status: "pending",
              summary: "1 → Admin",
              moves: [],
              createdAt: old,
            },
          });

          assertEquals(await expireProposals(NOW), 1);
          assertEquals(
            await prisma.mailProposal.count({ where: { status: "applied" } }),
            1,
          );
          const denied = await prisma.mailProposal.findFirstOrThrow({
            where: { status: "denied" },
          });
          assert(denied.decidedAt !== null);
        });
      });
    } finally {
      await closeDb();
    }
  },
});

Deno.test({
  name: "the morning message reads a pending proposal from the database",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await truncate(
      "MailProposal",
      "MailNote",
      "MailAccount",
      "Secret",
      "ScheduledRun",
      "Job",
    );
    await prisma.scheduledRun.create({
      data: { name: MORNING_JOB, lastRunAt: new Date(NOW.getTime() - DAY) },
    });
    await prisma.mailProposal.create({
      data: {
        status: "pending",
        summary: "9 → Admin, 2 stay",
        moves: buildProposal(decisions).moves,
        createdAt: new Date(NOW.getTime() - 3600_000),
      },
    });

    try {
      const message = await buildMorningMessage(NOW);
      assertStringIncludes(
        message,
        "Mail sorting proposal waiting: 9 → Admin, 2 stay",
      );
      assertStringIncludes(message, "🕒 Waiting for you (1)");

      await prisma.mailProposal.updateMany({ data: { status: "denied" } });
      const after = await buildMorningMessage(NOW);
      assert(!after.includes("Mail sorting proposal waiting"));
    } finally {
      await closeDb();
    }
  },
});

Deno.test("the sorting job has its own scheduled-run name", () => {
  assertEquals(SORT_JOB, "mail-sort");
});
