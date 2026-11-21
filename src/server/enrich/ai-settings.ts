import { config } from "../config.ts";
import { all, get, run } from "../db.ts";
import type { RawItem } from "../collectors/types.ts";
import { isNoiseTitle } from "./noise.ts";
import { FREEBIE_ONLY_SOURCES } from "./index.ts";
import type { ObtainMode } from "./obtain.ts";
import { isContentKind, type ContentKind } from "./kind.ts";
import { finishAiJob, recordAiBatch, startAiJob } from "./ai-telemetry.ts";

import { CATEGORY_DESC, CATEGORY_KEYS } from "../../shared/taxonomy.ts";
import { CLASSIFICATION_PROMPT } from "./evidence.ts";

export type AiVerdict = {
  index: number;
  keep: boolean;
  /** Content kind: freebie=free stuff | deal=deal/discount | opensource=open-source project | info=practical guide | noise=noise */
  kind?: ContentKind;
  category: string;
  reason: string;
  /** Obtain mode: decided by AI; falls back to rules when missing */
  obtain?: ObtainMode;
  /** 1-5 quality score: 5=high-value must-see/must-grab, 4=clearly good, 3=average, 2=marginal, 1=noise */
  quality?: number;
};

export type AiSourceMode = "all" | "exclude" | "only";

export type AiSettings = {
  /** Master switch: when off, collection no longer auto-submits for review */
  enabled: boolean;
  /** OpenAI-compatible endpoint, including /v1 */
  baseUrl: string;
  /** API key; the UI only shows the last four characters */
  apiKey: string;
  /** Model name */
  model: string;
  /** Max items submitted per round (20-500) */
  maxItems: number;
  /** Items per batch (2-20, default 6) */
  batchSize: number;
  /** Concurrent batches (1-8, default 4) */
  concurrency: number;
  /** Per-batch request timeout in seconds (5-60, default 15) */
  timeoutSec: number;
  /** First-pass rule pre-filter: when on, skips hard noise such as help requests / price questions / version-update notes so AI quota is not wasted */
  preFilterEnabled: boolean;
  /** User-defined entry block keywords: a match skips review and is not pushed directly */
  customNoiseKeywords: string[];
  /** Freebie-only sources (Epic/Steam/GamerPower, etc.) skip AI review and are treated as genuine freebies */
  skipFreebieSources: boolean;
  /** Review source scope: all = everything / exclude = exclude the listed sources / only = review only the listed sources */
  sourceMode: AiSourceMode;
  /** Source ID list used together with sourceMode */
  sourceIds: string[];
  /** Supplementary review rules (appended after the built-in default rubric without breaking the JSON output requirement) */
  extraPrompt: string;
  /** Advanced: fully custom main prompt; leave blank to use the built-in default */
  systemPrompt: string;
  /** true = automatically learn preferences from user stars (positive) and manual dismissals (negative) */
  learnFromFeedback: boolean;
  /** How many most recent samples to draw from each of the positive/negative sets (1-15, default 6) */
  feedbackLimit: number;
  /** Whether to enable AI semantic dedup (prevents duplicates after review insert and before Telegram push) */
  aiDedupEnabled: boolean;
  /** AI semantic dedup comparison window in hours (6-168, default 48) */
  aiDedupWindowHours: number;
};

const SETTINGS_KEY = "ai";
const DEFAULT_MAX_ITEMS = 60;

/** Category list and descriptions are generated from shared/taxonomy.ts, so adding categories needs no prompt edits */
const CATEGORY_PROMPT_LINE = `The category field can only be one of: ${CATEGORY_KEYS.join(" | ")}`;
const CATEGORY_DESC_LINE = `Subcategory reference: ${CATEGORY_KEYS.map((k) => `${k}=${CATEGORY_DESC[k]}`).join(";")}.`;
const DEFAULT_PROMPT = [
  "You are the content moderator and tagger for multi-topic communities and the Resource Radar. Your task is to filter out low signal-to-noise filler posts and accurately classify valuable content into free stuff / deals / open-source projects / important news / industry news; do not misclassify open-source projects, Black Friday deals, compliant carpool arrangements, or high-value major news / economic, stock and tech information as noise.",
  "",
  "Five kinds of valid content get keep=true (also set kind clearly):",
  "1. freebie (free stuff): limited-time free games / genuine software licenses, redemption codes/CDKs/public-benefit credits/free tokens, free cloud hosts/domains/GPUs/compute/student packs, freebie guides you can actually follow to claim, and newly launched OpenRouter :free models.",
  "   Counter-examples: reviews, usage logs, hands-on impressions, buying guides, ranked recommendations, head-to-head comparisons and copy-my-list posts are not freebie (there is nothing to claim); they should be kind=info. Only things you can actually claim or get for free are freebie.",
  "2. deal (deals / carpools / resale): clearly cost-effective paid promotions and all-time-low discounts (e.g. Black Friday / anniversary VPS deals, annual-billed small VPS, Steam all-time lows, genuine software buyout sales), plus legitimately organized carpools/shared subscriptions with a clearly stated price (e.g. ChatGPT/Claude/Netflix family-plan seats) or resale/transfer posts with a clearly stated price. Do not block good deals or seats just because they require payment.",
  "   Hard constraint: when the title contains Chinese trade-intent words such as N出 / 溢价N出 / 出 / 收 / 转让 / 过户 / 出号 / 车位 / 合租 / 拼团 / 独享车 and also carries a price or payment method, kind must be deal and never info (50出zouter = reselling zouter for 50 yuan; that is a deal, not information).",
  "3. opensource (open-source project): must have an explicit GitHub/GitLab repository, source code, or a deployable self-hosted tool, or an MCP/Agent/Docker project release or recommendation. Pure tech news (no open-source repo/source release) must not be tagged opensource.",
  "4. news (important news): limited to current-affairs headlines, national policies and regulations, State Council / ministry announcements, international affairs, diplomatic summits and major livelihood news from authoritative outlets such as CCTV News / China News Service / BBC / Deutsche Welle. Consumer shopping guides, e-commerce or brand gossip and gadget news from outlets like 什么值得买 (SMZDM) / IT之家 (ITHome) / community forums must not be tagged news (they should be deal or info).",
  "5. info (industry information): macroeconomics and finance, stocks/funds/IPO/earnings market updates, big-tech/chip/AI frontier news, hardware and gadget reviews, and developer tech newsletters / in-depth guides.",
  "",
  "Noise that gets keep=false (also set kind='noise'): only block genuinely worthless content:",
  "- Help requests / questions / recommendation asks / carpool asks / pure wanted-to-buy posts (e.g. Chinese example titles like 谁有优惠券, 求推荐便宜VPS, 求一个ChatGPT拼车, 收一台RN传家宝, 报错429怎么解决)",
  "- Vague proxy-buying lead generation, course sales or promotional advertorials (especially clickbait whose title looks free but whose body or ending demands adding a WeChat contact / a private message / commenting 1 / following to claim / a rebate link / paid unlock before you get anything)",
  "- Run-of-the-mill game patch notes with nothing notable (e.g. 修复若干闪退, meaning fixed a few crashes, while the game itself still requires paying full price)",
  "- Gossip, flame-bait, pure venting/discussion posts (e.g. 怎么看待白嫖, 如何评价...) or vague advertorials with no actual claim path",
  "- Ordinary full-price promotions with no notable discount",
  "",
  CATEGORY_PROMPT_LINE,
  CATEGORY_DESC_LINE,
  "Also determine the obtain mode (obtain), which can only be:",
  "- free: open it and get it for free directly, or free to use as open source, with no lottery or payment required",
  "- conditional: requires registration, identity verification, filling out a form, check-in point accrual, a reply, or new-user conditions to claim",
  "- lottery: raffle / luck-of-the-draw / random giveaway",
  "- lottery rule: if the title contains Sweepstakes / Winners / 抽奖 / 抽选 / 摇号 / 赢取, always set obtain=lottery and category=lottery; do not mark it free. A Steam/Epic Giveaway is a free game claim, so still mark it free.",
  "- trial: a short-term commercial SaaS trial that stops working once it expires without payment",
  "- promo: pure commercial lead-generation hook",
  "- paid: requires an actual paid purchase (e.g. Black Friday VPS deals, all-time-low games, buyout software)",
  "",
  "Also give a 1-5 quality score: 5=extremely high value (AAA game giveaway / unbeatable Black Friday VPS / hit open-source project / large token grant / major state-media headline), 4=clearly good content (new :free model / cost-effective annual-billed small VPS / practical open-source tool / important finance or tech information), 3=average or conditional, 2=heavily restricted / marginal, 1=noise.",
  'Return a JSON array whose elements look like {"index":0,"keep":true,"kind":"deal","category":"vps","obtain":"paid","quality":5,"reason":"Black Friday deal $10.99/yr KVM VPS"}.',
  "Write reason in English as a single phrase of no more than 8 words, stating the highlight or the block reason; output no extra text.",
].join("\n");

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: Boolean(config.aiBaseUrl && config.aiModel),
  baseUrl: config.aiBaseUrl,
  apiKey: config.aiApiKey,
  model: config.aiModel,
  maxItems: Math.min(Math.max(config.aiMaxItems, 20), 500),
  batchSize: 6,
  concurrency: 4,
  timeoutSec: 15,
  preFilterEnabled: true,
  customNoiseKeywords: [],
  skipFreebieSources: false,
  sourceMode: "all",
  sourceIds: [],
  extraPrompt: "",
  systemPrompt: "",
  learnFromFeedback: true,
  feedbackLimit: 6,
  aiDedupEnabled: true,
  aiDedupWindowHours: 48,
};

function numOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function normalizeStringList(v: unknown, maxLen = 40, maxCount = 80): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, maxLen))
        .filter(Boolean),
    ),
  ].slice(0, maxCount);
}

function normalizeSourceMode(v: unknown): AiSourceMode {
  return v === "exclude" || v === "only" ? v : "all";
}

function normalizeSettings(raw: Partial<AiSettings>, base: AiSettings): AiSettings {
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : base.baseUrl,
    apiKey:
      typeof raw.apiKey === "string" && raw.apiKey.trim() && !raw.apiKey.startsWith("••••")
        ? raw.apiKey.trim()
        : base.apiKey,
    model: typeof raw.model === "string" ? raw.model.trim() : base.model,
    maxItems: numOr(raw.maxItems, base.maxItems, 20, 500),
    batchSize: numOr(raw.batchSize, base.batchSize, 2, 20),
    concurrency: numOr(raw.concurrency, base.concurrency, 1, 8),
    timeoutSec: numOr(raw.timeoutSec, base.timeoutSec, 5, 60),
    preFilterEnabled: typeof raw.preFilterEnabled === "boolean" ? raw.preFilterEnabled : base.preFilterEnabled,
    customNoiseKeywords: "customNoiseKeywords" in raw ? normalizeStringList(raw.customNoiseKeywords) : base.customNoiseKeywords,
    skipFreebieSources: typeof raw.skipFreebieSources === "boolean" ? raw.skipFreebieSources : base.skipFreebieSources,
    sourceMode: "sourceMode" in raw ? normalizeSourceMode(raw.sourceMode) : base.sourceMode,
    sourceIds: "sourceIds" in raw ? normalizeStringList(raw.sourceIds, 60, 200) : base.sourceIds,
    extraPrompt: typeof raw.extraPrompt === "string" ? raw.extraPrompt : base.extraPrompt,
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : base.systemPrompt,
    learnFromFeedback: typeof raw.learnFromFeedback === "boolean" ? raw.learnFromFeedback : base.learnFromFeedback,
    feedbackLimit: numOr(raw.feedbackLimit, base.feedbackLimit, 1, 15),
    aiDedupEnabled: typeof raw.aiDedupEnabled === "boolean" ? raw.aiDedupEnabled : base.aiDedupEnabled,
    aiDedupWindowHours: numOr(raw.aiDedupWindowHours, base.aiDedupWindowHours, 6, 168),
  };
}

export function getAiSettings(): AiSettings {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", SETTINGS_KEY);
  if (!row) return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = JSON.parse(row.value) as Partial<AiSettings>;
    return normalizeSettings(raw, DEFAULT_AI_SETTINGS);
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function saveAiSettings(patch: Partial<AiSettings>): AiSettings {
  const cur = getAiSettings();
  const next = normalizeSettings(patch, cur);
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    SETTINGS_KEY,
    JSON.stringify(next),
    new Date().toISOString(),
  );
  return next;
}

/** Whether AI can actually be called at runtime (switch on, endpoint and model present). */
export function aiReady(s = getAiSettings()): boolean {
  return s.enabled && Boolean(s.baseUrl && s.model);
}

/** Whether the entry noise pre-filter is hit (help requests / price questions / version-update notes + user-defined noise keywords). */
export function matchesEntryNoise(title: string, s = getAiSettings()): boolean {
  if (!s.preFilterEnabled) return false;
  if (isNoiseTitle(title)) return true;
  if (s.customNoiseKeywords.length) {
    const lower = title.toLowerCase();
    if (s.customNoiseKeywords.some((kw) => lower.includes(kw.toLowerCase()))) return true;
  }
  return false;
}

/** Whether this source needs to be sent to AI review. When it returns false and the item is not noise, a freebie-only source may be treated as auto-approved. */
export function shouldPassSourceToAi(sourceId: string, s = getAiSettings()): boolean {
  if (s.skipFreebieSources && FREEBIE_ONLY_SOURCES.has(sourceId)) return false;
  if (s.sourceMode === "exclude" && s.sourceIds.includes(sourceId)) return false;
  if (s.sourceMode === "only" && !s.sourceIds.includes(sourceId)) return false;
  return true;
}

export function feedbackStats(limit = 6): {
  positive: number;
  negative: number;
  positiveSamples: string[];
  negativeSamples: string[];
} {
  const n = Math.min(Math.max(Math.round(limit), 1), 15);
  try {
    const pos = get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE starred = 1")?.n ?? 0;
    const neg = get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE status = 'ignored'")?.n ?? 0;
    const positiveSamples = all<{ title: string }>(
      "SELECT title FROM items WHERE starred = 1 ORDER BY last_seen_at DESC LIMIT ?",
      n,
    ).map((r) => r.title.slice(0, 80));
    const negativeSamples = all<{ title: string }>(
      "SELECT title FROM items WHERE status = 'ignored' ORDER BY last_seen_at DESC LIMIT ?",
      n,
    ).map((r) => r.title.slice(0, 80));
    return { positive: pos, negative: neg, positiveSamples, negativeSamples };
  } catch {
    return { positive: 0, negative: 0, positiveSamples: [], negativeSamples: [] };
  }
}

/** Safe view for the frontend: the API key is masked. */
export function publicAiSettings(s = getAiSettings()) {
  return {
    apiKey: "",
    enabled: s.enabled,
    baseUrl: s.baseUrl,
    model: s.model,
    maxItems: s.maxItems,
    batchSize: s.batchSize,
    concurrency: s.concurrency,
    timeoutSec: s.timeoutSec,
    preFilterEnabled: s.preFilterEnabled,
    customNoiseKeywords: s.customNoiseKeywords,
    skipFreebieSources: s.skipFreebieSources,
    sourceMode: s.sourceMode,
    sourceIds: s.sourceIds,
    extraPrompt: s.extraPrompt,
    systemPrompt: s.systemPrompt,
    learnFromFeedback: s.learnFromFeedback,
    feedbackLimit: s.feedbackLimit,
    aiDedupEnabled: s.aiDedupEnabled,
    aiDedupWindowHours: s.aiDedupWindowHours,
    hasKey: Boolean(s.apiKey),
    keyHint: s.apiKey ? "••••" + s.apiKey.slice(-4) : "",
    ready: aiReady(s),
    promptIsDefault: !s.systemPrompt.trim(),
    defaultPrompt: DEFAULT_PROMPT,
  };
}

function buildSystemPrompt(s: AiSettings): string {
  const parts: string[] = [s.systemPrompt.trim() || DEFAULT_PROMPT];
  if (s.extraPrompt.trim()) {
    parts.push("", "Supplementary review rules (must be followed with priority):", s.extraPrompt.trim());
  }
  parts.push("", CLASSIFICATION_PROMPT);
  if (!s.learnFromFeedback) return parts.join("\n");
  try {
    const fb = feedbackStats(s.feedbackLimit);
    if (!fb.positiveSamples.length && !fb.negativeSamples.length) return parts.join("\n");
    parts.push("", "The following comes from recent real user actions (match these preferences first):");
    if (fb.positiveSamples.length) {
      parts.push("Positive samples the user starred (similar items should be keep=true): " + fb.positiveSamples.map((t) => `${t}`).join(", "));
    }
    if (fb.negativeSamples.length) {
      parts.push("Negative samples the user manually dismissed (similar items should be keep=false): " + fb.negativeSamples.map((t) => `${t}`).join(", "));
    }
  } catch {
    /* ignore */
  }
  return parts.join("\n");
}

type CallResult = { map: Map<number, AiVerdict>; ttfbMs: number };

async function callOnce(
  payload: { index: number; title: string; summary: string }[],
  s: AiSettings,
): Promise<CallResult> {
  const endpoint = s.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const timeoutMs = s.timeoutSec * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  const tag = `[ai] batch n=${payload.length} idx=${payload[0]?.index ?? "-"}`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(s.apiKey ? { authorization: "Bearer " + s.apiKey } : {}),
      },
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        messages: [
          { role: "system", content: buildSystemPrompt(s) },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: ac.signal,
    });
    const ttfb = Date.now() - t0;
    if (!res.ok) throw new Error("AI HTTP " + res.status + " " + (await res.text()).slice(0, 120));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    console.log(`${tag} done ${Date.now() - t0}ms (headers ${ttfb}ms)`);
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonText = /\[[\s\S]*\]/.exec(content)?.[0];
    if (!jsonText) throw new Error("AI did not return a JSON array");
    const arr = JSON.parse(jsonText) as AiVerdict[];
    const map = new Map<number, AiVerdict>();
    for (const v of arr) {
      if (typeof v?.index === "number") map.set(v.index, v);
    }
    return { map, ttfbMs: ttfb };
  } finally {
    clearTimeout(timer);
  }
}

export type ReviewBatchEvent = {
  start: number;
  count: number;
  items: RawItem[];
  verdicts: Map<number, AiVerdict> | null;
  ttfbMs: number | null;
  error?: string;
};

function aiSummaryExcerpt(it: { summary?: string | null; content?: string | null }): string {
  const raw = (it.content || it.summary || "").replace(/\s+/g, " ").trim();
  if (raw.length <= 420) return raw;
  return `${raw.slice(0, 240)} … ${raw.slice(-170)}`;
}

/**
 * Submit items for review and return a mapping of index → verdict. Returns null when disabled or when all attempts failed.
 * When there are more items than maxItems, truncate to maxItems, then run concurrently by batchSize / concurrency.
 */
export async function reviewItems(
  items: RawItem[],
  settings?: AiSettings,
  hooks?: { onBatch?: (ev: ReviewBatchEvent) => void },
): Promise<Map<number, AiVerdict> | null> {
  const s = settings ?? getAiSettings();
  if (!aiReady(s) || !items.length) return null;

  const total = Math.min(items.length, s.maxItems);
  const merged = new Map<number, AiVerdict>();
  let ok = 0;

  type Job = { start: number; chunk: RawItem[]; payload: { index: number; title: string; summary: string }[] };
  const jobs: Job[] = [];
  for (let start = 0; start < total; start += s.batchSize) {
    const chunk = items.slice(start, Math.min(start + s.batchSize, total));
    jobs.push({
      start,
      chunk,
      payload: chunk.map((it, i) => ({
        index: start + i,
        title: (it.title ?? "").slice(0, 140),
        summary: aiSummaryExcerpt(it),
      })),
    });
  }

  const runJob = async (job: Job): Promise<CallResult | null> => {
    let lastErr: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await callOnce(job.payload, s);
        hooks?.onBatch?.({
          start: job.start,
          count: job.chunk.length,
          items: job.chunk,
          verdicts: res.map,
          ttfbMs: res.ttfbMs,
        });
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastErr = msg;
        if (attempt === 0) {
          console.log(`[ai] retry n=${job.payload.length} idx=${job.start}:${msg.slice(0, 60)}`);
          continue;
        }
        console.log(`[ai] giving up n=${job.payload.length} idx=${job.start}:${msg.slice(0, 60)}`);
      }
    }
    hooks?.onBatch?.({
      start: job.start,
      count: job.chunk.length,
      items: job.chunk,
      verdicts: null,
      ttfbMs: null,
      error: lastErr,
    });
    return null;
  };

  for (let i = 0; i < jobs.length; i += s.concurrency) {
    const wave = jobs.slice(i, i + s.concurrency);
    const results = await Promise.all(wave.map(runJob));
    for (const res of results) {
      if (!res) continue;
      for (const [k, v] of res.map) merged.set(k, v);
      ok += 1;
    }
  }

  return ok > 0 ? merged : null;
}

/** Connectivity test: accepts a form draft for a direct test (no need to save first), and returns the full verdict fields plus elapsed time. */
export async function testAiConnection(draft?: Partial<AiSettings>): Promise<{
  ok: boolean;
  ms: number;
  model: string;
  results: { title: string; keep: boolean; kind: string; category: string; obtain: string; quality: number | null; reason: string }[];
  error?: string;
}> {
  const cur = getAiSettings();
  const s: AiSettings = {
    ...normalizeSettings(draft ?? {}, cur),
    enabled: true, // the test endpoint allows verifying connectivity before the master switch is turned on
  };
  if (!s.baseUrl || !s.model) {
    return { ok: false, ms: 0, model: s.model, results: [], error: "Please fill in the API endpoint and model name first" };
  }

  const samples: RawItem[] = [
    { externalId: "t1", url: "https://example.com/1", title: "【福利】送 5 个 500M 动态IP测试，先到先得", summary: "回复即可" },
    { externalId: "t2", url: "https://example.com/2", title: "[黑五特惠] RackNerd 2核2G KVM VPS 年付 $10.99", summary: "黑五促销" },
    { externalId: "t3", url: "https://example.com/3", title: "开源自托管轻量状态监控面板 v2.1 发布 (Docker/MIT)", summary: "GitHub 开源" },
    { externalId: "t4", url: "https://example.com/4", title: "谁有 ovh 年付 10% 优惠券哇", summary: "求优惠券" },
  ] as RawItem[];

  const t0 = Date.now();
  const jobId = startAiJob({
    stage: "test",
    label: "Draft-config connectivity test",
    model: s.model,
    total: samples.length,
    totalBatches: Math.ceil(samples.length / s.batchSize),
  });
  try {
    const map = await reviewItems(samples, s, {
      onBatch: (ev) => {
        let kept = 0;
        let rejected = 0;
        const events = [];
        for (let i = 0; i < ev.items.length; i += 1) {
          const v = ev.verdicts?.get(ev.start + i);
          if (!v) continue;
          const keep = Boolean(v.keep);
          if (keep) kept += 1;
          else rejected += 1;
          events.push({
            title: ev.items[i]!.title,
            keep,
            kind: isContentKind(v.kind) ? v.kind : keep ? "freebie" : "noise",
            category: v.category ?? "-",
            quality: typeof v.quality === "number" ? v.quality : null,
            reason: v.reason ?? "",
            at: new Date().toISOString(),
          });
        }
        recordAiBatch(jobId, {
          events,
          kept,
          rejected,
          failed: ev.verdicts ? 0 : ev.count,
          ttfbMs: ev.ttfbMs,
        });
      },
    });
    const ms = Date.now() - t0;
    if (!map) {
      finishAiJob(jobId, { error: "Model returned no valid verdict" });
      return { ok: false, ms, model: s.model, results: [], error: "Model returned no valid verdict (check the endpoint / Key / model name or timeout setting)" };
    }
    finishAiJob(jobId);
    return {
      ok: true,
      ms,
      model: s.model,
      results: samples.map((it, i) => {
        const v = map.get(i);
        const keep = v?.keep ?? false;
        const kind = isContentKind(v?.kind) ? v.kind : keep ? "freebie" : "noise";
        return {
          title: it.title,
          keep,
          kind,
          category: v?.category ?? "-",
          obtain: v?.obtain ?? "-",
          quality: typeof v?.quality === "number" ? v.quality : null,
          reason: v?.reason ?? "(no verdict)",
        };
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishAiJob(jobId, { error: msg });
    return {
      ok: false,
      ms: Date.now() - t0,
      model: s.model,
      results: [],
      error: msg,
    };
  }
}

export { DEFAULT_PROMPT };
