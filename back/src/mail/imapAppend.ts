import MailComposer from "nodemailer/lib/mail-composer";
import { type MailAccountWithSecret, openImap } from "@/mail/account.ts";
import type { MailEvent } from "@/mail/watcher.ts";
import { logger } from "@/utils/logger.ts";

export type MailboxLike = {
  path: string;
  specialUse?: string;
  flags?: Iterable<string>;
};

export type ReplyDraft = {
  subject: string;
  body: string;
};

const DRAFTS_NAMES = /^(drafts?|brouillons?|entwürfe|entwuerfe)$/i;

function lastSegment(path: string): string {
  return path.split(/[./]/).pop() ?? path;
}

function hasDraftsFlag(box: MailboxLike): boolean {
  if (box.specialUse?.toLowerCase() === "\\drafts") return true;
  for (const flag of box.flags ?? []) {
    if (flag.toLowerCase() === "\\drafts") return true;
  }
  return false;
}

/**
 * The Drafts folder from LIST, through the special-use flag when the server
 * advertises it and by name otherwise. Returns null when the account has no
 * usable Drafts folder, so the caller can log it and try again later.
 */
export function draftsFolderPath(
  boxes: Iterable<MailboxLike>,
): string | null {
  const all = [...boxes];
  const special = all.find(hasDraftsFlag);
  if (special) return special.path;

  const named = all.find((box) => DRAFTS_NAMES.test(lastSegment(box.path)));
  return named?.path ?? null;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** "Re: " once, however the original subject is cased or spaced. */
export function replySubject(subject: string): string {
  const clean = oneLine(subject);
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean || "(no subject)"}`;
}

/** The first address in a formatted "Name <address>" or bare value. */
export function addressOf(value: string): string {
  const source = oneLine(value);
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(source);
  if (angle) return angle[1];
  return /[^\s<>,;:"]+@[^\s<>,;:"]+/.exec(source)?.[0] ?? "";
}

function messageIdFor(from: string): string {
  const domain = from.split("@")[1] || "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * Builds the RFC 822 message for a draft. No send path exists: this returns
 * bytes for IMAP APPEND only. Nodemailer's composer is used for the encoding
 * (UTF-8 headers, quoted-printable body) and for picking the headers apart;
 * it never talks to a server by itself.
 */
export async function buildReplyMessage(
  mail: MailEvent,
  account: { address: string },
  reply: ReplyDraft,
  options: { now?: Date; messageId?: string } = {},
): Promise<Uint8Array> {
  const to = addressOf(mail.replyTo ?? mail.from);
  if (!to) {
    throw new Error(
      `Cannot draft a reply to "${mail.from}": no reply address`,
    );
  }

  const from = oneLine(account.address);
  const body = reply.body.replace(/\r\n?/g, "\n").split("\n").join("\r\n");
  const originalId = mail.messageId ? oneLine(mail.messageId) : "";
  const threading = originalId
    ? { inReplyTo: originalId, references: [originalId] }
    : {};

  const composer = new MailComposer({
    from,
    to,
    subject: replySubject(reply.subject || mail.subject),
    text: body,
    encoding: "quoted-printable",
    messageId: options.messageId ?? messageIdFor(from),
    date: options.now ?? new Date(),
    ...threading,
  });

  const message = composer.compile();
  return await new Promise<Uint8Array>((resolve, reject) => {
    message.build((error: Error | null, built: Uint8Array) => {
      if (error) reject(error);
      else resolve(new Uint8Array(built));
    });
  });
}

/** The parts of the imapflow client APPEND needs; injectable for tests. */
export type ImapAppendClient = {
  list(): Promise<MailboxLike[]>;
  append(
    path: string,
    content: Uint8Array,
    flags?: string[],
  ): Promise<unknown>;
  logout(): Promise<void>;
};

export type AppendDependencies = {
  open?: (account: MailAccountWithSecret) => Promise<ImapAppendClient>;
};

/**
 * Appends a draft to the account's Drafts folder. The IMAP client is built by
 * openImap, which is the only place that decrypts the password, and it is
 * always logged out, whether the append worked or not.
 */
export async function appendDraft(
  account: MailAccountWithSecret,
  rfc822: Uint8Array,
  deps: AppendDependencies = {},
): Promise<string> {
  const client = await (deps.open ?? openImap)(account);
  try {
    const path = draftsFolderPath(await client.list());
    if (!path) {
      throw new Error(
        `No Drafts folder found for ${account.name} <${account.address}>`,
      );
    }
    await client.append(path, rfc822, ["\\Draft"]);
    return path;
  } finally {
    await client.logout().catch((err) =>
      logger.warn(`Closing the IMAP connection after APPEND failed: ${err}`)
    );
  }
}
