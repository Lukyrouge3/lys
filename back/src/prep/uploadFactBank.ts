// Uploads the owner's local fact bank to Nextcloud, where the prep workflow
// reads it. Run from a checkout that has ~/job/fact-bank:
//
//   deno task prep:upload-factbank [dir] [--overwrite]
//
// A file already in Nextcloud is skipped unless --overwrite is passed, so an
// edit made in Nextcloud is never clobbered by an older local copy. Missing
// parent folders are created.
import { join } from "node:path";
import { nextcloud, putFile } from "@/files/nextcloud.ts";
import { FACT_BANK_FOLDER } from "@/prep/factbank.ts";

const DEFAULT_DIR = "/home/luky/job/fact-bank";

async function main(): Promise<void> {
  const overwrite = Deno.args.includes("--overwrite");
  const dir = Deno.args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_DIR;

  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(
        `Fact bank folder not found: ${dir}\n` +
          "Pass the folder to upload: deno task prep:upload-factbank <dir> [--overwrite]",
      );
      Deno.exit(1);
    }
    throw error;
  }

  if (names.length === 0) {
    console.error(`No .md files in ${dir}; nothing uploaded.`);
    Deno.exit(1);
  }

  names.sort();
  const dav = nextcloud();
  for (const name of names) {
    const target = `${FACT_BANK_FOLDER}/${name}`;
    if (!overwrite && (await dav.exists(target))) {
      console.log(
        `skipped   ${target} (already there; --overwrite to replace)`,
      );
      continue;
    }
    await putFile(target, await Deno.readFile(join(dir, name)), { overwrite });
    console.log(`uploaded  ${target}`);
  }

  console.log(`${names.length} file(s) checked against ${FACT_BANK_FOLDER}.`);
}

if (import.meta.main) await main();
