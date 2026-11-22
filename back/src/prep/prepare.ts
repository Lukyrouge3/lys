// Generates a tailored CV and cover letter from the fact bank, compiles both,
// checks the PDFs, and has a second model pass audit every claim. The result is
// a draft for the owner: it is never sent or published here.
import { askAgent } from "@/mail/classify.ts";
import { loadBaseTemplates, loadFactBank } from "@/prep/factbank.ts";
import type { FactBank } from "@/prep/factbank.ts";
import { parseVerify, parseWrite } from "@/prep/parse.ts";
import type { WriteAnswer } from "@/prep/parse.ts";
import { verifyRequest, writeRequest } from "@/prep/prompt.ts";
import { compileTypst, pdfPageCount, pdfText } from "@/prep/typst.ts";
import type {
  PrepChatRequest,
  PrepDeps,
  PrepJobInput,
  PrepResult,
  PrepTemplates,
} from "@/prep/types.ts";
import { logger } from "@/utils/logger.ts";
import { withTimeout } from "@/utils/timeout.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_REPAIR_ROUNDS = 2;
const MAX_ERROR_CHARS = 1500;

const UNPARSABLE_REMINDER =
  "Your previous answer could not be parsed. Follow the required format exactly: " +
  'the very first line must be "language: fr" or "language: en", then a line ' +
  '"===== notes.md =====", the notes, a line "===== cv.typ =====", the complete ' +
  'CV source, a line "===== cover.typ =====", and the complete cover letter source. ' +
  "No text before the language line, and no markdown fence around the answer.";

const UNPARSABLE_ERROR =
  "The model gave an unusable answer for application preparation: expected " +
  '"language: fr" or "language: en" followed by the notes.md, cv.typ and cover.typ blocks.';

const EMPTY_WRITE_ERROR =
  "The model returned an empty answer for application preparation: it probably " +
  "spent its token budget thinking; see PREP_THINKING.";

/**
 * The thinking level for both prep calls. Measured against claude-haiku-5-5
 * through CLIProxyAPI on the Toreagle job: with the provider default, a
 * 16000-token write call spent 15130-16000 tokens on reasoning and returned an
 * empty or truncated answer; `(low)`, `(medium)` and a numeric budget behaved
 * the same. `(none)` disabled thinking (0 reasoning tokens), answered in
 * 4132-4914 output tokens and parsed. An empty value turns the suffix off.
 */
function prepThinking(): string {
  const raw = Deno.env.get("PREP_THINKING");
  return raw === undefined ? "none" : raw.trim();
}

/** The seam the workflow runs through, with real implementations by default. */
export function defaultDeps(): PrepDeps {
  return {
    llm: <T>(
      trigger: string,
      build: (model: string) => PrepChatRequest,
      parse: (answer: string) => T,
    ) =>
      askAgent(
        trigger,
        build,
        parse,
        Deno.env.get("PREP_AGENT")?.trim() || "lys",
        prepThinking(),
      ),
    compile: compileTypst,
    pageCount: pdfPageCount,
    text: pdfText,
    loadFacts: () => loadFactBank(),
    loadTemplates: () => loadBaseTemplates(),
    now: () => Date.now(),
  };
}

/**
 * Prepares one application end to end. Anything that cannot be produced and
 * checked is returned as `review` with the problems, rather than thrown away;
 * only an unusable writer answer, a provider failure or the wall-clock budget
 * running out rejects.
 */
export async function prepareApplication(
  job: PrepJobInput,
  overrides: Partial<PrepDeps> = {},
): Promise<PrepResult> {
  const deps: PrepDeps = { ...defaultDeps(), ...overrides };
  const started = deps.now();

  const result = await withTimeout(
    run(job, deps),
    timeoutMs(),
    "application preparation",
  );

  logger.info(
    `prep: ${job.company} — ${job.title}: ${result.status} in ${
      Math.round(deps.now() - started)
    } ms`,
  );
  return result;
}

async function run(job: PrepJobInput, deps: PrepDeps): Promise<PrepResult> {
  const [facts, templates] = await Promise.all([
    deps.loadFacts(),
    deps.loadTemplates(),
  ]);
  const familyName = familyNameOf(facts);

  let write = await askWrite(job, facts, templates, deps);
  if (!write) {
    write = await askWrite(job, facts, templates, deps, [UNPARSABLE_REMINDER]);
    if (!write) throw new Error(UNPARSABLE_ERROR);
  }

  let checked = await checkPair(write, deps, familyName);
  let cvPdf = checked.cvPdf ?? new Uint8Array();
  let coverPdf = checked.coverPdf ?? new Uint8Array();
  let problems = checked.problems;

  for (
    let round = 0;
    round < MAX_REPAIR_ROUNDS && problems.length > 0;
    round++
  ) {
    const repaired = await askWrite(job, facts, templates, deps, problems);
    if (!repaired) {
      problems = [
        UNPARSABLE_REMINDER,
        "The repair answer still could not be parsed.",
      ];
      continue;
    }

    write = repaired;
    checked = await checkPair(write, deps, familyName);
    cvPdf = checked.cvPdf ?? cvPdf;
    coverPdf = checked.coverPdf ?? coverPdf;
    problems = checked.problems;
  }

  const base = {
    language: write.language,
    notes: write.notes,
    cvTyp: write.cvTyp,
    coverTyp: write.coverTyp,
    cvPdf,
    coverPdf,
  };

  if (problems.length > 0) {
    return { ...base, status: "review", gaps: problems };
  }

  const verdict = await deps.llm(
    "prep:verify",
    (model) =>
      verifyRequest(model, facts.text, checked.cvText, checked.coverText),
    parseVerify,
  );

  if (!verdict) {
    return {
      ...base,
      status: "review",
      gaps: ["verifier gave no usable answer"],
    };
  }

  if (!verdict.ok) {
    return { ...base, status: "review", gaps: verdict.unsupported };
  }

  return { ...base, status: "ready", gaps: [] };
}

async function askWrite(
  job: PrepJobInput,
  facts: FactBank,
  templates: PrepTemplates,
  deps: PrepDeps,
  previousProblems?: string[],
): Promise<WriteAnswer | null> {
  let empty = false;
  const answer = await deps.llm(
    "prep:write",
    (model) =>
      writeRequest(model, job, facts.text, templates, previousProblems),
    (text) => {
      empty = text.trim().length === 0;
      return parseWrite(text);
    },
  );
  // An empty answer is not a format problem the model can be talked out of: it
  // spent the whole output budget before writing anything.
  if (!answer && empty) throw new Error(EMPTY_WRITE_ERROR);
  return answer;
}

type CheckedPair = {
  cvPdf: Uint8Array | null;
  coverPdf: Uint8Array | null;
  cvText: string;
  coverText: string;
  problems: string[];
};

async function checkPair(
  write: WriteAnswer,
  deps: PrepDeps,
  familyName: string | null,
): Promise<CheckedPair> {
  const [cv, cover] = await Promise.all([
    checkDocument("cv", write.cvTyp, deps, familyName),
    checkDocument("cover", write.coverTyp, deps, familyName),
  ]);

  return {
    cvPdf: cv.pdf,
    coverPdf: cover.pdf,
    cvText: cv.text,
    coverText: cover.text,
    problems: [...cv.problems, ...cover.problems],
  };
}

type DocumentCheck = {
  pdf: Uint8Array | null;
  text: string;
  problems: string[];
};

/** One document must compile cleanly, fit one page, and carry the name. */
async function checkDocument(
  label: "cv" | "cover",
  source: string,
  deps: PrepDeps,
  familyName: string | null,
): Promise<DocumentCheck> {
  let compiled;
  try {
    compiled = await deps.compile({ source });
  } catch (error) {
    return {
      pdf: null,
      text: "",
      problems: [
        `${label}: the Typst source does not compile: ${errorText(error)}`,
      ],
    };
  }

  const problems: string[] = [];

  if (compiled.warnings.length > 0) {
    problems.push(
      `${label}: Typst warnings: ${compiled.warnings.join("; ")}`,
    );
  }

  try {
    const pages = await deps.pageCount(compiled.pdf);
    if (pages !== 1) {
      problems.push(
        `${label}: page count ${pages}, cut content, do not shrink type below 10pt`,
      );
    }
  } catch (error) {
    problems.push(`${label}: page count failed: ${errorText(error)}`);
  }

  let text = "";
  try {
    text = await deps.text(compiled.pdf);
    if (text.trim().length === 0) {
      problems.push(`${label}: the extracted text is empty`);
    } else if (familyName && !text.includes(familyName)) {
      problems.push(
        `${label}: the extracted text does not contain the family name "${familyName}"`,
      );
    }
  } catch (error) {
    problems.push(`${label}: text extraction failed: ${errorText(error)}`);
  }

  return { pdf: compiled.pdf, text, problems };
}

/**
 * The family name as the fact bank writes it: surname first, in the Name row of
 * contact.md ("Torrenté Florian"), or before a comma. Null when the bank has no
 * readable name, in which case the name check is skipped.
 */
export function familyNameOf(facts: FactBank): string | null {
  const contact = facts.files.find((file) =>
    file.name.toLowerCase() === "contact"
  );
  if (!contact) return null;

  for (const raw of contact.content.split(/\r?\n/)) {
    const line = raw.trim();
    const table = /^\|\s*name\s*\|\s*([^|]+)\|/i.exec(line);
    const field = /^(?:full\s+)?name\s*:\s*(.+)$/i.exec(line);
    const value = (table?.[1] ?? field?.[1] ?? "").replace(/[*_`]/g, "").trim();
    if (!value) continue;

    const firstPart = value.split(",")[0].trim();
    const token = firstPart.split(/\s+/).find((part) => /\p{L}/u.test(part));
    if (!token) continue;

    const family = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (family) return family;
  }

  return null;
}

function timeoutMs(): number {
  const raw = Deno.env.get("PREP_TIMEOUT_MS")?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}…`
    : text;
}
