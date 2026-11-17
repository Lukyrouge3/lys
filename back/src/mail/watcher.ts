import { ImapFlow } from "imapflow";
import prisma from "@/db.ts";
import {
  getMailAccount,
  type MailAccountWithSecret,
  openImap,
} from "@/mail/account.ts";
import { uidWindow } from "@/mail/state.ts";
import { logger } from "@/utils/logger.ts";

const RECONNECT_MS = 30_000;
const FOLDER = "INBOX";

export type MailEvent = {
  account: string;
  folder: string;
  uid: number;
  from: string;
  subject: string;
  date: Date | null;
};

type Envelope = {
  subject?: string | null;
  date?: string | Date | null;
  from?: Array<{ name?: string | null; address?: string | null } | null> | null;
};

export function toMailEvent(
  account: string,
  folder: string,
  msg: { uid: number; envelope?: Envelope | null },
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
    account,
    folder,
    uid: msg.uid,
    from: from || "(unknown sender)",
    subject: envelope?.subject?.trim() || "(no subject)",
    date: date && !Number.isNaN(date.getTime()) ? date : null,
  };
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
  onMail: (mail: MailEvent) => void | Promise<void>,
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
  onMail: (mail: MailEvent) => void | Promise<void>,
  options: WatchOptions,
): Promise<void> {
  const account = await getMailAccount(options.account);
  if (!account) {
    logger.warn("No enabled mail account in the database");
    return;
  }

  const client = await openImap(account);
  client.on("error", (err) =>
    logger.warn(`Mail connection for ${account.name}: ${err.message}`));

  try {
    const lock = await client.getMailboxLock(FOLDER);
    try {
      // Sweeps are queued so two bursts of new mail never fetch twice
      let queue: Promise<void> = Promise.resolve();
      const schedule = () => {
        queue = queue.then(() => sweep(client, account, onMail)).catch((err) =>
          logger.warn(`Mail sweep for ${account.name} failed: ${err}`)
        );
      };

      await sweep(client, account, onMail);
      client.on("exists", schedule);
      logger.info(
        `Watching ${account.address} (${FOLDER}) for new mail`,
      );

      await untilAborted(signal);
      client.off("exists", schedule);
      await queue;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function sweep(
  client: ImapFlow,
  account: MailAccountWithSecret,
  onMail: (mail: MailEvent) => void | Promise<void>,
): Promise<void> {
  const box = client.mailbox;
  if (!box) return;

  const state = await prisma.mailFolder.findUnique({
    where: { accountId_path: { accountId: account.id, path: FOLDER } },
  });
  const { firstUid } = uidWindow(
    { uidValidity: state?.uidValidity ?? null, lastUid: state?.lastUid ?? 0 },
    { uidValidity: box.uidValidity, uidNext: box.uidNext },
  );

  const range = uidRange(firstUid, box.uidNext);
  let highest = Math.max(state?.lastUid ?? 0, box.uidNext - 1);

  if (range) {
    for await (
      const msg of client.fetch(range, { uid: true, envelope: true }, {
        uid: true,
      })
    ) {
      highest = Math.max(highest, msg.uid);
      try {
        await onMail(toMailEvent(account.name, FOLDER, msg));
      } catch (err) {
        // One bad message must not stop the folder
        logger.warn(`Handling mail ${msg.uid} failed: ${err}`);
      }
    }
  }

  await prisma.mailFolder.upsert({
    where: { accountId_path: { accountId: account.id, path: FOLDER } },
    update: { uidValidity: box.uidValidity, lastUid: highest },
    create: {
      accountId: account.id,
      path: FOLDER,
      uidValidity: box.uidValidity,
      lastUid: highest,
    },
  });
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

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
