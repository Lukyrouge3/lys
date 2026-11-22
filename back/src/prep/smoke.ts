// Verifies the image can produce an application PDF: it compiles the copy of
// the base CV that ships with the bot, then checks it is one page, warning-free
// and carries text. This is the check to run after rebuilding the image:
//
//   docker compose run --rm --no-deps bot deno run -A src/prep/smoke.ts
import {
  compileTypst,
  pdfPageCount,
  pdfText,
  typstAssetsDir,
} from "@/prep/typst.ts";
import { loadBaseTemplates } from "@/prep/factbank.ts";

async function main(): Promise<void> {
  const assets = typstAssetsDir();
  console.log(`assets: ${assets}`);
  const { cv } = await loadBaseTemplates(assets);

  const started = performance.now();
  const { pdf, warnings } = await compileTypst({ source: cv });
  const elapsed = Math.round(performance.now() - started);

  const pages = await pdfPageCount(pdf);
  const text = await pdfText(pdf);

  console.log(`compile: ${elapsed} ms, ${warnings.length} warning(s)`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);
  console.log(`pages: ${pages}`);
  console.log(`text: ${text.trim().length} characters`);
  console.log(`pdf: ${pdf.length} bytes`);

  const problems: string[] = [];
  if (warnings.length > 0) problems.push(`${warnings.length} warning(s)`);
  if (pages !== 1) problems.push(`${pages} pages, expected 1`);
  if (!text.includes("Torrenté Florian")) {
    problems.push("the name is missing from the extracted text");
  }
  if (problems.length > 0) {
    console.error(`smoke failed: ${problems.join("; ")}`);
    Deno.exit(1);
  }

  console.log("smoke ok");
}

if (import.meta.main) await main();
