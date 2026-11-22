// The fact bank and the base templates the prep workflow builds on. The bank
// lives in Nextcloud rather than in the image: the model reads it on every
// application, and the owner edits it from any device. The base .typ files are
// copies of ~/job/typst/base, shipped in assets/typst.
import { join } from "node:path";
import { nextcloud } from "@/files/nextcloud.ts";
import { typstAssetsDir } from "@/prep/typst.ts";

/** Nextcloud folder holding the bank; filled by `deno task prep:upload-factbank`. */
export const FACT_BANK_FOLDER = "Postulations/fact-bank";

// The order the prompt reads the bank in: pitch and identity first, then the
// evidence, then the questions the model must ask rather than guess. Other
// files follow alphabetically.
const PREFERRED_ORDER = [
  "summary",
  "contact",
  "experience",
  "projects",
  "skills",
  "education-awards",
  "hobbies",
  "open-questions",
];

export type FactBankFile = {
  /** File name without its .md extension, e.g. "experience". */
  name: string;
  content: string;
};

/**
 * The slice of the DAV client this module reads through, so tests can pass a
 * fake without a Nextcloud.
 */
export type FactBankDav = {
  exists(path: string): Promise<boolean>;
  getDirectoryContents(path: string): Promise<unknown>;
  getFileContents(path: string, options?: { format?: string }): Promise<
    unknown
  >;
};

export type FactBank = {
  files: FactBankFile[];
  /** Every file as `## <name>` followed by its content. */
  text: string;
};

/** Facts plus unresolved questions, ready to paste into a prompt. */
export async function loadFactBank(
  dav: FactBankDav = nextcloud(),
): Promise<FactBank> {
  if (!(await dav.exists(FACT_BANK_FOLDER))) {
    throw new Error(
      `The fact bank folder "${FACT_BANK_FOLDER}" is missing in Nextcloud. ` +
        `Upload it from the owner's checkout with: deno task prep:upload-factbank`,
    );
  }

  const entries = entriesOf(await dav.getDirectoryContents(FACT_BANK_FOLDER));
  const names = entries
    .filter((entry) =>
      entry.type === "file" && entry.basename.toLowerCase().endsWith(".md")
    )
    .map((entry) => entry.basename);

  if (names.length === 0) {
    throw new Error(
      `The fact bank folder "${FACT_BANK_FOLDER}" holds no .md files. ` +
        `Fill it from the owner's checkout with: deno task prep:upload-factbank`,
    );
  }

  const files: FactBankFile[] = [];
  for (const file of sortFactBankNames(names)) {
    const content = await dav.getFileContents(
      `${FACT_BANK_FOLDER}/${file}`,
      { format: "text" },
    );
    files.push({
      name: file.replace(/\.md$/i, ""),
      content: String(content).trimEnd(),
    });
  }

  return {
    files,
    text: files.map((file) => `## ${file.name}\n${file.content}`).join(
      "\n\n",
    ),
  };
}

/** The fixed reading order, with unknown files alphabetical at the end. */
export function sortFactBankNames(names: string[]): string[] {
  const rank = (name: string) => {
    const stem = name.replace(/\.md$/i, "").toLowerCase();
    const index = PREFERRED_ORDER.indexOf(stem);
    return index === -1 ? PREFERRED_ORDER.length : index;
  };
  return [...names].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : a.localeCompare(b);
  });
}

/** The base CV and cover letter, copied from ~/job/typst/base. */
export async function loadBaseTemplates(
  assetsDir = typstAssetsDir(),
): Promise<{ cv: string; cover: string }> {
  const [cv, cover] = await Promise.all([
    Deno.readTextFile(join(assetsDir, "base", "cv.typ")),
    Deno.readTextFile(join(assetsDir, "base", "cover.typ")),
  ]);
  return { cv, cover };
}

type DavFileEntry = {
  basename: string;
  type: "file" | "directory";
};

function entriesOf(value: unknown): DavFileEntry[] {
  const list = Array.isArray(value)
    ? value
    : (value as { data?: unknown })?.data;
  if (!Array.isArray(list)) {
    throw new Error("Unexpected Nextcloud listing: no entries.");
  }
  return list as DavFileEntry[];
}
