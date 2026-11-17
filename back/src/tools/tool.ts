import OpenAI from "@openai/openai";
import { GetWeatherTool } from "@/tools/getWeather.ts";
import { SetTitleTool } from "@/tools/setTitle.ts";
import { FakeSendEmailTool } from "@/tools/fakeSendEmail.ts";
import { RecallMemoryTool } from "@/tools/recallMemory.ts";
import { SaveMemoryTool } from "@/tools/saveMemory.ts";
import { ShareFolderTool } from "@/tools/shareFolder.ts";
import { CleanLinksTool } from "@/tools/cleanLinks.ts";
import { SendFileTool } from "@/tools/sendFile.ts";
import { ListFilesTool } from "@/tools/listFiles.ts";
import { FindFilesTool } from "@/tools/findFiles.ts";
import { ReadFileTool } from "@/tools/readFile.ts";
import { WriteFileTool } from "@/tools/writeFile.ts";
import { CreateFolderTool } from "@/tools/createFolder.ts";
import { MoveFileTool } from "@/tools/moveFile.ts";
import { DeleteFileTool } from "@/tools/deleteFile.ts";
import { EmitEvent } from "@/agent/events.ts";
import { ApprovalStatus } from "@/generated/prisma/enums.ts";

const tools = new Map<string, Tool>(
  [
    new GetWeatherTool(),
    new SetTitleTool(),
    new FakeSendEmailTool(),
    new RecallMemoryTool(),
    new SaveMemoryTool(),
    new ShareFolderTool(),
    new CleanLinksTool(),
    new SendFileTool(),
    new ListFilesTool(),
    new FindFilesTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new CreateFolderTool(),
    new MoveFileTool(),
    new DeleteFileTool(),
  ].map((
    tool,
  ) => [tool.name, tool]),
);

export interface Tool {
  name: string;
  description: string;
  arguments: Record<string, string>;
  argumentDescriptions: Record<string, string>;
  requiredArguments: string[];
  // Whether the call waits for the user's button. A function decides per call.
  requireApproval:
    | boolean
    | ((args: Record<string, unknown>) => boolean);

  run: (
    toolContext: ToolContext,
    args: Record<string, unknown>,
  ) => Promise<string>;
}

export function generateToolRequest(): OpenAI.Chat.ChatCompletionTool[] {
  const toolRequests: OpenAI.Chat.ChatCompletionTool[] = [];
  for (const tool of tools.values()) {
    const toolRequest = {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: {} as Record<
            string,
            { type: string; description: string }
          >,
          required: tool.requiredArguments,
        },
      },
    };

    for (const [argName, argType] of Object.entries(tool.arguments)) {
      toolRequest.function.parameters.properties[argName] = {
        type: argType,
        description: tool.argumentDescriptions[argName] || "",
      };
    }

    toolRequests.push(toolRequest);
  }
  return toolRequests;
}

export type ToolContext = {
  conversationId: string;
  approval: ApprovalStatus;

  emit: EmitEvent;
  /** Native attachment upload. Undefined when the chat has none. */
  sendFile?: (file: { name: string; data: Uint8Array }) => Promise<void>;
};

export type ToolResult =
  | { status: "ok"; content: string }
  | { status: "error"; content: string }
  | { status: "pendingApproval" };

export async function runTool(
  toolName: string,
  toolContext: ToolContext,
  args: string,
): Promise<ToolResult> {
  const tool = tools.get(toolName);
  if (!tool) {
    return { status: "error", content: `Tool ${toolName} not found` };
  }
  try {
    const parsedArgs = JSON.parse(args);
    const needsApproval = typeof tool.requireApproval === "function"
      ? tool.requireApproval(parsedArgs)
      : tool.requireApproval;
    if (needsApproval && toolContext.approval !== ApprovalStatus.approved) {
      return {
        status: "pendingApproval",
      };
    }

    return {
      status: "ok",
      content: await tool.run(toolContext, parsedArgs),
    };
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error);
    return { status: "error" as const, content };
  }
}
