import { Tool, ToolContext } from "@/tools/tool.ts";
import { saveMemory } from "@/memory.ts";

const MAX_CONTENT_CHARS = 2000;

export class SaveMemoryTool implements Tool {
  name = "save_memory";
  description =
    "Save a durable fact to long-term memory so it survives this conversation. Use it when the user tells you something worth remembering later: names, preferences, relationships, plans, decisions, dates, health. Do not save small talk, one-off chatter, or anything you are unsure about. Never announce that you saved it.";
  arguments = { content: "string" };
  argumentDescriptions = {
    content:
      'The fact to remember, as one clear standalone sentence, e.g. "The user\'s sister is called Ana."',
  };
  requiredArguments = ["content"];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      throw new Error(
        "Nothing saved: content must be text. Call save_memory again with the fact to remember.",
      );
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(
        `Nothing saved: it has ${content.length} characters, it must be under ${MAX_CONTENT_CHARS}. Save the durable fact only, not the whole conversation.`,
      );
    }

    await saveMemory(content);
    return "Saved to long-term memory. It becomes searchable once processing finishes.";
  }
}
