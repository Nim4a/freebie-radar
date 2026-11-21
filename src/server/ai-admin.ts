import { all, get, run } from "./db.ts";
import { calibrateScoreByObtain } from "./enrich/alias.ts";
import { demoteEditorialGoods, demoteOfflineCategory, enforceFreebieEvidence, enrichItem, FREEBIE_ONLY_SOURCES, isCategory, resolveKind, type ContentKind } from "./enrich/index.ts";
import { guessObtain } from "./enrich/obtain.ts";
import { isBlocked, loadActiveBlockRules } from "./enrich/blocklist.ts";
import { aiQueueStats } from "./enrich/ai-queue.ts";
import { getSourceHints, applyManualClassification, getManualClassification } from "./source-settings.ts";
import { categoryForSource } from "../shared/source-classification.ts";
import { isSharedResource } from "./enrich/evidence.ts";
import { finishAiJob, getAiTelemetry, recordAiBatch, startAiJob } from "./enrich/ai-telemetry.ts";
import { aiDedupDegradation, aiDedupStats, dedupeKeptItemsWithAi } from "./enrich/ai-dedup.ts";
import {
  aiReady,
  DEFAULT_PROMPT,
  feedbackStats,
  getAiSettings,
  publicAiSettings,
  reviewItems,
  saveAiSettings,
  testAiConnection,
  type AiSettings,
} from "./enrich/ai-settings.ts";

function updateAi(
  id: number,
  ai: string,
  keep: number,
  score: number,
  category: string | null,
  obtain: string | null,
  kind: string,
  quality: number | null,
): void {
  run(
    "UPDATE items SET ai = ?, ai_keep = ?, score = ?, category = ?, obtain = ?, kind = ?, ai_quality = COALESCE(?, ai_quality), ai_reviewed_at = ? WHERE id = ?",
    ai,
    keep,
    score,
    category,
    obtain,
    kind,
    quality,
    new Date().toISOString(),
    id,
  );
}

/** AI verdict stats: overall distribution + category distribution + queue status + execution telemetry + recent samples. */
export function aiStats() {
  const totals = get<{ kept: number; rejected: number }>(
    `SELECT
       SUM(CASE WHEN ai_keep = 1 THEN 1 ELSE 0 END) AS kept,
       SUM(CASE WHEN ai_keep = 0 THEN 1 ELSE 0 END) AS rejected
     FROM items WHERE status = 'active'`,
  );
  // The pending count must exclude entries skipped by the global blocklist to save quota, so the UI does not show "N pending" while backfill finds 0 actionable
  const pendingRows = all<{ source_id: string; title: string; summary: string | null }>(
    "SELECT source_id, title, summary FROM items WHERE status = 'active' AND ai IS NULL",
  );
  const rules = loadActiveBlockRules();
  let pending = 0;
  let blockedSkipped = 0;
  for (const r of pendingRows) {
    if (isBlocked(r, rules)) blockedSkipped += 1;
    else pending += 1;
  }
  const byCategory = all<{ category: string; n: number }>(
    `SELECT COALESCE(category,'other') AS category, COUNT(*) AS n
     FROM items WHERE status = 'active' AND ai_keep = 1
     GROUP BY category ORDER BY n DESC`,
  );
  const byKind = all<{ kind: string; n: number }>(
    `SELECT COALESCE(kind,'freebie') AS kind, COUNT(*) AS n
     FROM items WHERE status = 'active'
     GROUP BY kind ORDER BY n DESC`,
  );
  const recent = all<{
    id: number;
    source_id: string;
    title: string;
    score: number;
    obtain: string | null;
    kind: string | null;
    ai: string;
    ai_reviewed_at: string | null;
    last_seen_at: string;
  }>(
    `SELECT id, source_id, title, score, obtain, kind, ai, ai_reviewed_at, last_seen_at FROM items
     WHERE ai IS NOT NULL ORDER BY COALESCE(ai_reviewed_at, last_seen_at) DESC, id DESC LIMIT 40`,
  );
  return {
    kept: totals?.kept ?? 0,
    rejected: totals?.rejected ?? 0,
    pending,
    blockedSkipped,
    queue: aiQueueStats(),
    telemetry: getAiTelemetry(),
    byCategory,
    byKind,
    dedup: { ...aiDedupStats(), degraded: aiDedupDegradation() },
    recent: recent.map((r) => {
      let v: { keep?: boolean; kind?: string; reason?: string; category?: string; obtain?: string; quality?: number } = {};
      try {
        v = JSON.parse(r.ai) as typeof v;
      } catch {
        v = {};
      }
      return {
        id: r.id,
        sourceId: r.source_id,
        title: r.title,
        score: r.score,
        keep: v.keep ?? null,
        kind: v.kind ?? r.kind ?? (v.keep === false ? "noise" : "freebie"),
        reason: v.reason ?? "",
        category: v.category ?? "",
        obtain: v.obtain ?? r.obtain ?? "free",
        quality: typeof v.quality === "number" ? v.quality : null,
        reviewedAt: r.ai_reviewed_at ?? r.last_seen_at,
      };
    }),
  };
}

export type BackfillMode = "pending" | "recent" | "rejected";

/**
 * Manual backfill / re-review:
 * - pending: only review items with no AI verdict yet (default)
 * - recent: re-review recently ingested items with the latest prompt/preferences (recalibrate category, obtain mode and quality score)
 * - rejected: recheck non-freebie items recently blocked by AI (guard against false rejects)
 */
export async function backfillAi(
  limit = 200,
  mode: BackfillMode = "pending",
): Promise<{ reviewed: number; rejected: number; skippedBlocked: number; scanned: number; mode: BackfillMode; error?: string }> {
  const s = getAiSettings();
  if (!aiReady(s)) return { reviewed: 0, rejected: 0, skippedBlocked: 0, scanned: 0, mode, error: "AI is not enabled or not configured" };

  const safeLimit = Math.min(Math.max(Math.round(limit), 1), 2000);
  const scanLimit = Math.min(safeLimit * 4, 4000);
  const whereExtra =
    mode === "rejected"
      ? "AND ai_keep = 0"
      : mode === "recent"
        ? ""
        : "AND ai IS NULL";

  const rows = all<{
    id: number;
    source_id: string;
    external_id: string;
    title: string;
    summary: string | null;
    content: string | null;
    url: string;
    score: number;
    category: string | null;
    published_at: string | null;
    expires_at: string | null;
  }>(
    `SELECT id, source_id, external_id, title, summary, content, url, score, category, published_at, expires_at
     FROM items WHERE status = 'active' ${whereExtra}
     ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?`,
    scanLimit,
  );
  const blockRules = loadActiveBlockRules();
  const unblocked: typeof rows = [];
  let skippedBlocked = 0;
  for (const r of rows) {
    if (isBlocked(r, blockRules)) skippedBlocked += 1;
    else unblocked.push(r);
  }
  const activeRows = unblocked.slice(0, safeLimit);
  if (!activeRows.length) return { reviewed: 0, rejected: 0, skippedBlocked, scanned: rows.length, mode };

  const modeLabel = mode === "rejected" ? "recheck blocked" : mode === "recent" ? "re-review recent" : "backfill unreviewed";
  const jobId = startAiJob({
    stage: "backfill",
    label: `History backfill (${modeLabel})`,
    model: s.model,
    total: activeRows.length,
    totalBatches: Math.ceil(activeRows.length / s.batchSize),
  });

  let reviewed = 0;
let rejected = 0;
  const keptIds: number[] = [];
  let lastError: string | undefined;
  const CHUNK = Math.max(s.batchSize * s.concurrency, 24);

  try {
    for (let start = 0; start < activeRows.length; start += CHUNK) {
      const chunk = activeRows.slice(start, start + CHUNK);

      const raws = chunk.map((r) => ({
        externalId: r.external_id,
        url: r.url,
        title: r.title,
        summary: r.summary ?? "",
        content: r.content ?? null,
      }));
      let map;
      try {
        map = await reviewItems(raws as never, { ...s, maxItems: chunk.length }, {
          onBatch: (ev) => {
            if (ev.error) lastError = ev.error;
            let bKept = 0;
            let bRejected = 0;
            const events = [];
            for (let i = 0; i < ev.items.length; i += 1) {
              const v = ev.verdicts?.get(ev.start + i);
              if (!v) continue;
              const keep = Boolean(v.keep);
              if (keep) bKept += 1;
              else bRejected += 1;
              events.push({
                title: ev.items[i]!.title,
                keep,
                kind: v.kind ?? (keep ? "freebie" : "noise"),
                category: v.category ?? "-",
                quality: typeof v.quality === "number" ? v.quality : null,
                reason: v.reason ?? "",
                at: new Date().toISOString(),
              });
            }
            recordAiBatch(jobId, {
              events,
              kept: bKept,
              rejected: bRejected,
              failed: ev.verdicts ? 0 : ev.count,
              ttfbMs: ev.ttfbMs,
            });
          },
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!map) continue;
      for (let i = 0; i < chunk.length; i += 1) {
        const row = chunk[i]!;
        const v = map.get(i);
        if (!v) continue;
        reviewed += 1;
if (!v.keep) rejected += 1;
        else keptIds.push(row.id);
        const obtain = v.obtain ?? guessObtain(row.title, row.summary ?? "");
        const hints = getSourceHints(row.source_id);
        // On re-review, recompute the base score before calibrating so repeated multiplier/divisor passes do not drift
        const baseEnriched = enrichItem(
          {
            externalId: row.external_id,
            url: row.url,
            title: row.title,
            summary: row.summary ?? "",
            publishedAt: row.published_at,
            expiresAt: row.expires_at,
          },
          row.source_id,
          hints,
        );
        const baseScore = baseEnriched ? baseEnriched.score : row.score;
        const category = categoryForSource(row.source_id, isSharedResource(row.title, row.summary ?? "", row.content ?? "", row.url) ? "pan" : isCategory(v.category) ? v.category : row.category, hints);
        const quality =
          typeof v.quality === "number" && Number.isFinite(v.quality)
            ? Math.min(5, Math.max(1, Math.round(v.quality)))
            : null;
        let kind = resolveKind(v.kind, v.keep, {
          title: row.title,
          summary: row.summary ?? "",
          sourceId: row.source_id,
          category,
          obtain,
          isFree: baseEnriched?.isFree ?? false,
          price: baseEnriched?.price ?? null,
          freebieOnlySource: FREEBIE_ONLY_SOURCES.has(row.source_id),
          kindHint: hints.kindHint,
          guardEnabled: hints.guardEnabled,
        });
        // Freebie evidence check: lottery → lottery, explicit price → deal
        const evidenced = enforceFreebieEvidence(kind, obtain, row.title, category, {
          summary: row.summary,
          codes: baseEnriched?.codes,
          sourceId: row.source_id,
        });
        kind = evidenced.kind;
        const finalObtain = evidenced.obtain === undefined ? obtain : evidenced.obtain;
        const categoryHint = evidenced.category ?? category;
        // News/shitposts must not land in physical freebies
        let finalCategory = demoteEditorialGoods(
          demoteOfflineCategory(
            categoryHint,
            kind,
            row.title,
            row.summary ?? "",
            baseEnriched?.category ?? null,
          ),
          kind,
          { title: row.title, summary: row.summary ?? "", obtain: finalObtain, price: baseEnriched?.price ?? null },
        );
        const effectiveKeep = kind === "noise" ? false : v.keep;
        const keep = effectiveKeep ? 1 : 0;
        const ai = JSON.stringify({ ...v, keep: effectiveKeep, kind, category: finalCategory });
        ({ kind, category: finalCategory } = applyManualClassification(row.id, finalCategory, kind));
        const score = calibrateScoreByObtain(baseScore, finalObtain, effectiveKeep, quality, kind, {
          title: row.title,
          summary: row.summary ?? "",
          publishedAt: row.published_at,
          sourceId: row.source_id,
          codes: baseEnriched?.codes ?? [],
          price: baseEnriched?.price ?? null,
        });
        updateAi(row.id, ai, keep, score, finalCategory, finalObtain, kind, quality);
      }
    }
    finishAiJob(jobId, {
      skippedBlocked,
      error: reviewed === 0 ? lastError : undefined,
    });
  } catch (err) {
    finishAiJob(jobId, {
      skippedBlocked,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

// After a backfill/re-review pass, also run AI semantic dedup clustering so the history does not keep duplicate rows for one campaign
  if (keptIds.length && getAiSettings().aiDedupEnabled) {
    try {
      await dedupeKeptItemsWithAi(keptIds);
    } catch (err) {
      console.log("[ai] semantic dedup after backfill failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return { reviewed, rejected, skippedBlocked, scanned: rows.length, mode };
}

/**
 * Zero-token bulk reclassification: recompute category for active items with the latest keyword rules (and kind / obtain for items without an AI verdict).
 * scope = "other": only rescue items that fell into other/null; scope = "all": refresh all active items by the new rules (for AI-reviewed ones, only refresh the stragglers with category=other).
 */
export function reclassifyStoredItems(scope: "other" | "all" = "other", options: { dryRun?: boolean; sourceId?: string; itemId?: number; forceAutomatic?: boolean } = {}): {
  scanned: number;
  updated: number;
  movedFromOther: number;
  scope: "other" | "all";
  dryRun: boolean;
  rerouted: number;
  samples: { id: number; title: string; sourceId: string; fromKind: string | null; toKind: string | null; fromCategory: string | null; toCategory: string | null }[];
} {
  const cond = scope === "other" ? "status = 'active' AND (category = 'other' OR category IS NULL)" : "status = 'active'";
  const rows = all<{
    id: number;
    source_id: string;
    external_id: string | null;
    url: string;
    title: string;
    summary: string | null;
    content: string | null;
    category: string | null;
    kind: string | null;
    obtain: string | null;
    ai_keep: number | null;
    published_at: string | null;
    expires_at: string | null;
    ai_quality: number | null;
    ai: string | null;
    score: number;
    base_score: number | null;
  }>(
    `SELECT id, source_id, external_id, url, title, summary, SUBSTR(content,1,12000) AS content, category, kind, obtain, ai_keep, ai_quality, ai, score, base_score, published_at, expires_at
       FROM items WHERE ${options.itemId ? "1=1" : cond}${options.sourceId ? " AND source_id = ?" : ""}${options.itemId ? " AND id = ?" : ""} ORDER BY id DESC LIMIT 6000`,
    ...(options.sourceId ? [options.sourceId] : []),
    ...(options.itemId ? [options.itemId] : []),
  );

  let updated = 0;
  let movedFromOther = 0;
  let rerouted = 0;
  const hintsBySource = new Map<string, ReturnType<typeof getSourceHints>>();
  const samples: { id: number; title: string; sourceId: string; fromKind: string | null; toKind: string | null; fromCategory: string | null; toCategory: string | null }[] = [];
  for (const r of rows) {
    let hints = hintsBySource.get(r.source_id);
    if (!hints) { hints = getSourceHints(r.source_id); hintsBySource.set(r.source_id, hints); }
    const e = enrichItem(
      {
        externalId: r.external_id ?? String(r.id),
        url: r.url,
        title: r.title,
        summary: r.summary ?? "",
        content: r.content,
        publishedAt: r.published_at,
        expiresAt: r.expires_at,
      },
      r.source_id,
      hints,
    );
    if (!e) continue;
    // Prefer the category from AI review: the rules used to use it only for kind but stored the keyword result, discarding AI's correct category
    let aiCategory: string | null = null;
    let aiKind: string | null = null;
    if (r.ai) {
      try {
        const parsed = JSON.parse(r.ai) as { category?: unknown; kind?: unknown };
        if (isCategory(parsed.category)) aiCategory = parsed.category;
        if (typeof parsed.kind === "string") aiKind = parsed.kind;
      } catch {
        aiCategory = null;
      }
    }
    // Non-other items already manually/AI reviewed keep their category; only fix other / VPS posts mislabeled as news / news from non-authoritative sources
    const catWasLegacyNews = (r.category === "news" || r.category === "headline") && e.category === "vps";
    let nextCat: string | null =
      aiCategory ??
      (!options.forceAutomatic && r.ai_keep !== null && r.category && r.category !== "other" && !catWasLegacyNews ? r.category : e.category);
    nextCat = categoryForSource(r.source_id, isSharedResource(r.title, r.summary ?? "", r.content ?? "", r.url) ? "pan" : nextCat, hints);
    let nextKind = options.forceAutomatic ? aiKind ?? e.kind : r.ai_keep === null ? e.kind : (r.kind ?? e.kind);
    {
      nextKind = resolveKind(nextKind, r.ai_keep === 1 ? true : r.ai_keep === 0 ? false : null, {
        title: r.title,
        summary: r.summary ?? "",
        sourceId: r.source_id,
        category: nextCat,
        obtain: r.obtain,
        isFree: e.isFree,
        price: e.price,
        kindHint: hints.kindHint,
        guardEnabled: hints.guardEnabled,
        freebieOnlySource: FREEBIE_ONLY_SOURCES.has(r.source_id),
      });
    }
    const fallbackObtain = guessObtain(r.title, r.summary ?? "");
    const autoObtain = r.ai_keep === null ? fallbackObtain : (r.obtain ?? fallbackObtain);
    // Freebie evidence check: lottery → lottery, explicit price → deal, news category / price posts with no claim evidence → info.
    // The fix button must go through this gate, otherwise review posts already among real freebies cannot be fixed.
    const evidenced = enforceFreebieEvidence(nextKind as ContentKind, autoObtain, r.title, nextCat, {
      summary: r.summary,
      codes: e.codes,
      sourceId: r.source_id,
    });
    nextKind = evidenced.kind;
    const nextObtain = evidenced.obtain === undefined ? autoObtain : evidenced.obtain;
    nextCat = evidenced.category ?? nextCat;
    // News/shitposts must not land in physical freebies
    nextCat = demoteOfflineCategory(nextCat, nextKind, r.title, r.summary ?? "", e.category) as typeof nextCat;
    ({ category: nextCat, kind: nextKind } = applyManualClassification(r.id, nextCat, nextKind as import("../shared/taxonomy.ts").ContentKind));

// Also recompute scores with the new multi-factor weighting (rule-based content score goes into base_score, AI quality score is part of the blend)
    const keepBool = r.ai_keep === null ? null : r.ai_keep === 1;
    const quality =
      typeof r.ai_quality === "number" && Number.isFinite(r.ai_quality)
        ? Math.min(5, Math.max(1, Math.round(r.ai_quality)))
        : null;
    const nextScore = calibrateScoreByObtain(e.baseScore, nextObtain, keepBool, quality, nextKind, {
      title: e.title,
      summary: e.summary ?? "",
      publishedAt: e.publishedAt ?? null,
      sourceId: r.source_id,
      codes: e.codes,
      price: e.price,
    });

    if (
      nextCat !== r.category ||
      nextKind !== r.kind ||
      nextObtain !== r.obtain ||
      nextScore !== r.score ||
      e.baseScore !== (r.base_score ?? null)
    ) {
      if (nextCat !== r.category || nextKind !== r.kind) {
        rerouted += 1;
        if (samples.length < 30) samples.push({ id: r.id, title: r.title, sourceId: r.source_id, fromKind: r.kind, toKind: nextKind, fromCategory: r.category, toCategory: nextCat });
      }
      let ai = r.ai;
      if (ai && !getManualClassification(r.id) && (nextCat !== r.category || nextKind !== r.kind)) {
        try {
          const parsed: unknown = JSON.parse(ai);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ai = JSON.stringify({
            ...parsed, kind: nextKind, category: nextCat,
            classificationCorrection: { previousKind: r.kind, previousCategory: r.category, reason: "fixed source category or content evidence check", at: new Date().toISOString() },
          });
        } catch { /* preserve malformed legacy AI */ }
      }
      if (!options.dryRun) run(
        "UPDATE items SET category = ?, kind = ?, obtain = ?, base_score = ?, score = ?, ai = ? WHERE id = ?",
        nextCat,
        nextKind,
        nextObtain,
        e.baseScore,
        nextScore,
        ai,
        r.id,
      );
      updated += 1;
      if ((r.category === "other" || !r.category) && nextCat !== "other") {
        movedFromOther += 1;
      }
    }
  }
  return { scanned: rows.length, updated, movedFromOther, scope, dryRun: Boolean(options.dryRun), rerouted, samples };
}

export { publicAiSettings, saveAiSettings, testAiConnection, DEFAULT_PROMPT, aiReady, getAiSettings, feedbackStats };
export { aiDedupStats as aiDedupClusterStats, runAiDedupBackfill } from "./enrich/ai-dedup.ts";
export type { AiSettings };
