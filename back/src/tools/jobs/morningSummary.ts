import type { Tool, ToolContext } from "@/tools/tool.ts";
import { buildMorningMessage } from "@/scheduler/morning.ts";

export class MorningSummaryTool implements Tool {
  name = "morning_summary";
  description =
    "The morning message, on request: everything the owner clicked or sent since the previous morning, the applications still waiting for his input (with the short ids mark_job takes), and the important mail since yesterday. It is sent by itself every morning; use this tool when the owner asks for it again, or to answer what happened since then.";
  arguments = {};
  argumentDescriptions = {};
  requiredArguments = [];
  requireApproval = false;

  async run(
    _context: ToolContext,
    _args: Record<string, unknown>,
  ): Promise<string> {
    return await buildMorningMessage();
  }
}
