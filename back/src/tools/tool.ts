import OpenAI from "@openai/openai";
import { SetTitleTool } from "@/tools/chat/setTitle.ts";
import { RecallMemoryTool } from "@/tools/memory/recallMemory.ts";
import { SaveMemoryTool } from "@/tools/memory/saveMemory.ts";
import { ShareFolderTool } from "@/tools/files/shareFolder.ts";
import { CleanLinksTool } from "@/tools/files/cleanLinks.ts";
import { SendFileTool } from "@/tools/files/sendFile.ts";
import { ListFilesTool } from "@/tools/files/listFiles.ts";
import { FindFilesTool } from "@/tools/files/findFiles.ts";
import { ReadFileTool } from "@/tools/files/readFile.ts";
import { WriteFileTool } from "@/tools/files/writeFile.ts";
import { CreateFolderTool } from "@/tools/files/createFolder.ts";
import { MoveFileTool } from "@/tools/files/moveFile.ts";
import { DeleteFileTool } from "@/tools/files/deleteFile.ts";
import { ListJobsTool } from "@/tools/jobs/listJobs.ts";
import { MarkJobTool } from "@/tools/jobs/markJob.ts";
import { PrepareJobTool } from "@/tools/jobs/prepareJob.ts";
import { MorningSummaryTool } from "@/tools/jobs/morningSummary.ts";
import { EmitEvent } from "@/agent/events.ts";
import { ApprovalStatus } from "@/generated/prisma/enums.ts";

export type ToolRegistry = Map<string, Tool>;

export const defaultTools: ToolRegistry = new Map<string, Tool>(
  [
    new SetTitleTool(),
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
    new ListJobsTool(),
    new MarkJobTool(),
    new PrepareJobTool(),
    new MorningSummaryTool(),
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

export function generateToolRequest(
  registry: ToolRegistry = defaultTools,
): OpenAI.Chat.ChatCompletionTool[] {
  const toolRequests: OpenAI.Chat.ChatCompletionTool[] = [];
  for (const tool of registry.values()) {
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
  /** Model context budget, so tools can size their output to fit */
  contextWindow?: number;
};

export type ToolResult =
  | { status: "ok"; content: string }
  | { status: "error"; content: string }
  | { status: "pendingApproval" };

export async function runTool(
  toolName: string,
  toolContext: ToolContext,
  args: string,
  registry: ToolRegistry = defaultTools,
): Promise<ToolResult> {
  const tool = registry.get(toolName);
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
