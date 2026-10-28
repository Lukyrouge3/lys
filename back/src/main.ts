import { discordChat } from "@/chat/discord.ts";
import { logger } from "@/utils/logger.ts";

logger.info("Starting Discord bot");
await discordChat("lys");

/*import { createClient, FileStat } from "webdav";

const user = Deno.env.get("NEXTCLOUD_USERNAME")!;
const password = Deno.env.get("NEXTCLOUD_PASSWORD")!;
const url = Deno.env.get("NEXTCLOUD_URL")!;
const client = createClient(
  `${url}/remote.php/dav/files/${user}`,
  { username: user, password },
);
*/
