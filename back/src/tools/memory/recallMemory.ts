import { Tool, ToolContext } from "@/tools/tool.ts";
import { searchMemories } from "@/memory.ts";

export class RecallMemoryTool implements Tool {
  name = "recall_memory";
  description =
    "Search your long-term memory for facts about the user, the people in their life, their preferences, plans and earlier conversations. Use it when they refer to something from before this conversation, or when you are unsure whether you already know something. Do not use it for things already visible in this conversation.";
  arguments = { query: "string" };
  argumentDescriptions = {
    query:
      "What to look for, as a natural-language question or a few keywords.",
  };
  requiredArguments = ["query"];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new Error(
        "Nothing searched: the query must be text. Call recall_memory again with what to look for.",
      );
    }

    const results = await searchMemories(query, {
      maxTokens: 1500,
      budget: "mid",
      timeoutMs: 5000,
    });
    if (results.length === 0) return "No relevant memories found.";

    return results.map((result) => {
      const when = result.occurred_start?.slice(0, 10);
      return `- [${result.type}] ${result.text}${when ? ` (${when})` : ""}`;
    }).join("\n");
  }
}
