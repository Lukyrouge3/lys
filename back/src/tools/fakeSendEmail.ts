import { Tool, ToolContext } from "@/tools/tool.ts";

// Fake action to try out the approval flow, nothing is actually sent
export class FakeSendEmailTool implements Tool {
  name = "send_email";
  description = "Send an email (test tool, needs the user's approval)";
  arguments = { to: "string", subject: "string" };
  argumentDescriptions = {
    to: "Recipient email address",
    subject: "Email subject",
  };
  requiredArguments = ["to", "subject"];
  requireApproval = true;

  run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    return Promise.resolve(`Email "${args.subject}" sent to ${args.to}`);
  }
}
