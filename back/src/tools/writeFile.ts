import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud, putFile } from "@/files/nextcloud.ts";
import { normalizePath } from "@/files/paths.ts";
import type { DavEntry } from "@/files/format.ts";

const MAX_CHARS = 50_000;

export class WriteFileTool implements Tool {
  name = "write_file";
  description =
    "Create a text file in your Nextcloud, or replace one when overwrite is true. Missing parent folders are created. Use it for notes, lists, and small documents; send an existing file with send_file instead.";
  arguments = { path: "string", content: "string", overwrite: "boolean" };
  argumentDescriptions = {
    path: 'Path to write, e.g. "Notes/todo.md".',
    content: "Full text of the file.",
    overwrite:
      "Set true to replace an existing file. Without it, an existing file is left alone.",
  };
  requiredArguments = ["path", "content"];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const path = normalizePath(args.path);
    const content = args.content;
    if (typeof content !== "string") {
      throw new Error(
        "Nothing written: content must be text. Call write_file again with the file body.",
      );
    }
    if (content.length > MAX_CHARS) {
      throw new Error(
        `Nothing written: content has ${content.length} characters, it must be under ${MAX_CHARS}. Write a shorter file.`,
      );
    }

    const dav = nextcloud();
    if (await dav.exists(path)) {
      const entry = await dav.stat(path) as DavEntry;
      if (entry.type === "directory") {
        throw new Error(
          `Nothing written: "${path}" is a folder. Use a file path.`,
        );
      }
      if (args.overwrite !== true) {
        throw new Error(
          `Nothing written: "${path}" already exists. Pass overwrite true to replace it.`,
        );
      }
    }

    await putFile(path, new TextEncoder().encode(content));
    return `Wrote ${content.length} characters to "${path}".`;
  }
}
