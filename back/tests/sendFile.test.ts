import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  SendFileDav,
  SendFileDeps,
  SendFileTool,
} from "@/tools/files/sendFile.ts";
import type { ToolContext } from "@/tools/tool.ts";

const context: ToolContext = {
  conversationId: "test-conversation",
  approval: "approved",
  emit: () => {},
};

function fakeDav(size = 10): SendFileDav {
  return {
    exists: () => Promise.resolve(true),
    stat: () => Promise.resolve({ type: "file", size }),
    getFileContents: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  };
}

function shareStub() {
  const calls: string[] = [];
  const share: NonNullable<SendFileDeps["share"]> = (path) => {
    calls.push(path);
    return Promise.resolve({
      id: "share-1",
      url: "https://cloud.example/s/abc",
      expiration: "2026-12-01 00:00:00",
    });
  };
  return { calls, share };
}

Deno.test("an upload failure is reported and creates no public link", async () => {
  const share = shareStub();
  const tool = new SendFileTool({ dav: fakeDav(), share: share.share });

  await assertRejects(
    () =>
      tool.run(
        {
          ...context,
          sendFile: () => Promise.reject(new Error("upload refused")),
        },
        { path: "Mail/invoice.pdf" },
      ),
    Error,
    "No public link was created",
  );

  assertEquals(share.calls, []);
});

Deno.test("a chat without native upload gets a link", async () => {
  const share = shareStub();
  const tool = new SendFileTool({ dav: fakeDav(), share: share.share });

  const result = await tool.run(context, { path: "Mail/invoice.pdf" });

  assertEquals(share.calls, ["Mail/invoice.pdf"]);
  assertStringIncludes(result, "https://cloud.example/s/abc");
});

Deno.test("a successful upload needs no link", async () => {
  const share = shareStub();
  const tool = new SendFileTool({ dav: fakeDav(), share: share.share });
  const sent: string[] = [];

  const result = await tool.run(
    {
      ...context,
      sendFile: (file) => {
        sent.push(file.name);
        return Promise.resolve();
      },
    },
    { path: "Mail/invoice.pdf" },
  );

  assertEquals(sent, ["invoice.pdf"]);
  assertEquals(share.calls, []);
  assertStringIncludes(result, "as an attachment");
});

Deno.test("a file over the attachment limit is refused, not linked", async () => {
  const share = shareStub();
  const tool = new SendFileTool({
    dav: fakeDav(9 * 1024 * 1024),
    share: share.share,
  });

  await assertRejects(
    () =>
      tool.run(
        { ...context, sendFile: () => Promise.resolve() },
        { path: "Mail/big.bin" },
      ),
    Error,
    "attachment limit",
  );
  assertEquals(share.calls, []);
});

Deno.test("a newline in a file name cannot forge a line in the reply", async () => {
  const tool = new SendFileTool({
    dav: fakeDav(),
    share: () => Promise.resolve({ id: "1", url: "https://cloud.example/s/x" }),
  });

  const result = await tool.run(context, { path: "Mail/a\nb.pdf" });

  assertEquals(result.includes("\n"), false);
});
