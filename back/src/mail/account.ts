import { ImapFlow } from "imapflow";
import prisma from "@/db.ts";
import { decrypt } from "@/utils/aes.ts";

export async function getMailAccount(name?: string) {
  return await prisma.mailAccount.findFirst({
    where: { enabled: true, ...(name ? { name } : {}) },
    include: { password: true },
    orderBy: { name: "asc" },
  });
}

export type MailAccountWithSecret = NonNullable<
  Awaited<ReturnType<typeof getMailAccount>>
>;

/**
 * How long the client stays out of IDLE after a command. imapflow defaults to
 * 15s, which is a long blind spot for a connection that only exists to watch
 * mail: anything arriving in that window has no IDLE session to be pushed to.
 */
export const WATCH_IDLE_DELAY_MS = 1_000;

export async function openImap(
  account: MailAccountWithSecret,
  options: { autoIdleDelay?: number } = {},
): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapPort === 993,
    auth: {
      user: account.username,
      pass: await decrypt(account.password.value),
    },
    autoIdleDelay: options.autoIdleDelay,
    logger: false,
  });
  await client.connect();
  return client;
}
