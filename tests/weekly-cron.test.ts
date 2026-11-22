import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCron } from "../src/server/cron.ts";
import { config } from "../src/server/config.ts";

/* Weekly digest scheduling: WEEKLY_CRON must default to Monday 06:00 server time and stay
   overridable/disableable via env, so the weekly push runs server-side with no client login. */

function mondayAt(hour: number, minute: number): Date {
  // 2026-11-23 is a Monday; build the date in local time to match matchCron's default (utc=false)
  const d = new Date(2026, 10, 23, hour, minute, 30);
  assert.equal(d.getDay(), 1, "fixture must be a Monday");
  return d;
}

test("weekly cron: default WEEKLY_CRON fires Monday 06:00 local and not other minutes", () => {
  assert.equal(config.weeklyCron, "0 6 * * 1");
  assert.equal(matchCron(config.weeklyCron, mondayAt(6, 0)), true);
  assert.equal(matchCron(config.weeklyCron, mondayAt(5, 59)), false);
  assert.equal(matchCron(config.weeklyCron, mondayAt(6, 1)), false);
});

test("weekly cron: empty WEEKLY_CRON disables the weekly trigger", () => {
  // The scheduler guards on `config.weeklyCron && ...`, so an empty expression must never match
  assert.equal(matchCron("", mondayAt(6, 0)), false);
});
