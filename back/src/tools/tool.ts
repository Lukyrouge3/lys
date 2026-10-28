import OpenAI from "@openai/openai";
import { GetWeatherTool } from "@/tools/getWeather.ts";
import { SetTitleTool } from "@/tools/setTitle.ts";

const tools = new Map<string, Tool>(
  [new GetWeatherTool(), new SetTitleTool()].map((tool) => [tool.name, tool]),
);

export interface Tool {
  name: string;
  description: string;
  arguments: Record<string, string>;
  argumentDescriptions: Record<string, string>;
  requiredArguments: string[];

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
};

export function runTool(
  toolName: string,
  toolContext: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.get(toolName);
  if (!tool) {
    throw new Error(`Tool ${toolName} not found`);
  }
  return tool.run(toolContext, args);
}
