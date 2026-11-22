// Strict, line-based readers for the two prep answers. The write answer is
// Typst source, so it cannot be JSON; the delimiters are the only structure.
// Both parsers decide from the lines that are supposed to carry the answer,
// never from a keyword found anywhere in the text.
import type { PrepLanguage } from "@/prep/types.ts";

export type WriteAnswer = {
  language: PrepLanguage;
  notes: string;
  cvTyp: string;
  coverTyp: string;
};

export type VerifyAnswer = {
  ok: boolean;
  unsupported: string[];
};

const BLOCK_NAMES = ["notes.md", "cv.typ", "cover.typ"] as const;
type BlockName = (typeof BLOCK_NAMES)[number];

// Anchored at column 0 on purpose: an indented line is content, not structure.
const DELIMITER = /^=====\s*(notes\.md|cv\.typ|cover\.typ)\s*=====\s*$/;
const LANGUAGE_LINE = /^language:\s*(fr|en)\s*$/i;
const FENCE = /^```[\w+-]*$/;
const CLOSING_FENCE = "```";

/**
 * Reads the writer's answer. The first non-blank line must be the language;
 * the three blocks must each appear exactly once, in any order. A markdown
 * fence wrapped around a block is stripped only when both ends are fences.
 * Missing block, duplicate block or a bad language line returns null.
 */
export function parseWrite(answer: string): WriteAnswer | null {
  const lines = normalize(answer).split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex === -1) return null;

  const language = LANGUAGE_LINE.exec(lines[firstIndex].trim());
  if (!language) return null;

  const blocks = new Map<BlockName, string[]>();
  let current: BlockName | null = null;

  for (let index = firstIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    const delimiter = DELIMITER.exec(line);
    if (delimiter) {
      const name = delimiter[1] as BlockName;
      if (blocks.has(name)) return null;
      current = name;
      blocks.set(name, []);
      continue;
    }
    if (current) blocks.get(current)!.push(line);
  }

  if (blocks.size !== BLOCK_NAMES.length) return null;

  return {
    language: language[1].toLowerCase() as PrepLanguage,
    notes: cleanBlock(blocks.get("notes.md")!),
    cvTyp: cleanBlock(blocks.get("cv.typ")!),
    coverTyp: cleanBlock(blocks.get("cover.typ")!),
  };
}

const VERDICT_LINE = /^verdict:\s*(ok|issues)\s*$/i;
const UNSUPPORTED_LINE = /^unsupported:\s*(\S.*)$/i;

/**
 * Reads the verifier's answer. Only the `verdict:` line decides; a negation
 * such as "verdict: not ok" is not a verdict at all. `issues` without any
 * `unsupported:` line is unusable, not a pass.
 */
export function parseVerify(answer: string): VerifyAnswer | null {
  let verdict: "ok" | "issues" | null = null;
  const unsupported: string[] = [];

  for (const line of normalize(answer).split("\n")) {
    const verdictMatch = VERDICT_LINE.exec(line);
    if (verdictMatch) {
      // Two verdict lines mean the model did not answer one question.
      if (verdict !== null) return null;
      verdict = verdictMatch[1].toLowerCase() as "ok" | "issues";
      continue;
    }

    const unsupportedMatch = UNSUPPORTED_LINE.exec(line);
    if (unsupportedMatch) {
      const claim = unsupportedMatch[1].trim();
      if (claim) unsupported.push(claim);
    }
  }

  if (verdict === null) return null;
  if (verdict === "ok") return { ok: true, unsupported: [] };
  if (unsupported.length === 0) return null;
  return { ok: false, unsupported };
}

function normalize(answer: string): string {
  return answer.replace(/\r\n?/g, "\n");
}

/** Drops blank edges, and one fence pair when the block is fenced. */
function cleanBlock(lines: string[]): string {
  let block = trimBlankEdges(lines);

  if (block.length >= 2) {
    const first = block[0].trim();
    const last = block[block.length - 1].trim();
    if (FENCE.test(first) && last === CLOSING_FENCE) {
      block = trimBlankEdges(block.slice(1, -1));
    }
  }

  return block.join("\n");
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}
