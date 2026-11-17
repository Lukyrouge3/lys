import ICAL from "ical.js";
import { createDAVClient } from "tsdav";

const serverUrl = Deno.env.get("NEXTCLOUD_URL")!.replace(/\/$/, "");
const owner = Deno.env.get("NEXTCLOUD_OWNER")!;

const client = await createDAVClient({
  serverUrl: `${serverUrl}/remote.php/dav`,
  credentials: {
    username: Deno.env.get("NEXTCLOUD_USERNAME")!,
    password: Deno.env.get("NEXTCLOUD_PASSWORD")!,
  },
  authMethod: "Basic",
  defaultAccountType: "caldav",
});

const calendars = await client.fetchCalendars({
  account: {
    accountType: "caldav",
    serverUrl,
    rootUrl: `${serverUrl}/remote.php/dav/`,
    homeUrl: `${serverUrl}/remote.php/dav/calendars/${owner}/`,
  },
});
const personal = calendars.find((c) => c.url.endsWith("/personal/"))!;

// Next 3 events
const now = new Date();
const inOneYear = new Date(now.getTime() + 365 * 24 * 3600 * 1000);

const objects = await client.fetchCalendarObjects({
  calendar: personal,
  timeRange: { start: now.toISOString(), end: inOneYear.toISOString() },
  expand: true,
});

const events = objects
  .flatMap((o) =>
    new ICAL.Component(ICAL.parse(o.data)).getAllSubcomponents("vevent")
  )
  .map((vevent) => new ICAL.Event(vevent))
  .sort((a, b) => a.startDate.compare(b.startDate))
  .slice(0, 3);

for (const e of events) {
  console.log(`${e.startDate.toJSDate().toLocaleString()} — ${e.summary}`);
}

// Create a "test" event tomorrow at 10:00
const start = new Date(now);
start.setDate(start.getDate() + 1);
start.setHours(10, 0, 0, 0);

const vcalendar = new ICAL.Component("vcalendar");
vcalendar.addPropertyWithValue("prodid", "-//lys//EN");
vcalendar.addPropertyWithValue("version", "2.0");
const vevent = new ICAL.Component("vevent");
vevent.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
vcalendar.addSubcomponent(vevent);

const event = new ICAL.Event(vevent);
event.uid = crypto.randomUUID();
event.summary = "test";
event.startDate = ICAL.Time.fromJSDate(start, true);
event.endDate = ICAL.Time.fromJSDate(
  new Date(start.getTime() + 3600 * 1000),
  true,
);

const res = await client.createCalendarObject({
  calendar: personal,
  iCalString: vcalendar.toString(),
  filename: `${event.uid}.ics`,
});
console.log(
  `Created "test" on ${start.toLocaleString()} -> ${res.status} ${personal.url}${event.uid}.ics`,
);
