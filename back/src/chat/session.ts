import { AgentConfigWithProvider, getAgent } from "@/config/agentConfig.ts";
import { logger } from "@/utils/logger.ts";
import { getOpenAIClient } from "@/llm/provider.ts";
import {
  ConversationWithMessages,
  getLastConversation,
} from "@/llm/conversation.ts";
import { createUserMessage, toModelMessage } from "@/llm/message.ts";
import { generateToolRequest } from "@/tools/tool.ts";
import { runAgent } from "@/agent/agent.ts";
import { EmitEvent } from "@/agent/events.ts";
import { canResume, resolveApproval } from "@/agent/approval.ts";
import {
  buildRecallQuery,
  formatMemories,
  recallMemories,
  retainConversation,
} from "@/memory.ts";
import type OpenAI from "@openai/openai";

const tools = generateToolRequest();

// The most recent user message, used to anchor vague recall queries
function lastUserText(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
}

// What each chat app implements to display the agent's answer
export type ChatAdapter = {
  onEvent: EmitEvent;
};

export type ChatSessionOptions = {
  trigger: string;
  messageCount?: number;
};

export async function createChatSession(
  agentName: string,
  { trigger, messageCount }: ChatSessionOptions,
): Promise<ChatSession> {
  const agentConfig = await getAgent(agentName);
  logger.info(`Loaded agent config: ${agentConfig.name}`);

  const provider = agentConfig.provider;
  logger.info(`Using provider: ${provider.name} (${provider.id})`);

  const conversation = await getLastConversation(messageCount);
  logger.info(`Using conversation: ${conversation.name} (${conversation.id})`);

  return getChatSession(agentConfig, conversation, trigger);
}

export type ChatSession = {
  conversation: ConversationWithMessages;
  history: ConversationWithMessages["messages"];
  send: (input: string, adapter: ChatAdapter) => Promise<void>;
  // Returns false if there was nothing to resolve (already decided, unknown id)
  resolveApproval: (
    toolCallId: string,
    approved: boolean,
    adapter: ChatAdapter,
  ) => Promise<boolean>;
};

export async function getChatSession(
  agent: AgentConfigWithProvider,
  conversation: ConversationWithMessages,
  trigger: string,
): Promise<ChatSession> {
  const provider = agent.provider;
  const history = conversation.messages.reverse();
  const messages = history.map((msg) => toModelMessage(msg)).flat();
  const openai = await getOpenAIClient(provider);

  function emitTo(adapter: ChatAdapter): EmitEvent {
    return (event) => {
      if (event.type === "titleChanged") conversation.name = event.title;
      adapter.onEvent(event);
    };
  }

  async function run(
    emit: EmitEvent,
    runTrigger = trigger,
    memoryContext = "",
  ) {
    await runAgent({
      openai,
      agentConfig: agent,
      tools,
      messages,
      conversationId: conversation.id,
      trigger: runTrigger,
      provider,
      emit,
      memoryContext,
    });
  }

  return {
    conversation,
    // Messages loaded on start, oldest first
    history,
    async send(input: string, adapter: ChatAdapter) {
      const msg = await createUserMessage(input, conversation.id);

      // Start of turn: pull in what is relevant from earlier conversations.
      const memoryContext = formatMemories(
        await recallMemories(buildRecallQuery(input, lastUserText(messages))),
      );

      messages.push(...toModelMessage(msg));
      try {
        await run(emitTo(adapter), trigger, memoryContext);
      } finally {
        // End of turn: index what was just said, without blocking the reply.
        void retainConversation(conversation.id);
      }
    },
    async resolveApproval(
      toolCallId: string,
      approved: boolean,
      adapter: ChatAdapter,
    ) {
      const emit = emitTo(adapter);
      const call = await resolveApproval(
        toolCallId,
        conversation.id,
        approved,
        emit,
      );
      if (!call) return false;

      // The cached history still has "waiting for approval" as the result
      for (const msg of messages) {
        if (msg.role === "tool" && msg.tool_call_id === call.apiId) {
          msg.content = call.result ?? "";
        }
      }
      // No new user message: the model just reacts to the outcome
      try {
        if (await canResume(call, messages)) await run(emit, "approval");
      } finally {
        // The turn only really ends once the agent stops after the decision
        void retainConversation(conversation.id);
      }
      return true;
    },
  };
}
