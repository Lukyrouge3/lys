import { assertEquals, assertRejects } from "@std/assert";
import { createKeyedQueue } from "@/chat/discord/queue.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("different keys run concurrently", async () => {
  const queue = createKeyedQueue();
  const started: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const a = queue.run("a", async () => {
    started.push("a");
    await gate;
  });
  const b = queue.run("b", async () => {
    started.push("b");
    await gate;
  });

  await tick();
  assertEquals(started, ["a", "b"]);

  release();
  await Promise.all([a, b]);
});

Deno.test("one key runs its tasks in order", async () => {
  const queue = createKeyedQueue();
  const seen: number[] = [];

  const first = queue.run("chat", async () => {
    await tick();
    seen.push(1);
  });
  const second = queue.run("chat", () => {
    seen.push(2);
    return Promise.resolve();
  });
  const third = queue.run("chat", () => {
    seen.push(3);
    return Promise.resolve();
  });

  await Promise.all([first, second, third]);
  assertEquals(seen, [1, 2, 3]);
});

Deno.test("a throwing task does not poison the chain", async () => {
  const queue = createKeyedQueue();
  let ran = false;

  await assertRejects(
    () =>
      queue.run("chat", () => {
        throw new Error("boom");
      }),
    Error,
    "boom",
  );

  await queue.run("chat", () => {
    ran = true;
    return Promise.resolve();
  });
  assertEquals(ran, true);
});

Deno.test("the map empties once the chains drain", async () => {
  const queue = createKeyedQueue();
  assertEquals(queue.size(), 0);

  await Promise.all([
    queue.run("a", () => Promise.resolve()),
    queue.run("b", () => Promise.resolve()),
  ]);
  await queue.run("a", () => Promise.resolve());
  await tick();

  assertEquals(queue.size(), 0);
});
