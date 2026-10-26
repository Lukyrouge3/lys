import { PrismaClient } from "../src/generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { encrypt } from "../src/utils/aes.ts";

const [name, host, apiKey] = Deno.args;
if (!name || !host || !apiKey) {
  console.error("Usage: deno task db:seed <name> <host> <apiKey>");
  Deno.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Deno.env.get("DATABASE_URL") }),
});

const value = await encrypt(apiKey);

const secret = await prisma.secret.upsert({
  where: { name: `${name}-api-key` },
  update: { value },
  create: { name: `${name}-api-key`, value },
});

const provider = await prisma.provider.upsert({
  where: { name },
  update: { host, apiKeyId: secret.id },
  create: { name, host, apiKeyId: secret.id },
});

console.log(`Provider "${provider.name}" -> ${provider.host}`);

await prisma.$disconnect();
