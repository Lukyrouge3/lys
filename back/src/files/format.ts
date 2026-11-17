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
  if (entry.type === "directory") {
    return `[dir]  ${entry.basename}`;
  }
  return `[file] ${formatSize(entry.size)}  ${
    formatDate(entry.lastmod)
  }  ${entry.basename}`;
}

/** Full path without the leading slash, for find results. */
export function entryPath(entry: DavEntry): string {
  return entry.filename.replace(/^\/+/, "");
}

/** Like formatEntry, but shows the full path so the model can act on it. */
export function formatPathEntry(entry: DavEntry): string {
  if (entry.type === "directory") {
    return `[dir]  ${entryPath(entry)}`;
  }
  return `[file] ${formatSize(entry.size)}  ${formatDate(entry.lastmod)}  ${
    entryPath(entry)
  }`;
}
