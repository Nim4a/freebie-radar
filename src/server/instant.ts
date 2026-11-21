/**
 * Legacy entry point of the push module; the real implementation moved to push.ts (settings, batching, quiet hours and logs all live there).
 * These exports are kept so existing call sites in collectors do not have to change.
 */
export {
  pushInstant,
  pushReviewedByIds,
  pushStats,
  previewPush,
  flushBatch,
  queueSize,
  recentPushLog,
  startPushScheduler,
  getPushSettings,
  savePushSettings,
  detectLang,
  inQuietHoursZoned,
  isQuietNow,
  sourceLabel,
  type PushSettings,
  type PushRoute,
  type PushTiming,
  type AiFallbackMode,
  type PushSourceMode,
  type QuietAction,
  DEFAULT_SETTINGS,
} from "./push.ts";

import { all, get } from "./db.ts";

/** Legacy-compatible call: returns recently pushed items (without the body, keeping the list small). */
export function recentPushed(limit = 20) {
  return all(
    "SELECT id, source_id, title, url, score, codes, pushed_at FROM items WHERE pushed_at IS NOT NULL ORDER BY pushed_at DESC LIMIT ?",
    limit,
  );
}

export function instantStats(): { pushedLastHour: number; totalPushed: number } {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  return {
    pushedLastHour:
      get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM items WHERE pushed_at IS NOT NULL AND pushed_at >= ?",
        since,
      )?.n ?? 0,
    totalPushed: get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE pushed_at IS NOT NULL")?.n ?? 0,
  };
}
