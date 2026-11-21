import { all, get, run } from "./db.ts";

/**
 * Data retention policy: over time the items table grows without bound (7000+ now),
 * but only recent giveaways really matter; old rows waste space and slow the list.
 *
 * Rules:
 *  - starred items are never deleted
 *  - items AI judged to be giveaways are kept longer
 *  - manually ignored items are purged soonest
 *  - push logs and digests keep only a recent window
 */
export type RetentionSettings = {
  /** Retention days for ordinary items: expired rows that are neither giveaways nor starred */
  itemDays: number;
  /** Retention days for items AI judged to be giveaways (usually longer than ordinary ones) */
  keptDays: number;
  /** Retention days for manually ignored items */
  ignoredDays: number;
  /** Retention days for push logs */
  pushLogDays: number;
  /** Retention days for daily digests */
  digestDays: number;
  /** Whether cleanup runs automatically every day */
  auto: boolean;
};

export const DEFAULT_RETENTION: RetentionSettings = {
  itemDays: 60,
  keptDays: 180,
  ignoredDays: 14,
  pushLogDays: 30,
  digestDays: 90,
  auto: true,
};

const KEY = "retention";

function numOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function getRetention(): RetentionSettings {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", KEY);
  if (!row) return { ...DEFAULT_RETENTION };
  try {
    const raw = JSON.parse(row.value) as Partial<RetentionSettings>;
    return {
      itemDays: numOr(raw.itemDays, DEFAULT_RETENTION.itemDays, 1, 3650),
      keptDays: numOr(raw.keptDays, DEFAULT_RETENTION.keptDays, 1, 3650),
      ignoredDays: numOr(raw.ignoredDays, DEFAULT_RETENTION.ignoredDays, 1, 3650),
      pushLogDays: numOr(raw.pushLogDays, DEFAULT_RETENTION.pushLogDays, 1, 3650),
      digestDays: numOr(raw.digestDays, DEFAULT_RETENTION.digestDays, 1, 3650),
      auto: raw.auto !== false,
    };
  } catch {
    return { ...DEFAULT_RETENTION };
  }
}

export function saveRetention(patch: Partial<RetentionSettings>): RetentionSettings {
  const cur = getRetention();
  const next: RetentionSettings = {
    itemDays: numOr(patch.itemDays ?? cur.itemDays, cur.itemDays, 1, 3650),
    keptDays: numOr(patch.keptDays ?? cur.keptDays, cur.keptDays, 1, 3650),
    ignoredDays: numOr(patch.ignoredDays ?? cur.ignoredDays, cur.ignoredDays, 1, 3650),
    pushLogDays: numOr(patch.pushLogDays ?? cur.pushLogDays, cur.pushLogDays, 1, 3650),
    digestDays: numOr(patch.digestDays ?? cur.digestDays, cur.digestDays, 1, 3650),
    auto: typeof patch.auto === "boolean" ? patch.auto : cur.auto,
  };
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    KEY,
    JSON.stringify(next),
    new Date().toISOString(),
  );
  return next;
}

export type CleanupReport = {
  deleted: Record<string, number>;
  remaining: number;
  at: string;
};

/** Run one cleanup pass and return how many rows were deleted. dryRun only counts, never deletes. */
export function runCleanup(s?: RetentionSettings, dryRun = false): CleanupReport {
  const cfg = s ?? getRetention();
  const now = Date.now();
  const iso = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const deleted: Record<string, number> = {};

  const plans: { label: string; sql: string; params: (string | number)[] }[] = [
    {
      label: "expired non-giveaway items",
      sql: `DELETE FROM items
            WHERE starred = 0 AND NOT EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.item_id = items.id AND uis.starred = 1)
              AND COALESCE(ai_keep, 0) != 1
              AND COALESCE(published_at, first_seen_at) < ?`,
      params: [iso(cfg.itemDays)],
    },
    {
      label: "expired giveaway items",
      sql: `DELETE FROM items
            WHERE starred = 0 AND NOT EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.item_id = items.id AND uis.starred = 1)
              AND COALESCE(ai_keep, 0) = 1
              AND COALESCE(published_at, first_seen_at) < ?`,
      params: [iso(cfg.keptDays)],
    },
    {
      label: "manually ignored items",
      sql: `DELETE FROM items WHERE starred = 0 AND NOT EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.item_id = items.id AND uis.starred = 1) AND status = 'ignored' AND COALESCE(published_at, first_seen_at) < ?`,
      params: [iso(cfg.ignoredDays)],
    },
    {
      label: "push log",
      sql: "DELETE FROM push_log WHERE created_at < ?",
      params: [iso(cfg.pushLogDays)],
    },
    {
      label: "daily digests",
      sql: "DELETE FROM digests WHERE created_at < ?",
      params: [iso(cfg.digestDays)],
    },
  ];

  for (const p of plans) {
    if (dryRun) {
      const n = get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM (" + p.sql.replace(/^DELETE FROM/, "SELECT 1 FROM") + ")",
        ...p.params,
      );
      deleted[p.label] = n?.n ?? 0;
    } else {
      const info = run(p.sql, ...p.params);
      deleted[p.label] = Number(info.changes);
    }
  }

  const remaining = get<{ n: number }>("SELECT COUNT(*) AS n FROM items")?.n ?? 0;
  return { deleted, remaining, at: new Date().toISOString() };
}

/** Database size in MB, used to decide whether a cleanup is needed. */
export function dbSizeMb(path: string): number {
  try {
    // Not read from disk at runtime; the caller supplies it. Kept as a placeholder so no fs dependency is introduced
    return 0;
  } catch {
    return 0;
  }
}

export function itemCounts(): { total: number; active: number; ignored: number; starred: number } {
  const r = get<{ total: number; active: number; ignored: number; starred: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status='ignored' THEN 1 ELSE 0 END) AS ignored,
            SUM(CASE WHEN starred=1 THEN 1 ELSE 0 END) AS starred
     FROM items`,
  );
  return { total: r?.total ?? 0, active: r?.active ?? 0, ignored: r?.ignored ?? 0, starred: r?.starred ?? 0 };
}
