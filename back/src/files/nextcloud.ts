import { createClient, type WebDAVClient } from "webdav";
import { parentOf } from "@/files/paths.ts";

let client: WebDAVClient | null = null;

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export function nextcloud(): WebDAVClient {
  if (!client) {
    const url = required("NEXTCLOUD_URL");
    const username = required("NEXTCLOUD_USERNAME");
    client = createClient(
      `${url}/remote.php/dav/files/${encodeURIComponent(username)}/`,
      { username, password: required("NEXTCLOUD_PASSWORD") },
    );
  }
  return client;
}

/** The part of the DAV client putFile needs, so it can be tested without one. */
export type DavWriter = Pick<
  WebDAVClient,
  "exists" | "createDirectory" | "putFileContents"
>;

export async function putFile(
  path: string,
  content: Uint8Array,
  dav: DavWriter = nextcloud(),
): Promise<void> {
  const folder = parentOf(path);
  if (folder && !(await dav.exists(folder))) {
    await dav.createDirectory(folder, { recursive: true });
  }
  await dav.putFileContents(path, content.slice().buffer, { overwrite: true });
}
