// Creates or rotates the bearer token the browser extension uses to post jobs:
//
//   deno task jobs:token
//
// The value is printed once and stored encrypted, like every other secret; it is
// never logged again. Rotating invalidates the copy pasted in the extension.
import prisma from "@/db.ts";
import { decrypt, encrypt } from "@/utils/aes.ts";
import { logger } from "@/utils/logger.ts";

export const JOBS_TOKEN_SECRET = "jobs-api-token";

/**
 * The token the local job API accepts, or null before `deno task jobs:token`.
 * The server reads it once at startup, so after rotating it the bot must be
 * restarted.
 */
export async function loadJobsToken(): Promise<string | null> {
  const secret = await prisma.secret.findUnique({
    where: { name: JOBS_TOKEN_SECRET },
  });
  if (!secret) return null;
  return await decrypt(secret.value);
}

if (import.meta.main) {
  const token = crypto.getRandomValues(new Uint8Array(32)).toHex();
  const value = await encrypt(token);

  await prisma.secret.upsert({
    where: { name: JOBS_TOKEN_SECRET },
    update: { value },
    create: { name: JOBS_TOKEN_SECRET, value },
  });

  console.log(token);
  console.log(
    "Paste this token into the extension's job options now; it is not shown again.",
  );
  logger.info(
    `jobs: token stored as secret ${JOBS_TOKEN_SECRET}; restart the bot to use it`,
  );
  await prisma.$disconnect();
}
