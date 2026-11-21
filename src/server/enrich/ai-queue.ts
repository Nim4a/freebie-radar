import { getAiSettings, reviewItems, type AiVerdict } from "./ai-settings.ts";
import { dedupeKeptItemsWithAi } from "./ai-dedup.ts";
import { demoteEditorialGoods, demoteOfflineCategory, enforceFreebieEvidence, FREEBIE_ONLY_SOURCES, isCategory, resolveKind, type ContentKind } from "./index.ts";
import { calibrateScoreByObtain } from "./alias.ts";
import type { RawItem } from "../collectors/types.ts";
import { get, run } from "../db.ts";
import { finishAiJob, recordAiBatch, startAiJob } from "./ai-telemetry.ts";
import { getSourceHints, applyManualClassification } from "../source-settings.ts";
import { categoryForSource } from "../../shared/source-classification.ts";
import { isSharedResource } from "./evidence.ts";

const VALID_OBTAIN = new Set(["free", "conditional", "lottery", "trial", "promo", "paid"]);

function parseCodes(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
/**
 * AI async review queue:
 * - supports the "grab the code first, review later" mode that fills in the AI verdict in the background
 * - supports the "review before push" mode that consumes the remaining new items beyond the sync limit
 * - items that pass review (aiKeep=true) and have not been pushed yet can be re-pushed via a callback (into the immediate or batched queue)
 */

export type AiQueueJob = {
  itemId: number;
  sourceId?: string;
  url: string;
  title: string;
  summary: string;
  content?: string | null;
  pushOnApprove?: boolean;
};

type PostReviewHandler = (sourceId: string, itemIds: number[]) => Promise<unknown>;

const queue: AiQueueJob[] = [];
let running = false;
let processed = 0;
let dropped = 0;
const MAX_QUEUE = 500;
let postReviewHandler: PostReviewHandler | null = null;

export function setPostReviewHandler(handler: PostReviewHandler | null): void {
  postReviewHandler = handler;
}

/** Collector-side call: enqueue new items and return immediately. */
export function enqueueForAi(items: AiQueueJob[]): void {
  if (!items.length) return;
  const existingIds = new Set(queue.map((q) => q.itemId));
  const fresh = items.filter((it) => !existingIds.has(it.itemId));
  if (!fresh.length) return;
  if (queue.length + fresh.length > MAX_QUEUE) {
    const overflow = queue.length + fresh.length - MAX_QUEUE;
    queue.splice(0, overflow);
    dropped += overflow;
  }
  queue.push(...fresh);
  void drain();
}

export function aiQueueStats(): { queued: number; processed: number; dropped: number; running: boolean } {
  return { queued: queue.length, processed, dropped, running };
}

export type AppliedVerdict = {
  aiKeep: boolean;
  kind: ContentKind;
  category: string | null;
  obtain: string | null;
  score: number;
  reason: string | null;
};

function applyVerdictToItem(itemId: number, verdict: AiVerdict): AppliedVerdict | null {
  const nextCategory = isCategory(verdict.category) ? verdict.category : null;
  const nextObtain = verdict.obtain && VALID_OBTAIN.has(verdict.obtain) ? verdict.obtain : null;
  const nextQuality =
    typeof verdict.quality === "number" && Number.isFinite(verdict.quality)
      ? Math.min(5, Math.max(1, Math.round(verdict.quality)))
      : null;
  try {
    const cur = get<{
      score: number;
      base_score: number | null;
      ai_keep: number | null;
      obtain: string | null;
      category: string | null;
      title: string;
      summary: string | null;
      source_id: string;
      is_free: number;
      price: number | null;
      published_at: string | null;
      codes: string | null;
      content: string | null;
      url: string;
    }>(
      "SELECT score, base_score, ai_keep, obtain, category, title, summary, source_id, is_free, price, published_at, codes, content, url FROM items WHERE id = ?",
      itemId,
    );
    if (!cur) return null;
    const hints = getSourceHints(cur.source_id);
    const rawCategory = categoryForSource(cur.source_id, isSharedResource(cur.title, cur.summary ?? "", cur.content ?? "", cur.url) ? "pan" : nextCategory ?? cur.category ?? null, hints);
    const effectiveObtain = nextObtain ?? cur?.obtain ?? null;
    const autoKind = resolveKind(verdict.kind, verdict.keep, {
      title: cur?.title ?? "",
      summary: cur?.summary ?? "",
      sourceId: cur?.source_id,
      category: rawCategory,
      obtain: effectiveObtain,
      isFree: cur?.is_free === 1,
      price: cur?.price ?? null,
      freebieOnlySource: Boolean(cur?.source_id && FREEBIE_ONLY_SOURCES.has(cur.source_id)),
      kindHint: hints.kindHint,
      guardEnabled: hints.guardEnabled,
    });
    // Freebie evidence check: lottery -> lottery, explicit price -> deal
    const evidenced = enforceFreebieEvidence(autoKind, effectiveObtain, cur?.title ?? "", rawCategory, {
      summary: cur?.summary,
      codes: parseCodes(cur?.codes),
      sourceId: cur?.source_id,
    });
    const finalKind = evidenced.kind;
    const finalObtain = evidenced.obtain === undefined ? effectiveObtain : evidenced.obtain;
    const finalCategoryHint = evidenced.category ?? rawCategory;
    // News / chit-chat must not land in physical freebies: downgrade to the fallback category when the AI gets it wrong
    const autoCategory = demoteEditorialGoods(
      demoteOfflineCategory(
        finalCategoryHint,
        autoKind,
        cur?.title ?? "",
        cur?.summary ?? "",
      ),
      finalKind,
      { title: cur?.title ?? "", summary: cur?.summary ?? "", obtain: finalObtain, price: cur?.price ?? null },
    );
    const { kind: effectiveKind, category: effectiveCategory } = applyManualClassification(itemId, autoCategory, finalKind);
    const effectiveKeep = finalKind === "noise" ? false : verdict.keep;
    const keep = effectiveKeep ? 1 : 0;
    const nextScore = cur
      ? calibrateScoreByObtain(
          cur.base_score ?? cur.score,
          finalObtain,
          effectiveKeep,
          nextQuality,
          effectiveKind,
          {
            title: cur.title,
            summary: cur.summary ?? "",
            publishedAt: cur.published_at ?? null,
            sourceId: cur.source_id,
codes: parseCodes(cur.codes),
            price: cur.price ?? null,
          },
        )
      : 0;
    run(
      `UPDATE items
          SET ai = ?,
              ai_keep = ?,
              kind = ?,
              ai_quality = COALESCE(?, ai_quality),
              obtain = COALESCE(?, obtain),
              category = COALESCE(?, category),
              score = ?,
              ai_reviewed_at = ?
        WHERE id = ?`,
      JSON.stringify({ ...verdict, keep: effectiveKeep, kind: finalKind, category: autoCategory }),
      keep,
      effectiveKind,
      nextQuality,
      finalObtain,
      effectiveCategory,
      nextScore,
      new Date().toISOString(),
      itemId,
    );
    return {
      aiKeep: effectiveKeep,
      kind: effectiveKind,
      category: effectiveCategory,
      obtain: finalObtain,
      score: nextScore,
      reason: typeof verdict.reason === "string" && verdict.reason.trim() ? verdict.reason.trim() : null,
    };
  } catch {
    return null;
  }
}

/** Review before push: send this round's pending new items to the model for a verdict and write to the DB; returns each itemId's latest conclusion. */
export async function reviewFreshNow(items: AiQueueJob[]): Promise<Map<number, AppliedVerdict>> {
  const out = new Map<number, AppliedVerdict>();
  if (!items.length) return out;
  const s = getAiSettings();
  const raws = items.map((j) => ({
    externalId: String(j.itemId),
    url: j.url,
    title: j.title,
    summary: j.summary,
  })) as RawItem[];
  const srcId = items[0]?.sourceId;
  const jobId = startAiJob({
    stage: "sync",
    label: srcId ? `${srcId} · review before push` : "review before push",
    sourceId: srcId,
    model: s.model,
    total: items.length,
    totalBatches: Math.ceil(items.length / s.batchSize),
  });
  let batchErr: string | undefined;
  try {
    const map = await reviewItems(raws, { ...s, maxItems: Math.max(s.maxItems, items.length) }, {
      onBatch: (ev) => {
        if (ev.error) batchErr = ev.error;
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
            kind: v.kind ?? (keep ? "freebie" : "noise"),
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
    if (!map) {
      finishAiJob(jobId, { error: batchErr ?? "the model returned no valid conclusion" });
      return out;
    }
    const keptIds: number[] = [];
    for (const [idx, verdict] of map) {
      const job = items[idx];
      if (!job) continue;
      const applied = applyVerdictToItem(job.itemId, verdict);
      if (applied) {
        processed += 1;
        out.set(job.itemId, applied);
        if (applied.aiKeep) keptIds.push(job.itemId);
      } else {
        dropped += 1;
      }
    }
    if (keptIds.length) {
      try {
        await dedupeKeptItemsWithAi(keptIds);
      } catch (err) {
        console.log("[ai-queue] semantic dedup failed:", err instanceof Error ? err.message : String(err));
      }
    }
    finishAiJob(jobId);
  } catch (err) {
    finishAiJob(jobId, { error: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const s = getAiSettings();
      const waveSize = Math.min(Math.max(s.batchSize * s.concurrency, 12), 48);
      const batch = queue.splice(0, waveSize);
      const raws = batch.map((j) => ({
        externalId: String(j.itemId),
        url: j.url,
        title: j.title,
        summary: j.summary,
        content: j.content ?? null,
      })) as RawItem[];

      const jobId = startAiJob({
        stage: "queue",
        label: "async queue batch",
        sourceId: batch[0]?.sourceId,
        model: s.model,
        total: batch.length,
        totalBatches: Math.ceil(batch.length / s.batchSize),
      });
      let map;
      let batchErr: string | undefined;
      try {
        map = await reviewItems(raws, { ...s, maxItems: batch.length }, {
          onBatch: (ev) => {
            if (ev.error) batchErr = ev.error;
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
                kind: v.kind ?? (keep ? "freebie" : "noise"),
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
      } catch (err) {
        dropped += batch.length;
        finishAiJob(jobId, { error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (!map) {
        dropped += batch.length;
        finishAiJob(jobId, { error: batchErr ?? "the model returned no valid conclusion" });
        continue;
      }
      finishAiJob(jobId);
      const keptIds: number[] = [];
      const approvedBySource = new Map<string, number[]>();
      for (const [idx, verdict] of map) {
        const job = batch[idx];
        if (!job) continue;
        const applied = applyVerdictToItem(job.itemId, verdict);
        if (applied) {
          processed += 1;
          if (applied.aiKeep) keptIds.push(job.itemId);
          if (applied.aiKeep && job.pushOnApprove && job.sourceId) {
            const list = approvedBySource.get(job.sourceId) ?? [];
            list.push(job.itemId);
            approvedBySource.set(job.sourceId, list);
          }
        } else {
          dropped += 1;
        }
      }

      // Cluster-dedupe before re-pushing: avoid the same campaign being pushed once per source (B站/喜加一 style giveaways especially)
      if (keptIds.length) {
        try {
          await dedupeKeptItemsWithAi(keptIds);
        } catch (err) {
          console.error("[ai-queue] semantic dedup failed:", err instanceof Error ? err.message : String(err));
        }
      }

      if (postReviewHandler && approvedBySource.size) {
        for (const [sourceId, ids] of approvedBySource) {
          try {
            await postReviewHandler(sourceId, ids);
          } catch (err) {
            console.error("[ai-queue] re-review re-push callback failed:", err instanceof Error ? err.message : String(err));
          }
        }
      }
    }
  } finally {
    running = false;
  }
}
