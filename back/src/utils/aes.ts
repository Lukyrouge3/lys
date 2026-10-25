const encoder = new TextEncoder();
const decoder = new TextDecoder();
const masterKey = Deno.env.get("AES_KEY");
if (!masterKey) {
  throw new Error("AES_KEY environment variable is not set");
}
const masterKeyBytes = Uint8Array.fromBase64(masterKey);
if (masterKeyBytes.length !== 32) {
  throw new Error("AES_KEY must be a base64-encoded 32-byte key");
}

const key = await crypto.subtle.importKey(
  "raw",
  masterKeyBytes,
  "AES-GCM",
  false,
  ["encrypt", "decrypt"],
);

export async function encrypt(plainText: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plainText),
  );
  return new Uint8Array([...iv, ...new Uint8Array(encrypted)]).toBase64();
}

export async function decrypt(cipherText: string): Promise<string> {
  const data = Uint8Array.fromBase64(cipherText);
  const iv = data.slice(0, 12);
  const encryptedData = data.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encryptedData,
  );
  return decoder.decode(decrypted);
}
