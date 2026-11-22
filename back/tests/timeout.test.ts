import { assertEquals, assertRejects } from "@std/assert";
import { withTimeout } from "@/utils/timeout.ts";

Deno.test("withTimeout resolves with the promise's value", async () => {
  assertEquals(
    await withTimeout(Promise.resolve(42), 1_000, "Ranking call"),
    42,
  );
});

Deno.test("withTimeout rejects with the label when the clock runs out", async () => {
  const err = await assertRejects(
    () => withTimeout(new Promise<void>(() => {}), 10, "Inbox write"),
    Error,
    "Inbox write timed out after 10 ms",
  );
  assertEquals(err.message, "Inbox write timed out after 10 ms");
});

Deno.test("a late rejection after the timeout is not unhandled", async () => {
  let rejectLate: (err: Error) => void = () => {};
  const slow = new Promise<void>((_, reject) => {
    rejectLate = reject;
  });

  await assertRejects(
    () => withTimeout(slow, 10, "Discord ping"),
    Error,
    "Discord ping timed out after 10 ms",
  );

  // Settles after the race is over: the runtime would report it if unhandled
  rejectLate(new Error("too late"));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

Deno.test("the timer is cleared whether the promise resolves or rejects", async () => {
  // The resource sanitizer fails this test if either timer is left behind
  assertEquals(
    await withTimeout(Promise.resolve("ok"), 60_000, "Long limit"),
    "ok",
  );

  const err = await assertRejects(
    () => withTimeout(Promise.reject(new Error("boom")), 60_000, "Long limit"),
    Error,
    "boom",
  );
  assertEquals(err.message, "boom");
});
