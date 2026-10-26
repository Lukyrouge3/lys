import OpenAI from "@openai/openai";
import prisma from "../db.ts";
import { Provider, Secret } from "../generated/prisma/client.ts";
import { decrypt } from "../utils/aes.ts";

export type ProviderWithApiKey = Provider & { apiKey: Secret };

export async function getProvider(name: string): Promise<ProviderWithApiKey> {
  const provider = await prisma.provider.findFirst({
    where: { name },
    include: { apiKey: true },
  });
  if (!provider) {
    throw new Error("No provider found");
  }
  return provider;
}

export async function getOpenAIClient(
  provider: ProviderWithApiKey,
): Promise<OpenAI> {
  const decryptedApiKey = await decrypt(provider.apiKey.value);

  const openai = new OpenAI({
    baseURL: provider.host,
    apiKey: decryptedApiKey,
  });

  return openai;
}
