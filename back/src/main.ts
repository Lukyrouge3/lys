import { PrismaClient } from "./generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { decrypt, encrypt } from "./utils/aes.ts";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Deno.env.get("DATABASE_URL") }),
});

const secret = await prisma.secret.findFirst({ where: { name: "My Secret" } });
const decryptedSecret = secret ? await decrypt(secret.value) : null;

console.log("Decrypted secret:", decryptedSecret);
