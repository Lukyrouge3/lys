import {
  HindsightClient,
  HindsightError,
  type RecallResult,
} from "@vectorize-io/hindsight-client";
import prisma from "@/db.ts";
import { logger } from "@/utils/logger.ts";
import { expirePendingApprovals, UNDECIDED } from "@/agent/pending.ts";

const BASE_URL = Deno.env.get("HINDSIGHT_BASE_URL");
const API_KEY = Deno.env.get("HINDSIGHT_API_KEY") || undefined;
const BANK_ID = Deno.env.get("HINDSIGHT_BANK_ID") ?? "Lys";
const RETAIN_CONTEXT = Deno.env.get("HINDSIGHT_RETAIN_CONTEXT") ??
  "Personal assistant chatting with the user";

// Recall sits on the critical path before every reply, so keep it cheap.
const MAX_RECALL_TOKENS = 1200;
const RECALL_TIMEOUT_MS = 2000;
// The recall API rejects queries over 500 tokens; 1500 chars is a safe margin.
const MAX_QUERY_CHARS = 1500;
// Back off instead of calling a Hindsight that is down (or not running) on
// every single turn.
const COOLDOWN_MS = 60_000;
// One retain is one extraction job. Keep it small enough to be accepted, and
// spread a backlog over a few turns instead of sending one huge document.
const MAX_RETAIN_CHARS = 8000;
// Rough cost of the JSON keys, role and timestamp around each message.
const RETAIN_OVERHEAD_CHARS = 100;

const LEADING_TIMESTAMP = /^\[[^\]]*\]\s*/;

type MemoryKind = "recall" | "retain";
export type RetainRow = {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
};

let client: HindsightClient | null = null;
const unavailableUntil: Record<MemoryKind, number> = { recall: 0, retain: 0 };

function memory(): HindsightClient | null {
  if (!BASE_URL) return null;
  client ??= new HindsightClient({ baseUrl: BASE_URL, apiKey: API_KEY });
  return client;
}

function usable(kind: MemoryKind): boolean {
  return Date.now() >= unavailableUntil[kind];
}

// A bad request (too long, malformed) will fail the same way forever, so it
// must not pause the whole memory layer. Only outages get a cooldown.
function isOutage(err: unknown): boolean {
  if (!(err instanceof HindsightError)) return true; // network error, timeout
  const status = err.statusCode;
  return status === undefined || status >= 500 || status === 429 ||
    status === 408;
}

function markUnavailable(kind: MemoryKind, err: unknown): void {
  if (!isOutage(err)) {
    logger.warn(`Hindsight ${kind} rejected a request: ${err}`);
    return;
  }
  if (usable(kind)) {
    logger.warn(
      `Hindsight ${kind} failed at ${BASE_URL}, pausing it for 60s: ${err}`,
    );
  }
  unavailableUntil[kind] = Date.now() + COOLDOWN_MS;
}

/**
 * The latest user message is the query. Short or context-dependent messages
 * ("what about the second one?") are anchored to the previous user message so
 * they still retrieve something.
 */
export function buildRecallQuery(
  input: string,
  previousUser?: string,
): string {
  const query = input.replace(LEADING_TIMESTAMP, "").trim();
  if (!query) return "";

  const words = query.split(/\s+/).length;
  const vague =
    /^(and|but|so|then|also|what about|how about|that|this|it|the)\b/i.test(
      query,
    );

  const anchored = (words < 6 || vague) && previousUser
    ? `${previousUser.replace(LEADING_TIMESTAMP, "").trim()} — ${query}`
    : query;

  return anchored.slice(0, MAX_QUERY_CHARS);
}

export type MemoryHit = Pick<RecallResult, "text" | "type">;

export type SearchOptions = {
  maxTokens?: number;
  budget?: "low" | "mid" | "high";
  timeoutMs?: number;
};

/**
 * Recall that reports failure to the caller, so the tool can tell the model
 * memory is down instead of claiming it found nothing. Throws when Hindsight
 * is unset, cooling down, or the request fails.
 */
export async function searchMemories(
  query: string,
  options: SearchOptions = {},
): Promise<RecallResult[]> {
  const hs = memory();
  if (!hs) {
    throw new Error("Long-term memory is not configured on this server.");
  }
  if (!usable("recall")) {
    throw new Error(
      "Long-term memory is temporarily unavailable after a recent failure. Answer from the conversation instead.",
    );
  }
  if (!query.trim()) {
    throw new Error("Nothing to search for: the query is empty.");
  }

  try {
    const response = await hs.recall(BANK_ID, query, {
      maxTokens: options.maxTokens ?? MAX_RECALL_TOKENS,
      budget: options.budget ?? "low",
      preferObservations: true,
      includeEntities: false,
      signal: AbortSignal.timeout(options.timeoutMs ?? RECALL_TIMEOUT_MS),
    });
    return response.results;
  } catch (err) {
    markUnavailable("recall", err);
    throw err;
  }
}

export async function recallMemories(
  query: string,
  maxTokens = MAX_RECALL_TOKENS,
): Promise<MemoryHit[]> {
  if (!query) return [];
  try {
    const results = await searchMemories(query, { maxTokens });
    return results.map(({ text, type }) => ({ text, type }));
  } catch {
    // searchMemories already logged it; a reply without memory is fine
    return [];
  }
}

export function formatMemories(hits: MemoryHit[]): string {
  if (hits.length === 0) return "";
  return "What you remember about them from earlier conversations:\n" +
    hits.map((hit) => `- ${hit.text}`).join("\n");
}

/**
 * Store one fact the assistant explicitly chose to remember. Each note becomes
 * its own document: appending to the conversation document could be wiped by
 * the first end-of-turn replace, and creating a document with append hangs.
 */
export async function saveMemory(content: string): Promise<void> {
  const hs = memory();
  if (!hs) {
    throw new Error("Long-term memory is not configured on this server.");
  }
  if (!usable("retain")) {
    throw new Error(
      "Long-term memory is temporarily unavailable after a recent failure.",
    );
  }

  const text = content.trim();
  if (!text) {
    throw new Error("Nothing to remember: the content is empty.");
  }

  try {
    await hs.retain(BANK_ID, text, {
      documentId: `note-${crypto.randomUUID()}`,
      context:
        "A fact the assistant deliberately saved about the user or the conversation",
      timestamp: new Date().toISOString(),
      async: true,
    });
  } catch (err) {
    markUnavailable("retain", err);
    throw err;
  }
}

export type RetainBatch = {
  transcript: Array<{ role: string; content: string; timestamp: string }>;
  // Every message consumed by this batch, including empty tool-call turns
  ids: string[];
};

/**
 * Take messages in order until the character budget is used up. Empty turns
 * cost nothing, and one oversized message is cut short rather than poisoning
 * every later attempt.
 */
export function buildRetainBatch(
  rows: RetainRow[],
  maxChars = MAX_RETAIN_CHARS,
): RetainBatch {
  const batch: RetainBatch = { transcript: [], ids: [] };
  let used = 0;

  for (const row of rows) {
    const content = row.content.trim();
    if (!content) {
      batch.ids.push(row.id);
      continue;
    }

    // Only the first message may be cut: a later one that does not fit whole
    // waits for the next batch, so no message is silently half-remembered
    const room = maxChars - used - RETAIN_OVERHEAD_CHARS;
    if (batch.transcript.length > 0 && content.length > room) break;

    const text = content.slice(0, Math.max(room, 1));

    batch.transcript.push({
      role: row.role,
      content: text,
      timestamp: row.createdAt.toISOString(),
    });
    batch.ids.push(row.id);
    used += text.length + RETAIN_OVERHEAD_CHARS;
  }

  return batch;
}

type Retention = { rerun: boolean; done: Promise<void> };
const inFlight = new Map<string, Retention>();

/**
 * Append the messages saved since the last retain to the conversation's
 * Hindsight document. Safe to call after every turn: it does nothing while a
 * turn is paused on a tool approval, and nothing when there is no new content.
 */
export function retainConversation(conversationId: string): Promise<void> {
  const running = inFlight.get(conversationId);
  if (running) {
    // A turn that ends mid-retain would otherwise wait for some later turn:
    // remember that more work arrived and run once more.
    running.rerun = true;
    return running.done;
  }

  const state: Retention = { rerun: false, done: Promise.resolve() };
  state.done = (async () => {
    try {
      do {
        state.rerun = false;
        await doRetain(conversationId);
      } while (state.rerun);
    } finally {
      inFlight.delete(conversationId);
    }
  })();

  inFlight.set(conversationId, state);
  return state.done;
}

async function doRetain(conversationId: string): Promise<void> {
  const hs = memory();
  if (!hs || !usable("retain")) return;

  try {
    // A turn waiting on any approval is not finished, so its messages would be
    // retained mid-loop. Wait until every decision lets the agent continue, and
    // let a forgotten button expire instead of blocking this forever.
    await expirePendingApprovals();
    const pending = await prisma.toolCall.count({
      where: {
        approval: { in: [...UNDECIDED] },
        message: { conversationId },
      },
    });
    if (pending > 0) return;

    const rows = await prisma.message.findMany({
      where: { conversationId, retainedAt: null, role: { not: "system" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, createdAt: true },
    });
    if (rows.length === 0) return;

    // Tool-call-only assistant turns have empty content and carry nothing
    // worth remembering; tool results stay out of memory on purpose.
    const { transcript, ids } = buildRetainBatch(rows);
    if (ids.length === 0) return;

    if (transcript.length > 0) {
      // Append needs a document to append to, so the very first write creates
      // it with replace. After that only new messages are sent, and unchanged
      // chunks are never re-extracted.
      const alreadyRetained = await prisma.message.count({
        where: { conversationId, retainedAt: { not: null } },
      });

      try {
        await hs.retain(BANK_ID, JSON.stringify(transcript), {
          documentId: conversationId,
          updateMode: alreadyRetained > 0 ? "append" : "replace",
          context: RETAIN_CONTEXT,
          timestamp: transcript.at(-1)!.timestamp,
          async: true,
        });
      } catch (err) {
        if (isOutage(err)) throw err;
        // A rejected batch would fail the same way on every turn, so drop it
        // (and log it) instead of blocking memory forever.
        logger.warn(
          `Hindsight dropped a batch of ${transcript.length} messages: ${err}`,
        );
      }
    }

    await prisma.message.updateMany({
      where: { id: { in: ids } },
      data: { retainedAt: new Date() },
    });
    logger.debug(`Retained ${transcript.length} messages of ${conversationId}`);
  } catch (err) {
    // Memory must never break the chat: leave the messages unmarked so a
    // later turn retries them.
    markUnavailable("retain", err);
  }
}
