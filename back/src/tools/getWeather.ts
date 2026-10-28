import { Tool, ToolContext } from "@/tools/tool.ts";

export class GetWeatherTool implements Tool {
  name = "get_weather";
  description = "Get the current weather for a city";
  arguments = { city: "string" };
  argumentDescriptions = { city: "City name" };
  requiredArguments = ["city"];

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    return JSON.stringify({
      city: args.city,
      temperature: "25°C",
      condition: "Sunny",
    });
  }
}
