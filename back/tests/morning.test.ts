import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import { saveJob } from "@/jobs/store.ts";
import type { JobStatus } from "@/generated/prisma/client.ts";
import {
  buildMorningMessage,
  type ClickedJob,
  formatClickedJobs,
  formatImportantMail,
  formatWaitingJobs,
  mailTail,
  MORNING_JOB,
  MORNING_LIMIT,
  morningSections,
  renderMorning,
  summaryWindow,
  type WaitingJob,
} from "@/scheduler/morning.ts";
import { generateToolRequest, runTool } from "@/tools/tool.ts";

const NOW = new Date("2026-11-22T06:30:00Z");
const YESTERDAY_MORNING = new Date("2026-11-21T06:30:00Z");

function clicked(overrides: Partial<ClickedJob> = {}): ClickedJob {
  return {
    id: "8e230981-0000-0000-0000-000000000001",
    rank: "apply",
    title: "Backend Developer",
    company: "Acme",
    status: "queued",
    url: "https://www.linkedin.com/jobs/view/123",
    ...overrides,
  };
}

function waiting(overrides: Partial<WaitingJob> = {}): WaitingJob {
  return {
    id: "1f2e3d4c-0000-0000-0000-000000000002",
    rank: "apply",
    title: "Platform Engineer",
    company: "Globex",
    status: "ready",
    prepFolder: "Postulations/Globex",
    prepNote: null,
    ...overrides,
  };
}

Deno.test("the window is the previous morning, or the last 24 h", () => {
  assertEquals(
    summaryWindow(NOW, YESTERDAY_MORNING).toISOString(),
    "2026-11-21T06:30:00.000Z",
  );
  assertEquals(
    summaryWindow(NOW, null).toISOString(),
    "2026-11-21T06:30:00.000Z",
  );
  // Two days without a run: a 24 h recap, not 48 h.
  assertEquals(
    summaryWindow(NOW, new Date("2026-11-19T06:30:00Z")).toISOString(),
    "2026-11-21T06:30:00.000Z",
  );
  // A clock that moved backwards.
  assertEquals(
    summaryWindow(NOW, new Date("2026-11-23T06:30:00Z")).toISOString(),
    "2026-11-21T06:30:00.000Z",
  );
});

Deno.test("clicked jobs are grouped by rank, with the link on its own line", () => {
  const items = formatClickedJobs([
    clicked({ rank: "skip", title: "Sales" }),
    clicked({ rank: null, title: "Intern" }),
    clicked({ rank: "maybe", title: "Data Analyst" }),
    clicked({ rank: "apply", title: "Backend Developer" }),
  ]);

  assertEquals(items.map((item) => item.full.split("\n")[0]), [
    "🎯 Backend Developer — Acme (queued)",
    "🤔 Data Analyst — Acme (queued)",
    "· Intern — Acme (queued)",
    "🚫 Sales — Acme (queued)",
  ]);
  assertEquals(
    items[0].full.split("\n")[1],
    "<https://www.linkedin.com/jobs/view/123>",
  );
  assertEquals(items[0].short.includes("<"), false);
});

Deno.test("waiting jobs explain what each one needs", () => {
  const items = formatWaitingJobs([
    waiting({ status: "ready", prepFolder: "Postulations/Globex" }),
    waiting({
      status: "review",
      id: "aaaa1111-0000-0000-0000-000000000003",
      prepFolder: null,
      prepNote: "CV missing dates",
    }),
    waiting({
      status: "queued",
      id: "bbbb2222-0000-0000-0000-000000000004",
      prepFolder: null,
      rank: "apply",
    }),
  ]);

  assertEquals(items.map((item) => item.full), [
    "✅ Platform Engineer — Globex · ready · 1f2e3d4c\n" +
    "Prepared in Postulations/Globex: review and send.",
    "⚠️ Platform Engineer — Globex · review · aaaa1111\n" +
    "Needs your look: CV missing dates",
    "⏳ Platform Engineer — Globex · waiting to be prepared · bbbb2222",
  ]);
  assertEquals(
    items[0].short,
    "✅ Platform Engineer — Globex · ready · 1f2e3d4c",
  );
});

Deno.test("important mail shows sender, subject and topic", () => {
  const items = formatImportantMail([
    {
      from: "Alice <alice@example.com>",
      subject: "Invoice 42",
      topic: "invoice November",
    },
    { from: "bob@example.com", subject: "Hello", topic: "" },
  ]);

  assertEquals(items[0].full, "• Alice — Invoice 42 (invoice November)");
  assertEquals(items[1].full, "• bob@example.com — Hello");
});

Deno.test("the ordinary mail is one line, or absent", () => {
  assertEquals(mailTail(0, 0), undefined);
  assertEquals(mailTail(4, 12), "Other mail: 4 normal, 12 noise.");
});

Deno.test("an empty morning says so without hints", () => {
  const message = renderMorning(
    morningSections({
      since: YESTERDAY_MORNING,
      clicked: [],
      waiting: [],
      importantMail: [],
      otherMail: { normal: 0, noise: 0 },
    }),
  );

  assertStringIncludes(message, "📥 Clicked since yesterday\nnothing clicked");
  assertStringIncludes(message, "🕒 Waiting for you\nNothing waiting");
  assertStringIncludes(
    message,
    "📬 Important mail since yesterday\nNo important mail.",
  );
  assertEquals(message.includes("mark_job"), false);
  assert(message.length <= MORNING_LIMIT);
});

Deno.test("the closing hint only appears when something waits", () => {
  const sections = morningSections({
    since: YESTERDAY_MORNING,
    clicked: [],
    waiting: [waiting()],
    importantMail: [],
    otherMail: { normal: 0, noise: 0 },
  });
  const message = renderMorning(sections);

  assertStringIncludes(message, "🕒 Waiting for you (1)");
  assertStringIncludes(message, '"I applied to 1f2e3d4c"');
});

Deno.test("a long morning shortens items before dropping them", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    clicked({
      id: `job-${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`,
      title: `Senior Full Stack Developer Number ${index}`,
      company: `Very Long Company Name Incorporated ${index}`,
      rank: index % 2 === 0 ? "apply" : "maybe",
      url: `https://www.linkedin.com/jobs/view/${1000 + index}`,
    }));

  const sections = morningSections({
    since: YESTERDAY_MORNING,
    clicked: many,
    waiting: [waiting()],
    importantMail: Array.from({ length: 10 }, (_, index) => ({
      from: `Sender ${index} <sender${index}@example.com>`,
      subject: `An important subject line number ${index}`,
      topic: `topic ${index}`,
    })),
    otherMail: { normal: 3, noise: 8 },
  });

  const message = renderMorning(sections);
  assert(message.length <= MORNING_LIMIT, `got ${message.length} chars`);

  const clickedLines = message.split("\n").filter((line) =>
    /^(🎯|🤔|·|🚫) /.test(line)
  );
  assert(clickedLines.length < many.length);
  assertStringIncludes(
    message,
    `… and ${many.length - clickedLines.length} more`,
  );

  // Every item that is shown stays whole: the link line or the one-line form.
  for (const line of message.split("\n")) {
    if (line.startsWith("<https://")) continue;
    assert(line.length < 200, `line too long: ${line}`);
  }
});

Deno.test({
  name: "the morning message reads the database",
  async fn(t) {
    await truncate(
      "ScheduledRun",
      "MailNote",
      "MailProposal",
      "MailAccount",
      "Secret",
      "Job",
    );

    await prisma.scheduledRun.create({
      data: { name: MORNING_JOB, lastRunAt: YESTERDAY_MORNING },
    });

    let counter = 0;
    async function addJob(
      overrides: Partial<{
        title: string;
        company: string;
        rank: "apply" | "maybe" | "skip" | null;
        status: JobStatus;
        createdAt: Date;
        prepFolder: string | null;
        prepNote: string | null;
        preparedAt: Date | null;
      }> = {},
    ) {
      counter += 1;
      const { job } = await saveJob({
        source: "linkedin",
        externalId: `ext-${counter}`,
        url: `https://www.linkedin.com/jobs/view/${counter}`,
        title: overrides.title ?? `Job ${counter}`,
        company: overrides.company ?? "Acme",
        location: "Geneva",
        description: "Description that must never appear.",
      });
      return await prisma.job.update({
        where: { id: job.id },
        data: {
          rank: overrides.rank === undefined ? "apply" : overrides.rank,
          status: overrides.status ?? "queued",
          createdAt: overrides.createdAt ?? new Date("2026-11-22T05:00:00Z"),
          prepFolder: overrides.prepFolder ?? null,
          prepNote: overrides.prepNote ?? null,
          preparedAt: overrides.preparedAt ?? null,
        },
      });
    }

    const applyJob = await addJob({
      title: "Backend Developer",
      company: "Acme",
      rank: "apply",
    });
    const maybeJob = await addJob({
      title: "Data Analyst",
      company: "Globex",
      rank: "maybe",
      createdAt: new Date("2026-11-22T04:00:00Z"),
    });
    const unrankedJob = await addJob({
      title: "Intern",
      company: "Initech",
      rank: null,
      createdAt: new Date("2026-11-22T03:00:00Z"),
    });
    const skipJob = await addJob({
      title: "Sales",
      company: "Hooli",
      rank: "skip",
      createdAt: new Date("2026-11-22T02:00:00Z"),
    });
    const oldJob = await addJob({
      title: "Old Application",
      rank: "skip",
      createdAt: new Date("2026-11-21T05:00:00Z"),
    });

    const older = new Date("2026-11-21T05:00:00Z");
    const readyJob = await addJob({
      title: "Platform Engineer",
      company: "Globex",
      status: "ready",
      createdAt: older,
      prepFolder: "Postulations/Globex",
      preparedAt: new Date("2026-11-21T18:00:00Z"),
    });
    const reviewJob = await addJob({
      title: "Data Engineer",
      company: "Initech",
      status: "review",
      createdAt: older,
      prepNote: "CV missing dates",
    });
    const waitingJob = await addJob({
      title: "Frontend Developer",
      company: "Hooli",
      rank: "apply",
      status: "queued",
      createdAt: older,
    });
    await addJob({
      title: "Already Prepared But Queued",
      status: "queued",
      createdAt: older,
      prepFolder: "Postulations/Old",
      preparedAt: new Date("2026-11-21T18:00:00Z"),
    });
    await addJob({
      title: "Maybe Not Apply",
      rank: "maybe",
      status: "queued",
      createdAt: older,
    });

    const secret = await prisma.secret.create({
      data: { name: "morning-test-mail", value: "not-a-real-password" },
    });
    const account = await prisma.mailAccount.create({
      data: {
        name: "morning-test",
        address: "owner@example.com",
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        username: "owner",
        password: { connect: { id: secret.id } },
      },
    });

    let uid = 0;
    async function addMail(
      importance: string,
      subject: string,
      receivedAt: Date,
      topic = "",
    ) {
      uid += 1;
      return await prisma.mailNote.create({
        data: {
          accountId: account.id,
          folder: "INBOX",
          uid,
          from: "Alice <alice@example.com>",
          subject,
          topic,
          importance,
          receivedAt,
        },
      });
    }

    await addMail(
      "important",
      "Invoice 42",
      new Date("2026-11-22T05:30:00Z"),
      "invoice November",
    );
    await addMail(
      "important",
      "Excluded Mail Before The Window",
      new Date("2026-11-19T05:30:00Z"),
    );
    await addMail("normal", "Lunch?", new Date("2026-11-22T04:30:00Z"));
    await addMail("noise", "Newsletter", new Date("2026-11-22T04:00:00Z"));

    const message = await buildMorningMessage(NOW);

    await t.step("clicked jobs, grouped, with links", () => {
      assertStringIncludes(message, "📥 Clicked since yesterday (4 jobs)");
      const order = [
        "🎯 Backend Developer — Acme (queued)",
        "🤔 Data Analyst — Globex (queued)",
        "· Intern — Initech (queued)",
        "🚫 Sales — Hooli (queued)",
      ].map((line) => message.indexOf(line));
      assert(order.every((index) => index >= 0), "every clicked job is listed");
      assertEquals([...order].sort((a, b) => a - b), order);
      assertStringIncludes(message, `<${applyJob.url}>`);
      assertEquals(message.includes("Old Application"), false);
      assertEquals(
        message.includes("Description that must never appear"),
        false,
      );
    });

    await t.step("waiting jobs carry the short id", () => {
      assertStringIncludes(message, "🕒 Waiting for you (4)");
      assertStringIncludes(message, `· ready · ${readyJob.id.slice(0, 8)}`);
      assertStringIncludes(message, "Prepared in Postulations/Globex");
      assertStringIncludes(message, "Needs your look: CV missing dates");
      assertStringIncludes(
        message,
        `waiting to be prepared · ${waitingJob.id.slice(0, 8)}`,
      );
      assertEquals(message.includes("Already Prepared But Queued"), false);
      assertEquals(message.includes("Maybe Not Apply"), false);
      assertStringIncludes(message, "mark_job");
    });

    await t.step("only important mail of the window, plus the counts", () => {
      assertStringIncludes(
        message,
        "📬 Important mail since yesterday (1 mail)",
      );
      assertStringIncludes(message, "• Alice — Invoice 42 (invoice November)");
      assertEquals(message.includes("Excluded Mail Before The Window"), false);
      assertEquals(message.includes("Lunch?"), false);
      assertEquals(message.includes("Newsletter"), false);
      assertStringIncludes(message, "Other mail: 1 normal, 1 noise.");
    });

    await t.step("the whole message fits in one DM", () => {
      assert(message.length <= MORNING_LIMIT);
    });

    await t.step(
      "a job status that is no longer waiting disappears",
      async () => {
        const applied = await prisma.job.update({
          where: { id: applyJob.id },
          data: { status: "applied" },
        });
        assertEquals(applied.status, "applied");
        const next = await buildMorningMessage(NOW);
        assertEquals(
          next.includes(`waiting to be prepared · ${applyJob.id.slice(0, 8)}`),
          false,
        );
        assertEquals(next.includes("Backend Developer"), true);
      },
    );

    await t.step("the short ids stay unique and quotable", () => {
      const ids = [
        applyJob.id,
        maybeJob.id,
        unrankedJob.id,
        skipJob.id,
        readyJob.id,
        reviewJob.id,
        waitingJob.id,
        oldJob.id,
      ].map((id) => id.slice(0, 8));
      assertEquals(new Set(ids).size, ids.length);
    });

    // Leave the tables as we found them: nothing here may shape a later file.
    await truncate(
      "ScheduledRun",
      "MailNote",
      "MailProposal",
      "MailAccount",
      "Secret",
      "Job",
    );
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "morning_summary is a registered tool and returns the same text",
  async fn() {
    const result = await runTool("morning_summary", {
      conversationId: "test",
      approval: "pending",
      emit: () => {},
    }, "{}");

    const advertised = generateToolRequest().find((request) =>
      request.type === "function" &&
      request.function.name === "morning_summary"
    );
    assert(advertised, "morning_summary must be advertised to the model");
    if (advertised?.type === "function") {
      assertEquals(advertised.function.parameters?.required, []);
    }

    assertEquals(result.status, "ok");
    if (result.status === "ok") {
      assertStringIncludes(result.content, "Clicked since yesterday");
      assertStringIncludes(result.content, "Waiting for you");
      assertStringIncludes(result.content, "Important mail since yesterday");
      assert(result.content.length <= MORNING_LIMIT);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test("the database handle is closed", async () => {
  await closeDb();
});
