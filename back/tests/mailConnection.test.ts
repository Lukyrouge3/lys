import { assertEquals } from "@std/assert";
import { watchEnd } from "@/mail/watcher.ts";

// The parts of ImapFlow's event API that watchEnd uses. imapflow never
// reconnects on its own, so a closed connection has to end the watch.
class FakeConnection {
  private listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

Deno.test("a closed connection ends the watch so it can reconnect", async () => {
  const connection = new FakeConnection();
  const ended = watchEnd(connection, new AbortController().signal);

  connection.emit("close");

  assertEquals(await ended, "closed");
});

Deno.test("a connection error ends the watch too", async () => {
  const connection = new FakeConnection();
  const ended = watchEnd(connection, new AbortController().signal);

  connection.emit("error");

  assertEquals(await ended, "closed");
});

Deno.test("stopping the watcher ends it without waiting for close", async () => {
  const connection = new FakeConnection();
  const controller = new AbortController();
  const ended = watchEnd(connection, controller.signal);

  controller.abort();

  assertEquals(await ended, "aborted");
});

Deno.test("an already aborted signal resolves without watching", async () => {
  const connection = new FakeConnection();

  assertEquals(await watchEnd(connection, AbortSignal.abort()), "aborted");
  assertEquals(connection.listenerCount(), 0);
});

Deno.test("the watch leaves no listeners behind", async () => {
  const connection = new FakeConnection();
  const controller = new AbortController();
  const ended = watchEnd(connection, controller.signal);

  controller.abort();
  await ended;

  assertEquals(connection.listenerCount(), 0);
});
