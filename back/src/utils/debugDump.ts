// Dev only: with DEBUG_DUMP=1, every LLM call writes its raw request and
// response chunks to debug/, including fields the SDK doesn't type
// (reasoning_content, timings, ...)
const enabled = Deno.env.get("DEBUG_DUMP") === "1";
const DEBUG_DIR = new URL("../../debug/", import.meta.url);

export function startDump(request: unknown): (data: unknown) => void {
  if (!enabled) return () => {};

  Deno.mkdirSync(DEBUG_DIR, { recursive: true });
  const name = new Date().toISOString().replaceAll(":", "-");
  Deno.writeTextFileSync(
    new URL(`${name}-request.json`, DEBUG_DIR),
    JSON.stringify(request, null, 2),
  );

  const responseFile = new URL(`${name}-response.jsonl`, DEBUG_DIR);
  return (data) =>
    Deno.writeTextFileSync(responseFile, JSON.stringify(data) + "\n", {
      append: true,
    });
}
