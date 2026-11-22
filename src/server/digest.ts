import { config } from "./config.ts";
import { all, get, run } from "./db.ts";
import { CATEGORY_LABEL, dedupeByTitle, KIND_LABEL, type ContentKind, type DedupeEntry } from "./enrich/index.ts";
import { hasValueSignal, isNoiseTitle } from "./enrich/noise.ts";
import { isBlocked, loadActiveBlockRules } from "./enrich/blocklist.ts";
import { getPushSettings, passesPushFilters, sourceLabel } from "./push.ts";
import { sendTelegram } from "./telegram.ts";
import { displayTitle, hydrateTranslations } from "./enrich/translate.ts";
import { passesInterest } from "./enrich/interest.ts";
import { packItemMessages } from "./tg-pack.ts";
import { buildHotReport } from "./hot.ts";
export { sendTelegram };
export type DigestItem = {
  id: number;
  source_id: string;
  title: string;
  url: string;
  category: string | null;
  kind?: string | null;
  score: number;
  expires_at: string | null;
  published_at: string | null;
  price?: number | null;
  is_free?: number;
  obtain?: string | null;
  ai?: string | null;
  codes?: string;
  urlKey?: string | null;
  ai_quality?: number | null;
  /** English rendering of `title` (display only) */
  title_en?: string | null;
  /** English rendering of `summary` (display only) */
  summary_en?: string | null;
};

export type Digest = {
  date: string;
  items: DigestItem[];
  text: string;
};

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function recentDigestPushed(day: string): { ids: Set<number>; seeds: DedupeEntry[] } {
  const rows = all<{ item_ids: string }>(
    "SELECT item_ids FROM digests WHERE (kind IS NULL OR kind = 'daily') AND date >= ?",
    new Date(new Date(day).getTime() - 3 * 86_400_000).toISOString().slice(0, 10),
  );
  const ids = new Set<number>();
  for (const r of rows) {
    try {
      for (const id of JSON.parse(r.item_ids) as number[]) ids.add(id);
    } catch {
      /* ignore corrupt history rows */
    }
  }
  if (!ids.size) return { ids, seeds: [] };
  const placeholders = [...ids].map(() => "?").join(",");
  const seeds = all<DedupeEntry>(
    `SELECT title, url_key AS urlKey FROM items WHERE id IN (${placeholders})`,
    ...ids,
  );
  return { ids, seeds };
}

export function pickDaily(date = new Date(), topN = config.dailyTopN): DigestItem[] {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const lookback = new Date(dayStart.getTime() - 2 * 86_400_000).toISOString();
  const now = new Date().toISOString();

  const rows = all<DigestItem>(
    "SELECT id, source_id, title, title_en, summary_en, url, url_key AS urlKey, category, kind, score, expires_at, published_at, price, is_free, obtain, ai, codes FROM items WHERE status = 'active' AND COALESCE(published_at, first_seen_at) >= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY score DESC, COALESCE(published_at, first_seen_at) DESC LIMIT 400",
    lookback,
    now,
  );

  const pushed = recentDigestPushed(dayKey(date));
  const rules = loadActiveBlockRules();
  const settings = getPushSettings();
  const aiKeepMap = new Map<number, boolean | null>();
  const fresh = rows.filter((r) => {
    if (pushed.ids.has(r.id) || isBlocked(r, rules)) return false;
    let codes: string[] = [];
    try { codes = JSON.parse(r.codes ?? '[]') as string[]; } catch { codes = []; }
    let aiKeep: boolean | null = null;
    if (r.ai) {
      try { aiKeep = (JSON.parse(r.ai) as { keep?: boolean }).keep ?? null; } catch { aiKeep = null; }
    }
    aiKeepMap.set(r.id, aiKeep);
    // Topic filter: only free AI / domain / VPS / cloud, never free-internet nodes or games.
    // Checked on the source text plus the English rendering, so nothing slips through
    // just because a title was translated.
    if (!passesInterest({ title: r.title, title_en: r.title_en, summary_en: r.summary_en, category: r.category })) return false;
    if (settings.aiFallbackMode !== "ignore_ai" && (aiKeep === false || r.kind === "noise")) return false;
    if (!settings.applyToDigest) return true;
    return passesPushFilters({
      sourceId: r.source_id,
      title: r.title,
      score: r.score,
      codes,
      price: r.price ?? null,
      isFree: r.is_free === 1,
      aiKeep,
      kind: r.kind ?? null,
      category: r.category,
      obtain: r.obtain ?? null,
      publishedAt: r.published_at,
    }, settings);
  });

  const hasSignal = (r: DigestItem) => aiKeepMap.get(r.id) === true || hasValueSignal(r.title, r.kind);
  const strictRaw = fresh.filter((r) => r.score >= MIN_DIGEST_SCORE && hasSignal(r) && !isNoiseTitle(r.title));
  const strict = dedupeByTitle(strictRaw, pushed.seeds);
  if (strict.length >= Math.min(6, topN)) return strict.slice(0, topN);

  const relaxedRaw = fresh.filter((r) => hasSignal(r) && !isNoiseTitle(r.title) && r.score >= MIN_DIGEST_SCORE - 10);
  const relaxed = dedupeByTitle(relaxedRaw, pushed.seeds);
  return relaxed.slice(0, topN);
}
const MIN_DIGEST_SCORE = 55;


function daysLeft(iso: string | null): string | null {
  if (!iso) return null;
  const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (Number.isNaN(d)) return null;
  if (d < 0) return "expired";
  if (d === 0) return "ends today";
  return "ends in " + d + " days";
}

function digestFooter(): string {
  return config.publicBaseUrl ? "🔗 All: " + config.publicBaseUrl : "";
}

function digestHeaderFor(count: number, date: Date): (part: number, parts: number) => string {
  const label = `${date.getMonth() + 1}/${date.getDate()}`;
  return (part, parts) => {
    const tail = parts > 1 ? ` (${part}/${parts})` : "";
    return "🛰 Radar · " + label + " — " + count + " items" + tail;
  };
}

/**
 * The whole day in ONE message, every item a numbered hyperlink. Telegram counts only
 * the visible text, so the URL inside <a href> is free and ~45 items fit comfortably;
 * titles are trimmed in stages before the list is ever split.
 */
export function buildDigestMessages(items: DigestItem[], date = new Date()): string[] {
  const picks = items.map((it) => ({ title: displayTitle(it), url: it.url }));
  const footer = digestFooter();
  const packed = packItemMessages(
    picks,
    digestHeaderFor(items.length, date),
    footer ? () => footer : undefined,
  );
  return packed.length ? packed : [digestHeaderFor(items.length, date)(1, 1)];
}

export function formatDigest(items: DigestItem[], date = new Date()): string {
  const label = `${date.getMonth() + 1}/${date.getDate()}`;
  if (!items.length) return "🛰 Resource Radar · " + label + "\n\nNo new claimable resources today, see you tomorrow.";
  return buildDigestMessages(items, date).join("\n\n");
}

export type DailyResult = { date: string; count: number; text: string; pushed: boolean; parts?: number; skippedReason?: string };

export async function runDaily(options: { dryRun?: boolean; date?: Date; log?: (m: string) => void } = {}): Promise<DailyResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const date = options.date ?? new Date();
  const key = dayKey(date);
  const items = pickDaily(date);
  // The digest is the main English surface: make sure the picks are rendered in English
  // even for items collected minutes before this run.
  await hydrateTranslations(items, { max: 40, timeoutMs: 45_000 });
  const messages = buildDigestMessages(items, date);
  const text = messages.join("\n\n");

  if (options.dryRun) {
    log("[daily] dry-run " + key + " items=" + items.length + " parts=" + messages.length);
    log(text);
    return { date: key, count: items.length, text, parts: messages.length, pushed: false, skippedReason: "dry-run" };
  }

  if (config.pushChannel === "none") {
    run(
      "INSERT INTO digests (date, item_ids, payload, created_at, pushed_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(date) DO UPDATE SET item_ids = excluded.item_ids, payload = excluded.payload",
      key,
      JSON.stringify(items.map((i) => i.id)),
      JSON.stringify({ text, count: items.length, parts: messages.length }),
      new Date().toISOString(),
    );
    log("[daily] " + key + " generated " + items.length + " items (PUSH_CHANNEL=none, stored only)");
    return { date: key, count: items.length, text, parts: messages.length, pushed: false, skippedReason: "push disabled" };
  }

  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error("PUSH_CHANNEL=telegram but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is missing");
  }

  for (const part of messages) await sendTelegram(part, { parseMode: "HTML" });
  run(
    "INSERT INTO digests (date, item_ids, payload, created_at, pushed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET item_ids = excluded.item_ids, payload = excluded.payload, pushed_at = excluded.pushed_at",
    key,
    JSON.stringify(items.map((i) => i.id)),
    JSON.stringify({ text, count: items.length, parts: messages.length }),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  log("[daily] " + key + " pushed " + items.length + " items to Telegram (" + messages.length + " message(s))");
  return { date: key, count: items.length, text, parts: messages.length, pushed: true };
}

export function lastDigests(limit = 10) {
  const rows = all<{ date: string; item_ids: string; created_at: string; pushed_at: string | null; kind: string }>(
    "SELECT date, item_ids, created_at, pushed_at, kind FROM digests ORDER BY date DESC LIMIT ?",
    limit,
  );
  return rows.map((r) => {
    let count = 0;
    try {
      count = (JSON.parse(r.item_ids) as number[]).length;
    } catch {
      count = 0;
    }
    return { ...r, kind: r.kind ?? "daily", count };
  });
}

export function digestExists(day: string): boolean {
  return Boolean(get("SELECT date FROM digests WHERE date = ?", day));
}

/* ------------------------------------------------------------------ *
 * Weekly: the past 7 days' "worth grabbing" picks + hot words + category distribution
 * ------------------------------------------------------------------ */

const WEEK_DAYS = 7;

function shortDate(iso: string): string {
  return iso.slice(5, 10).replace("-", "/");
}

/** Weekly storage key: `2026-11-03~11-09` — sorts as a string and never collides with the daily digest's date primary key */
export function weekKey(date = new Date()): string {
  const end = new Date(date);
  const start = new Date(end.getTime() - (WEEK_DAYS - 1) * 86_400_000);
  return dayKey(start) + "~" + dayKey(end).slice(5);
}

export function pickWeekly(date = new Date(), topN = 20): DigestItem[] {
  const end = new Date(date);
  const start = new Date(end.getTime() - WEEK_DAYS * 86_400_000);
  const now = new Date().toISOString();
  const rows = all<DigestItem>(
    `SELECT id, source_id, title, title_en, summary_en, url, url_key AS urlKey, category, kind, score, expires_at, published_at,
            price, is_free, obtain, ai, codes, ai_quality
       FROM items
      WHERE status = 'active'
        AND ai_keep = 1
        AND kind != 'noise'
        AND COALESCE(published_at, first_seen_at) >= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY COALESCE(ai_quality, 0) DESC, score DESC, COALESCE(published_at, first_seen_at) DESC
      LIMIT 600`,
    start.toISOString(),
    now,
  );
  const rules = loadActiveBlockRules();
  const settings = getPushSettings();
  const usable = rows.filter((r) => {
    if (isBlocked(r, rules)) return false;
    if (settings.applyToDigest) {
      let codes: string[] = [];
      try {
        codes = JSON.parse(r.codes ?? "[]") as string[];
      } catch {
        codes = [];
      }
      return passesPushFilters(
        {
          sourceId: r.source_id,
          title: r.title,
          score: r.score,
          codes,
          price: r.price ?? null,
          isFree: r.is_free === 1,
          aiKeep: true,
          kind: r.kind ?? null,
          category: r.category,
          obtain: r.obtain ?? null,
          publishedAt: r.published_at,
        },
        settings,
      );
    }
    return true;
  });
  // When a dozen sources report the same freebie, keep only one so the weekly is not flooded by free-game posts
  return dedupeByTitle(usable, []).slice(0, topN);
}

export function formatWeekly(items: DigestItem[], date = new Date()): string {
  const end = new Date(date);
  const start = new Date(end.getTime() - (WEEK_DAYS - 1) * 86_400_000);
  const range = shortDate(dayKey(start)) + " ~ " + shortDate(dayKey(end));
  const head = "🛰 Resource Radar · Weekly picks (" + range + ")";
  if (!items.length) return head + "\n\nNo new claimable resources this week, see you next week.";

  const hot = buildHotReport(WEEK_DAYS * 24).words.slice(0, 6).map((w) => w.w);
  const byCategory = new Map<string, number>();
  for (const it of items) {
    const key = it.category ? (CATEGORY_LABEL[it.category as keyof typeof CATEGORY_LABEL] ?? it.category) : "Other";
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  const catLine = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => k + " " + n)
    .join(" · ");

  const lines = [head, items.length + " items · only AI-confirmed freebies that have not expired", ""];
  if (hot.length) lines.push("🔥 Hot words this week: " + hot.join(" · "));
  if (catLine) lines.push("📊 Category distribution: " + catLine);
  lines.push("");

  items.forEach((it, i) => {
    const cat = it.category ? (CATEGORY_LABEL[it.category as keyof typeof CATEGORY_LABEL] ?? it.category) : "Other";
    const kindTag = it.kind && it.kind !== "freebie" && it.kind !== "noise" ? KIND_LABEL[it.kind as ContentKind] : null;
    const exp = daysLeft(it.expires_at);
    const meta = [sourceLabel(it.source_id), kindTag, cat, exp].filter(Boolean).join(" · ");
    lines.push(i + 1 + ". " + displayTitle(it).slice(0, 100));
    lines.push("   " + meta);
    lines.push("   " + it.url);
    lines.push("");
  });
  lines.push("Source: Resource Radar multi-source aggregation");
  return lines.join("\n");
}

export type WeeklyResult = { date: string; count: number; text: string; pushed: boolean; skippedReason?: string };

export async function runWeekly(options: { dryRun?: boolean; date?: Date; log?: (m: string) => void } = {}): Promise<WeeklyResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const date = options.date ?? new Date();
  const key = weekKey(date);
  const items = pickWeekly(date);
  await hydrateTranslations(items, { max: 40, timeoutMs: 30_000 });
  const text = formatWeekly(items, date);

  if (options.dryRun) {
    log("[weekly] dry-run " + key + " items=" + items.length);
    log(text);
    return { date: key, count: items.length, text, pushed: false, skippedReason: "dry-run" };
  }

  const save = (pushedAt: string | null) =>
    run(
      `INSERT INTO digests (date, item_ids, payload, created_at, pushed_at, kind) VALUES (?, ?, ?, ?, ?, 'weekly')
       ON CONFLICT(date) DO UPDATE SET item_ids = excluded.item_ids, payload = excluded.payload,
         pushed_at = COALESCE(excluded.pushed_at, digests.pushed_at), kind = 'weekly'`,
      key,
      JSON.stringify(items.map((i) => i.id)),
      JSON.stringify({ text, count: items.length, range: key }),
      new Date().toISOString(),
      pushedAt,
    );

  if (config.pushChannel !== "telegram" || !config.telegramBotToken || !config.telegramChatId) {
    save(null);
    log("[weekly] " + key + " generated " + items.length + " items (push not enabled, stored only)");
    return { date: key, count: items.length, text, pushed: false, skippedReason: "push disabled" };
  }

  await sendTelegram(text);
  save(new Date().toISOString());
  log("[weekly] " + key + " pushed " + items.length + " items to Telegram");
  return { date: key, count: items.length, text, pushed: true };
}
