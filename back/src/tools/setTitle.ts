import { Tool, ToolContext } from "@/tools/tool.ts";
import prisma from "@/db.ts";
import * as z from "zod";

export class SetTitleTool implements Tool {
  name = "set_title";
  description = "Set the title of the current conversation";
  arguments = { title: "string" };
  argumentDescriptions = {
    title:
      "New title for the conversation. Must be between 3 and 64 characters.",
  };
  requiredArguments = ["title"];

  async run(
    toolContext: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const parsed = z.string().trim().min(3).max(64).safeParse(args.title);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));

    await prisma.conversation.update({
      where: { id: toolContext.conversationId },
      data: { name: parsed.data },
    });

    return "OK";
  }
}
