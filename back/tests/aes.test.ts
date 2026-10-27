import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { decrypt, encrypt } from "@/utils/aes.ts";

Deno.test("encrypt then decrypt returns the original text", async () => {
  const cipherText = await encrypt("sk-secret-key");
  assertEquals(await decrypt(cipherText), "sk-secret-key");
});

Deno.test("encrypting the same text twice gives different results", async () => {
  assertNotEquals(await encrypt("same"), await encrypt("same"));
});

Deno.test("decrypting tampered data throws", async () => {
  const bytes = Uint8Array.fromBase64(await encrypt("sk-secret-key"));
  bytes[bytes.length - 1] ^= 1;
  await assertRejects(() => decrypt(bytes.toBase64()));
});
