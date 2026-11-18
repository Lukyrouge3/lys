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
  requireApproval = false;

  async run(
    toolContext: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    // Errors say what didn't happen and what to do, small models need that
    const parsed = z.string().trim().safeParse(args.title);
    if (!parsed.success) {
      throw new Error(
        "Title NOT changed: the title must be text. Call set_title again with a text title.",
      );
    }
    const title = parsed.data;
    if (title.length < 3 || title.length > 64) {
      throw new Error(
        `Title NOT changed: it has ${title.length} characters, it must be between 3 and 64. Call set_title again with a ${
          title.length > 64 ? "shorter" : "longer"
        } title.`,
      );
    }

    await prisma.conversation.update({
      where: { id: toolContext.conversationId },
      data: { name: title },
    });
    toolContext.emit({ type: "titleChanged", title });

    return "Title changed successfully";
  }
}
