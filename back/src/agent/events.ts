// Everything the agent tells the chat app while it runs.
// Each adapter handles the events it cares about and ignores the rest.
export type AgentEvent =
  | { type: "chunk"; text: string }
  | { type: "turnStart" }
  | { type: "turnEnd" }
  | { type: "toolCall"; name: string; arguments: string; result: string }
  | { type: "titleChanged"; title: string };

export type EmitEvent = (event: AgentEvent) => void;
