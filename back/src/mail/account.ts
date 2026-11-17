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

export async function openImap(
  account: MailAccountWithSecret,
): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapPort === 993,
    auth: {
      user: account.username,
      pass: await decrypt(account.password.value),
    },
    logger: false,
  });
  await client.connect();
  return client;
}
