import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import OpenAI from "@openai/openai";
import prisma from "@/db.ts";
import { runAgent } from "@/agent/agent.ts";
import { canResume, resolveApproval } from "@/agent/approval.ts";
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
  contextWindow: 8192,
  maxReplyTokens: 1024,
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

    // Runs send_email (needs approval) once and returns its stored tool call
    async function pendingCall() {
      const { provider, conversationId } = await setup();
      const { openai, requests } = fakeOpenAI(() =>
        toolCallReply("call-1", "send_email", '{"to":"a@b.c","subject":"hi"}')
      );
      const events: AgentEvent[] = [];
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "user", content: "mail them" },
      ];
      await run(
        openai,
        provider,
        conversationId,
        messages,
        (event) => events.push(event),
      );
      const call = await prisma.toolCall.findFirstOrThrow();
      return { call, conversationId, events, requests, messages };
    }

    await t.step(
      "a tool needing approval is stored as pending, not run",
      async () => {
        const { call, events } = await pendingCall();
        assertEquals(call.approval, "pending");
        assertStringIncludes(call.result!, "Not run yet");
        assert(
          events.some((e) =>
            e.type === "approvalRequested" && e.approvalId === call.id
          ),
        );
      },
    );

    await t.step(
      "a pending call ends the run on its tool result",
      async () => {
        const { requests, messages } = await pendingCall();
        assertEquals(requests.length, 1);
        assertEquals(messages.at(-1)?.role, "tool");
      },
    );

    await t.step("resumes once the pending call is decided", async () => {
      const { call, conversationId, messages } = await pendingCall();
      assertEquals(await canResume(call, messages), false);
      const resolved = await resolveApproval(
        call.id,
        conversationId,
        true,
        () => {},
      );
      assertEquals(await canResume(resolved!, messages), true);
    });

    await t.step(
      "doesn't resume while another call from the same response is pending",
      async () => {
        const { provider, conversationId } = await setup();
        const { openai } = fakeOpenAI(() => [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: {
                  name: "send_email",
                  arguments: '{"to":"a@b.c","subject":"one"}',
                },
              },
              {
                index: 1,
                id: "call-2",
                function: {
                  name: "send_email",
                  arguments: '{"to":"a@b.c","subject":"two"}',
                },
              },
            ],
          }),
        ]);
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "user", content: "mail them twice" },
        ];
        await run(openai, provider, conversationId, messages);
        const [first, second] = await prisma.toolCall.findMany({
          orderBy: { apiId: "asc" },
        });
        const one = await resolveApproval(
          first.id,
          conversationId,
          true,
          () => {},
        );
        assertEquals(await canResume(one!, messages), false);
        const two = await resolveApproval(
          second.id,
          conversationId,
          false,
          () => {},
        );
        assertEquals(await canResume(two!, messages), true);
      },
    );

    await t.step(
      "doesn't resume if the conversation moved on",
      async () => {
        const { call, conversationId, messages } = await pendingCall();
        messages.push(
          { role: "user", content: "never mind" },
          { role: "assistant", content: "ok" },
        );
        const resolved = await resolveApproval(
          call.id,
          conversationId,
          true,
          () => {},
        );
        assertEquals(await canResume(resolved!, messages), false);
      },
    );

    await t.step("approving runs the tool and stores the result", async () => {
      const { call, conversationId } = await pendingCall();
      const resolved = await resolveApproval(
        call.id,
        conversationId,
        true,
        () => {},
      );
      assertEquals(resolved?.result, 'Email "hi" sent to a@b.c');
      const stored = await prisma.toolCall.findUniqueOrThrow({
        where: { id: call.id },
      });
      assertEquals(stored.approval, "approved");
      assert(stored.decidedAt);
    });

    await t.step("rejecting doesn't run the tool", async () => {
      const { call, conversationId } = await pendingCall();
      const resolved = await resolveApproval(
        call.id,
        conversationId,
        false,
        () => {},
      );
      assertStringIncludes(resolved!.result!, "Rejected");
      const stored = await prisma.toolCall.findUniqueOrThrow({
        where: { id: call.id },
      });
      assertEquals(stored.approval, "denied");
    });

    await t.step("an approval can only be decided once", async () => {
      const { call, conversationId } = await pendingCall();
      assert(await resolveApproval(call.id, conversationId, true, () => {}));
      assertEquals(
        await resolveApproval(call.id, conversationId, true, () => {}),
        null,
      );
      assertEquals(
        await resolveApproval(call.id, conversationId, false, () => {}),
        null,
      );
    });

    await t.step(
      "an approval from another conversation is ignored",
      async () => {
        const { call } = await pendingCall();
        const other = await prisma.conversation.create({
          data: { name: "other" },
        });
        assertEquals(
          await resolveApproval(call.id, other.id, true, () => {}),
          null,
        );
      },
    );

    await prisma.$disconnect();
  },
});
