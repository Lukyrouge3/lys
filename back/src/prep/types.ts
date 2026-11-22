// The shape of a prepared application and the seams that let the workflow be
// tested (and reused) without a model, Typst or Nextcloud.
import type { Job } from "@/generated/prisma/client.ts";
import type { FactBank } from "@/prep/factbank.ts";
import type { CompileOptions, CompileResult } from "@/prep/typst.ts";

export type PrepLanguage = "fr" | "en";

export type PrepStatus = "ready" | "review";

export type PrepResult = {
  language: PrepLanguage;
  /** Requirement → fact-bank row mapping, as markdown. */
  notes: string;
  cvTyp: string;
  coverTyp: string;
  cvPdf: Uint8Array;
  coverPdf: Uint8Array;
  status: PrepStatus;
  /** Unsupported claims or failed checks when status is "review". */
  gaps: string[];
};

/** The request shape `askAgent` takes; kept local like the other prompts. */
export type PrepChatRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
  temperature: number;
};

export type PrepLlm = <T>(
  trigger: string,
  build: (model: string) => PrepChatRequest,
  parse: (answer: string) => T,
) => Promise<T>;

export type PrepTemplates = { cv: string; cover: string };

export type PrepDeps = {
  llm: PrepLlm;
  compile: (options: CompileOptions) => Promise<CompileResult>;
  pageCount: (pdf: Uint8Array) => Promise<number>;
  text: (pdf: Uint8Array) => Promise<string>;
  loadFacts: () => Promise<FactBank>;
  loadTemplates: () => Promise<PrepTemplates>;
  now: () => number;
};

export type PrepJobInput = Pick<
  Job,
  "title" | "company" | "location" | "description" | "url"
>;
