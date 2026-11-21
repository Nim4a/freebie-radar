import { config } from "./config.ts";
import { all } from "./db.ts";
import { hasCookieConfiguredForSource } from "./cookie-store.ts";
import { runSource } from "./collectors/index.ts";

/** Minimal 5-field cron matcher: minute hour day month weekday; supports * , - /. */
export function matchCron(expr: string, date: Date, utc = false): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const get = utc
    ? [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()]
    : [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return parts.every((part, i) => matchField(part, get[i]!, ranges[i]![0], ranges[i]![1]));
}

export function matchField(field: string, value: number, min: number, max: number): boolean {
  for (const chunk of field.split(",")) {
    const [rangePart, stepPart] = chunk.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step <= 0) return false;
    let start = min;
    let end = max;
    if (rangePart && rangePart !== "*") {
      const [a, b] = rangePart.split("-");
      start = Number(a);
      end = b === undefined ? (stepPart ? max : start) : Number(b);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (value < start || value > end) continue;
    if ((value - start) % step === 0) return true;
  }
  return false;
}


export function listDueSourceIds(): string[] {
  const due = all<{ id: string; kind: string; interval_sec: number; last_run_at: string | null }>(
    `SELECT id, kind, interval_sec, last_run_at FROM sources
      WHERE enabled = 1
        AND (last_run_at IS NULL OR datetime(last_run_at, '+' || interval_sec || ' seconds') <= datetime('now'))
      ORDER BY last_run_at IS NOT NULL, last_run_at ASC`,
  );
  const filter = config.enabledSources;
  return due
    .filter((s) => {
      if (filter.length && !filter.includes(s.id)) return false;
      if (s.kind === "ingest" && !hasCookieConfiguredForSource(s.id)) return false;
      return true;
    })
    .map((s) => s.id);
}

/**
 * Poll by each source's own interval_sec: run when due, serially, so upstreams are not hammered.
 * Code-drop sources run every 60-120s; daily digest/listing/cookie-hosted sources every half hour to a few hours.
 */
export function startIntervalScheduler(task: {
  log?: (m: string) => void;
  tickMs?: number;
} = {}): void {
  const log = task.log ?? ((m: string) => console.log(m));
  const tickMs = task.tickMs ?? 30_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const id of listDueSourceIds()) {
        try {
          await runSource(id);
        } catch (err) {
          log(`[cron] ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log(`[cron] scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), tickMs);
  timer.unref?.();
  intervalTimer = timer;
  log(`[cron] interval scheduler started (tick=${tickMs}ms)`);
}

let intervalTimer: NodeJS.Timeout | null = null;

export function stopIntervalScheduler(): void {
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = null;
}
let timer: NodeJS.Timeout | null = null;
let lastKey = "";

export function startScheduler(task: { collect: () => Promise<unknown>; daily: () => Promise<unknown>; log?: (m: string) => void }): void {
  if (timer) return;
  const log = task.log ?? ((m: string) => console.log(m));
  timer = setInterval(() => {
    const now = new Date();
    const key = now.toISOString().slice(0, 16);
    if (key === lastKey) return;
    lastKey = key;
    if (config.enableScheduler && matchCron(config.collectCron, now)) {
      log("[cron] triggering collection");
      task.collect().catch((e) => log(`[cron] collection failed: ${String(e)}`));
    }
    if (config.enableScheduler && matchCron(config.dailyCron, now)) {
      log("[cron] triggering daily digest");
      task.daily().catch((e) => log(`[cron] daily digest failed: ${String(e)}`));
    }
  }, 30_000);
  log(`[cron] scheduler started collect="${config.collectCron}" daily="${config.dailyCron}"`);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
