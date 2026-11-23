// Wires the daily jobs into the running bot: the morning summary, the mail
// sorting proposal, and the nightly prep catch-up. Quiet hours do not apply to
// the morning message: it is what quiet hours end for.
import type { Client } from "discord.js";
import { dmOwner } from "@/chat/discord/notify.ts";
import { logger } from "@/utils/logger.ts";
import { startDaily } from "@/scheduler/clock.ts";
import { buildMorningMessage, MORNING_JOB } from "@/scheduler/morning.ts";
import {
  PREP_CATCHUP_JOB,
  prepCatchupEnabled,
  prepCatchupTime,
  runPrepCatchup,
} from "@/scheduler/prepCatchup.ts";
import {
  runSortProposal,
  SORT_JOB,
  sortEnabled,
  sortTime,
} from "@/scheduler/sortProposal.ts";

export const DEFAULT_MORNING_TIME = "07:30";
export const DEFAULT_TIMEZONE = "Europe/Zurich";

/** Local time of the morning message, from `MORNING_TIME` ("HH:MM"). */
export function morningTime(): string {
  return Deno.env.get("MORNING_TIME")?.trim() || DEFAULT_MORNING_TIME;
}

/** The owner's timezone, from `TZ`. */
export function ownerTimezone(): string {
  return Deno.env.get("TZ")?.trim() || DEFAULT_TIMEZONE;
}

/**
 * Starts the daily morning DM, unless `MAIL_SORT=0` the daily sorting
 * proposal, and unless `PREP_ENABLED=0` the nightly prep catch-up. The returned
 * function stops all of them.
 */
export function startScheduler(client: Client): () => void {
  const stops: Array<() => void> = [];

  stops.push(
    startDaily({
      name: MORNING_JOB,
      at: morningTime(),
      tz: ownerTimezone(),
      run: async () => {
        const message = await buildMorningMessage();
        await dmOwner(client, message);
        logger.info(
          `scheduler: morning message sent (${message.length} chars)`,
        );
      },
    }).stop,
  );

  if (sortEnabled()) {
    stops.push(
      startDaily({
        name: SORT_JOB,
        at: sortTime(),
        tz: ownerTimezone(),
        run: async () => {
          const summary = await runSortProposal(client);
          if (summary) logger.info(`scheduler: sorting proposal — ${summary}`);
        },
      }).stop,
    );
  } else {
    logger.info("scheduler: mail sorting proposal disabled (MAIL_SORT=0)");
  }

  if (prepCatchupEnabled()) {
    stops.push(
      startDaily({
        name: PREP_CATCHUP_JOB,
        at: prepCatchupTime(),
        tz: ownerTimezone(),
        run: () => runPrepCatchup(),
      }).stop,
    );
  } else {
    logger.info("scheduler: prep catch-up disabled (PREP_ENABLED=0)");
  }

  return () => {
    for (const stop of stops) stop();
  };
}
