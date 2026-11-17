import { createClient, type WebDAVClient } from "webdav";

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

export async function putFile(
  path: string,
  content: Uint8Array,
): Promise<void> {
  const dav = nextcloud();
  const folder = path.slice(0, path.lastIndexOf("/"));
  if (folder && !(await dav.exists(folder))) {
    await dav.createDirectory(folder, { recursive: true });
  }
  await dav.putFileContents(path, content.slice().buffer, { overwrite: true });
}
