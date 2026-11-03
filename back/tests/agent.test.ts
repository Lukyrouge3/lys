import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import OpenAI from "@openai/openai";
import prisma from "@/db.ts";
import { runAgent } from "@/agent/agent.ts";
import { AgentEvent, EmitEvent } from "@/agent/events.ts";
import { generateToolRequest } from "@/tools/tool.ts";
import { AgentConfig } from "@/config/agentConfig.ts";
import { Provider } from "@/generated/prisma/client.ts";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Request = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

const agentConfig: AgentConfig = {
  name: "test",
  model: "test-model",
  systemPrompt: "You are a test.",
};

function chunk(delta: Chunk["choices"][number]["delta"]): Chunk {
  return {
    id: "chunk",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function textReply(text: string): Chunk[] {
  return [chunk({ content: text })];
}

function toolCallReply(id: string, name: string, args: string): Chunk[] {
  const half = Math.floor(args.length / 2);
  return [
    chunk({
      tool_calls: [{ index: 0, id, function: { name, arguments: "" } }],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }],
    }),
  ];
}

// Fake client: each call to create() gets the next scripted reply
function fakeOpenAI(reply: (request: Request, call: number) => Chunk[]) {
  const requests: Request[] = [];
  const openai = {
    chat: {
      completions: {
        create: (request: Request) => {
          requests.push(structuredClone(request));
          const chunks = reply(request, requests.length - 1);
          return Promise.resolve((async function* () {
            yield* chunks;
          })());
        },
      },
    },
  } as unknown as OpenAI;
  return { openai, requests };
}

async function setup() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "ToolCall", "Message", "LlmCall", "Conversation", "Provider", "Secret" CASCADE`,
  );
  const secret = await prisma.secret.create({
    data: { name: "test-key", value: "unused" },
  });
  const provider: Provider = await prisma.provider.create({
    data: { name: "test", host: "http://fake", apiKeyId: secret.id },
  });
  const conversation = await prisma.conversation.create({
    data: { name: "test" },
  });
  return { provider, conversationId: conversation.id };
}

function run(
  openai: OpenAI,
  provider: Provider,
  conversationId: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  emit: EmitEvent = () => {},
) {
  return runAgent({
    openai,
    agentConfig,
    tools: generateToolRequest(),
    messages,
    conversationId,
    trigger: "test",
    provider,
    emit,
  });
}

Deno.test({
  name: "runAgent",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("a plain reply is saved and added to history", async () => {
      const { provider, conversationId } = await setup();
      const { openai, requests } = fakeOpenAI(() => textReply("Hey!"));
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "user", content: "hi" },
      ];

      await run(openai, provider, conversationId, messages);

      assertEquals(requests.length, 1);
      assertEquals(messages.at(-1), { role: "assistant", content: "Hey!" });
      const saved = await prisma.message.findMany({
        where: { conversationId },
      });
      assertEquals(saved.length, 1);
      assertEquals(saved[0].content, "Hey!");
      assert(saved[0].llmCallId);
    });

    await t.step(
      "a tool call runs the tool and sends the result back",
      async () => {
        const { provider, conversationId } = await setup();
        const { openai, requests } = fakeOpenAI((_, call) =>
          call === 0
            ? toolCallReply("call-1", "get_weather", '{"city":"Paris"}')
            : textReply("It's sunny in Paris")
        );
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "user", content: "weather?" },
        ];

        await run(openai, provider, conversationId, messages);

        assertEquals(requests.length, 2);
        const second = requests[1].messages;
        const assistant = second.at(
          -2,
        ) as OpenAI.Chat.ChatCompletionAssistantMessageParam;
        assertEquals(assistant.tool_calls?.[0].id, "call-1");
        const tool = second.at(
          -1,
        ) as OpenAI.Chat.ChatCompletionToolMessageParam;
        assertEquals(tool.role, "tool");
        assertEquals(tool.tool_call_id, "call-1");
        assertStringIncludes(tool.content as string, "Paris");

        const stored = await prisma.toolCall.findFirstOrThrow();
        assertEquals(stored.apiId, "call-1");
        assertEquals(stored.arguments, '{"city":"Paris"}');
        assertStringIncludes(stored.result!, "Paris");
        assertEquals(messages.at(-1), {
          role: "assistant",
          content: "It's sunny in Paris",
        });
      },
    );

    await t.step("an unknown tool stores the error as its result", async () => {
      const { provider, conversationId } = await setup();
      const { openai } = fakeOpenAI((_, call) =>
        call === 0 ? toolCallReply("call-1", "nope", "{}") : textReply("oops")
      );

      await run(openai, provider, conversationId, [
        { role: "user", content: "hi" },
      ]);

      const stored = await prisma.toolCall.findFirstOrThrow();
      assertEquals(stored.result, "Error: Tool nope not found");
    });

    await t.step(
      "malformed arguments store the error as the result",
      async () => {
        const { provider, conversationId } = await setup();
        const { openai } = fakeOpenAI((_, call) =>
          call === 0
            ? toolCallReply("call-1", "get_weather", "{not json")
            : textReply("oops")
        );

        await run(openai, provider, conversationId, [
          { role: "user", content: "hi" },
        ]);

        const stored = await prisma.toolCall.findFirstOrThrow();
        assertStringIncludes(stored.result!, "Error:");
      },
    );

    await t.step("after 5 tool rounds the last call has no tools", async () => {
      const { provider, conversationId } = await setup();
      const { openai, requests } = fakeOpenAI((request, call) =>
        request.tools
          ? toolCallReply(`call-${call}`, "get_weather", '{"city":"Paris"}')
          : textReply("Giving up on tools")
      );
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "user", content: "weather?" },
      ];

      await run(openai, provider, conversationId, messages);

      assertEquals(requests.length, 6);
      assert(requests.slice(0, 5).every((request) => request.tools));
      assertEquals(requests[5].tools, undefined);
      assertEquals(messages.at(-1), {
        role: "assistant",
        content: "Giving up on tools",
      });
    });

    await t.step(
      "only the first 5 tool calls of a response are kept",
      async () => {
        const { provider, conversationId } = await setup();
        const manyCalls = Array.from({ length: 20 }, (_, i) =>
          chunk({
            tool_calls: [{
              index: i,
              id: `call-${i}`,
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            }],
          }));
        const { openai } = fakeOpenAI((_, call) =>
          call === 0 ? manyCalls : textReply("Done")
        );

        await run(openai, provider, conversationId, [
          { role: "user", content: "weather x20" },
        ]);

        assertEquals(await prisma.toolCall.count(), 5);
      },
    );

    await t.step("events are emitted in order", async () => {
      const { provider, conversationId } = await setup();
      const { openai } = fakeOpenAI((_, call) =>
        call === 0
          ? toolCallReply("call-1", "set_title", '{"title":"Weather talk"}')
          : textReply("Done")
      );
      const events: AgentEvent[] = [];

      await run(
        openai,
        provider,
        conversationId,
        [{ role: "user", content: "rename this" }],
        (event) => events.push(event),
      );

      assertEquals(events, [
        { type: "turnStart" },
        { type: "turnEnd" },
        { type: "titleChanged", title: "Weather talk" },
        {
          type: "toolCall",
          name: "set_title",
          arguments: '{"title":"Weather talk"}',
          result: "Title changed successfully",
        },
        { type: "turnStart" },
        { type: "chunk", text: "Done" },
        { type: "turnEnd" },
      ]);
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      assertEquals(conversation.name, "Weather talk");
    });

    await prisma.$disconnect();
  },
});
