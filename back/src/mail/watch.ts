// Print mail as it arrives, for checking the watcher by hand.
//
//   deno task mail:watch [accountName]
import { watchMail } from "@/mail/watcher.ts";

const watcher = watchMail((mail) => {
  console.log(
    `[${mail.date?.toISOString() ?? "?"}] ${mail.account}/${mail.folder} ` +
      `#${mail.uid} from ${mail.from}: ${mail.subject}`,
  );
}, { account: Deno.args[0] });

console.log("Watching for new mail. Ctrl+C to stop.");
await new Promise<void>((resolve) => {
  Deno.addSignalListener("SIGINT", () => resolve());
});
await watcher.stop();
