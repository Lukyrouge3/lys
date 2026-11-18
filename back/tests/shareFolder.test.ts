import { assertEquals } from "@std/assert";
import { parseShareResponse, shareRequest } from "@/files/share.ts";
import {
  normalizePath,
  parseMode,
  ShareFolderTool,
} from "@/tools/files/shareFolder.ts";
import { generateToolRequest, runTool, ToolContext } from "@/tools/tool.ts";

const context: ToolContext = {
  conversationId: "test-conversation",
  approval: "pending",
  emit: () => {},
};

Deno.test("a leading or trailing slash is dropped", () => {
  assertEquals(normalizePath("/Mail/2026/invoice/"), "Mail/2026/invoice");
  assertEquals(normalizePath("  Mail  "), "Mail");
});

Deno.test("an empty or wandering path is rejected", () => {
  assertEquals(
    (() => {
      try {
        normalizePath("");
        return "no error";
      } catch {
        return "error";
      }
    })(),
    "error",
  );
  assertEquals(
    (() => {
      try {
        normalizePath("Mail/../etc");
        return "no error";
      } catch {
        return "error";
      }
    })(),
    "error",
  );
  assertEquals(
    (() => {
      try {
        normalizePath(42);
        return "no error";
      } catch {
        return "error";
      }
    })(),
    "error",
  );
});

Deno.test("mode defaults to a direct share", () => {
  assertEquals(parseMode(undefined), "user");
  assertEquals(parseMode("user"), "user");
  assertEquals(parseMode("link"), "link");
});

Deno.test("an unknown mode is rejected", () => {
  let failed = false;
  try {
    parseMode("public");
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
});

Deno.test("a user share names the owner, a link share does not", () => {
  assertEquals(shareRequest("Mail/2026", "user", "Lukyrouge"), {
    path: "Mail/2026",
    shareType: 0,
    shareWith: "Lukyrouge",
    permissions: 1,
  });
  assertEquals(shareRequest("Mail/2026", "link", "Lukyrouge"), {
    path: "Mail/2026",
    shareType: 3,
    permissions: 1,
  });
});

Deno.test("an OCS share response yields its id and url", () => {
  assertEquals(
    parseShareResponse({
      ocs: {
        meta: { status: "ok", statuscode: 200 },
        data: {
          id: "42",
          url: "https://cloud.example/s/abc",
          file_target: "/Mail",
        },
      },
    }),
    { id: "42", url: "https://cloud.example/s/abc", target: "/Mail" },
  );
});

Deno.test("an OCS failure carries the server's message", () => {
  let message = "";
  try {
    parseShareResponse({
      ocs: {
        meta: { status: "failure", statuscode: 404, message: "Path not found" },
        data: {},
      },
    });
  } catch (err) {
    message = (err as Error).message;
  }
  assertEquals(message, "Nextcloud refused the share: Path not found");
});

Deno.test("the tool is advertised to the model", () => {
  const names = generateToolRequest().map((tool) =>
    tool.type === "function" ? tool.function.name : ""
  );
  assertEquals(names.includes("share_folder"), true);
});

Deno.test("a public link waits for approval, a direct share does not", () => {
  const tool = new ShareFolderTool();
  const needsApproval = tool.requireApproval as (
    args: Record<string, unknown>,
  ) => boolean;

  assertEquals(needsApproval({ path: "Mail", mode: "link" }), true);
  assertEquals(needsApproval({ path: "Mail", mode: "user" }), false);
  assertEquals(needsApproval({ path: "Mail" }), false);
});

Deno.test("a link share pauses instead of running", async () => {
  assertEquals(
    (await runTool("share_folder", context, '{"path":"Mail","mode":"link"}'))
      .status,
    "pendingApproval",
  );
});

Deno.test("bad arguments fail before touching Nextcloud", async () => {
  assertEquals(
    (await runTool("share_folder", context, '{"path":""}')).status,
    "error",
  );
  assertEquals(
    (await runTool("share_folder", context, '{"path":"Mail","mode":"public"}'))
      .status,
    "error",
  );
  assertEquals(
    (await runTool("share_folder", context, '{"path":"../secrets"}')).status,
    "error",
  );
});
