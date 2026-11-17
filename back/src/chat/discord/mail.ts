import type { Client } from "discord.js";
import { classifyMail } from "@/mail/classify.ts";
import { watchMail } from "@/mail/watcher.ts";
import { logger } from "@/utils/logger.ts";
import { dmOwner, formatMailNotice } from "@/chat/discord/notify.ts";

/**
 * New mail is classified locally and only "important" ones become a DM.
 * Classification is serial: the watcher awaits each message before the next.
 */
export function startMailNotifications(client: Client) {
  return watchMail(async (mail) => {
    const importance = await classifyMail(mail);
    logger.debug(
      `Mail ${mail.uid} from ${mail.from} classified as ${importance}`,
    );
    if (importance !== "important") return;
    await dmOwner(client, formatMailNotice(mail));
  });
}
