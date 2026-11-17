import * as z from "zod";
import prisma from "../src/db.ts";
import { encrypt } from "../src/utils/aes.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../src/config/agentConfig.ts";

const schema = z.object({
  providers: z.array(z.object({
    name: z.string(),
    host: z.string(),
    apiKey: z.string(),
  })),
  agents: z.array(z.object({
    name: z.string(),
    model: z.string(),
    provider: z.string(),
  })),
  mailAccounts: z.array(z.object({
    name: z.string(),
    address: z.string(),
    imapHost: z.string(),
    imapPort: z.number().default(993),
    smtpHost: z.string(),
    smtpPort: z.number().default(587),
    username: z.string().optional(),
    password: z.string(),
  })).default([]),
});

const path = Deno.args[0] ?? "prisma/seed.json";
const seed = schema.parse(JSON.parse(Deno.readTextFileSync(path)));

for (const { name, host, apiKey } of seed.providers) {
  const value = await encrypt(apiKey);
  const secret = await prisma.secret.upsert({
    where: { name: `${name}-api-key` },
    update: { value },
    create: { name: `${name}-api-key`, value },
  });
  await prisma.provider.upsert({
    where: { name },
    update: { host, apiKeyId: secret.id },
    create: { name, host, apiKeyId: secret.id },
  });
  console.log(`Provider "${name}" -> ${host}`);
}

for (const { name, model, provider } of seed.agents) {
  await prisma.agent.upsert({
    where: { name },
    update: { model, provider: { connect: { name: provider } } },
    create: {
      name,
      model,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      provider: { connect: { name: provider } },
    },
  });
  console.log(`Agent "${name}" -> ${model} on ${provider}`);
}

for (const account of seed.mailAccounts) {
  const secret = await prisma.secret.upsert({
    where: { name: `${account.name}-mail-password` },
    update: { value: await encrypt(account.password) },
    create: {
      name: `${account.name}-mail-password`,
      value: await encrypt(account.password),
    },
  });
  const data = {
    address: account.address,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    username: account.username ?? account.address,
    passwordId: secret.id,
  };
  await prisma.mailAccount.upsert({
    where: { name: account.name },
    update: data,
    create: { name: account.name, ...data },
  });
  console.log(`Mail account "${account.name}" -> ${account.address}`);
}

await prisma.$disconnect();
