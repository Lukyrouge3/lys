import { cliChat } from "@/chat/cli.ts";
import { logger } from "@/utils/logger.ts";
import prisma from "@/db.ts";

try {
  logger.info("Starting chat session");
  await cliChat("lys");
} finally {
  await prisma.$disconnect();
}
