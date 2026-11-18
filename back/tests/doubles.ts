// Test doubles for the two behaviours the tool loop needs: something harmless
// that returns a value, and something that waits for approval. Neither is
// registered in production, so the model can never call them.
import { defaultTools, type Tool, type ToolContext } from "@/tools/tool.ts";

export class WeatherStub implements Tool {
  name = "get_weather";
  description = "Get the current weather for a city (test double)";
  arguments = { city: "string" };
  argumentDescriptions = { city: "City name" };
  requiredArguments = ["city"];
  requireApproval = false;

  run(_context: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (typeof args.city !== "string" || !args.city) {
      throw new Error("city must be text");
    }
    return Promise.resolve(
      JSON.stringify({ city: args.city, temperature: "25°C" }),
    );
  }
}

export class ApprovalStub implements Tool {
  name = "send_email";
  description = "Send an email (test double)";
  arguments = { to: "string", subject: "string" };
  argumentDescriptions = { to: "Recipient", subject: "Subject" };
  requiredArguments = ["to", "subject"];
  requireApproval = true;

  run(_context: ToolContext, args: Record<string, unknown>): Promise<string> {
    return Promise.resolve(`Email "${args.subject}" sent to ${args.to}`);
  }
}

/** The production registry plus the doubles, for tests that inject one. */
export function testTools(): Map<string, Tool> {
  const weather = new WeatherStub();
  const email = new ApprovalStub();
  return new Map<string, Tool>([
    ...defaultTools,
    [weather.name, weather],
    [email.name, email],
  ]);
}
