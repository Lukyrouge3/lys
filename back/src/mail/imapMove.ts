// Runs the moves of an approved proposal. One connection per account, INBOX
// opened once, and every move is checked before it is made: the mailbox must
// still be the same UID space, and the UID must still be there. A move that
// cannot be verified is skipped, never guessed.
import prisma from "@/db.ts";
import { type MailAccountWithSecret, openImap } from "@/mail/account.ts";
import {
  INBOX,
  type MailMove,
  SORT_TARGETS,
  type SortFolder,
} from "@/mail/sort.ts";
import { logger } from "@/utils/logger.ts";

/** The parts of the imapflow client a move needs; injectable for tests. */
export type MailboxLike = {
  path: string;
  specialUse?: string;
};

export type ImapMoveClient = {
  mailboxOpen(
    path: string,
  ): Promise<{ path: string; uidValidity: bigint | number }>;
  status(
    path: string,
    query: { uidValidity?: boolean },
  ): Promise<{ uidValidity?: bigint | number } | false>;
  fetchOne(
    seq: number | string,
    query: { uid: true },
    options: { uid: true },
  ): Promise<{ uid: number } | false>;
  list(): Promise<MailboxLike[]>;
  mailboxCreate(path: string): Promise<{ path: string; created: boolean }>;
  messageMove(
    range: number | string,
    destination: string,
    options: { uid: true },
  ): Promise<unknown>;
  logout(): Promise<void>;
};

export type MoveOutcome = "moved" | "skipped" | "failed";

export type MoveResult = {
  move: MailMove;
  outcome: MoveOutcome;
  reason?: string;
};

export type MoveDependencies = {
  open?: (account: MailAccountWithSecret) => Promise<ImapMoveClient>;
  account?: (accountId: string) => Promise<MailAccountWithSecret | null>;
};

async function loadAccount(
  accountId: string,
): Promise<MailAccountWithSecret | null> {
  return await prisma.mailAccount.findFirst({
    where: { id: accountId, enabled: true },
    include: { password: true },
  });
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mailboxes are compared case-insensitively so one is never created twice. */
function nameOf(path: string): string {
  return path.toLowerCase();
}

/**
 * Creates the target mailbox when it is not in the LIST output. A create that
 * fails because another run made it in the meantime is not an error.
 */
async function ensureMailbox(
  client: ImapMoveClient,
  known: Set<string>,
  target: string,
): Promise<void> {
  if (known.has(nameOf(target))) return;

  try {
    await client.mailboxCreate(target);
  } catch (err) {
    const listed = await client.list();
    for (const box of listed) known.add(nameOf(box.path));
    if (!known.has(nameOf(target))) throw err;
  }
  known.add(nameOf(target));
}

/** Moves the group's mail on one open connection; one failure never stops the rest. */
async function moveOnAccount(
  client: ImapMoveClient,
  moves: MailMove[],
): Promise<MoveResult[]> {
  const results: MoveResult[] = [];

  let inbox: { uidValidity: bigint | number };
  try {
    inbox = await client.mailboxOpen(INBOX);
  } catch (err) {
    const reason = `could not open ${INBOX}: ${text(err)}`;
    return moves.map((move) => ({ move, outcome: "skipped", reason }));
  }

  const opened = inbox.uidValidity;
  if (opened === undefined || opened === null) {
    const reason = `${INBOX} has no UIDVALIDITY, the mail cannot be verified`;
    return moves.map((move) => ({ move, outcome: "skipped", reason }));
  }

  let known: Set<string>;
  try {
    known = new Set((await client.list()).map((box) => nameOf(box.path)));
  } catch (err) {
    const reason = `could not list the mailboxes: ${text(err)}`;
    return moves.map((move) => ({ move, outcome: "skipped", reason }));
  }

  for (const move of moves) {
    try {
      if (move.folder !== INBOX) {
        results.push({
          move,
          outcome: "skipped",
          reason: `the mail is in ${move.folder}, not ${INBOX}`,
        });
        continue;
      }
      if (!SORT_TARGETS.includes(move.target as SortFolder)) {
        results.push({
          move,
          outcome: "skipped",
          reason: `"${move.target}" is not a sorting folder`,
        });
        continue;
      }

      // The UID space must still be the one this connection selected: a
      // mailbox rewritten in between has different mail under the same UIDs.
      const status = await client.status(INBOX, { uidValidity: true });
      if (!status || status.uidValidity === undefined) {
        results.push({
          move,
          outcome: "skipped",
          reason: `could not read ${INBOX} UIDVALIDITY`,
        });
        continue;
      }
      if (String(status.uidValidity) !== String(opened)) {
        results.push({
          move,
          outcome: "skipped",
          reason: `${INBOX} was rewritten (UIDVALIDITY changed)`,
        });
        continue;
      }

      const found = await client.fetchOne(move.uid, { uid: true }, {
        uid: true,
      });
      if (!found || found.uid !== move.uid) {
        results.push({
          move,
          outcome: "skipped",
          reason: `mail #${move.uid} is no longer in ${INBOX}`,
        });
        continue;
      }

      await ensureMailbox(client, known, move.target);
      const copied = await client.messageMove(move.uid, move.target, {
        uid: true,
      });
      if (copied === false) {
        results.push({
          move,
          outcome: "skipped",
          reason: `the server did not report moving mail #${move.uid}`,
        });
        continue;
      }
      results.push({ move, outcome: "moved" });
    } catch (err) {
      results.push({ move, outcome: "failed", reason: text(err) });
    }
  }

  return results;
}

/**
 * Applies the moves of an approved proposal, grouped by account. Mail outside
 * INBOX is skipped, nothing is ever deleted or expunged, and every connection
 * is logged out whether the moves worked or not.
 */
export async function applyMoves(
  moves: MailMove[],
  deps: MoveDependencies = {},
): Promise<MoveResult[]> {
  const open = deps.open ?? openImap;
  const load = deps.account ?? loadAccount;

  const byAccount = new Map<string, MailMove[]>();
  for (const move of moves) {
    const group = byAccount.get(move.accountId);
    if (group) group.push(move);
    else byAccount.set(move.accountId, [move]);
  }

  const results: MoveResult[] = [];
  for (const [accountId, group] of byAccount) {
    let account: MailAccountWithSecret | null = null;
    try {
      account = await load(accountId);
    } catch (err) {
      logger.warn(`Could not load mail account ${accountId}: ${err}`);
    }
    if (!account) {
      const reason = "the mail account is gone or disabled";
      for (const move of group) {
        results.push({ move, outcome: "skipped", reason });
      }
      continue;
    }

    let client: ImapMoveClient;
    try {
      client = await open(account);
    } catch (err) {
      const reason = `could not connect: ${text(err)}`;
      logger.warn(`Moving mail on ${account.name} failed: ${reason}`);
      for (const move of group) {
        results.push({ move, outcome: "skipped", reason });
      }
      continue;
    }

    try {
      results.push(...await moveOnAccount(client, group));
    } catch (err) {
      // Should be unreachable; never let one account hide the other's outcome.
      logger.warn(`Moving mail on ${account.name} stopped: ${err}`);
      for (const move of group) {
        results.push({ move, outcome: "failed", reason: text(err) });
      }
    } finally {
      await client.logout().catch((err) =>
        logger.warn(
          `Closing the IMAP connection after moving failed: ${text(err)}`,
        )
      );
    }
  }

  return results;
}
