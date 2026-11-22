import { config, pushEnabled } from "./config.ts";
import { all, get, run } from "./db.ts";
import { matchesEntryNoise, shouldReview } from "./enrich/ai.ts";
import { mergeKey, TitleDeduper, type DedupeEntry } from "./enrich/index.ts";
import { hasValueSignal, URGENT } from "./enrich/noise.ts";
import { filterPushDuplicatesWithAi, type DedupCandidate } from "./enrich/ai-dedup.ts";
import { getAiSettings } from "./enrich/ai-settings.ts";
import { displayTitle, hydrateTranslations } from "./enrich/translate.ts";
import { KIND_LABEL, type ContentKind } from "./enrich/kind.ts";
import { OBTAIN_LABEL } from "./enrich/obtain.ts";
import { isBlocked, loadActiveBlockRules } from "./enrich/blocklist.ts";
import { passesInterest } from "./enrich/interest.ts";
import { packItemMessages } from "./tg-pack.ts";
import { sendTelegram } from "./telegram.ts";
import type { FreshItem } from "./collectors/index.ts";
import { CATEGORY_SET, KIND_ORDER, OBTAIN_SET } from "../shared/taxonomy.ts";

/* ------------------------------------------------------------------ *
 * Push settings (stored in the settings table, editable from the web UI, no restart needed)
 * ------------------------------------------------------------------ */

export type PushTiming = "wait_ai" | "instant_first";
export type AiFallbackMode = "strict" | "rule_fallback" | "ignore_ai";
export type PushSourceMode = "all" | "include" | "exclude";
export type QuietAction = "batch" | "drop";

export type PushRoute = {
  id: string;
  name: string;
  enabled: boolean;
  /** Allowed content kinds: freebie / deal / opensource / info; an empty array means unrestricted (noise is excluded automatically) */
  kinds: string[];
  /** Allowed categories; an empty array means unrestricted */
  categories: string[];
  /** Allowed acquisition methods; an empty array means unrestricted */
  obtainModes: string[];
  /** Topic keywords (any single hit is enough); an empty array means unrestricted */
  keywords: string[];
  /** Maximum price: null = unlimited / 0 = free only */
  maxPrice: number | null;
  /** Minimum score requirement (0-100) */
  minScore: number;
  /** true = push instantly once the high-score/urgent conditions hold; false = only collect into a batch */
  instant: boolean;
  /** Optional custom message header prefix (overrides the global customHeader) */
  header?: string;
};
export type PushSettings = {
  /** Master switch; when off, neither instant nor batch push is sent, but the daily digest can still be triggered separately */
  enabled: boolean;
  /** Push timing: wait_ai = run AI review before pushing (avoids false pushes); instant_first = push code drops immediately and backfill the review in the background */
  pushTiming: PushTiming;
  /** With wait_ai, how many items may wait synchronously for AI review before each push round (5-60); the rest go to a background queue and are pushed automatically once reviewed */
  syncPrePushLimit: number;
  /** When a background AI re-review (beyond the sync cap, or instant_first backfill) judges the item a real freebie, add it back into the push pipeline automatically */
  pushAfterBackfill: boolean;
  /** Handling when AI has no verdict or rejects: strict = AI must confirm; rule_fallback = let it through on strong signals when unreviewed; ignore_ai = ignore AI, rules only */
  aiFallbackMode: AiFallbackMode;
  /** Legacy field: equivalent to aiFallbackMode !== "ignore_ai" */
  onlyAiKeep: boolean;
  /** Score threshold for an instant push */
  instantScore: number;
  /** Score threshold for entering the batch queue */
  batchScore: number;
  /** Whether an item containing a redemption code is pushed immediately */
  instantOnCodes: boolean;
  /** Whether titles containing words like "limited / first come, first served" are pushed immediately */
  instantOnUrgent: boolean;
  /** Maximum pushes per hour (individual items inside a batch count too) */
  maxPerHour: number;
  /** Maximum number of items per instant push */
  maxPerInstant: number;
  /** Batch interval (minutes); 0 disables batching */
  batchIntervalMin: number;
  /** Maximum number of items merged into one batch */
  maxPerBatch: number;
  /** Whether quiet hours are enabled */
  quietEnabled: boolean;
  /** Quiet window, e.g. "23:30-08:00" */
  quietHours: string;
  /** Delivery channel: telegram uses the personal Bot, webhook uses a custom HTTP endpoint (QQ bridges / Bark / Feishu / Slack all work) */
  deliverVia: "telegram" | "webhook";
  /** Webhook URL, POSTed as JSON; leave empty to skip delivery */
  webhookUrl: string;
  /** Optional: send an X-Radar-Secret header so the receiver can verify the origin */
  webhookSecret: string;
  /** Quiet-hours behavior: batch = move into batching and send in the morning; drop = neither send nor batch during the quiet window */
  quietAction: QuietAction;
  /** Timezone used to evaluate quiet hours */
  timezone: string;
  /** Maximum age of a post in hours; 0 means unlimited, default 72 hours */
  maxAgeHours: number;
  /** Language preference: all / zh = Chinese only / en = English only */
  langMode: "all" | "zh" | "en";
  /** Source filter mode: all / include = only the listed sources / exclude = exclude the listed sources */
  sourceMode: PushSourceMode;
  /** List of source IDs used together with sourceMode */
  sourceIds: string[];
  /** Whether the push shows the price */
  includePrice: boolean;
  /** Whether the push shows the deadline */
  includeDeadline: boolean;
  /** Whether the push shows the overall score */
  includeScore: boolean;
  /** Whether the push shows the acquisition tag (e.g. conditional / lottery) */
  includeObtain: boolean;
  /** Whether the push includes the AI recommendation reason */
  includeAiReason: boolean;
  /** Custom header prefix for instant/batch messages (empty = default) */
  customHeader: string;
  /** Whether to deduplicate by title (the same game covered by several sources is pushed only once) */
  dedupeByTitle: boolean;
  /** Maximum price: null = unlimited / 0 = completely free only / positive = cap in CNY */
  maxPrice: number | null;
  /** Allowed acquisition methods; an empty array means unrestricted. Defaults to free only */
  obtainModes: string[];
  /** Allowed content kinds (freebie / deal / opensource / info); an empty array means unrestricted (noise excluded) */
  kinds: string[];
  /** Multi-channel push routing: when non-empty with enabled routes, items are split by each route's own conditions */
  routes: PushRoute[];
  /** Whitelist of pushable categories; an empty array means all are allowed */
  categories: string[];
  /** Items matching a "My subscriptions" keyword prefer instant push */
  prioritizeSubscribed: boolean;
  /** Apply the price / category / language / source / AI filters to the daily picks too */
  applyToDigest: boolean;
};

export const DEFAULT_SETTINGS: PushSettings = {
  enabled: true,
  pushTiming: "wait_ai",
  syncPrePushLimit: 20,
  pushAfterBackfill: true,
  aiFallbackMode: "rule_fallback",
  onlyAiKeep: true,
  instantScore: 70,
  batchScore: 60,
  instantOnCodes: true,
  instantOnUrgent: true,
  maxPerHour: 24,
  maxPerInstant: 5,
  batchIntervalMin: 30,
  maxPerBatch: 8,
  quietEnabled: true,
  quietHours: "23:30-08:00",
  deliverVia: "telegram",
  webhookUrl: "",
  webhookSecret: "",
  quietAction: "batch",
  timezone: "Asia/Shanghai",
  maxAgeHours: 72,
  langMode: "all",
  sourceMode: "all",
  sourceIds: [],
  includePrice: true,
  includeDeadline: true,
  includeScore: true,
  includeObtain: true,
  includeAiReason: true,
  customHeader: "",
  dedupeByTitle: true,
  maxPrice: null,
  obtainModes: ["free"],
  kinds: ["freebie"],
  routes: [],
  categories: [],
  prioritizeSubscribed: true,
  applyToDigest: true,
};

const SETTINGS_KEY = "push";
/** Legal values for category / acquisition method / kind come from shared/taxonomy.ts so they cannot drift from the home-page categories */
const VALID_CATEGORIES: ReadonlySet<string> = CATEGORY_SET;
const VALID_OBTAIN: ReadonlySet<string> = OBTAIN_SET;
/** Pushable kinds: noise is a rejection result, never a push target */
const VALID_KINDS = new Set<string>(KIND_ORDER);

function numOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function normalizeMaxPrice(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "all") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n * 100) / 100, 10000);
}

function normalizeCategories(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && VALID_CATEGORIES.has(x)))];
}

function normalizeObtain(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && VALID_OBTAIN.has(x)))];
}

function normalizeKinds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && VALID_KINDS.has(x)))];
}

function normalizeRoutes(v: unknown): PushRoute[] {
  if (!Array.isArray(v)) return [];
  const out: PushRoute[] = [];
  for (let i = 0; i < Math.min(v.length, 20); i += 1) {
    const raw = v[i] as Partial<PushRoute> | null;
    if (!raw || typeof raw !== "object") continue;
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
    if (!name) continue;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 40) : `route-${i + 1}`;
    const keywords = Array.isArray(raw.keywords)
      ? [...new Set(raw.keywords.filter((k): k is string => typeof k === "string").map((k) => k.trim().slice(0, 80)).filter(Boolean))].slice(0, 30)
      : [];
    out.push({
      id,
      name,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      kinds: normalizeKinds(raw.kinds),
      categories: normalizeCategories(raw.categories),
      obtainModes: normalizeObtain(raw.obtainModes),
      keywords,
      maxPrice: normalizeMaxPrice(raw.maxPrice),
      minScore: numOr(raw.minScore, 55, 0, 100),
      instant: typeof raw.instant === "boolean" ? raw.instant : true,
      header: typeof raw.header === "string" ? raw.header.trim().slice(0, 40) : undefined,
    });
  }
  return out;
}
function normalizeSourceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string").map((s) => s.trim().slice(0, 100)).filter(Boolean))].slice(0, 200);
}

export function normalizeSettings(raw: Partial<PushSettings>, base: PushSettings = DEFAULT_SETTINGS): PushSettings {
  const instantScore = numOr(raw.instantScore, base.instantScore, 0, 100);
  const rawBatchScore = numOr(raw.batchScore, base.batchScore, 0, 100);
  const batchScore = Math.min(rawBatchScore, instantScore);

  let aiFallbackMode: AiFallbackMode = base.aiFallbackMode;
  if (raw.aiFallbackMode === "strict" || raw.aiFallbackMode === "rule_fallback" || raw.aiFallbackMode === "ignore_ai") {
    aiFallbackMode = raw.aiFallbackMode;
  } else if (typeof raw.onlyAiKeep === "boolean") {
    if (!raw.onlyAiKeep) aiFallbackMode = "ignore_ai";
    else if (base.aiFallbackMode === "ignore_ai") aiFallbackMode = "rule_fallback";
  }

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    pushTiming: raw.pushTiming === "instant_first" || raw.pushTiming === "wait_ai" ? raw.pushTiming : base.pushTiming,
    syncPrePushLimit: numOr(raw.syncPrePushLimit, base.syncPrePushLimit, 5, 60),
    pushAfterBackfill: typeof raw.pushAfterBackfill === "boolean" ? raw.pushAfterBackfill : base.pushAfterBackfill,
    aiFallbackMode,
    onlyAiKeep: aiFallbackMode !== "ignore_ai",
    instantScore,
    batchScore,
    instantOnCodes: typeof raw.instantOnCodes === "boolean" ? raw.instantOnCodes : base.instantOnCodes,
    instantOnUrgent: typeof raw.instantOnUrgent === "boolean" ? raw.instantOnUrgent : base.instantOnUrgent,
    maxPerHour: numOr(raw.maxPerHour, base.maxPerHour, 1, 200),
    maxPerInstant: numOr(raw.maxPerInstant, base.maxPerInstant, 1, 10),
    batchIntervalMin: numOr(raw.batchIntervalMin, base.batchIntervalMin, 0, 720),
    maxPerBatch: numOr(raw.maxPerBatch, base.maxPerBatch, 1, 20),
    quietEnabled: typeof raw.quietEnabled === "boolean" ? raw.quietEnabled : base.quietEnabled,
  quietHours: typeof raw.quietHours === "string" ? raw.quietHours : base.quietHours,
  deliverVia: raw.deliverVia === "webhook" || raw.deliverVia === "telegram" ? raw.deliverVia : base.deliverVia,
  webhookUrl: typeof raw.webhookUrl === "string" ? raw.webhookUrl.trim().slice(0, 500) : base.webhookUrl,
  webhookSecret: typeof raw.webhookSecret === "string" ? raw.webhookSecret.trim().slice(0, 200) : base.webhookSecret,
    quietAction: raw.quietAction === "drop" || raw.quietAction === "batch" ? raw.quietAction : base.quietAction,
    timezone: typeof raw.timezone === "string" && raw.timezone ? raw.timezone : base.timezone,
    maxAgeHours: numOr(raw.maxAgeHours, base.maxAgeHours, 0, 720),
    langMode: raw.langMode === "zh" || raw.langMode === "en" || raw.langMode === "all" ? raw.langMode : base.langMode,
    sourceMode: raw.sourceMode === "include" || raw.sourceMode === "exclude" || raw.sourceMode === "all" ? raw.sourceMode : base.sourceMode,
    sourceIds: "sourceIds" in raw ? normalizeSourceIds(raw.sourceIds) : base.sourceIds,
    includePrice: typeof raw.includePrice === "boolean" ? raw.includePrice : base.includePrice,
    includeDeadline: typeof raw.includeDeadline === "boolean" ? raw.includeDeadline : base.includeDeadline,
    includeScore: typeof raw.includeScore === "boolean" ? raw.includeScore : base.includeScore,
    includeObtain: typeof raw.includeObtain === "boolean" ? raw.includeObtain : base.includeObtain,
    includeAiReason: typeof raw.includeAiReason === "boolean" ? raw.includeAiReason : base.includeAiReason,
    customHeader: typeof raw.customHeader === "string" ? raw.customHeader.trim().slice(0, 60) : base.customHeader,
    dedupeByTitle: typeof raw.dedupeByTitle === "boolean" ? raw.dedupeByTitle : base.dedupeByTitle,
    maxPrice: "maxPrice" in raw ? normalizeMaxPrice(raw.maxPrice) : base.maxPrice,
    obtainModes: "obtainModes" in raw ? normalizeObtain(raw.obtainModes) : base.obtainModes,
    kinds: "kinds" in raw ? normalizeKinds(raw.kinds) : base.kinds,
    routes: "routes" in raw ? normalizeRoutes(raw.routes) : base.routes,
    categories: "categories" in raw ? normalizeCategories(raw.categories) : base.categories,
    prioritizeSubscribed: typeof raw.prioritizeSubscribed === "boolean" ? raw.prioritizeSubscribed : base.prioritizeSubscribed,
    applyToDigest: typeof raw.applyToDigest === "boolean" ? raw.applyToDigest : base.applyToDigest,
  };
}

export function getPushSettings(): PushSettings {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", SETTINGS_KEY);
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(row.value) as Partial<PushSettings>, DEFAULT_SETTINGS);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function savePushSettings(patch: Partial<PushSettings>): PushSettings {
  const cur = getPushSettings();
  const merged = normalizeSettings(patch, cur);
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    SETTINGS_KEY,
    JSON.stringify(merged),
    new Date().toISOString(),
  );
  // Hot-reload the batch timer: changing 0 to 10 minutes or shortening the interval should not require a restart or waiting out the previous cycle
  if (schedulerStarted) rescheduleFlush();
  return merged;
}

/* ------------------------------------------------------------------ *
 * Language detection / title normalization / filter decisions (same rules as the front-end filters)
 * ------------------------------------------------------------------ */

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

export function detectLang(text: string): "zh" | "en" {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0) return "en";
  return cjk / Math.max(cjk + latin, 1) > 0.15 ? "zh" : "en";
}

export function titleKey(title: string): string {
  return mergeKey(title);
}

function langAllowed(item: { title: string }, s: PushSettings): boolean {
  if (s.langMode === "all") return true;
  return detectLang(item.title) === s.langMode;
}

export function sourceAllowed(sourceId: string | undefined, s: PushSettings): boolean {
  if (s.sourceMode === "all" || !sourceId) return true;
  if (s.sourceMode === "include") return s.sourceIds.includes(sourceId);
  if (s.sourceMode === "exclude") return !s.sourceIds.includes(sourceId);
  return true;
}

export function priceAllowed(
  item: { price?: number | null; isFree?: boolean; obtain?: string | null },
  maxPrice: number | null,
): boolean {
  if (maxPrice === null) return true;
  const free = item.isFree === true || item.price === 0;
  if (maxPrice === 0) {
    if (item.obtain === "paid") return false;
    if (item.obtain && item.obtain !== "free" && item.obtain !== "conditional") return false;
    return free;
  }
  if (free) return true;
  return typeof item.price === "number" && item.price <= maxPrice;
}

export function aiAllowed(
  item: { title: string; score: number; codes: string[]; aiKeep?: boolean | null; kind?: string | null },
  onlyAiKeepOrSettings: boolean | PushSettings,
): boolean {
  const mode: AiFallbackMode =
    typeof onlyAiKeepOrSettings === "boolean"
      ? onlyAiKeepOrSettings
        ? "rule_fallback"
        : "ignore_ai"
      : onlyAiKeepOrSettings.aiFallbackMode;

  if (mode === "ignore_ai") return true;
  if (item.aiKeep === false || item.kind === "noise") return false;
  if (item.aiKeep === true) return true;
  // No AI verdict yet (aiKeep === null | undefined)
  if (!shouldReview()) return true;
  if (mode === "strict") return false;
  return item.codes.length > 0 || (item.score >= 70 && hasValueSignal(item.title, item.kind));
}

export function categoryAllowed(category: string | null | undefined, allow: string[]): boolean {
  if (!allow.length) return true;
  return Boolean(category && allow.includes(category));
}

export function obtainAllowed(obtain: string | null | undefined, allow: string[]): boolean {
  if (!allow.length) return true;
  return allow.includes(obtain ?? "free");
}

export function kindAllowed(kind: string | null | undefined, allow: string[]): boolean {
  if (!allow.length) return kind !== "noise";
  return allow.includes(kind ?? "freebie");
}

export function matchPushRoute(
  item: {
    title: string;
    summary?: string | null;
    score: number;
    price?: number | null;
    isFree?: boolean;
    kind?: string | null;
    category?: string | null;
    obtain?: string | null;
  },
  routes: PushRoute[],
): PushRoute | null {
  const enabled = routes.filter((r) => r.enabled);
  if (!enabled.length) return null;
  const hay = (item.title + " " + (item.summary ?? "")).toLowerCase();
  for (const r of enabled) {
    if (!kindAllowed(item.kind, r.kinds)) continue;
    if (!categoryAllowed(item.category, r.categories)) continue;
    if (!obtainAllowed(item.obtain, r.obtainModes)) continue;
    if (!priceAllowed(item, r.maxPrice)) continue;
    if (r.keywords.length && !r.keywords.some((kw) => hay.includes(kw.toLowerCase()))) continue;
    if (item.score < r.minScore) continue;
    return r;
  }
  return null;
}

export function freshEnoughForPush(
  publishedAt: string | null | undefined,
  maxAgeHours = 72,
  nowMs = Date.now(),
): boolean {
  if (maxAgeHours <= 0 || !publishedAt) return true;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return true;
  return nowMs - ts <= maxAgeHours * 3_600_000;
}

export type FilterRejectReason =
  | "stale"
  | "source"
  | "lang"
  | "kind"
  | "category"
  | "price"
  | "ai"
  | "obtain"
  | "route"
  | "interest";

export function checkPushFilter(
  item: {
    sourceId?: string;
    title: string;
    summary?: string | null;
    score: number;
    codes: string[];
    price?: number | null;
    isFree?: boolean;
    aiKeep?: boolean | null;
    kind?: string | null;
    category?: string | null;
    obtain?: string | null;
    publishedAt?: string | null;
  },
  s: PushSettings,
): FilterRejectReason | null {
  if (!freshEnoughForPush(item.publishedAt, s.maxAgeHours)) return "stale";
  if (!sourceAllowed(item.sourceId, s)) return "source";
  if (!langAllowed(item, s)) return "lang";
  if (!aiAllowed(item, s)) return "ai";
  // Topic filter before routes: free AI / domain / VPS / cloud only, never free-internet
  // nodes or game giveaways. A matching route must not be able to re-admit them.
  if (!passesInterest(item)) return "interest";

  const hasEnabledRoutes = s.routes?.some((r) => r.enabled);
  if (hasEnabledRoutes) {
    return matchPushRoute(item, s.routes) ? null : "route";
  }

  if (!kindAllowed(item.kind, s.kinds ?? [])) return "kind";
  if (!categoryAllowed(item.category, s.categories)) return "category";
  if (!priceAllowed(item, s.maxPrice)) return "price";
  if (!obtainAllowed(item.obtain, s.obtainModes)) return "obtain";
  return null;
}

/** Filter check shared by push and digest: age / source / language / kind / category / max price / AI verification / acquisition method / multi-route. */
export function passesPushFilters(
  item: {
    sourceId?: string;
    title: string;
    summary?: string | null;
    score: number;
    codes: string[];
    price?: number | null;
    isFree?: boolean;
    aiKeep?: boolean | null;
    kind?: string | null;
    category?: string | null;
    obtain?: string | null;
    publishedAt?: string | null;
  },
  s: PushSettings,
): boolean {
  return checkPushFilter(item, s) === null;
}

function matchSubscriptions(item: { title: string; summary?: string | null }, keywords: string[]): string[] {
  if (!keywords.length) return [];
  const text = (item.title + " " + (item.summary ?? "")).toLowerCase();
  return keywords.filter((k) => text.includes(k.toLowerCase()));
}

function fmtPrice(item: FreshItem): string | null {
  if (item.isFree) return "Free";
  if (typeof item.price !== "number" || item.price <= 0) return null;
  const v = item.price < 1 ? "<1" : String(Math.round(item.price));
  return "~¥" + v;
}

function fmtDeadline(item: FreshItem): string | null {
  if (!item.expiresAt) return null;
  const t = new Date(item.expiresAt).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  if (days < 0) return null;
  if (days === 0) return "Ends today";
  if (days <= 14) return days + " days left";
  return null;
}

export const SOURCE_SHORT: Record<string, string> = {
  "linuxdo-welfare": "LINUX DO Welfare",
  "linuxdo-resource": "LINUX DO Resources",
  "linuxdo-develop": "LINUX DO Dev & Tuning",
  "linuxdo-news": "LINUX DO News",
  "linuxdo-domestic": "LINUX DO Domestic Alternatives",
  "tg-pan-yunpan": "TG Cloud Drive",
  "tg-pan-yiove": "TG Yiove Resources",
  "v2ex-free": "V2EX Free Giveaways",
  "v2ex-deals": "V2EX Deals",
  "v2ex-share": "V2EX Share",
  "v2ex-promotions": "V2EX Promotions",
  "v2ex-cloud": "V2EX Cloud",
  "xiaoheihe-search": "Xiaoheihe",
  "zhihu-search": "Zhihu",
  "xhs-search": "Xiaohongshu",
  gamerpower: "GamerPower",
  "epic-free": "Epic Freebie",
  "steam-free": "Steam Free",
  "gog-free": "GOG Free",
  "cheapshark-free": "CheapShark",
  "rss-isthereanydeal": "ITAD Freebie",
  "rss-indiegamebundles": "IndieGameBundles",
  "rss-ggdeals": "GG.deals",
  "rss-reddit-freegames": "Reddit Games",
  "rss-reddit-freegamesonsteam": "Reddit Steam",
  "rss-reddit-efreebies": "Reddit E-Freebies",
  "rss-reddit-gamedeals": "Reddit GameDeals",
  "rss-reddit-freebies": "Reddit Freebies",
  "rss-reddit-apphookup": "AppHookup Free",
  "rss-reddit-freeebooks": "Reddit Ebooks",
  "rss-reddit-googleplay": "GooglePlay Free",
  "rss-keylol": "Keylol",
  "rss-slickdeals": "Slickdeals",
  "rss-heyitsfree": "HeyItsFree",
  "rss-freebieshark": "FreebieShark",
  "rss-giveawayoftheday": "Giveaway of the Day",
  "rss-vonbeau": "VonBeau",
  "rss-hip2save": "Hip2Save",
  "rss-ozbargain": "OzBargain",
  "rss-lowendbox": "LowEndBox",
  "rss-iplaysoft": "iPlaySoft",
  "tg-freegames": "TG Game Intel",
  "tg-cn-deals": "TG CN Deals",
  "bsky-gamedeals": "Bluesky Games",
  "bsky-plugins": "Bluesky Plugins",
  "rss-nodeseek": "NodeSeek",
  "rss-sharewareonsale": "SharewareOnSale",
  "rss-tickcoupon": "TickCoupon",
  "rss-fuliba": "Fuliba",
  "rss-52pojie": "52pojie",
  "rss-smzdm": "SMZDM",
  "github-free-for-dev": "GitHub",
};

export function sourceLabel(id: string): string {
  return SOURCE_SHORT[id] ?? id;
}

/* ------------------------------------------------------------------ *
 * Quiet hours
 * ------------------------------------------------------------------ */

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function inQuietHours(quiet: string, at = new Date()): boolean {
  const [from, to] = quiet.split("-");
  const a = parseHHMM(from ?? "");
  const b = parseHHMM(to ?? "");
  if (a === null || b === null) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  if (a === b) return false;
  if (a < b) return now >= a && now < b;
  return now >= a || now < b;
}

function zonedMinutes(timezone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return (h % 24) * 60 + m;
  } catch {
    return at.getHours() * 60 + at.getMinutes();
  }
}

export function inQuietHoursZoned(quiet: string, timezone: string, at = new Date()): boolean {
  const [from, to] = quiet.split("-");
  const a = parseHHMM(from ?? "");
  const b = parseHHMM(to ?? "");
  if (a === null || b === null) return false;
  const now = zonedMinutes(timezone, at);
  if (a === b) return false;
  if (a < b) return now >= a && now < b;
  return now >= a || now < b;
}

export function isQuietNow(s = getPushSettings(), at = new Date()): boolean {
  if (!s.quietEnabled) return false;
  return inQuietHoursZoned(s.quietHours, s.timezone, at);
}

/* ------------------------------------------------------------------ *
 * Candidate filtering
 * ------------------------------------------------------------------ */

type Decision = { push: boolean; reason: string; urgent: boolean; route?: PushRoute | null };

function decide(item: FreshItem, s: PushSettings, subHits: string[], route: PushRoute | null = null): Decision {
  if (matchesEntryNoise(item.title)) return { push: false, reason: "", urgent: false, route };
  if (s.aiFallbackMode !== "ignore_ai" && (item.aiKeep === false || item.kind === "noise")) {
    return { push: false, reason: "", urgent: false, route };
  }
  const routeTag = route ? `[${route.name}] ` : "";
  if (route && !route.instant) {
    return { push: false, reason: "", urgent: false, route };
  }
  if (s.prioritizeSubscribed && subHits.length > 0) {
    return { push: true, reason: routeTag + "subscription hit: " + subHits.join("/"), urgent: true, route };
  }
  if (s.instantOnCodes && item.codes.length > 0) return { push: true, reason: routeTag + "has code", urgent: true, route };
  if (s.instantOnUrgent && URGENT.test(item.title) && item.score >= 40) {
    return { push: true, reason: routeTag + "limited/limited-time", urgent: true, route };
  }
  const scoreGate = route ? Math.max(s.instantScore, route.minScore) : s.instantScore;
  if (item.score >= scoreGate) return { push: true, reason: routeTag + "high score " + Math.round(item.score), urgent: false, route };
  return { push: false, reason: "", urgent: false, route };
}

function canEnterBatch(item: FreshItem, s: PushSettings, d: Decision): boolean {
  if (matchesEntryNoise(item.title)) return false;
  if (s.aiFallbackMode !== "ignore_ai" && (item.aiKeep === false || item.kind === "noise")) return false;
  // Passing AI verification, or hitting a freebie / deal / opensource channel value signal, is enough to enter batching; a pure-Chinese DEAL_HINT no longer blocks it
  const hasSignal = item.aiKeep === true || hasValueSignal(item.title, item.kind);
  if (!hasSignal && !d.push) return false;
  const batchGate = d.route ? d.route.minScore : s.batchScore;
  return item.score >= batchGate || d.push;
}

/** Items pushed in the last N hours (with the canonical_id cluster key), shared by AI semantic dedupe and rule dedupe. */
function recentPushedEntries(windowHours = 48): DedupCandidate[] {
  return all<{
    id: number;
    title: string;
    summary: string | null;
    urlKey: string | null;
    canonicalId: number | null;
    category: string | null;
    kind: string | null;
    publishedAt: string | null;
  }>(
    `SELECT id, title, summary, url_key AS urlKey, canonical_id AS canonicalId, category, kind,
            COALESCE(published_at, first_seen_at) AS publishedAt
       FROM items WHERE pushed_at IS NOT NULL AND pushed_at >= ?`,
    new Date(Date.now() - Math.max(windowHours, 6) * 3_600_000).toISOString(),
  );
}

function recentPushedSeeds(includeQueue = true): DedupeEntry[] {
  const rows = recentPushedEntries(24);
  if (!includeQueue || !queue.length) return rows;
  return [...rows, ...queue.map((q) => ({ title: q.item.title, canonicalId: q.item.canonicalId ?? null }))];
}

function pushedLastHour(): number {
  return (
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM items WHERE pushed_at IS NOT NULL AND pushed_at >= ?",
      new Date(Date.now() - 3_600_000).toISOString(),
    )?.n ?? 0
  );
}

/**
 * How many items this round can really go out on the instant channel, and how many slip into batching.
 * Preview and real push share this one function, so "the UI says 5 will go out" matches what is actually sent.
 */
export function planInstant(instantCount: number, s: PushSettings, usedThisHour: number): { send: number; defer: number; budget: number } {
  const budget = Math.max(0, s.maxPerHour - usedThisHour);
  const send = Math.min(instantCount, s.maxPerInstant, budget);
  return { send, defer: instantCount - send, budget };
}

/* ------------------------------------------------------------------ *
 * Batch queue
 * ------------------------------------------------------------------ */

type QueueItem = { id: number; sourceId: string; item: FreshItem; subHits?: string[]; route?: PushRoute | null; reason?: string };
let queue: QueueItem[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let schedulerStarted = false;

export function queueSize(): number {
  return queue.length;
}

function enqueue(entries: QueueItem[]): void {
  const seen = new Set(queue.map((q) => q.id));
  for (const e of entries) if (!seen.has(e.id)) queue.push(e);
  if (queue.length > 200) queue = queue.slice(-200);
  // Ensure a timer is running on enqueue: otherwise, after batching is turned off and on again, or when the scheduler starts after the enqueue, the queue would just sit there
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const s = getPushSettings();
  if (!s.enabled || !pushEnabled || s.batchIntervalMin <= 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushBatch();
    scheduleFlush();
  }, s.batchIntervalMin * 60_000);
  flushTimer.unref?.();
}

function rescheduleFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  scheduleFlush();
}

export function startPushScheduler(): void {
  schedulerStarted = true;
  const s = getPushSettings();
  if (!s.enabled || !pushEnabled) return;
  scheduleFlush();
  console.log("[push] batch scheduler started, interval " + s.batchIntervalMin + " minutes");
}

/* ------------------------------------------------------------------ *
 * Message assembly
 * ------------------------------------------------------------------ */

export function parseAiMeta(aiRaw: string | null): { aiKeep: boolean | null; aiReason: string | null } {
  if (!aiRaw) return { aiKeep: null, aiReason: null };
  try {
    const parsed = JSON.parse(aiRaw) as { keep?: boolean; reason?: string };
    return {
      aiKeep: typeof parsed.keep === "boolean" ? parsed.keep : null,
      aiReason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : null,
    };
  } catch {
    return { aiKeep: null, aiReason: null };
  }
}

export function itemBlock(sourceId: string, it: FreshItem, s: PushSettings, seq?: number, subHits: string[] = []): string[] {
  const lines: string[] = [];
  const prefix = seq === undefined ? "" : seq + ". ";
  const meta: string[] = [sourceLabel(sourceId)];
  const kindTag = it.kind && it.kind !== "freebie" && it.kind !== "noise" ? KIND_LABEL[it.kind as ContentKind] : null;
  if (kindTag) meta.push(kindTag);
  const price = s.includePrice ? fmtPrice(it) : null;
  if (price) meta.push(price);
  if (s.includeObtain && it.obtain && it.obtain !== "free") {
    meta.push(OBTAIN_LABEL[it.obtain as keyof typeof OBTAIN_LABEL] ?? it.obtain);
  }
  if (s.includeDeadline) {
    const dl = fmtDeadline(it);
    if (dl) meta.push(dl);
  }
  if (subHits.length) meta.push("Subs: " + subHits.join("/"));
  if (detectLang(it.title) === "en" && s.langMode === "all") meta.push("EN");
  if (s.includeScore && it.score) meta.push(Math.round(it.score) + " pts");

  lines.push(prefix + displayTitle(it).slice(0, 110));
  lines.push("   " + meta.join(" · "));
  if (s.includeAiReason && it.aiReason) lines.push("   💡 " + it.aiReason);
  if (it.codes.length) lines.push("   Code: " + it.codes.join(" / "));
  lines.push("   " + it.url);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Instant push
 * ------------------------------------------------------------------ */

export async function pushInstant(sourceId: string, fresh: FreshItem[]): Promise<number> {
  const s = getPushSettings();
  if (!s.enabled || !pushEnabled || config.pushChannel !== "telegram") return 0;
  if (!config.telegramBotToken || !config.telegramChatId) return 0;
  if (!fresh.length) return 0;

  const rules = loadActiveBlockRules();
  const subKeywords = all<{ keyword: string }>("SELECT keyword FROM subscriptions").map((r) => r.keyword);
  const candidates = fresh.filter((it) => {
    if (isBlocked({ ...it, sourceId }, rules)) return false;
    return passesPushFilters({ ...it, sourceId }, s);
  });
  const deduper = s.dedupeByTitle ? new TitleDeduper(candidates, recentPushedSeeds(true)) : null;
  // Fresh items are pushed within seconds of collection, before the background pass has
  // seen them: one bounded call so the message still goes out in English.
  await hydrateTranslations(candidates, { max: 12, timeoutMs: 20_000 });

  const instant: { it: FreshItem; reason: string; subHits: string[]; route: PushRoute | null }[] = [];
  const batched: QueueItem[] = [];
  const quiet = isQuietNow(s);
  const hasRoutes = s.routes?.some((r) => r.enabled);

  for (const it of candidates) {
    if (deduper?.isDuplicate(it)) continue;
    const subHits = matchSubscriptions(it, subKeywords);
    const route = hasRoutes ? matchPushRoute(it, s.routes) : null;
    const d = decide(it, s, subHits, route);

    if (d.push && !quiet) {
      instant.push({ it, reason: d.reason, subHits, route });
      deduper?.markSeen(it);
      continue;
    }
    if (quiet && s.quietAction === "drop") continue;
    if (canEnterBatch(it, s, d)) {
      batched.push({
        id: it.id,
        sourceId,
        item: it,
        subHits,
        route,
        reason: d.reason || (route ? `[${route.name}] ` : "") + "met batch high-score threshold",
      });
      deduper?.markSeen(it);
    }
  }

  // AI semantic dedupe fallback: catch "same campaign, different wording" that rule clustering misses (e.g. the dozen phrasings of "BLG wins, Bilibili gives everyone a premium membership")
  if (instant.length || batched.length) {
    const targets = [...instant.map((x) => x.it), ...batched.map((q) => q.item)];
    const { intercepted } = await filterPushDuplicatesWithAi(
      targets.map((it) => ({
        id: it.id,
        title: it.title,
        summary: it.summary ?? null,
        kind: it.kind ?? null,
        category: it.category ?? null,
        canonicalId: it.canonicalId ?? null,
      })),
      recentPushedEntries(getAiSettings().aiDedupWindowHours),
    );
    if (intercepted.length) {
      const dropIds = new Set(intercepted.map((x) => x.item.id));
      for (let i = instant.length - 1; i >= 0; i -= 1) {
        if (dropIds.has(instant[i]!.it.id)) instant.splice(i, 1);
      }
      for (let i = batched.length - 1; i >= 0; i -= 1) {
        if (dropIds.has(batched[i]!.item.id)) batched.splice(i, 1);
      }
      console.log(`[push] ${sourceId} AI semantic dedupe blocked ${intercepted.length} duplicates`);
    }
  }

  if (batched.length && s.batchIntervalMin > 0) enqueue(batched);
  if (quiet && (instant.length || batched.length)) {
    console.log(
      `[push] quiet hours ${s.quietHours} (${s.quietAction === "drop" ? "skipped" : "moved to batch, " + batched.length + " items"})`,
    );
  }

// Items cut by the instant cap must not be lost: demote them into the batch queue and send them gradually against the hourly budget.
  // When batching is off they stay in the queue (the UI shows "N queued") and can be sent manually with "send batch now".
  const usedThisHour = pushedLastHour();
  const plan = planInstant(instant.length, s, usedThisHour);
  const picked = instant.slice(0, plan.send);
  const overflow = instant.slice(plan.send);
  if (overflow.length) {
    enqueue(overflow.map(({ it, reason, subHits, route }) => ({ id: it.id, sourceId, item: it, subHits, route, reason })));
    console.log(
      `[push] ${sourceId} instant cap exceeded, moved ${overflow.length} items to batch (per-round instant cap ${s.maxPerInstant}, remaining budget this hour ${plan.budget})`,
    );
  }
  if (!picked.length) return 0;

  // ONE message for the whole round: the user wants a single clickable list, not a ping per item.
  const headerBase = picked[0]?.route?.header || s.customHeader || "⚡ New";
  const footer = config.publicBaseUrl ? "🔗 " + config.publicBaseUrl : "";
  const messages = packItemMessages(
    picked.map(({ it }) => ({ title: displayTitle(it), url: it.url })),
    (part, parts) =>
      headerBase + " · " + picked.length + (picked.length === 1 ? " item" : " items") +
      (parts > 1 ? ` (${part}/${parts})` : ""),
    footer ? () => footer : undefined,
  );
  const text = messages.join("\n\n");
  const reasons = summarizeReasons(picked.map((p) => p.reason));
  let sent = 0;
  try {
    for (const m of messages) await sendTelegram(m, { parseMode: "HTML" });
    const now = new Date().toISOString();
    for (const { it } of picked) {
      run("UPDATE items SET pushed_at = ?, title_key = ? WHERE id = ?", now, titleKey(it.title), it.id);
    }
    logPush("instant", picked.map(({ it }) => it.id), text, picked.length, true, null, reasons);
    sent = picked.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[push] instant push failed:", msg);
    logPush("instant", picked.map(({ it }) => it.id), text, 0, false, msg, reasons);
  }
  if (sent) console.log("[push] " + sourceId + " instant push " + sent + " items in " + messages.length + " message(s)");
  return sent;
}

/** Called by the background AI re-review queue: run a push decision for an item that has just been approved and not yet pushed. */
export async function pushReviewedByIds(sourceId: string, itemIds: number[]): Promise<number> {
  if (!itemIds.length) return 0;
  const s = getPushSettings();
  if (!s.enabled || !s.pushAfterBackfill || !pushEnabled) return 0;

  const ph = itemIds.map(() => "?").join(",");
  const rows = all<{
    id: number;
    title: string;
    summary: string | null;
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
    title_en: string | null;
    summary_en: string | null;
  }>(
    `SELECT id, title, summary, title_en, summary_en, url, category, kind, score, codes, price, is_free, obtain, expires_at, published_at, ai, canonical_id
       FROM items
      WHERE id IN (${ph}) AND status = 'active' AND pushed_at IS NULL`,
    ...itemIds,
  );
  if (!rows.length) return 0;

  const fresh: FreshItem[] = rows.map((r) => {
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const aiMeta = parseAiMeta(r.ai);
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
      aiKeep: aiMeta.aiKeep,
      aiReason: aiMeta.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      title_en: r.title_en,
      summary_en: r.summary_en,
      canonicalId: r.canonical_id,
    };
  });

  return pushInstant(sourceId, fresh);
}

/* ------------------------------------------------------------------ *
 * Batch push (re-checks the latest DB state / latest blocklist / latest push rules before sending)
 * ------------------------------------------------------------------ */

export async function flushBatch(force = false): Promise<number> {
  if (!queue.length) return 0;
  const s = getPushSettings();
  if (!s.enabled || !pushEnabled) return 0;
  if (!force && isQuietNow(s)) return 0;

  const budget = Math.max(0, s.maxPerHour - pushedLastHour());
  if (!budget) return 0;

  const rawTake = queue.splice(0, Math.min(s.maxPerBatch, budget));
  if (!rawTake.length) return 0;

  // Re-check the DB so nothing goes out that the user disabled, blocklisted, or the background AI judged not a freebie while it waited in the queue
  const ids = rawTake.map((q) => q.id);
  const ph = ids.map(() => "?").join(",");
  const dbRows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
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
    pushed_at: string | null;
status: string;
    ai: string | null;
    canonical_id: number | null;
    title_en: string | null;
    summary_en: string | null;
  }>(
    `SELECT id, source_id, title, summary, title_en, summary_en, url, category, kind, score, codes, price, is_free, obtain, expires_at, published_at, pushed_at, status, ai, canonical_id
       FROM items WHERE id IN (${ph})`,
    ...ids,
  );
  const rowMap = new Map(dbRows.map((r) => [r.id, r]));
  const rules = loadActiveBlockRules();
  const subKeywords = all<{ keyword: string }>("SELECT keyword FROM subscriptions").map((r) => r.keyword);
  const hasRoutes = s.routes?.some((r) => r.enabled);

  const refreshed: QueueItem[] = [];
  for (const q of rawTake) {
    const r = rowMap.get(q.id);
    // If the row no longer exists (test or manual delete) or is disabled/already pushed, skip it; if it is still there, re-check strictly against the latest state
    if (!r || r.status !== "active" || r.pushed_at !== null) continue;
    if (isBlocked(r, rules)) continue;
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const aiMeta = parseAiMeta(r.ai);
    const fresh: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: aiMeta.aiKeep,
      aiReason: aiMeta.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      title_en: r.title_en,
      summary_en: r.summary_en,
      canonicalId: r.canonical_id,
    };
    if (!passesPushFilters({ ...fresh, sourceId: r.source_id }, s)) continue;
    const subHits = matchSubscriptions(fresh, subKeywords);
    const route = hasRoutes ? matchPushRoute(fresh, s.routes) : null;
    const d = decide(fresh, s, subHits, route);
    if (!canEnterBatch(fresh, s, d)) continue;
    refreshed.push({ id: r.id, sourceId: r.source_id, item: fresh, subHits, route, reason: q.reason });
  }

  let take = refreshed;
  if (s.dedupeByTitle && refreshed.length) {
    const entries = refreshed.map((q) => ({ title: q.item.title, q }));
    const deduper = new TitleDeduper(entries, recentPushedSeeds(false));
    take = [];
    for (const entry of entries) {
      if (deduper.isDuplicate(entry)) continue;
      deduper.markSeen(entry);
      take.push(entry.q);
    }
  }
// AI semantic dedupe: compare once more against already-pushed records before a batch goes out, to prevent "same campaign, different wording" spam
  if (take.length) {
    const { intercepted } = await filterPushDuplicatesWithAi(
      take.map((q) => ({
        id: q.id,
        title: q.item.title,
        summary: q.item.summary ?? null,
        kind: q.item.kind ?? null,
        category: q.item.category ?? null,
        canonicalId: q.item.canonicalId ?? null,
      })),
      recentPushedEntries(getAiSettings().aiDedupWindowHours),
    );
    if (intercepted.length) {
      const dropIds = new Set(intercepted.map((x) => x.item.id));
      take = take.filter((q) => !dropIds.has(q.id));
      console.log(`[push] batch AI semantic dedupe blocked ${intercepted.length} duplicates`);
    }
  }
  if (!take.length) return 0;

  // Same reason as the instant path: a queued item may have been collected before the
  // background pass reached it. One bounded call, never blocks longer than the timeout.
  await hydrateTranslations(take.map((q) => q.item), { max: 12, timeoutMs: 20_000 });

  const footer = config.publicBaseUrl ? "🔗 " + config.publicBaseUrl : "";
  let batchTitle = s.customHeader
    ? `${s.customHeader} · ${take.length} items`
    : `📦 ${take.length} new this round`;
  if (hasRoutes) {
    const tags = [...new Set(take.map((q) => q.route?.header || q.route?.name).filter(Boolean))];
    if (tags.length) batchTitle += " · " + tags.join(" / ");
  }
  const messages = packItemMessages(
    take.map((q) => ({ title: displayTitle(q.item), url: q.item.url })),
    (part, parts) => batchTitle + (parts > 1 ? ` (${part}/${parts})` : ""),
    footer ? () => footer : undefined,
  );
  const text = messages.join("\n\n");

  try {
    for (const m of messages) await sendTelegram(m, { parseMode: "HTML" });
    const now = new Date().toISOString();
    for (const q of take) {
      run("UPDATE items SET pushed_at = ?, title_key = ? WHERE id = ?", now, titleKey(q.item.title), q.id);
    }
    logPush("batch", take.map((q) => q.id), text, take.length, true, null, summarizeReasons(take.map((q) => q.reason)));
    console.log("[push] batch push " + take.length + " items in " + messages.length + " message(s)");
    return take.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[push] batch push failed:", msg);
    logPush("batch", take.map((q) => q.id), text, 0, false, msg, summarizeReasons(take.map((q) => q.reason)));
    queue.unshift(...take);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Push records and state
 * ------------------------------------------------------------------ */

/** Compress a batch of items' match reasons into one summary line: strip the route prefix, normalize "high score 78" to "high score", then sort by count. */
function summarizeReasons(reasons: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const key = (r?.trim() || "met batch high-score threshold").replace(/^\[[^\]]+\]\s*/, "").replace(/high score\s*\d+/, "high score");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => k + " " + n)
    .join(" · ");
}

function logPush(
  kind: string,
  ids: number[],
  text: string,
  count: number,
  ok: boolean,
  error: string | null,
  reason: string | null = null,
): void {
  run(
    "INSERT INTO push_log (kind, item_ids, text, count, ok, error, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    kind,
    JSON.stringify(ids),
    text.slice(0, 4000),
    count,
    ok ? 1 : 0,
    error?.slice(0, 400) ?? null,
    reason?.slice(0, 300) ?? null,
    new Date().toISOString(),
  );
}

export function recentPushLog(limit = 30) {
  return all<{
    id: number;
    kind: string;
    item_ids: string;
    text: string;
    count: number;
    ok: number;
    error: string | null;
    reason: string | null;
    created_at: string;
  }>("SELECT * FROM push_log ORDER BY id DESC LIMIT ?", limit);
}

export function pushStats() {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  return {
    pushedLastHour: pushedLastHour(),
    pushedLast24h:
      get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE pushed_at IS NOT NULL AND pushed_at >= ?", day)?.n ?? 0,
    totalPushed: get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE pushed_at IS NOT NULL")?.n ?? 0,
    queued: queue.length,
    lastHourLogs: get<{ n: number }>("SELECT COUNT(*) AS n FROM push_log WHERE created_at >= ?", since)?.n ?? 0,
    failures: get<{ n: number }>("SELECT COUNT(*) AS n FROM push_log WHERE ok = 0 AND created_at >= ?", day)?.n ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Preview: runs the full set of push filters once and reports the block reasons per dimension
 * ------------------------------------------------------------------ */

export function previewPush(limit = 6): {
  instant: string[];
  batch: string[];
  queued: number;
  scanned: number;
  matched: number;
  /** Total number of items eligible for "instant" (not limited by the display count) */
  instantTotal: number;
  /** How many of this batch can really go out instantly given the per-round instant cap and the hourly budget */
  sendableInstant: number;
  /** Total number of items eligible for "batch" (including those pushed over from the instant cap) */
  batchTotal: number;
  /** Number of items pushed into the batch queue by the instant cap */
  deferred: number;
  /** Items already pushed this hour */
  usedThisHour: number;
  caps: { maxPerInstant: number; maxPerHour: number; maxPerBatch: number; batchIntervalMin: number; budget: number };
  rejectedBy: {
    blocked: number;
    duplicate: number;
    stale: number;
    source: number;
    lang: number;
    kind: number;
    category: number;
    price: number;
    ai: number;
    obtain: number;
    route: number;
    interest: number;
    lowScore: number;
  };
} {
  const s = getPushSettings();
  const rules = loadActiveBlockRules();
  const subKeywords = all<{ keyword: string }>("SELECT keyword FROM subscriptions").map((r) => r.keyword);
  const lookbackHours = s.maxAgeHours > 0 ? Math.min(s.maxAgeHours, 168) : 168;
  const rows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    pushed_at: string | null;
published_at: string | null;
    ai: string | null;
    canonical_id: number | null;
    title_en: string | null;
    summary_en: string | null;
  }>(
    `SELECT id, source_id, title, summary, title_en, summary_en, url, category, kind, score, codes, price, is_free, obtain, expires_at, pushed_at, published_at, ai, canonical_id
     FROM items WHERE status = 'active' AND pushed_at IS NULL AND COALESCE(published_at, first_seen_at) >= ?
     ORDER BY score DESC LIMIT 180`,
    new Date(Date.now() - lookbackHours * 3_600_000).toISOString(),
  );

  const instant: string[] = [];
  const batch: string[] = [];
  let matched = 0;
  /** Number of items truly eligible for "instant" after dedupe (not limited by the display count) */
  let instantTotal = 0;
  /** Number of items eligible for "batch" after dedupe (including those pushed over from the instant cap, appended at the end) */
  let batchTotal = 0;
  const rejectedBy = {
    blocked: 0,
    duplicate: 0,
    stale: 0,
    source: 0,
    lang: 0,
    kind: 0,
    category: 0,
    price: 0,
    ai: 0,
    obtain: 0,
    route: 0,
    interest: 0,
    lowScore: 0,
  };
  const deduper = s.dedupeByTitle ? new TitleDeduper(rows, recentPushedSeeds(true)) : null;
  const hasRoutes = s.routes?.some((r) => r.enabled);

  for (const r of rows) {
    if (isBlocked(r, rules)) {
      rejectedBy.blocked += 1;
      continue;
    }
    if (deduper?.isDuplicate(r)) {
      rejectedBy.duplicate += 1;
      continue;
}
    // Reuse the cluster key stored by AI semantic dedupe for free: items already pushed in the same cluster are honestly shown as duplicates in the preview
    if (r.canonical_id != null) {
      const pushedSibling = get<{ id: number }>(
        "SELECT id FROM items WHERE pushed_at IS NOT NULL AND canonical_id = ? AND id != ? LIMIT 1",
        r.canonical_id,
        r.id,
      );
      if (pushedSibling) {
        rejectedBy.duplicate += 1;
        continue;
      }
    }
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const aiMeta = parseAiMeta(r.ai);
    const fresh: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: aiMeta.aiKeep,
      aiReason: aiMeta.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      title_en: r.title_en,
      summary_en: r.summary_en,
      canonicalId: r.canonical_id,
    };
    const reject = checkPushFilter({ ...fresh, sourceId: r.source_id }, s);
    if (reject) {
      rejectedBy[reject] = (rejectedBy[reject] ?? 0) + 1;
      continue;
    }

    matched += 1;
    const subHits = matchSubscriptions(fresh, subKeywords);
    const route = hasRoutes ? matchPushRoute(fresh, s.routes) : null;
    const d = decide(fresh, s, subHits, route);
    const batchable = canEnterBatch(fresh, s, d);
    if (d.push) instantTotal += 1;
    else if (batchable) batchTotal += 1;
    else {
      rejectedBy.lowScore += 1;
      continue;
    }
    const block = itemBlock(r.source_id, fresh, s, undefined, subHits).join("\n");
    deduper?.markSeen(r);
    if (d.push && instant.length < limit) {
      const prefix = route?.header ? route.header + " · " : s.customHeader ? s.customHeader + " · " : "⚡ ";
      instant.push(prefix + d.reason + "\n" + block);
    } else if (!d.push && batchable && batch.length < limit) {
      const routeNote = hasRoutes && route ? `[Route: ${route.name}]\n` : "";
      batch.push(routeNote + block);
    }
  }
  const usedThisHour = pushedLastHour();
  // Reuse the real push algorithm: what the preview calls "can send N" is what actually gets sent
  const plan = planInstant(instantTotal, s, usedThisHour);
  const sendableInstant = plan.send;
  const deferred = plan.defer;
  return {
    instant,
    batch,
    queued: queue.length,
    scanned: rows.length,
    matched,
    instantTotal,
    sendableInstant,
    batchTotal: batchTotal + deferred,
    deferred,
    usedThisHour,
    caps: {
      maxPerInstant: s.maxPerInstant,
      maxPerHour: s.maxPerHour,
      maxPerBatch: s.maxPerBatch,
      batchIntervalMin: s.batchIntervalMin,
      budget: plan.budget,
    },
    rejectedBy,
  };
}
