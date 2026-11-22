import type { Client } from "discord.js";
import prisma from "@/db.ts";
import { getMailAccount } from "@/mail/account.ts";
import { classifyMail } from "@/mail/classify.ts";
import { draftReply } from "@/mail/draft.ts";
import { appendDraft, buildReplyMessage } from "@/mail/imapAppend.ts";
import { recordMailNote } from "@/mail/notes.ts";
import { type MailEvent, watchMail } from "@/mail/watcher.ts";
import { logger } from "@/utils/logger.ts";
import { inQuietHours } from "@/utils/quietHours.ts";
import { dmOwner, formatMailNotice } from "@/chat/discord/notify.ts";
import { formatDraftNotice } from "@/chat/discord/draftNotice.ts";
import { storeAttachments } from "@/mail/documents.ts";

const DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DRAFTS_PER_DAY = 10;

/** MAIL_DRAFTS_PER_DAY, falling back to ten on a missing or unusable value. */
export function draftsPerDay(): number {
  const raw = Deno.env.get("MAIL_DRAFTS_PER_DAY");
  if (!raw?.trim()) return DEFAULT_DRAFTS_PER_DAY;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DRAFTS_PER_DAY;
}

/**
 * Notes and drafts are useful extras: a failure there must never cost the
 * important-mail notice, and must never throw into the watcher.
 */
async function safely(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logger.warn(`${label} failed: ${err}`);
  }
}

async function maybeDraft(client: Client, mail: MailEvent): Promise<void> {
  if (Deno.env.get("MAIL_DRAFTS") === "0") return;

  const already = await prisma.mailDraft.findUnique({
    where: {
      accountId_folder_uid: {
        accountId: mail.accountId,
        folder: mail.folder,
        uid: mail.uid,
      },
    },
  });
  if (already) return;

  const limit = draftsPerDay();
  const since = new Date(Date.now() - DRAFT_WINDOW_MS);
  const made = await prisma.mailDraft.count({
    where: { draftedAt: { gte: since } },
  });
  if (made >= limit) {
    logger.debug(
      `Mail draft budget spent (${made}/${limit} in 24h); skipping #${mail.uid}`,
    );
    return;
  }

  const reply = await draftReply(mail);
  if (!reply.needsReply) {
    logger.debug(`No reply needed for mail #${mail.uid}`);
    return;
  }

  const account = await getMailAccount(mail.account);
  if (!account) {
    logger.warn(
      `Cannot draft a reply for ${mail.account}: the account is gone or disabled`,
    );
    return;
  }

  const rfc822 = await buildReplyMessage(mail, account, reply);
  const folder = await appendDraft(account, rfc822);

  // Recorded only after the append: a failed append is retried next time the
  // mail is seen instead of being remembered as done.
  await prisma.mailDraft.create({
    data: {
      accountId: mail.accountId,
      folder: mail.folder,
      uid: mail.uid,
      subject: reply.subject || mail.subject,
    },
  });
  logger.info(`Draft reply for #${mail.uid} appended to ${folder}`);

  if (!inQuietHours()) {
    await dmOwner(client, formatDraftNotice(mail, reply.body));
  }
}

/**
 * New mail is classified locally and only "important" ones become a DM. Every
 * mail gets a MailNote for the morning summary; important ones may also get a
 * reply draft appended to the Drafts folder. Classification stays serial: the
 * watcher awaits each message before the next.
 */
export function startMailNotifications(client: Client) {
  return watchMail(async (mail, attachments) => {
    if (attachments.length > 0) {
      await storeAttachments(mail, attachments);
    }

    const verdict = await classifyMail(mail);
    logger.debug(
      `Mail ${mail.uid} from ${mail.from} classified as ${verdict.importance}: ${verdict.topic}`,
    );

    await safely(
      "Recording the mail note",
      () => recordMailNote(mail.accountId, mail, verdict),
    );

    if (verdict.importance !== "important") return;

    if (inQuietHours()) {
      logger.debug(
        `Quiet hours: holding the notice for mail #${mail.uid} until morning`,
      );
    } else {
      await dmOwner(client, formatMailNotice(mail, verdict.topic));
    }

    await safely("Drafting a reply", () => maybeDraft(client, mail));
  });
}
