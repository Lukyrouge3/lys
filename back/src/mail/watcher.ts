import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import prisma from "@/db.ts";
import {
  getMailAccount,
  type MailAccountWithSecret,
  openImap,
  WATCH_IDLE_DELAY_MS,
} from "@/mail/account.ts";
import { type FolderState, folderStateAfter, uidWindow } from "@/mail/state.ts";
import { logger } from "@/utils/logger.ts";

const RECONNECT_MS = 30_000;
const FOLDER = "INBOX";
const PREVIEW_CHARS = 2000;

export type MailEvent = {
  accountId: string;
  account: string;
  folder: string;
  uid: number;
  from: string;
  subject: string;
  date: Date | null;
  // First part of the plain-text body, for classification and notices
  preview: string;
};

type Envelope = {
  subject?: string | null;
  date?: string | Date | null;
  from?: Array<{ name?: string | null; address?: string | null } | null> | null;
};

export function toMailEvent(
  account: { id: string; name: string },
  folder: string,
  msg: { uid: number; envelope?: Envelope | null },
  preview = "",
): MailEvent {
  const envelope = msg.envelope;
  const from = (envelope?.from ?? [])
    .map((person) =>
      person?.name
        ? `${person.name} <${person.address ?? ""}>`
        : person?.address ?? ""
    )
    .filter(Boolean)
    .join(", ");
  const date = envelope?.date ? new Date(envelope.date) : null;

  return {
    accountId: account.id,
    account: account.name,
    folder,
    uid: msg.uid,
    from: from || "(unknown sender)",
    subject: envelope?.subject?.trim() || "(no subject)",
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    preview,
  };
}

export type MailAttachment = {
  filename: string;
  mime: string;
  content: Uint8Array;
};

export type MailHandler = (
  mail: MailEvent,
  attachments: MailAttachment[],
) => void | Promise<void>;

/** Start of a quoted reply or forward: everything below is not new text. */
const QUOTE_START = [
  /^-{2,}\s*(message original|original message|message d'origine|forwarded message|message transféré)\s*-{2,}$/i,
  /^_{5,}$/,
  /^on\s.+\bwrote\s*:$/i,
  /^le\s.+\ba écrit\s*:$/i,
  /^--\s*$/,
];

/** Header block of a forwarded mail, skipped when the forward has no text. */
const QUOTE_HEADER =
  /^(sujet|subject|date|de|from|répondre à|reply-to|pour|to|envoyé|sent|cc)\s*:/i;

/**
 * The part of a body worth reading: the new text first, and when a forward
 * carries none, the quoted message with its header block removed. Line
 * structure is kept so notices and prompts get paragraphs, not one long line.
 */
export function cleanPreview(text: string, limit = PREVIEW_CHARS): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => !line.startsWith(">"));

  const cut = lines.findIndex((line) =>
    QUOTE_START.some((pattern) => pattern.test(line))
  );
  let kept = cut === -1 ? lines : lines.slice(0, cut);

  // A bare forward has nothing above the separator: read the quoted mail instead
  if (cut !== -1 && kept.every((line) => line === "")) {
    kept = lines.slice(cut + 1);
    while (kept.length > 0 && (kept[0] === "" || QUOTE_HEADER.test(kept[0]))) {
      kept.shift();
    }
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

/** Body preview plus every real attachment, parsed once per message. */
export async function parseMail(
  source?: Uint8Array | null,
  limit = PREVIEW_CHARS,
): Promise<{ preview: string; attachments: MailAttachment[] }> {
  if (!source || source.length === 0) {
    return { preview: "", attachments: [] };
  }
  try {
    const parsed = await PostalMime.parse(source);
    const attachments = parsed.attachments
      // Inline parts are signature logos and tracked pixels, not documents
      .filter((part) => part.filename && !part.related && !part.contentId)
      .map((part) => ({
        filename: part.filename!,
        mime: part.mimeType || "application/octet-stream",
        content: typeof part.content === "string"
          ? new TextEncoder().encode(part.content)
          : new Uint8Array(part.content),
      }))
      .filter((part) => part.content.byteLength > 0);

    return {
      preview: cleanPreview(parsed.text ?? "", limit),
      attachments,
    };
  } catch {
    // A message that cannot be parsed still has a usable envelope
    return { preview: "", attachments: [] };
  }
}

/**
 * The IMAP range for everything not seen yet. `n:*` always matches the newest
 * message, even when its UID is below n, so the upper bound is spelled out.
 */
export function uidRange(firstUid: number, uidNext: number): string | null {
  const last = uidNext - 1;
  return firstUid > last ? null : `${firstUid}:${last}`;
}

export type Watcher = {
  stop: () => Promise<void>;
};

/** How a watch ended: the user stopped it, or the connection went away. */
export type WatchEnd = "aborted" | "closed";

/** The parts of ImapFlow's event API watchEnd needs. */
type Connection = {
  on(event: "close" | "error", listener: () => void): unknown;
  off(event: "close" | "error", listener: () => void): unknown;
};

/**
 * Resolves when the connection goes away or the watcher is stopped. imapflow
 * never reconnects on its own, so a connection that closes must end this watch
 * and let the reconnect loop in watchMail open a new one. Waiting only on the
 * abort signal is what used to leave the watcher alive but deaf, with no log.
 */
export function watchEnd(
  connection: Connection,
  signal: AbortSignal,
): Promise<WatchEnd> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");

    const finish = (end: WatchEnd) => {
      connection.off("close", onClose);
      connection.off("error", onClose);
      signal.removeEventListener("abort", onAbort);
      resolve(end);
    };
    function onClose() {
      finish("closed");
    }
    function onAbort() {
      finish("aborted");
    }

    connection.on("close", onClose);
    connection.on("error", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type WatchOptions = {
  account?: string;
  reconnectMs?: number;
};

/**
 * Keeps one IDLE connection per account and reports mail arriving after it
 * started. A fresh folder begins at uidNext: mail from before the watcher ran
 * is not replayed.
 */
export function watchMail(
  onMail: MailHandler,
  options: WatchOptions = {},
): Watcher {
  const controller = new AbortController();

  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        await watchOnce(controller.signal, onMail, options);
      } catch (err) {
        logger.warn(`Mail watcher failed: ${err}`);
      }
      if (!controller.signal.aborted) {
        await sleep(options.reconnectMs ?? RECONNECT_MS, controller.signal);
      }
    }
  })();

  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

async function watchOnce(
  signal: AbortSignal,
  onMail: MailHandler,
  options: WatchOptions,
): Promise<void> {
  const account = await getMailAccount(options.account);
  if (!account) {
    logger.warn("No enabled mail account in the database");
    return;
  }

  const client = await openImap(account, {
    autoIdleDelay: WATCH_IDLE_DELAY_MS,
  });
  client.on(
    "error",
    (err) => logger.warn(`Mail connection for ${account.name}: ${err.message}`),
  );

  try {
    // Selected but not locked. imapflow's auto-IDLE refuses to arm while a
    // mailbox lock is held, and a connection that never idles is never told by
    // the server that mail arrived. The lock lives inside sweep() instead.
    await client.mailboxOpen(FOLDER);

    // Sweeps are queued so two bursts of new mail never fetch twice
    let queue: Promise<void> = Promise.resolve();
    const schedule = () => {
      queue = queue.then(() => sweep(client, account, onMail)).catch((err) =>
        logger.warn(`Mail sweep for ${account.name} failed: ${err}`)
      );
    };

    // Registered before the first sweep: mail arriving while the catch-up runs
    // still schedules a follow-up. Sweeps take the mailbox lock, so the
    // follow-up cannot overlap the catch-up in flight.
    client.on("exists", schedule);

    await sweep(client, account, onMail);
    logger.info(
      `Watching ${account.address} (${FOLDER}) for new mail`,
    );

    const end = await watchEnd(client, signal);
    client.off("exists", schedule);
    await queue;
    if (end === "closed") {
      throw new Error(`Mail connection for ${account.name} closed`);
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function sweep(
  client: ImapFlow,
  account: MailAccountWithSecret,
  onMail: MailHandler,
): Promise<void> {
  // Locked only for the sweep, never for the life of the connection: auto-IDLE
  // will not arm while a lock is held, and then the server has no session to
  // push EXISTS to.
  const lock = await client.getMailboxLock(FOLDER);
  try {
    // A pushed EXISTS carries no UIDs, and mailbox.uidNext is only refreshed by
    // SELECT/STATUS - it does not move on its own. Without this the window
    // below is computed from the uidNext of the last SELECT and comes out
    // empty, so pushed mail would never be fetched. uidValidity is asked for
    // too: a mailbox can be rewritten while this connection stays up, and the
    // SELECT that opened it is long gone.
    const status = await client.status(FOLDER, {
      uidNext: true,
      uidValidity: true,
    });
    if (
      !status || status.uidNext === undefined ||
      status.uidValidity === undefined
    ) {
      throw new Error(`Could not read ${FOLDER} status`);
    }
    const mailbox = {
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
    };

    const row = await prisma.mailFolder.findUnique({
      where: { accountId_path: { accountId: account.id, path: FOLDER } },
    });
    const state: FolderState = {
      uidValidity: row?.uidValidity ?? null,
      lastUid: row?.lastUid ?? 0,
    };

    const { firstUid } = uidWindow(state, mailbox);
    const range = uidRange(firstUid, mailbox.uidNext);
    let highestFetched = 0;

    if (range) {
      for await (
        const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          source: true,
        }, { uid: true })
      ) {
        highestFetched = Math.max(highestFetched, msg.uid);
        try {
          const { preview, attachments } = await parseMail(msg.source);
          await onMail(
            toMailEvent(account, FOLDER, msg, preview),
            attachments,
          );
        } catch (err) {
          // One bad message must not stop the folder
          logger.warn(`Handling mail ${msg.uid} failed: ${err}`);
        }
      }
    }

    // Never derived from the old cursor: after a reset that value belongs to a
    // UID space that no longer exists.
    const next = folderStateAfter(state, mailbox, highestFetched);
    await prisma.mailFolder.upsert({
      where: { accountId_path: { accountId: account.id, path: FOLDER } },
      update: next,
      create: { accountId: account.id, path: FOLDER, ...next },
    });
  } finally {
    lock.release();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
