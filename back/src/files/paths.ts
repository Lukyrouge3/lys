// Tool paths are relative to the user's Nextcloud root: no leading slash,
// no trailing slash, no "..".
export function normalizePath(value: unknown): string {
  const path = clean(value);
  if (!path) throw new Error("Invalid path: it is empty.");
  return path;
}

/** Same, but "" (or "/") means the root folder. */
export function normalizeFolder(value: unknown): string {
  return clean(value);
}

/** The folder that contains this path; "" when the path is at the root. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function clean(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error("Invalid path: it must be text.");
  }
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (path.split("/").includes("..")) {
    throw new Error("Invalid path: it cannot contain '..'.");
  }
  return path;
}
