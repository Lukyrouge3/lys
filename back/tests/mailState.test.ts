import { assertEquals } from "@std/assert";
import { uidWindow } from "@/mail/state.ts";

const mailbox = { uidValidity: 42n, uidNext: 100 };

Deno.test("a new folder starts at the next uid", () => {
  assertEquals(uidWindow({ uidValidity: null, lastUid: 0 }, mailbox), {
    reset: true,
    firstUid: 100,
  });
});

Deno.test("an unchanged folder continues after the last read uid", () => {
  assertEquals(uidWindow({ uidValidity: 42n, lastUid: 99 }, mailbox), {
    reset: false,
    firstUid: 100,
  });
});

Deno.test("a rewritten mailbox resets to the next uid", () => {
  assertEquals(uidWindow({ uidValidity: 41n, lastUid: 99 }, mailbox), {
    reset: true,
    firstUid: 100,
  });
});

Deno.test("a stale last uid past uidNext asks for nothing new", () => {
  assertEquals(uidWindow({ uidValidity: 42n, lastUid: 150 }, mailbox), {
    reset: false,
    firstUid: 151,
  });
});
