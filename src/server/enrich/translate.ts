/**
 * English rendering of scraped Chinese titles and summaries.
 *
 * The scraped `items.title` / `items.summary` columns are never overwritten: every matcher in the app
 * (noise filter, block rules, push keyword filters, subscription matching, dedupe) keeps reading the
 * original Chinese text. Translation writes to `items.title_en` / `items.summary_en` instead, and only
 * the display surfaces (web list/card, RSS, Telegram digest, Telegram push) prefer the `_en` column
 * when it exists.
 *
 * The pass is incremental: `translated_at` marks a row as handled, a partial index keeps the
 * "untranslated" lookup cheap, and rows are processed newest-first so the feed turns English fast.
 */
import { config } from "../config.ts";
import { all, get, run } from "../db.ts";
import { getAiSettings } from "./ai-settings.ts";

/** Any CJK ideograph / kana — a row without one is already readable and is skipped. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/** Model used when neither TRANSLATE_MODEL nor the AI settings name one. */
const DEFAULT_TRANSLATE_MODEL = "groq/openai/gpt-oss-120b";

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 600;
const REQUEST_TIMEOUT_MS = 60_000;
const PAUSE_BETWEEN_BATCHES_MS = 1_200;

export type TranslateStats = {
  /** false when no endpoint/model is configured — nothing was attempted */
  configured: boolean;
  model: string;
  scanned: number;
  translated: number;
  /** rows whose text had no CJK, or which had nothing to translate */
  skipped: number;
  failed: number;
  /** items still waiting for a translation after this pass */
  pending: number;
  errors: string[];
};

type PendingRow = { id: number; title: string; summary: string | null };

type TranslateTarget = { url: string; apiKey: string; model: string };

let inFlight = false;
let lastRunAt: string | null = null;
let lastStats: TranslateStats | null = null;

export function isTranslating(): boolean {
  return inFlight;
}

function withV1(base: string): string {
  const b = base.trim().replace(/\/+$/, "");
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

/** Endpoint resolution order: TRANSLATE_* env → the app's own AI settings → AI_* env defaults. */
export function translateTarget(): TranslateTarget | null {
  const s = getAiSettings();
  const base = config.translateBaseUrl || s.baseUrl || config.aiBaseUrl;
  const model = config.translateModel || s.model || config.aiModel || DEFAULT_TRANSLATE_MODEL;
  const apiKey = config.translateApiKey || s.apiKey || config.aiApiKey || "";
  if (!base || !model) return null;
  return { url: `${withV1(base)}/chat/completions`, apiKey, model };
}

export function translateModelName(): string {
  return translateTarget()?.model ?? DEFAULT_TRANSLATE_MODEL;
}

export function translationStatus(): {
  configured: boolean;
  model: string;
  inFlight: boolean;
  lastRunAt: string | null;
  lastStats: TranslateStats | null;
  pending: number;
  done: number;
  total: number;
} {
  const t = translateTarget();
  const counts = get<{ pending: number; done: number; total: number }>(
    `SELECT
       SUM(CASE WHEN translated_at IS NULL THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN translated_at IS NOT NULL THEN 1 ELSE 0 END) AS done,
       COUNT(*) AS total
     FROM items`,
  );
  return {
    configured: Boolean(t),
    model: t?.model ?? DEFAULT_TRANSLATE_MODEL,
    inFlight,
    lastRunAt,
    lastStats,
    pending: counts?.pending ?? 0,
    done: counts?.done ?? 0,
    total: counts?.total ?? 0,
  };
}

const SYSTEM_PROMPT =
  "You translate Chinese listings from a freebies/deals aggregator into natural English. " +
  "Rules: headline style, concise, no surrounding quotes, no commentary; keep brand names, product " +
  "names, version numbers and URLs as they are; keep the meaning of the original, never invent offers. " +
  "Titles stay under 70 characters. Summaries become one or two plain English sentences. " +
  'Answer with ONLY a JSON array, no markdown fence and no prose: [{"i":0,"t":"english title","s":"english summary"}]. ' +
  'Omit "s" when the input had no summary.';

function buildUserPrompt(rows: PendingRow[]): string {
  const payload = rows.map((r, i) => ({
    i,
    title: r.title,
    ...(r.summary && r.summary.trim() ? { summary: r.summary.trim().slice(0, 600) } : {}),
  }));
  return `Translate these ${payload.length} entries:\n${JSON.stringify(payload, null, 0)}`;
}

/** Tolerant JSON-array parse: accepts a bare array, a ```json fence, or prose around the array. */
function parseTranslationArray(text: string): Array<{ i: number; t: string; s?: string }> | null {
  let s = (text ?? "").trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("[");
  const last = s.lastIndexOf("]");
  if (first === -1 || last <= first) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Array<{ i: number; t: string; s?: string }> = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const i = typeof o.i === "number" ? o.i : typeof o.i === "string" ? Number(o.i) : NaN;
    const t = typeof o.t === "string" ? o.t.trim() : "";
    if (!Number.isFinite(i) || !t) continue;
    const s = typeof o.s === "string" ? o.s.trim() : "";
    out.push({ i, t, ...(s ? { s } : {}) });
  }
  return out.length ? out : null;
}

/** True when the model handed back something usable, i.e. non-empty English without leftover CJK. */
function usableTranslation(text: string, max: number): boolean {
  const t = text.trim();
  if (!t) return false;
  if (CJK.test(t)) return false;
  return t.length <= max;
}

type ChatReply = { ok: true; text: string } | { ok: false; error: string; retryable: boolean };

async function chat(target: TranslateTarget, rows: PendingRow[], timeoutMs = REQUEST_TIMEOUT_MS): Promise<ChatReply> {
  const body = JSON.stringify({
    model: target.model,
    stream: false,
    temperature: 0.2,
    max_tokens: 2500,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(rows) },
    ],
  });
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
        // Cloudflare fronts some gateways and answers 403 (error 1010) to bare fetch/undici agents.
        "user-agent": "curl/8.4.0",
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `HTTP ${res.status} ${text.slice(0, 180)}`,
        retryable: res.status === 429 || res.status >= 500,
      };
    }
    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return { ok: false, error: `non-JSON reply: ${text.slice(0, 180)}`, retryable: false };
    }
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content) return { ok: false, error: "empty completion", retryable: true };
    return { ok: true, text: content };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, error: msg, retryable: true };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Translate up to `limit` untranslated rows, newest first.
 * Never throws for upstream problems — they land in `errors` and the pass ends cleanly.
 */
export async function translatePending(limit?: number): Promise<TranslateStats> {
  const max = Math.max(1, Math.min(200, limit ?? config.translateBatch));
  const target = translateTarget();
  const stats: TranslateStats = {
    configured: Boolean(target),
    model: target?.model ?? DEFAULT_TRANSLATE_MODEL,
    scanned: 0,
    translated: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    errors: [],
  };
  const pendingCount = () =>
    get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE translated_at IS NULL")?.n ?? 0;

  if (!target) {
    stats.errors.push("no translation endpoint configured (TRANSLATE_BASE_URL or AI_BASE_URL)");
    stats.pending = pendingCount();
    lastStats = stats;
    lastRunAt = new Date().toISOString();
    return stats;
  }

  const rows = all<PendingRow>(
    `SELECT id, title, summary FROM items
      WHERE translated_at IS NULL
      ORDER BY (status = 'active') DESC, COALESCE(published_at, first_seen_at) DESC
      LIMIT ?`,
    max,
  );
  stats.scanned = rows.length;

  const now = new Date().toISOString();
  const needModel: PendingRow[] = [];
  for (const r of rows) {
    const title = (r.title ?? "").trim();
    const summary = (r.summary ?? "").trim();
    if (!CJK.test(title) && !CJK.test(summary)) {
      // Already English (or pure numbers/symbols) — nothing for the model to do.
      run("UPDATE items SET translated_at = ? WHERE id = ?", now, r.id);
      stats.skipped += 1;
      continue;
    }
    needModel.push({ id: r.id, title, summary: summary || null });
  }

  const batchSize = Math.max(2, Math.min(20, config.translateBatchSize));
  for (let i = 0; i < needModel.length; i += batchSize) {
    const chunk = needModel.slice(i, i + batchSize);
    let reply: ChatReply = { ok: false, error: "not attempted", retryable: false };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      reply = await chat(target, chunk);
      if (reply.ok) break;
      if (!reply.retryable || attempt === 2) break;
      await sleep(2_000 * (attempt + 1));
    }

    if (!reply.ok) {
      stats.failed += chunk.length;
      if (stats.errors.length < 5) stats.errors.push(reply.error);
      continue;
    }

    const parsed = parseTranslationArray(reply.text);
    if (!parsed) {
      stats.failed += chunk.length;
      if (stats.errors.length < 5) stats.errors.push(`unparsable reply: ${reply.text.slice(0, 160)}`);
      continue;
    }

    const byIndex = new Map(parsed.map((p) => [p.i, p]));
    const stamp = new Date().toISOString();
    for (let k = 0; k < chunk.length; k += 1) {
      const row = chunk[k];
      const hit = byIndex.get(k);
      if (!hit || !usableTranslation(hit.t, MAX_TITLE_CHARS)) {
        stats.failed += 1;
        continue;
      }
      const summaryEn =
        hit.s && usableTranslation(hit.s, MAX_SUMMARY_CHARS) ? hit.s.trim() : null;
      run(
        "UPDATE items SET title_en = ?, summary_en = COALESCE(?, summary_en), translated_at = ? WHERE id = ?",
        hit.t.trim(),
        summaryEn,
        stamp,
        row.id,
      );
      stats.translated += 1;
    }

    if (i + batchSize < needModel.length) await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  stats.pending = pendingCount();
  lastStats = stats;
  lastRunAt = new Date().toISOString();
  return stats;
}

/** One scheduler tick: no-op when disabled or when the previous pass is still running. */
export async function translateTick(): Promise<TranslateStats | null> {
  if (!config.translateEnabled) return null;
  if (inFlight) return null;
  inFlight = true;
  try {
    return await translatePending();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[translate] pass failed:", msg);
    return null;
  } finally {
    inFlight = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Kick the pass straight away, then every TRANSLATE_INTERVAL_MIN minutes. */
export function startTranslateScheduler(): void {
  if (!config.translateEnabled || timer) return;
  const minutes = Math.max(1, config.translateIntervalMin);
  const tick = () => {
    void translateTick().then((s) => {
      if (s && (s.translated || s.failed)) {
        console.log(
          `[translate] +${s.translated} translated, ${s.failed} failed, ${s.pending} pending (${s.model})`,
        );
      }
    });
  };
  setTimeout(tick, 20_000);
  timer = setInterval(tick, minutes * 60_000);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[translate] scheduler on: every ${minutes}m, batch ${config.translateBatch}, model ${translateModelName()}`);
}

/* ------------------------------------------------------------------ *
 * Fast path for anything that renders right now
 *
 * The scheduled pass drains the backlog every few minutes; but a Telegram
 * push, the daily digest and the web list can be asked for an item that was
 * collected seconds ago and has no title_en yet. hydrateTranslations() closes
 * that gap with a single bounded model call, so a fresh item still goes out in
 * English. Everything here degrades to the original Chinese text on failure —
 * never throws, never blocks a send for longer than `timeoutMs`.
 * ------------------------------------------------------------------ */

export type TranslatableItem = {
  id?: number;
  title: string;
  summary?: string | null;
  title_en?: string | null;
  summary_en?: string | null;
};

export type DisplayText = { title: string; summary: string | null };

const CACHE_MAX = 5_000;
const displayCache = new Map<number, DisplayText>();

function remember(id: number, titleEn: string | null | undefined, summaryEn: string | null | undefined): void {
  const title = (titleEn ?? "").trim();
  if (!title) return;
  if (displayCache.size >= CACHE_MAX) {
    const oldest = displayCache.keys().next().value;
    if (oldest !== undefined) displayCache.delete(oldest);
  }
  displayCache.set(id, { title, summary: (summaryEn ?? "").trim() || null });
}

/** Warm the cache from rows that already carry their English rendering. */
export function seedTranslations(rows: TranslatableItem[]): void {
  for (const r of rows) {
    if (typeof r.id === "number" && r.id > 0) remember(r.id, r.title_en, r.summary_en);
  }
}

/** English title when we have one, the original otherwise. */
export function displayTitle(it: TranslatableItem): string {
  if (typeof it.id === "number") {
    const hit = displayCache.get(it.id);
    if (hit) return hit.title;
  }
  return (it.title_en ?? "").trim() || it.title;
}

/** English summary when we have one, the original otherwise (null when empty). */
export function displaySummary(it: TranslatableItem): string | null {
  if (typeof it.id === "number") {
    const hit = displayCache.get(it.id);
    if (hit) return hit.summary;
  }
  const en = (it.summary_en ?? "").trim();
  if (en) return en;
  const zh = (it.summary ?? "").trim();
  return zh || null;
}

/**
 * Best-effort: give every item passed in an English title before it is rendered.
 * - rows already translated in the DB only cost one indexed read
 * - at most `max` new rows are sent to the model per call
 */
export async function hydrateTranslations(
  items: TranslatableItem[],
  opts: { max?: number; timeoutMs?: number } = {},
): Promise<void> {
  const max = Math.max(0, Math.min(40, opts.max ?? 12));
  const ids = [
    ...new Set(
      items.map((i) => i.id).filter((n): n is number => typeof n === "number" && n > 0),
    ),
  ];
  if (!ids.length) return;

  const unknown = ids.filter((id) => !displayCache.has(id));
  if (unknown.length) {
    try {
      const placeholders = unknown.map(() => "?").join(",");
      const rows = all<{ id: number; title_en: string | null; summary_en: string | null }>(
        `SELECT id, title_en, summary_en FROM items WHERE id IN (${placeholders})`,
        ...unknown,
      );
      for (const r of rows) remember(r.id, r.title_en, r.summary_en);
    } catch (err) {
      console.error("[translate] hydrate lookup failed:", err instanceof Error ? err.message : err);
    }
  }

  const target = translateTarget();
  if (!target || max === 0) return;

  const seen = new Set<number>();
  const need: PendingRow[] = [];
  for (const it of items) {
    if (typeof it.id !== "number" || it.id <= 0 || seen.has(it.id)) continue;
    seen.add(it.id);
    if (displayCache.has(it.id)) continue;
    const title = (it.title ?? "").trim();
    const summary = (it.summary ?? "").trim();
    if (!CJK.test(title) && !CJK.test(summary)) {
      // Nothing to translate — cache the original so later calls skip the lookup.
      displayCache.set(it.id, { title, summary: summary || null });
      continue;
    }
    need.push({ id: it.id, title, summary: summary || null });
    if (need.length >= max) break;
  }
  if (!need.length) return;

  let reply: ChatReply | null = null;
  try {
    reply = await chat(target, need, opts.timeoutMs ?? 25_000);
  } catch (err) {
    console.error("[translate] hydrate call failed:", err instanceof Error ? err.message : err);
    return;
  }
  if (!reply.ok) {
    console.error("[translate] hydrate reply rejected:", reply.error);
    return;
  }

  const parsed = parseTranslationArray(reply.text);
  if (!parsed) {
    console.error("[translate] hydrate reply unparsable:", reply.text.slice(0, 160));
    return;
  }
  const byIndex = new Map(parsed.map((p) => [p.i, p]));
  const stamp = new Date().toISOString();
  for (let k = 0; k < need.length; k += 1) {
    const row = need[k];
    const hit = byIndex.get(k);
    if (!hit || !usableTranslation(hit.t, MAX_TITLE_CHARS)) continue;
    const summaryEn = hit.s && usableTranslation(hit.s, MAX_SUMMARY_CHARS) ? hit.s.trim() : null;
    try {
      run(
        "UPDATE items SET title_en = ?, summary_en = COALESCE(?, summary_en), translated_at = ? WHERE id = ?",
        hit.t.trim(),
        summaryEn,
        stamp,
        row.id,
      );
    } catch (err) {
      console.error("[translate] hydrate write failed:", err instanceof Error ? err.message : err);
    }
    remember(row.id, hit.t, summaryEn);
  }
}
