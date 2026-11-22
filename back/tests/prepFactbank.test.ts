import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  FACT_BANK_FOLDER,
  loadBaseTemplates,
  loadFactBank,
} from "@/prep/factbank.ts";

// Scrambled on purpose: the loader, not the listing order, decides.
const FILES: Record<string, string> = {
  "skills.md": "C++",
  "zzz-extra.md": "late",
  "summary.md": "Le pitch",
  "experience.md": "IMA",
  "aaa-extra.md": "early",
  "contact.md": "Florian",
  "projects.md": "kernel",
  "education-awards.md": "42",
  "hobbies.md": "climbing",
  "open-questions.md": "phone number?",
};

type Entry = { basename: string; type: "file" | "directory" };

function fakeDav(
  options: {
    files?: Record<string, string>;
    entries?: Entry[];
    folder?: boolean;
    wrap?: boolean;
  } = {},
) {
  const files = options.files ?? FILES;
  const reads: string[] = [];
  const listing: Entry[] = options.entries ??
    Object.keys(files).map((name) => ({
      basename: name,
      type: "file" as const,
    }));
  const client = {
    exists: (_path: string) => Promise.resolve(options.folder ?? true),
    getDirectoryContents: (_path: string) => {
      const entries = listing.map((entry) => ({
        ...entry,
        filename: `/${FACT_BANK_FOLDER}/${entry.basename}`,
        size: 1,
      }));
      return Promise.resolve(options.wrap ? { data: entries } : entries);
    },
    getFileContents: (path: string) => {
      reads.push(path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      return Promise.resolve(files[name]);
    },
  };
  return { client, reads };
}

Deno.test("the fact bank is read in its fixed order", async () => {
  const bank = await loadFactBank(fakeDav().client);

  assertEquals(bank.files.map((file) => file.name), [
    "summary",
    "contact",
    "experience",
    "projects",
    "skills",
    "education-awards",
    "hobbies",
    "open-questions",
    "aaa-extra",
    "zzz-extra",
  ]);
});

Deno.test("each fact bank file becomes a level-2 heading", async () => {
  const { client } = fakeDav();
  const bank = await loadFactBank(client);

  assertEquals(bank.text.split("\n\n")[0], "## summary\nLe pitch");
  assertStringIncludes(bank.text, "## open-questions\nphone number?");
  assertEquals(bank.text.includes("summary.md"), false);
  assert(
    bank.text.indexOf("## summary") < bank.text.indexOf("## contact"),
    "summary must come before contact",
  );
});

Deno.test("only .md files are read, folders are ignored", async () => {
  const dav = fakeDav({
    files: { "summary.md": "S", "notes.txt": "T" },
    entries: [
      { basename: "summary.md", type: "file" },
      { basename: "notes.txt", type: "file" },
      { basename: "archive", type: "directory" },
    ],
  });

  const bank = await loadFactBank(dav.client);

  assertEquals(bank.files.map((file) => file.name), ["summary"]);
  assertEquals(dav.reads, [`${FACT_BANK_FOLDER}/summary.md`]);
});

Deno.test("a wrapped listing is unwrapped", async () => {
  const bank = await loadFactBank(fakeDav({ wrap: true }).client);
  assertEquals(bank.files.length, Object.keys(FILES).length);
});

Deno.test("a missing fact bank folder says how to upload it", async () => {
  const error = await assertRejects(
    () => loadFactBank(fakeDav({ folder: false }).client),
    Error,
  );
  assertStringIncludes(error.message, FACT_BANK_FOLDER);
  assertStringIncludes(error.message, "prep:upload-factbank");
});

Deno.test("an empty fact bank folder says how to fill it", async () => {
  const error = await assertRejects(
    () => loadFactBank(fakeDav({ files: {} }).client),
    Error,
  );
  assertStringIncludes(error.message, "no .md files");
  assertStringIncludes(error.message, "prep:upload-factbank");
});

Deno.test("the base templates ship with the bot", async () => {
  const { cv, cover } = await loadBaseTemplates();

  assertStringIncludes(cv, "@preview/moderner-cv:0.2.1");
  assertStringIncludes(cv, "Torrenté Florian");
  assertStringIncludes(cover, "New Computer Modern Sans");
});
