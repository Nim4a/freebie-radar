/**
 * Combined score: multi-dimensional weighting, led by the AI quality score.
 *
 * The old implementation was pure keyword addition (baseline 30, free +15, any freebie word +10/14, within 24h +16 ...),
 * so a title stuffed with "free / freebie / limited time" could reach a high score while the AI quality score played no part at all.
 * This is now a weighted sum of five 0-100 dimensions multiplied by a penalty factor:
 *
 * Obtain certainty 30%  one band each for free/conditional/trial/lottery/promo/paid; paid follows the price band
 * AI quality      35%  1-5 maps to 8/30/55/80/100; unreviewed items fall back to the rule content score x0.9
 * Recency         15%  continuous decay, no more jumps at 24h/3d/7d
 * Source trust    10%  computed from the real 30-day AI retention rate + average quality score, no hard-coded table
 * Verifiability   10%  redemption codes, limited/limited-time, concrete quantities - the easier it is to verify "this freebie is real", the higher
 *
 * Penalties (multiplicative): questions/help requests x0.55, engagement bait (add WeChat / DM / comment below) x0.6, too-short title x0.72.
 */

import { all } from "../db.ts";
import { isNoiseTitle, URGENT } from "./noise.ts";

/** Dimension weights, summing to 1. Change these to retune the model. */
export const SCORE_WEIGHTS = {
  obtain: 0.3,
  quality: 0.35,
  freshness: 0.15,
  trust: 0.1,
  proof: 0.1,
} as const;

export type ScoreCtx = {
  title?: string;
  summary?: string;
  publishedAt?: string | null;
  sourceId?: string;
  codes?: string[];
  price?: number | null;
};

export type ScoreBreakdown = {
  total: number;
  obtain: number;
  quality: number;
  freshness: number;
  trust: number;
  proof: number;
  penalty: number;
  notes: string[];
};

function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Obtain certainty: this dimension answers "can you click and get it". */
const OBTAIN_SCORE: Record<string, number> = {
  free: 100,
  conditional: 72,
  trial: 35,
  lottery: 22,
  promo: 6,
  paid: 30,
};

export function obtainScore(
  obtain: string | null | undefined,
  kind?: string | null,
  price?: number | null,
): number {
  const key = obtain ?? "";
  if (key !== "paid") return OBTAIN_SCORE[key] ?? 55;
  // For paid items look at the kind: a Black Friday deal / news / open source is "worth buying", ordinary paid items in the freebie feed should mostly not score high
  if (kind === "deal" || kind === "news" || kind === "info" || kind === "opensource") {
    const p = typeof price === "number" && price >= 0 ? price : null;
    if (p === null) return 65;
    if (p <= 10) return 70;
    if (p <= 50) return 55;
    if (p <= 200) return 38;
    return 22;
  }
  return 25;
}

/** AI quality curve: 1 means out, 5 is full marks. Falls back to the rule content score when unreviewed. */
const QUALITY_CURVE: Record<number, number> = { 1: 8, 2: 30, 3: 55, 4: 80, 5: 100 };

export function qualityScore(quality: number | null | undefined, ruleScore: number): number {
  if (typeof quality === "number" && Number.isFinite(quality)) {
    const q = Math.min(5, Math.max(1, Math.round(quality)));
    return QUALITY_CURVE[q] ?? 55;
  }
  return clamp(Math.round(ruleScore * 0.9));
}

/** Recency: continuous decay, newer is higher, no more 24h/3d/7d cliffs. */
export function freshnessScore(publishedAt: string | null | undefined): number {
  if (!publishedAt) return 55;
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t)) return 55;
  const hours = (Date.now() - t) / 3_600_000;
  if (hours < 0) return 100;
  if (hours <= 6) return 100;
  if (hours <= 24) return clamp(92 - ((hours - 6) / 18) * 10);
  if (hours <= 72) return clamp(82 - ((hours - 24) / 48) * 17);
  if (hours <= 168) return clamp(65 - ((hours - 72) / 96) * 20);
  if (hours <= 720) return clamp(45 - ((hours - 168) / 552) * 35);
  return 5;
}

type SourceStat = { reviewed: number; keepRate: number; avgQuality: number };

const TRUST_TTL_MS = 10 * 60_000;
let trustCache: { at: number; map: Map<string, SourceStat> } | null = null;

/** Source trust: real 30-day AI retention rate + average quality score. Fewer than 5 samples is treated as a neutral 50. */
export function sourceTrustMap(): Map<string, SourceStat> {
  if (trustCache && Date.now() - trustCache.at < TRUST_TTL_MS) return trustCache.map;
  const map = new Map<string, SourceStat>();
  try {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = all<{ source_id: string; reviewed: number; kept: number; avgq: number | null }>(
      `SELECT source_id,
              COUNT(*) AS reviewed,
              SUM(CASE WHEN ai_keep = 1 THEN 1 ELSE 0 END) AS kept,
              AVG(ai_quality) AS avgq
         FROM items
        WHERE ai_keep IS NOT NULL
          AND first_seen_at >= ?
        GROUP BY source_id`,
      since,
    );
    for (const r of rows) {
      if (!r.reviewed || r.reviewed < 5) continue;
      map.set(r.source_id, {
        reviewed: r.reviewed,
        keepRate: r.kept / r.reviewed,
        avgQuality: r.avgq ?? 3,
      });
    }
  } catch {
    // treat it as neutral when the table is not built yet or the query fails; it does not affect storage
  }
  trustCache = { at: Date.now(), map };
  return map;
}

export function resetTrustCache(): void {
  trustCache = null;
}

export function trustScore(sourceId: string | undefined, map = sourceTrustMap()): number {
  if (!sourceId) return 50;
  const s = map.get(sourceId);
  if (!s) return 50;
  const q = (Math.min(5, Math.max(1, s.avgQuality)) - 1) / 4;
  return clamp(s.keepRate * 60 + q * 40);
}

const QUANTITY_RE = /\d+\s*(?:个|份|名|台|张|次|天|GB|TB|MB|元|美刀|刀)/i;
const SCARCITY_RE = /限量|限时|先到先得|手慢无|名额|库存|剩余|抢完|截止/i;

/** Verifiability: the easier it is to verify "this freebie is real and still claimable" right now, the higher. */
export function proofScore(title: string, codes?: string[]): number {
  let s = 20;
  if (codes?.length) s += 50;
  if (SCARCITY_RE.test(title)) s += 20;
  if (QUANTITY_RE.test(title)) s += 15;
  if (URGENT.test(title)) s += 10;
  return clamp(s);
}

const LURE_RE =
  /加微|加\s*V|微信|私信|关注(?:后|领|即可|才)|评论区?\s*扣|扣\s*1|返利|返现|\baff\b|扫码进群|进群领|付费解锁/i;

/** Multiplicative penalty: the common fingerprint of clickbait and engagement bait. */
export function penaltyFactor(title: string, summary = ""): { factor: number; notes: string[] } {
  const notes: string[] = [];
  let factor = 1;
  if (isNoiseTitle(title)) {
    factor *= 0.55;
    notes.push("question/help request");
  }
  if (LURE_RE.test(`${title} ${summary}`)) {
    factor *= 0.6;
    notes.push("engagement bait");
  }
  // only judge the length when a title was actually given; do not invent a penalty when ctx is missing
  if (title && title.trim().length < 6) {
    factor *= 0.72;
    notes.push("title too short");
  }
  return { factor: Math.max(0.15, factor), notes };
}

/**
 * Produces the final score.
 *
 * Missing dimensions (no publish time, not enough source samples) are excluded from the weighting and their weight is redistributed over the rest -
 * otherwise "unknown" is treated as "slightly below average" and drags every new source's score down.
 *
 * rule content score (scoreItem's result, 0-100), used only as the quality fallback when the AI has not reviewed the item
 */
export function combineScore(
  ruleScore: number,
  obtain: string | null | undefined,
  aiKeep: boolean | null,
  quality: number | null | undefined,
  kind: string | null | undefined,
  ctx: ScoreCtx = {},
): ScoreBreakdown {
  const trustMap = sourceTrustMap();
  const dims = {
    obtain: obtainScore(obtain, kind, ctx.price),
    quality: qualityScore(quality, ruleScore),
    freshness: freshnessScore(ctx.publishedAt ?? null),
    trust: trustScore(ctx.sourceId, trustMap),
    proof: proofScore(ctx.title ?? "", ctx.codes),
  };

  if (aiKeep === false || kind === "noise") {
    // the AI rejected it or it is noise: push it straight to the bottom without weighting, so keywords cannot drag junk back up
    return { total: Math.min(Math.round(ruleScore * 0.25), 25), ...dims, penalty: 0.25, notes: ["AI rejected"] };
  }

  const parts: Array<{ key: keyof typeof dims; weight: number; known: boolean }> = [
    { key: "obtain", weight: SCORE_WEIGHTS.obtain, known: true },
    { key: "quality", weight: SCORE_WEIGHTS.quality, known: true },
    { key: "freshness", weight: SCORE_WEIGHTS.freshness, known: Boolean(ctx.publishedAt) },
    { key: "trust", weight: SCORE_WEIGHTS.trust, known: Boolean(ctx.sourceId && trustMap.has(ctx.sourceId)) },
    { key: "proof", weight: SCORE_WEIGHTS.proof, known: true },
  ];

  let knownWeight = 0;
  let weighted = 0;
  for (const p of parts) {
    if (!p.known) continue;
    knownWeight += p.weight;
    weighted += dims[p.key] * p.weight;
  }
  const base = knownWeight > 0 ? weighted / knownWeight : 50;

  const { factor, notes } = penaltyFactor(ctx.title ?? "", ctx.summary ?? "");
  return { total: clamp(Math.round(base * factor)), ...dims, penalty: factor, notes };
}
