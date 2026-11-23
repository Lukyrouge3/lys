// Bundles one prepared application into the single file the owner uploads to a
// job site: the CV first, then the cover letter, then the owner's own PDFs
// (diplomas, references, certificates) from a shared attachments folder. The
// attachments are uploaded by hand in Nextcloud, so this runs again whenever
// the owner asks; application.pdf is generated and may be overwritten, while
// every other file in the folder still goes through the no-overwrite putFile.
import { type DavWriter, nextcloud } from "@/files/nextcloud.ts";
import { pdfPageCount } from "@/prep/typst.ts";
import { type MergePart, mergePdfs, type MergeSkipped } from "@/prep/merge.ts";
import { logger } from "@/utils/logger.ts";

export const DEFAULT_ATTACHMENTS_FOLDER = "Postulations/attachments";
export const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
export const APPLICATION_PDF = "application.pdf";

export type BundleSkipped = MergeSkipped;

export type BundleResult = {
  /** `<folder>/application.pdf`. */
  path: string;
  /** Every part in merge order (CV, cover letter, attachments), including skips. */
  parts: string[];
  skipped: BundleSkipped[];
  pages: number;
};

/** The slice of the DAV client bundling needs. */
export type BundleDav = DavWriter & {
  getDirectoryContents(path: string): Promise<unknown>;
  getFileContents(
    path: string,
    options?: { format?: "binary" | "text" },
  ): Promise<unknown>;
};

export type BundleDeps = {
  /** Injected in tests; the real client otherwise. */
  dav?: BundleDav;
  /** Unused by the current bundle, kept so callers share the delivery clock. */
  now?: Date;
  /** Injected in tests so no pdfunite is needed. */
  merge?: typeof mergePdfs;
  /** Injected in tests so no pdfinfo is needed. */
  pageCount?: (pdf: Uint8Array) => Promise<number>;
};

type DavEntry = {
  basename?: string;
  type?: string;
};

/** The attachments folder (env PREP_ATTACHMENTS_FOLDER). */
export function attachmentsFolder(): string {
  const configured = Deno.env.get("PREP_ATTACHMENTS_FOLDER")?.trim();
  return stripSlashes(configured || DEFAULT_ATTACHMENTS_FOLDER);
}

/**
 * Builds `<folder>/application.pdf`: the CV, then the cover letter, then every
 * PDF in the attachments folder sorted by name (01-x.pdf, 2-y.pdf, 10-z.pdf).
 * Missing or empty CV/cover files are errors; a broken attachment is skipped.
 */
export async function bundleApplication(
  folder: string,
  {
    dav = nextcloud(),
    merge = mergePdfs,
    pageCount = pdfPageCount,
  }: BundleDeps = {},
): Promise<BundleResult> {
  const base = stripSlashes(folder);
  if (!base) {
    throw new Error("Cannot bundle an application: the folder is empty.");
  }

  const documents = entriesOf(await dav.getDirectoryContents(base));
  const cvName = findDocument(documents, "cv", "CV", base);
  const coverName = findDocument(documents, "cover", "cover letter", base);

  const cv = await readPdf(dav, `${base}/${cvName}`, "CV");
  const cover = await readPdf(dav, `${base}/${coverName}`, "cover letter");

  const attachments = await readAttachments(dav, attachmentsFolder());
  const parts = [cvName, coverName, ...attachments.names];
  const mergeParts: MergePart[] = [
    { name: cvName, bytes: cv },
    { name: coverName, bytes: cover },
    ...attachments.parts,
  ];

  const merged = await merge(mergeParts);
  const skipped = [...attachments.skipped, ...merged.skipped];
  const pages = await pageCount(merged.pdf);
  const path = `${base}/${APPLICATION_PDF}`;

  // Generated file: re-bundling is expected to replace it.
  await dav.putFileContents(path, merged.pdf.slice().buffer, {
    overwrite: true,
  });

  logger.info(
    `jobs: bundle ${base}: ${parts.length} parts, ${skipped.length} skipped, ${pages} pages, ${merged.pdf.length} bytes${
      skipped.length > 0 ? ` (${describeSkipped(skipped)})` : ""
    }`,
  );
  if (merged.pdf.length > MAX_BUNDLE_BYTES) {
    logger.warn(
      `jobs: bundle ${base}: application.pdf is ${merged.pdf.length} bytes, over the 40 MB warning line; still written`,
    );
  }

  return { path, parts, skipped, pages };
}

/** Lists the attachment PDFs, creating the folder so the owner can find it. */
async function readAttachments(
  dav: BundleDav,
  folder: string,
): Promise<{
  names: string[];
  parts: MergePart[];
  skipped: BundleSkipped[];
}> {
  if (!(await dav.exists(folder))) {
    await dav.createDirectory(folder, { recursive: true });
    logger.info(
      `jobs: bundle ${folder}: created the attachments folder for the owner's extra PDFs`,
    );
    return { names: [], parts: [], skipped: [] };
  }

  const entries = entriesOf(await dav.getDirectoryContents(folder));
  const files = entries.filter((entry) =>
    entry.type !== "directory" && typeof entry.basename === "string"
  );
  const nonPdf = files
    .map((entry) => entry.basename as string)
    .filter((name) => !isPdf(name));
  if (nonPdf.length > 0) {
    logger.info(
      `jobs: bundle ${folder}: ignored non-PDF file(s): ${nonPdf.join(", ")}`,
    );
  }

  const names = files
    .map((entry) => entry.basename as string)
    .filter(isPdf)
    .sort(naturalCompare);

  if (names.length === 0) {
    logger.info(
      `jobs: bundle ${folder}: no attachments found in ${folder}; the bundle is CV + cover letter only`,
    );
    return { names: [], parts: [], skipped: [] };
  }

  const parts: MergePart[] = [];
  const skipped: BundleSkipped[] = [];
  for (const name of names) {
    try {
      parts.push({
        name,
        bytes: await readPdf(dav, `${folder}/${name}`, "attachment"),
      });
    } catch (error) {
      skipped.push({ name, reason: errorText(error) });
    }
  }
  return { names, parts, skipped };
}

/** Returns the first `cv-*.pdf` or `cover-*.pdf` in the application folder. */
function findDocument(
  entries: DavEntry[],
  prefix: string,
  label: string,
  folder: string,
): string {
  const pattern = new RegExp(`^${prefix}-.*\\.pdf$`, "i");
  const matches = entries
    .filter((entry) =>
      entry.type !== "directory" && typeof entry.basename === "string" &&
      pattern.test(entry.basename)
    )
    .map((entry) => entry.basename as string)
    .sort(naturalCompare);

  if (matches.length === 0) {
    throw new Error(
      `No ${label} PDF found in ${folder}: expected ${prefix}-<lang>.pdf. Re-prepare the job.`,
    );
  }
  return matches[0];
}

async function readPdf(
  dav: BundleDav,
  path: string,
  label: string,
): Promise<Uint8Array> {
  let value: unknown;
  try {
    value = await dav.getFileContents(path, { format: "binary" });
  } catch (error) {
    throw new Error(
      `Could not read the ${label} PDF ${path}: ${errorText(error)}`,
    );
  }

  const bytes = toBytes(value);
  if (bytes.length === 0) {
    throw new Error(`The ${label} PDF is empty: ${path}. Re-prepare the job.`);
  }
  return bytes;
}

/**
 * Sorts file names the way a person reads them: runs of digits compare as
 * numbers, so 01-x.pdf < 2-y.pdf < 10-z.pdf.
 */
export function naturalCompare(a: string, b: string): number {
  const chunks = /(\d+)|(\D+)/g;
  const left = a.match(chunks) ?? [];
  const right = b.match(chunks) ?? [];

  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const one = left[index];
    const other = right[index];
    const oneNumber = /^\d+$/.test(one);
    const otherNumber = /^\d+$/.test(other);

    if (oneNumber && otherNumber) {
      const difference = Number(one) - Number(other);
      if (difference !== 0) return difference;
    } else {
      const difference = one.toLowerCase().localeCompare(other.toLowerCase());
      if (difference !== 0) return difference;
    }
  }

  if (left.length !== right.length) return left.length - right.length;
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("Nextcloud returned no file data.");
}

function entriesOf(value: unknown): DavEntry[] {
  const list = Array.isArray(value)
    ? value
    : (value as { data?: unknown })?.data;
  return Array.isArray(list) ? list as DavEntry[] : [];
}

function stripSlashes(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function describeSkipped(skipped: BundleSkipped[]): string {
  return skipped.map((entry) => `${entry.name} (${entry.reason})`).join(", ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
