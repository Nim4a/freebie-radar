import { config } from "./config.ts";
import { all, get, run } from "./db.ts";
import { decryptSecret, encryptSecret, maskBotToken } from "./crypto.ts";
import { detectTelegramChatIds, sendTelegramWith, type DetectedChat } from "./telegram.ts";
import {
  DEFAULT_SETTINGS,
  getPushSettings,
  itemBlock,
  isQuietNow,
  parseAiMeta,
  passesPushFilters,
  planInstant,
  normalizeSettings,
  sourceLabel,
  type PushRoute,
  type PushSettings,
} from "./push.ts";
import { isBlocked, type BlockRule } from "./enrich/blocklist.ts";
import { TitleDeduper, type DedupeEntry } from "./enrich/index.ts";
import { matchesEntryNoise } from "./enrich/ai.ts";
import { hydrateTranslations } from "./enrich/translate.ts";
import { URGENT, hasValueSignal } from "./enrich/noise.ts";
import type { FreshItem } from "./collectors/index.ts";
import { postWebhook as sendWebhook, validateWebhookUrl } from "./webhook.ts";

/* ------------------------------------------------------------------ *
 * Personal push configuration
 * ------------------------------------------------------------------ */

export type UserPushConfig = {
  enabled: boolean;
  hasToken: boolean;
  botTokenMask: string;
  chatId: string;
  settings: PushSettings;
  /** Whether to inherit the site-wide base noise blocklist (on by default; users can turn it off) */
  useGlobalBlocks: boolean;
  dailyEnabled: boolean;
  consecutiveFails: number;
  lastError: string | null;
  lastFlushAt: string | null;
  lastPushedAt: string | null;
};

type ConfigRow = {
  user_id: number;
  enabled: number;
  bot_token_enc: string | null;
  bot_token_mask: string | null;
  chat_id: string;
  settings: string;
  use_global_blocks: number;
  daily_enabled: number;
  consecutive_fails: number;
  last_error: string | null;
  last_flush_at: string | null;
  last_pushed_at: string | null;
  updated_at: string;
};

function parseSettings(raw: string | null): PushSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<PushSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function rowToConfig(row: ConfigRow | undefined): UserPushConfig {
  if (!row) {
    return {
      enabled: false,
      hasToken: false,
      botTokenMask: "",
      chatId: "",
      settings: { ...DEFAULT_SETTINGS },
      useGlobalBlocks: true,
      dailyEnabled: false,
      consecutiveFails: 0,
      lastError: null,
      lastFlushAt: null,
      lastPushedAt: null,
    };
  }
  return {
    enabled: row.enabled === 1,
    hasToken: Boolean(row.bot_token_enc),
    botTokenMask: row.bot_token_mask ?? "",
    chatId: row.chat_id ?? "",
    settings: parseSettings(row.settings),
    useGlobalBlocks: row.use_global_blocks === 1,
    dailyEnabled: row.daily_enabled === 1,
    consecutiveFails: row.consecutive_fails,
    lastError: row.last_error,
    lastFlushAt: row.last_flush_at,
    lastPushedAt: row.last_pushed_at,
  };
}

export function getUserPushConfig(userId: number): UserPushConfig {
  const row = get<ConfigRow>("SELECT * FROM user_push_configs WHERE user_id = ?", userId);
  return rowToConfig(row);
}

/** Decrypt a personal Bot Token; on failure treat it as unconfigured (the key was rotated) instead of throwing at the caller */
export function resolveUserBotToken(userId: number): string | null {
  const row = get<{ bot_token_enc: string | null }>("SELECT bot_token_enc FROM user_push_configs WHERE user_id = ?", userId);
  if (!row?.bot_token_enc) return null;
  try {
    return decryptSecret(row.bot_token_enc);
  } catch {
    console.warn("[user-push] the Bot Token of user", userId, "cannot be decrypted; treating it as unconfigured");
    return null;
  }
}

export type UserPushPatch = Partial<PushSettings> & {
  enabled?: boolean;
  botToken?: string;
  clearToken?: boolean;
  chatId?: string;
  useGlobalBlocks?: boolean;
  dailyEnabled?: boolean;
};

export function saveUserPushConfig(userId: number, patch: UserPushPatch): UserPushConfig {
  const cur = getUserPushConfig(userId);
  const now = new Date().toISOString();
  const nextSettings = normalizeSettings(patch, cur.settings);
  if (nextSettings.webhookUrl) validateWebhookUrl(nextSettings.webhookUrl);
  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(nextSettings.quietHours) ||
      nextSettings.quietHours.split("-").some((part) => Number(part.slice(0, 2)) > 23 || Number(part.slice(3)) > 59)) {
    throw new Error("quiet hours must use the HH:MM-HH:MM format");
  }
  try { new Intl.DateTimeFormat("en", { timeZone: nextSettings.timezone }); } catch { throw new Error("invalid timezone"); }
  // Keep the thresholds in step and clamp the upper bounds, so a user cannot end up with "batch threshold > instant threshold"
  const instantScore = clampNum(nextSettings.instantScore, 0, 100, cur.settings.instantScore);
  const batchScore = Math.min(clampNum(nextSettings.batchScore, 0, 100, cur.settings.batchScore), instantScore);
  nextSettings.instantScore = instantScore;
  nextSettings.batchScore = batchScore;
  nextSettings.maxPerHour = clampNum(nextSettings.maxPerHour, 1, config.userPushMaxPerHour, cur.settings.maxPerHour);
  nextSettings.maxPerInstant = clampNum(nextSettings.maxPerInstant, 1, config.userPushMaxPerInstant, cur.settings.maxPerInstant);
  nextSettings.batchIntervalMin = clampNum(nextSettings.batchIntervalMin, 0, 720, cur.settings.batchIntervalMin);
  nextSettings.maxPerBatch = clampNum(nextSettings.maxPerBatch, 1, 20, cur.settings.maxPerBatch);

  let enc = get<{ bot_token_enc: string | null }>("SELECT bot_token_enc FROM user_push_configs WHERE user_id = ?", userId)?.bot_token_enc ?? null;
  let mask = cur.botTokenMask;
  if (patch.clearToken) {
    enc = null;
    mask = "";
  } else if (typeof patch.botToken === "string" && patch.botToken.trim()) {
    const token = patch.botToken.trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("malformed Bot Token (expected something like 123456789:AAxxxx)");
    enc = encryptSecret(token);
    mask = maskBotToken(token);
  }

  const enabled = typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled;
  const chatId = typeof patch.chatId === "string" ? patch.chatId.trim().slice(0, 64) : cur.chatId;
  const useGlobalBlocks = typeof patch.useGlobalBlocks === "boolean" ? patch.useGlobalBlocks : cur.useGlobalBlocks;
  const dailyEnabled = typeof patch.dailyEnabled === "boolean" ? patch.dailyEnabled : cur.dailyEnabled;
  const ready = nextSettings.deliverVia === "webhook" ? Boolean(nextSettings.webhookUrl) : Boolean(enc) && Boolean(chatId);
  if (enabled && !ready) throw new Error(nextSettings.deliverVia === "webhook" ? "save the Webhook URL before enabling pushes" : "save the Bot Token and Chat ID before enabling pushes");
  nextSettings.enabled = enabled;

  run(
    `INSERT INTO user_push_configs
       (user_id, enabled, bot_token_enc, bot_token_mask, chat_id, settings, use_global_blocks, daily_enabled,
        consecutive_fails, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       bot_token_enc = excluded.bot_token_enc,
       bot_token_mask = excluded.bot_token_mask,
       chat_id = excluded.chat_id,
       settings = excluded.settings,
       use_global_blocks = excluded.use_global_blocks,
       daily_enabled = excluded.daily_enabled,
       consecutive_fails = CASE WHEN excluded.bot_token_enc IS NOT NULL THEN 0 ELSE user_push_configs.consecutive_fails END,
       updated_at = excluded.updated_at`,
    userId,
    enabled && ready ? 1 : 0,
    enc,
    mask,
    chatId,
    JSON.stringify(nextSettings),
    useGlobalBlocks ? 1 : 0,
    dailyEnabled ? 1 : 0,
    now,
  );
  return getUserPushConfig(userId);
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/* ------------------------------------------------------------------ *
 * Personal blocklist / watch words
 * ------------------------------------------------------------------ */

export function loadUserBlockRules(userId: number, includeGlobal: boolean): BlockRule[] {
  const own = all<BlockRule>(
    "SELECT id, pattern, mode, scope, enabled, created_at FROM user_block_rules WHERE user_id = ? AND enabled = 1 ORDER BY id",
    userId,
  ).filter((r) => r.mode !== "regex");
  if (!includeGlobal) return own;
  const global = all<BlockRule>(
    "SELECT id, pattern, mode, scope, enabled, created_at FROM block_rules WHERE enabled = 1 ORDER BY id",
  );
  // A personal rule id can collide with a global rule id, so offset them to keep regex caches and dedup keys apart
  return [...global.map((r) => ({ ...r, id: r.id + 1_000_000 })), ...own];
}

export function loadUserSubscriptions(userId: number): string[] {
  return all<{ keyword: string }>("SELECT keyword FROM user_subscriptions WHERE user_id = ? ORDER BY keyword", userId).map(
    (r) => r.keyword,
  );
}

/* ------------------------------------------------------------------ *
 * Delivery records
 * ------------------------------------------------------------------ */

type DeliveryStatus = "queued" | "sent" | "failed";

function recordDelivery(userId: number, itemId: number, status: DeliveryStatus, titleKey: string | null, reason: string, routeName: string | null): boolean {
  const now = new Date().toISOString();
  const res = run(
    `INSERT INTO user_push_deliveries (user_id, item_id, title_key, status, reason, route_name, queued_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, item_id) DO NOTHING`,
    userId,
    itemId,
    titleKey,
    status,
    reason,
    routeName,
    now,
    status === "sent" ? now : null,
  );
  return Number(res.changes) > 0;
}

function markSent(userId: number, itemIds: readonly number[]): void {
  if (!itemIds.length) return;
  const now = new Date().toISOString();
  const ph = itemIds.map(() => "?").join(",");
  run(
    `UPDATE user_push_deliveries SET status = 'sent', sent_at = ? WHERE user_id = ? AND item_id IN (${ph})`,
    now,
    userId,
    ...itemIds,
  );
  run("UPDATE user_push_configs SET last_pushed_at = ? WHERE user_id = ?", now, userId);
}

function sentLastHour(userId: number): number {
  return (
    get<{ n: number }>(
      `SELECT
         (SELECT COUNT(*) FROM user_push_deliveries WHERE user_id = ? AND status = 'sent' AND sent_at >= ?) +
         COALESCE((SELECT SUM(count) FROM user_push_logs WHERE user_id = ? AND kind = 'daily' AND ok = 1 AND created_at >= ?), 0) AS n`,
      userId,
      new Date(Date.now() - 3_600_000).toISOString(),
      userId,
      new Date(Date.now() - 3_600_000).toISOString(),
    )?.n ?? 0
  );
}

function recentUserSeeds(userId: number, includeQueued = true): DedupeEntry[] {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = all<{ title: string; canonical_id: number | null }>(
    `SELECT i.title AS title, i.canonical_id AS canonical_id
       FROM user_push_deliveries d JOIN items i ON i.id = d.item_id
      WHERE d.user_id = ? AND d.queued_at >= ? ${includeQueued ? "" : "AND d.status = 'sent'"}`,
    userId,
    since,
  );
  return rows.map((r) => ({ title: r.title, canonicalId: r.canonical_id ?? null }));
}

/* ------------------------------------------------------------------ *
 * Enabled users
 * ------------------------------------------------------------------ */

type ActiveUser = { userId: number; settings: PushSettings; chatId: string; token: string; useGlobalBlocks: boolean; via: "telegram" | "webhook" };

function activeUsers(userId?: number): ActiveUser[] {
  const rows = all<ConfigRow>(
    "SELECT c.* FROM user_push_configs c JOIN users u ON u.id = c.user_id WHERE c.enabled = 1 AND u.disabled = 0" + (userId === undefined ? "" : " AND c.user_id = ?"),
    ...(userId === undefined ? [] : [userId]),
  );
  const out: ActiveUser[] = [];
  for (const row of rows) {
    const settings = parseSettings(row.settings);
    const via: "telegram" | "webhook" = settings.deliverVia === "webhook" ? "webhook" : "telegram";
    if (via === "webhook") {
      if (!settings.webhookUrl) continue;
      out.push({ userId: row.user_id, settings, chatId: "", token: "", useGlobalBlocks: row.use_global_blocks === 1, via });
      continue;
    }
    if (!row.bot_token_enc || !row.chat_id) continue;
    const token = resolveUserBotToken(row.user_id);
    if (!token) continue;
    out.push({
      userId: row.user_id,
      settings,
      chatId: row.chat_id,
      token,
      useGlobalBlocks: row.use_global_blocks === 1,
      via,
    });
  }
  return out;
}

/** The collector side uses this to decide "run the push pipeline even when the global Bot is not configured" */
export function hasEnabledUserPush(): boolean {
  return (get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_configs WHERE enabled = 1")?.n ?? 0) > 0;
}

export function enabledUserPushCount(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_configs WHERE enabled = 1")?.n ?? 0;
}

/* ------------------------------------------------------------------ *
 * Per-user decision (same criteria as the global decide, but using personal settings and personal rules)
 * ------------------------------------------------------------------ */

type UserDecision = { push: boolean; reason: string; urgent: boolean; route: PushRoute | null };

function matchUserSubscriptions(item: { title: string; summary?: string | null }, keywords: string[]): string[] {
  if (!keywords.length) return [];
  const text = (item.title + " " + (item.summary ?? "")).toLowerCase();
  return keywords.filter((k) => text.includes(k.toLowerCase()));
}

function matchRoute(item: FreshItem & { sourceId: string }, routes: PushRoute[]): PushRoute | null {
  const enabled = routes.filter((r) => r.enabled);
  if (!enabled.length) return null;
  const hay = (item.title + " " + (item.summary ?? "")).toLowerCase();
  for (const r of enabled) {
    if (r.kinds.length && !r.kinds.includes(item.kind ?? "freebie")) continue;
    if (r.categories.length && !r.categories.includes(item.category ?? "")) continue;
    if (r.obtainModes.length && !r.obtainModes.includes(item.obtain ?? "free")) continue;
    if (r.keywords.length && !r.keywords.some((kw) => hay.includes(kw.toLowerCase()))) continue;
    if (item.score < r.minScore) continue;
    return r;
  }
  return null;
}

function decideForUser(item: FreshItem, s: PushSettings, subHits: string[], route: PushRoute | null): UserDecision {
  if (matchesEntryNoise(item.title)) return { push: false, reason: "", urgent: false, route };
  if (s.aiFallbackMode !== "ignore_ai" && (item.aiKeep === false || item.kind === "noise")) {
    return { push: false, reason: "", urgent: false, route };
  }
  const routeTag = route ? `[${route.name}] ` : "";
  if (route && !route.instant) return { push: false, reason: "", urgent: false, route };
  if (s.prioritizeSubscribed && subHits.length > 0) {
    return { push: true, reason: routeTag + "subscription hit: " + subHits.join("/"), urgent: true, route };
  }
  if (s.instantOnCodes && item.codes.length > 0) return { push: true, reason: routeTag + "has code", urgent: true, route };
  if (s.instantOnUrgent && URGENT.test(item.title) && item.score >= 40) {
    return { push: true, reason: routeTag + "limited/limited-time", urgent: true, route };
  }
  const gate = route ? Math.max(s.instantScore, route.minScore) : s.instantScore;
  if (item.score >= gate) return { push: true, reason: routeTag + "high score " + Math.round(item.score), urgent: false, route };
  return { push: false, reason: "", urgent: false, route };
}

function canBatchForUser(item: FreshItem, s: PushSettings, d: UserDecision): boolean {
  if (matchesEntryNoise(item.title)) return false;
  if (s.aiFallbackMode !== "ignore_ai" && (item.aiKeep === false || item.kind === "noise")) return false;
  const hasSignal = item.aiKeep === true || hasValueSignal(item.title, item.kind);
  if (!hasSignal && !d.push) return false;
  const gate = d.route ? d.route.minScore : s.batchScore;
  return item.score >= gate || d.push;
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/**
 * Generic webhook delivery: POST JSON.
 * This exists instead of "official QQ Bot push" because official QQ bots only allow passive replies (at most 5 per msg_id)
 * and expose no active push channel; pushing to QQ needs a OneBot implementation such as NapCat / Lagrange, which happens to expose an HTTP API,
 * so a webhook is the only workable route (it also covers Bark / Feishu / DingTalk / Slack / self-hosted).
 */
async function postWebhook(settings: PushSettings, text: string): Promise<void> {
  await sendWebhook(settings.webhookUrl, text, settings.webhookSecret);
}
async function sendToUser(user: ActiveUser, text: string): Promise<void> {
  try {
    if (user.via === "webhook") {
      await postWebhook(user.settings, text);
    } else {
      await sendTelegramWith({ botToken: user.token, chatId: user.chatId }, text);
    }
    run("UPDATE user_push_configs SET consecutive_fails = 0, last_error = NULL WHERE user_id = ?", user.userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fails = (get<{ n: number }>("SELECT consecutive_fails AS n FROM user_push_configs WHERE user_id = ?", user.userId)?.n ?? 0) + 1;
    // 3 failures in a row (revoked token / wrong chat_id / blocked) auto-disable it, so the loop does not burn every round
    const disable = fails >= 3;
    run(
      "UPDATE user_push_configs SET consecutive_fails = ?, last_error = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END WHERE user_id = ?",
      fails,
      msg.slice(0, 300),
      disable ? 1 : 0,
      user.userId,
    );
    if (disable) console.warn(`[user-push] user ${user.userId} failed ${fails} sends in a row; personal push has been disabled automatically`);
    throw err;
  }
}

function logUserPush(userId: number, kind: string, itemIds: number[], text: string, ok: boolean, error: string | null, reason: string | null): void {
  run(
    "INSERT INTO user_push_logs (user_id, kind, item_ids, text, count, ok, error, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    userId,
    kind,
    JSON.stringify(itemIds),
    text.slice(0, 4000),
    itemIds.length,
    ok ? 1 : 0,
    error,
    reason,
    new Date().toISOString(),
  );
}

function userPrefix(route: PushRoute | null, s: PushSettings, fallback: string): string {
  if (route?.header) return route.header + " · ";
  if (s.customHeader) return s.customHeader + " · ";
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Dispatch: route new items by each user's rules as they arrive
 * ------------------------------------------------------------------ */

export async function dispatchUserPush(sourceId: string, fresh: FreshItem[]): Promise<number> {
  if (!fresh.length) return 0;
  const users = activeUsers();
  if (!users.length) return 0;

  let totalSent = 0;
  const batchSize = 3;
  for (let i = 0; i < users.length; i += batchSize) {
    const slice = users.slice(i, i + batchSize);
    const results = await Promise.allSettled(slice.map((u) => withDeliveryLock(u.userId, () => dispatchForUser(u, sourceId, fresh))));
    for (const r of results) if (r.status === "fulfilled") totalSent += r.value;
  }
  return totalSent;
}

async function dispatchForUser(user: ActiveUser, sourceId: string, fresh: FreshItem[]): Promise<number> {
  const s = user.settings;
  if (!s.enabled) return 0;
  const rules = loadUserBlockRules(user.userId, user.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(user.userId);
  const hasRoutes = s.routes?.some((r) => r.enabled);
  const hidden = new Set(all<{ item_id: number }>("SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1", user.userId).map((r) => r.item_id));

  const candidates = fresh
    .filter((it) => !hidden.has(it.id))
    .filter((it) => !isBlocked({ ...it, sourceId }, rules))
    .filter((it) => passesPushFilters({ ...it, sourceId }, s));
  if (!candidates.length) return 0;

  const deduper = s.dedupeByTitle ? new TitleDeduper(candidates, recentUserSeeds(user.userId, true)) : null;
  const quiet = isQuietNow(s);

  const instant: { it: FreshItem; reason: string; subHits: string[]; route: PushRoute | null }[] = [];
  const batched: { it: FreshItem; reason: string; subHits: string[]; route: PushRoute | null }[] = [];

  for (const it of candidates) {
    if (deduper?.isDuplicate(it)) continue;
    const subHits = matchUserSubscriptions(it, subKeywords);
    const route = hasRoutes ? matchRoute({ ...it, sourceId }, s.routes) : null;
    if (hasRoutes && !route) continue;
    const d = decideForUser(it, s, subHits, route);
    if (d.push && !quiet) {
      instant.push({ it, reason: d.reason, subHits, route });
      deduper?.markSeen(it);
      continue;
    }
    if (quiet && s.quietAction === "drop") continue;
    if (canBatchForUser(it, s, d)) {
      batched.push({ it, reason: d.reason || (route ? `[${route.name}] ` : "") + "met batch high-score threshold", subHits, route });
      deduper?.markSeen(it);
    }
  }

  // Enqueue: the unique key on deliveries dedups naturally, so one user gets one row per item
  for (const b of batched) {
    if (recordDelivery(user.userId, b.it.id, "queued", null, b.reason, b.route?.name ?? null)) {
      // record only, do not send
    }
  }

  if (!instant.length) return 0;

  const used = sentLastHour(user.userId);
  const plan = planInstant(instant.length, s, used);
  const picked = instant.slice(0, plan.send);
  const overflow = instant.slice(plan.send);
  for (const o of overflow) {
    recordDelivery(user.userId, o.it.id, "queued", null, o.reason, o.route?.name ?? null);
  }

  // Items that just arrived may not be in the English pass yet — render them in English here.
  await hydrateTranslations(picked.map((p) => p.it), { max: 12, timeoutMs: 20_000 });

  let sent = 0;
  for (const { it, reason, subHits, route } of picked) {
    if (!recordDelivery(user.userId, it.id, "queued", null, reason, route?.name ?? null)) continue;
    const text = [userPrefix(route, s, "⚡ New · ") + reason, "", ...itemBlock(sourceId, it, s, undefined, subHits)].join("\n");
    try {
      await sendToUser(user, text);
      markSent(user.userId, [it.id]);
      logUserPush(user.userId, "instant", [it.id], text, true, null, reason);
      sent += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logUserPush(user.userId, "instant", [it.id], text, false, msg, reason);
      break;
    }
  }
  if (sent) console.log(`[user-push] instant push to user ${user.userId}: ${sent} items (source ${sourceLabel(sourceId)})`);
  return sent;
}

/* ------------------------------------------------------------------ *
 * Batch flush
 * ------------------------------------------------------------------ */

export async function flushUserBatches(force = false, userId?: number): Promise<number> {
  const users = activeUsers(userId);
  if (!users.length) return 0;
  let total = 0;
  for (const user of users) {
    try {
      total += await flushUserLocked(user, force);
    } catch (err) {
      console.error("[user-push] flush failed:", err instanceof Error ? err.message : err);
    }
  }
  return total;
}

const deliveries = new Map<number, Promise<void>>();
async function withDeliveryLock<T>(userId: number, operation: () => Promise<T>): Promise<T> {
  const previous = deliveries.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => barrier);
  deliveries.set(userId, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (deliveries.get(userId) === current) deliveries.delete(userId); }
}
async function flushUserLocked(user: ActiveUser, force: boolean): Promise<number> {
  return withDeliveryLock(user.userId, () => flushOneUser(user, force));
}

async function flushOneUser(user: ActiveUser, force: boolean): Promise<number> {
  const s = user.settings;
  if (!s.enabled) return 0;
  if (!force && isQuietNow(s)) return 0;
  if (!force) {
    if (!s.batchIntervalMin) return 0;
    const last = get<{ last_flush_at: string | null }>("SELECT last_flush_at FROM user_push_configs WHERE user_id = ?", user.userId)?.last_flush_at;
    if (last && Date.now() - Date.parse(last) < s.batchIntervalMin * 60_000) return 0;
  }

  const budget = Math.max(0, s.maxPerHour - sentLastHour(user.userId));
  if (!budget) return 0;

  const rows = all<{ id: number; item_id: number; reason: string | null; route_name: string | null }>(
    "SELECT id, item_id, reason, route_name FROM user_push_deliveries WHERE user_id = ? AND status = 'queued' ORDER BY queued_at ASC LIMIT ?",
    user.userId,
    Math.min(s.maxPerBatch, budget),
  );
  if (!rows.length) return 0;

  const ids = rows.map((r) => r.item_id);
  const ph = ids.map(() => "?").join(",");
  const dbRows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    title_en: string | null;
    title_fa: string | null;
    summary_en: string | null;
    summary_fa: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    status: string;
    ai: string | null;
    canonical_id: number | null;
  }>(
    `SELECT id, source_id, title, summary, title_en, summary_en, title_fa, summary_fa, url, category, kind, score, codes, price, is_free, obtain,
            expires_at, published_at, status, ai, canonical_id
       FROM items WHERE id IN (${ph})`,
    ...ids,
  );
  const byId = new Map(dbRows.map((r) => [r.id, r]));
  const hidden = new Set(all<{ item_id: number }>(
    `SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1 AND item_id IN (${ph})`, user.userId, ...ids,
  ).map((r) => r.item_id));

  const rules = loadUserBlockRules(user.userId, user.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(user.userId);
  const hasRoutes = s.routes?.some((r) => r.enabled);

  // Second lookup: anything closed, blocklisted or re-judged by the AI while it waited in the queue is never sent
  const picked: { row: (typeof dbRows)[number]; item: FreshItem; subHits: string[]; route: PushRoute | null; reason: string }[] = [];
  for (const q of rows) {
    const r = byId.get(q.item_id);
    if (!r || r.status !== "active" || hidden.has(r.id)) continue;
    if (isBlocked(r, rules)) continue;
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    const item: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      title_en: r.title_en,
      title_fa: r.title_fa,
      summary_en: r.summary_en,
      summary_fa: r.summary_fa,
      canonicalId: r.canonical_id,
    };
    if (!passesPushFilters({ ...item, sourceId: r.source_id }, s)) continue;
    const subHits = matchUserSubscriptions(item, subKeywords);
    const route = hasRoutes ? matchRoute({ ...item, sourceId: r.source_id }, s.routes) : null;
    if (hasRoutes && !route) continue;
    picked.push({ row: r, item, subHits, route, reason: q.reason ?? "batch summary" });
  }
  const pickedIds = new Set(picked.map((p) => p.item.id));
  for (const q of rows) {
    if (!pickedIds.has(q.item_id)) run("UPDATE user_push_deliveries SET status = 'failed' WHERE id = ?", q.id);
  }
  if (!picked.length) {
    // Everything was filtered out: mark it as failed so it cannot stay stuck in the queue forever
    for (const q of rows) {
      run("UPDATE user_push_deliveries SET status = 'failed' WHERE id = ?", q.id);
    }
    return 0;
  }

  const header = picked[0]!.route?.header ?? s.customHeader ?? "📦 Resource Radar · Batch summary";
  await hydrateTranslations(picked.map((p) => p.item), { max: 12, timeoutMs: 20_000 });

  const lines: string[] = [`${header} (${picked.length} items)`];
  picked.forEach((p, i) => {
    lines.push("");
    lines.push(...itemBlock(p.row.source_id, p.item, s, i + 1, p.subHits));
  });
  const text = lines.join("\n");

  try {
    await sendToUser(user, text);
    markSent(user.userId, picked.map((p) => p.item.id));
    logUserPush(user.userId, "batch", picked.map((p) => p.item.id), text, true, null, null);
    run("UPDATE user_push_configs SET last_flush_at = ? WHERE user_id = ?", new Date().toISOString(), user.userId);
    console.log(`[user-push] batch push to user ${user.userId}: ${picked.length} items`);
    return picked.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUserPush(user.userId, "batch", picked.map((p) => p.item.id), text, false, msg, null);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Personal daily digest
 * ------------------------------------------------------------------ */

export async function pushUserDaily(): Promise<number> {
  const rows = all<ConfigRow>("SELECT c.* FROM user_push_configs c JOIN users u ON u.id = c.user_id WHERE c.enabled = 1 AND c.daily_enabled = 1 AND u.disabled = 0");
  let sent = 0;
  for (const row of rows) {
    const settings = parseSettings(row.settings);
    const via: "telegram" | "webhook" = settings.deliverVia === "webhook" ? "webhook" : "telegram";
    const token = via === "webhook" ? "" : (resolveUserBotToken(row.user_id) ?? "");
    if (via === "webhook" ? !settings.webhookUrl : !token || !row.chat_id) continue;
    const user: ActiveUser = {
      userId: row.user_id,
      settings,
      chatId: row.chat_id,
      token,
      useGlobalBlocks: row.use_global_blocks === 1,
      via,
    };
    try {
      const n = await withDeliveryLock(user.userId, () => sendDailyDigest(user));
      sent += n;
    } catch (err) {
      console.error("[user-push] personal daily digest failed:", err instanceof Error ? err.message : err);
    }
  }
  return sent;
}

async function sendDailyDigest(user: ActiveUser): Promise<number> {
  const s = user.settings;
  const budget = Math.max(0, s.maxPerHour - sentLastHour(user.userId));
  if (!s.enabled || !budget) return 0;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    title_en: string | null;
    title_fa: string | null;
    summary_en: string | null;
    summary_fa: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    ai: string | null;
    canonical_id: number | null;
  }>(
    `SELECT id, source_id, title, summary, title_en, summary_en, title_fa, summary_fa, url, category, kind, score, codes, price, is_free, obtain,
            expires_at, published_at, ai, canonical_id
       FROM items
      WHERE status = 'active' AND COALESCE(published_at, first_seen_at) >= ?
      ORDER BY score DESC LIMIT 120`,
    since,
  );
  const rules = loadUserBlockRules(user.userId, user.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(user.userId);
  const hidden = new Set(all<{ item_id: number }>("SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1", user.userId).map((r) => r.item_id));
  const items: { row: (typeof rows)[number]; item: FreshItem; subHits: string[] }[] = [];
  for (const r of rows) {
    if (hidden.has(r.id)) continue;
    if (isBlocked(r, rules)) continue;
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    const item: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      title_en: r.title_en,
      title_fa: r.title_fa,
      summary_en: r.summary_en,
      summary_fa: r.summary_fa,
      canonicalId: r.canonical_id,
    };
    if (!passesPushFilters({ ...item, sourceId: r.source_id }, s)) continue;
    items.push({ row: r, item, subHits: matchUserSubscriptions(item, subKeywords) });
    if (items.length >= Math.min(12, budget)) break;
  }
  if (!items.length) return 0;
  await hydrateTranslations(items.map((p) => p.item), { max: 12, timeoutMs: 20_000 });
  const lines = [`📰 Resource Radar · Personal digest (${new Date().toISOString().slice(0, 10)}, ${items.length} items)`];
  items.forEach((p, i) => {
    lines.push("");
    lines.push(...itemBlock(p.row.source_id, p.item, s, i + 1, p.subHits));
  });
  const text = lines.join("\n");
  try {
    await sendToUser(user, text);
    logUserPush(user.userId, "daily", items.map((p) => p.item.id), text, true, null, null);
    return 1;
  } catch (err) {
    logUserPush(user.userId, "daily", items.map((p) => p.item.id), text, false, err instanceof Error ? err.message : String(err), null);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Scheduling and queries
 * ------------------------------------------------------------------ */

let userFlushTimer: NodeJS.Timeout | null = null;
let userSchedulerStarted = false;

export function startUserPushScheduler(): void {
  userSchedulerStarted = true;
  scheduleUserFlush();
}

function scheduleUserFlush(): void {
  if (userFlushTimer) return;
  // Per-user batch intervals differ, so poll on a 1-minute tick and decide per user by their own batchIntervalMin
  userFlushTimer = setInterval(() => {
    void tickUserFlush();
  }, 60_000);
  userFlushTimer.unref?.();
}

let lastUserFlushAt = 0;

async function tickUserFlush(): Promise<void> {
  if (!userSchedulerStarted) return;
  // Only really run a round every 5 minutes at the very least, so the 1-minute tick does not saturate the egress
  if (Date.now() - lastUserFlushAt < 5 * 60_000) return;
  lastUserFlushAt = Date.now();
  try {
    await flushUserBatches(false);
  } catch (err) {
    console.error("[user-push] scheduled flush failed:", err instanceof Error ? err.message : err);
  }
}

export function userPushStats(userId: number): {
  queued: number;
  sentLast24h: number;
  sentLastHour: number;
  totalSent: number;
  failures: number;
  lastError: string | null;
  // Aligned with the global /api/push stats fields, so the same push panel can be reused as is
  pushedLastHour: number;
  pushedLast24h: number;
  totalPushed: number;
  lastHourLogs: number;
} {
  const cfg = getUserPushConfig(userId);
  const queued =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_deliveries WHERE user_id = ? AND status = 'queued'", userId)?.n ?? 0;
  const sent24 =
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM user_push_deliveries WHERE user_id = ? AND status = 'sent' AND sent_at >= ?",
      userId,
      new Date(Date.now() - 86_400_000).toISOString(),
    )?.n ?? 0;
  const daily24 = get<{ n: number }>("SELECT COALESCE(SUM(count),0) AS n FROM user_push_logs WHERE user_id = ? AND kind = 'daily' AND ok = 1 AND created_at >= ?", userId, new Date(Date.now() - 86_400_000).toISOString())?.n ?? 0;
  const sentHour = sentLastHour(userId);
  const total =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_deliveries WHERE user_id = ? AND status = 'sent'", userId)?.n ?? 0;
  const dailyTotal = get<{ n: number }>("SELECT COALESCE(SUM(count),0) AS n FROM user_push_logs WHERE user_id = ? AND kind = 'daily' AND ok = 1", userId)?.n ?? 0;
  return {
    queued,
    sentLast24h: sent24 + daily24,
    sentLastHour: sentHour,
    totalSent: total + dailyTotal,
    failures:
      get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_logs WHERE user_id = ? AND ok = 0", userId)?.n ?? 0,
    lastError: cfg.lastError,
    pushedLastHour: sentHour,
    pushedLast24h: sent24 + daily24,
    totalPushed: total + dailyTotal,
    lastHourLogs:
      get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_logs WHERE user_id = ? AND created_at >= ?", userId, new Date(Date.now() - 3_600_000).toISOString())?.n ?? 0,
  };
}

export function userPushLogs(userId: number, limit = 30): Array<{
  id: number;
  kind: string;
  item_ids: string;
  text: string;
  count: number;
  ok: number;
  error: string | null;
  reason: string | null;
  created_at: string;
}> {
  return all(
    "SELECT id, kind, item_ids, text, count, ok, error, reason, created_at FROM user_push_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    userId,
    Math.min(Math.max(limit, 1), 100),
  );
}

/** Dry run: scan the most recent 180 items with the personal rules and return the distribution of push/block reasons */
export function previewUserPush(userId: number, limit = 6): {
  instant: string[];
  batch: string[];
  scanned: number;
  matched: number;
  rejectedBy: Record<string, number>;
  queued: number;
  instantTotal: number;
  sendableInstant: number;
  batchTotal: number;
  deferred: number;
  usedThisHour: number;
  caps: { maxPerInstant: number; maxPerHour: number; maxPerBatch: number; batchIntervalMin: number; budget: number };
} {
  const cfg = getUserPushConfig(userId);
  const s = cfg.settings;
  const rules = loadUserBlockRules(userId, cfg.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(userId);
  const rows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    title_en: string | null;
    title_fa: string | null;
    summary_en: string | null;
    summary_fa: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    ai: string | null;
    canonical_id: number | null;
  }>(
    `SELECT id, source_id, title, summary, title_en, summary_en, title_fa, summary_fa, url, category, kind, score, codes, price, is_free, obtain,
            expires_at, published_at, ai, canonical_id
       FROM items WHERE status = 'active' AND NOT EXISTS (
         SELECT 1 FROM user_push_deliveries d WHERE d.user_id = ? AND d.item_id = items.id AND d.status = 'sent'
       ) ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT 180`,
    userId,
  );
  const rejectedBy: Record<string, number> = {};
  const instant: string[] = [];
  const batch: string[] = [];
  let matched = 0;
  const hasRoutes = s.routes?.some((r) => r.enabled);
  const hidden = new Set(all<{ item_id: number }>("SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1", userId).map((r) => r.item_id));
  const deduper = s.dedupeByTitle
    ? new TitleDeduper(
        rows.map((r) => ({ title: r.title, canonicalId: r.canonical_id ?? null })),
        recentUserSeeds(userId, true),
      )
    : null;

  for (const r of rows) {
    if (hidden.has(r.id)) { rejectedBy.hidden = (rejectedBy.hidden ?? 0) + 1; continue; }
    if (isBlocked(r, rules)) {
      rejectedBy.blocked = (rejectedBy.blocked ?? 0) + 1;
      continue;
    }
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    const item: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      title_en: r.title_en,
      title_fa: r.title_fa,
      summary_en: r.summary_en,
      summary_fa: r.summary_fa,
      canonicalId: r.canonical_id,
    };
    const reason = checkReason({ ...item, sourceId: r.source_id }, s);
    if (reason) {
      rejectedBy[reason] = (rejectedBy[reason] ?? 0) + 1;
      continue;
    }
    if (deduper?.isDuplicate({ title: item.title, canonicalId: item.canonicalId ?? null })) {
      rejectedBy.duplicate = (rejectedBy.duplicate ?? 0) + 1;
      continue;
    }
    deduper?.markSeen({ title: item.title, canonicalId: item.canonicalId ?? null });
    matched += 1;
    const subHits = matchUserSubscriptions(item, subKeywords);
    const route = hasRoutes ? matchRoute({ ...item, sourceId: r.source_id }, s.routes) : null;
    if (hasRoutes && !route) { rejectedBy.route = (rejectedBy.route ?? 0) + 1; continue; }
    const d = decideForUser(item, s, subHits, route);
    const line = `[${sourceLabel(r.source_id)}] ${r.title.slice(0, 60)} · ${Math.round(r.score)} pts`;
    if (d.push) instant.push(line);
    else if (canBatchForUser(item, s, d)) batch.push(line);
  }
  const used = sentLastHour(userId);
  const plan = planInstant(instant.length, s, used);
  const quiet = isQuietNow(s);
  const sendable = quiet ? 0 : plan.send;
  const overflow = instant.slice(sendable);
  const batched = s.batchIntervalMin > 0 && !(quiet && s.quietAction === "drop") ? [...batch, ...overflow] : [];
  return {
    instant: instant.slice(0, sendable).slice(0, limit),
    batch: batched.slice(0, limit),
    scanned: rows.length,
    matched,
    rejectedBy,
    queued: userPushStats(userId).queued,
    instantTotal: instant.length,
    sendableInstant: sendable,
    batchTotal: batched.length,
    deferred: overflow.length,
    usedThisHour: used,
    caps: { maxPerInstant: s.maxPerInstant, maxPerHour: s.maxPerHour, maxPerBatch: s.maxPerBatch, batchIntervalMin: s.batchIntervalMin, budget: Math.max(0, s.maxPerHour - used) },
  };
}

function checkReason(item: FreshItem & { sourceId: string }, s: PushSettings): string | null {
  if (!passesPushFilters(item, s)) {
    // Reuse the global decision and then bucket it roughly into "why"; that is enough for the frontend
    if (!s.enabled) return "disabled";
    return "filtered";
  }
  return null;
}

export type { DetectedChat };
export { detectTelegramChatIds };

/** Send one arbitrary text to a user (used by test messages); throws when credentials are missing */
export async function sendTelegramToUser(userId: number, text: string): Promise<void> {
  const settings = getUserPushConfig(userId).settings;
  if (settings.deliverVia === "webhook") {
    if (!settings.webhookUrl) throw new Error("save the webhook URL first");
    await postWebhook(settings, text);
    return;
  }
  const token = resolveUserBotToken(userId);
  const chatId = get<{ chat_id: string }>("SELECT chat_id FROM user_push_configs WHERE user_id = ?", userId)?.chat_id ?? "";
  if (!token || !chatId) throw new Error("save the Bot Token and Chat ID first");
  await sendTelegramWith({ botToken: token, chatId }, text);
}

/**
 * Called after the background AI review passes: load the items by id and run personal dispatch again.
 * Complements the global pushReviewedByIds: that one returns 0 when no global Bot is configured, and personal push must not go silent with it.
 */
export async function dispatchUserPushByIds(sourceId: string, itemIds: readonly number[]): Promise<number> {
  if (!itemIds.length) return 0;
  if (!hasEnabledUserPush()) return 0;
  const ph = itemIds.map(() => "?").join(",");
  const rows = all<{
    id: number;
    title: string;
    summary: string | null;
    title_en: string | null;
    title_fa: string | null;
    summary_en: string | null;
    summary_fa: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    ai: string | null;
    canonical_id: number | null;
  }>(
    "SELECT id, title, summary, title_en, summary_en, title_fa, summary_fa, url, category, kind, score, codes, price, is_free, obtain, expires_at, published_at, ai, canonical_id " +
      "FROM items WHERE id IN (" + ph + ") AND status = 'active'",
    ...itemIds,
  );
  const fresh: FreshItem[] = rows.map((r) => {
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      title_en: r.title_en,
      title_fa: r.title_fa,
      summary_en: r.summary_en,
      summary_fa: r.summary_fa,
      canonicalId: r.canonical_id,
    };
  });
  return dispatchUserPush(sourceId, fresh);
}
