// The shape WebDAV returns for a file or folder, kept structural so the tools
// don't depend on the client's type package.
export type DavEntry = {
  filename: string;
  basename: string;
  lastmod?: string;
  size: number;
  type: "file" | "directory";
  mime?: string;
};

// deno-lint-ignore no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * File names and remote messages can carry newlines and other control
 * characters; left raw they would forge extra lines in the model's context.
 */
export function cleanForContext(value: string): string {
  return value.replace(CONTROL_CHARS, " ");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDate(value?: string): string {
  if (!value) return "unknown date";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown date"
    : date.toISOString().slice(0, 10);
}

/** One compact line per entry, cheap enough for a small model to read. */
export function formatEntry(entry: DavEntry): string {
  const name = cleanForContext(entry.basename);
  if (entry.type === "directory") {
    return `[dir]  ${name}`;
  }
  return `[file] ${formatSize(entry.size)}  ${
    formatDate(entry.lastmod)
  }  ${name}`;
}

/** Full path without the leading slash, for find results. */
export function entryPath(entry: DavEntry): string {
  return entry.filename.replace(/^\/+/, "");
}

/** Like formatEntry, but shows the full path so the model can act on it. */
export function formatPathEntry(entry: DavEntry): string {
  const path = cleanForContext(entryPath(entry));
  if (entry.type === "directory") {
    return `[dir]  ${path}`;
  }
  return `[file] ${formatSize(entry.size)}  ${
    formatDate(entry.lastmod)
  }  ${path}`;
}
