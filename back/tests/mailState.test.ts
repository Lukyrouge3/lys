import { assert, assertEquals } from "@std/assert";
import { folderStateAfter, uidWindow } from "@/mail/state.ts";

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

Deno.test("a reset drops the old last uid instead of carrying it over", () => {
  assertEquals(
    folderStateAfter({ uidValidity: 41n, lastUid: 150 }, mailbox, 0),
    { uidValidity: 42n, lastUid: 99 },
  );
});

Deno.test("a reset keeps the uids it actually fetched", () => {
  assertEquals(
    folderStateAfter({ uidValidity: 41n, lastUid: 150 }, mailbox, 104),
    { uidValidity: 42n, lastUid: 104 },
  );
});

Deno.test("an unchanged folder moves to the highest fetched uid", () => {
  assertEquals(
    folderStateAfter({ uidValidity: 42n, lastUid: 99 }, mailbox, 104),
    { uidValidity: 42n, lastUid: 104 },
  );
});

Deno.test("nothing fetched leaves an unchanged folder where it was", () => {
  assertEquals(
    folderStateAfter({ uidValidity: 42n, lastUid: 99 }, mailbox, 0),
    { uidValidity: 42n, lastUid: 99 },
  );
});

Deno.test("an empty mailbox after a reset starts at zero", () => {
  assertEquals(
    folderStateAfter(
      { uidValidity: 41n, lastUid: 150 },
      { uidValidity: 42n, uidNext: 1 },
      0,
    ),
    { uidValidity: 42n, lastUid: 0 },
  );
});

Deno.test("the saved cursor never points past the mailbox", () => {
  // Fetched uids never exceed uidNext - 1; anything else is a fetch bug.
  for (
    const previous of [
      { uidValidity: null, lastUid: 0 },
      { uidValidity: 41n, lastUid: 150 },
      { uidValidity: 42n, lastUid: 0 },
      { uidValidity: 42n, lastUid: 99 },
    ]
  ) {
    for (const fetched of [0, 1, 50, 99]) {
      const next = folderStateAfter(previous, mailbox, fetched);
      assert(
        next.lastUid <= mailbox.uidNext - 1,
        `validity ${previous.uidValidity} lastUid ${previous.lastUid} + ${fetched} -> lastUid ${next.lastUid}`,
      );
    }
  }
});
