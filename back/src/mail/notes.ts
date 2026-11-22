import prisma from "@/db.ts";
import type { MailVerdict } from "@/mail/classify.ts";
import type { MailEvent } from "@/mail/watcher.ts";

/**
 * Records the classifier's verdict for every mail it sees. The morning summary
 * reads these rows, so the note is written even for mail that gets no notice.
 * The unique key makes seeing the same mail twice (a watcher restart, a reset
 * UID space) harmless: the newer verdict wins.
 */
export async function recordMailNote(
  accountId: string,
  mail: MailEvent,
  verdict: MailVerdict,
): Promise<void> {
  const fields = {
    from: mail.from,
    subject: mail.subject,
    topic: verdict.topic,
    importance: verdict.importance,
    receivedAt: mail.date ?? new Date(),
  };

  await prisma.mailNote.upsert({
    where: {
      accountId_folder_uid: {
        accountId,
        folder: mail.folder,
        uid: mail.uid,
      },
    },
    update: fields,
    create: { accountId, folder: mail.folder, uid: mail.uid, ...fields },
  });
}
