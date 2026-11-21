import { all, get, run, tx } from "../db.ts";
import { aiReady, getAiSettings, type AiSettings } from "./ai-settings.ts";

export type DedupCandidate = {
  id: number;
  title: string;
  summary?: string | null;
  kind?: string | null;
  category?: string | null;
  canonicalId?: number | null;
};

export type SemanticDupMatch = {
  index: number;
  duplicateOfId: number;
  reason: string;
};

const DEDUP_SYSTEM_PROMPT = [
  "You are the AI semantic dedup judge for resource aggregation and news information.",
  "Task: for each item, decide whether a candidate (the new candidates) is essentially **the same giveaway campaign, the same free game/software, the same open-source project, or the same news event** as an anchor (the existing baselines) or an earlier candidate.",
  "",
  "Typical cases that count as a duplicate (you must fill in duplicateOfId):",
  "- The same campaign on different platforms, or under brand abbreviations or different wording (e.g. the Chinese titles B站免费领7天大会员 and 哔哩哔哩为庆祝BLG夺冠赠送大会员, BLG夺冠送七天大会员)",
  "- The same limited-time-free game/software covered by different sources, or in its Chinese and English versions",
  "- The same macro/tech news rewritten by different media (e.g. CCTV, China News Service and BBC reporting the same policy/event)",
  "",
  "Never misjudge as duplicates (must return duplicateOfId: null):",
  "- The same event but with clearly different prizes/perks (e.g. the Chinese titles BLG夺冠B站送大会员 vs BLG夺冠LOLM手游送皮肤英雄)",
  "- Separate campaigns of different banks / partner merchants / co-branded cards (e.g. the Chinese titles 中国银行2233卡领B站会员 vs B站全站送7天大会员, or 阿里云送券 vs 腾讯云送券)",
  "- Different deal-priced VPS / different open-source projects / different individual products",
  "",
  'Output only a JSON array whose elements look like {"index":0,"duplicateOfId":12345,"reason":"same Bilibili BLG championship membership giveaway"}; if there is no duplicate, duplicateOfId is null. Output no extra text.',
].join("\n");
/**
 * AI semantic dedup degradation counter: when the model is unavailable / times out / runs out of quota,
 * dedup silently falls back to pure rules; this records the count and the most recent reason for the AI review panel to display, so it is not mistaken for dedup always being in effect.
 */
const degradation = { count: 0, lastAt: null as string | null, lastReason: null as string | null };

export function aiDedupDegradation(): { count: number; lastAt: string | null; lastReason: string | null } {
  return { ...degradation };
}

function noteDegraded(reason: string): void {
  degradation.count += 1;
  degradation.lastAt = new Date().toISOString();
  degradation.lastReason = reason.slice(0, 120);
}

function compactExcerpt(it: { summary?: string | null }, maxLen = 90): string {
  const txt = (it.summary ?? "").replace(/\s+/g, " ").trim();
  return txt.length <= maxLen ? txt : txt.slice(0, maxLen) + "…";
}

/** Find the cluster root node, guarding against chained hops and cycles. */
export function resolveClusterRoot(itemId: number): number {
  let cur = itemId;
  const visited = new Set<number>([cur]);
  for (let hop = 0; hop < 8; hop += 1) {
    const row = get<{ canonical_id: number | null }>("SELECT canonical_id FROM items WHERE id = ?", cur);
    if (!row || row.canonical_id == null || row.canonical_id === cur) return cur;
    if (visited.has(row.canonical_id)) return cur;
    visited.add(row.canonical_id);
    cur = row.canonical_id;
  }
  return cur;
}

/**
 * Merge itemId and targetId into the same canonical_id cluster (the root item also writes canonical_id = rootId,
 * so a single SQL `PARTITION BY canonical_id` hits the entire cluster).
 */
export function linkCanonicalCluster(itemId: number, targetId: number): number {
  if (!Number.isFinite(itemId) || !Number.isFinite(targetId) || itemId === targetId) return itemId;
  const rootTarget = resolveClusterRoot(targetId);
  const rootSelf = resolveClusterRoot(itemId);
  const rootId = Math.min(rootTarget, rootSelf);
  tx(() => {
    run(
      "UPDATE items SET canonical_id = ? WHERE id IN (?, ?, ?) OR canonical_id IN (?, ?)",
      rootId,
      rootId,
      itemId,
      targetId,
      itemId,
      rootTarget,
    );
  });
  return rootId;
}

/** Call the LLM to compare candidates with anchors and return the map of matched duplicate entries (index -> match). */
export async function findSemanticDuplicatesWithAi(
  candidates: DedupCandidate[],
  anchors: DedupCandidate[],
  settings?: AiSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<number, SemanticDupMatch>> {
  const out = new Map<number, SemanticDupMatch>();
  const s = settings ?? getAiSettings();
  if (!candidates.length) return out;
  if (!anchors.length && candidates.length < 2) return out;
  if (!aiReady(s)) return out;

  const validAnchorIds = new Set(anchors.map((a) => a.id));
  const candidateIds = new Set(candidates.map((c) => c.id));
  const endpoint = s.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const ac = new AbortController();
  const timeoutMs = Math.max(s.timeoutSec * 1000, 12_000);
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const payload = {
    anchors: anchors.slice(0, 40).map((a) => ({
      id: a.id,
      kind: a.kind ?? "freebie",
      category: a.category ?? "other",
      title: a.title.slice(0, 120),
      summary: compactExcerpt(a, 70),
    })),
    candidates: candidates.map((c, idx) => ({
      index: idx,
      id: c.id,
      kind: c.kind ?? "freebie",
      category: c.category ?? "other",
      title: c.title.slice(0, 120),
      summary: compactExcerpt(c, 70),
    })),
  };

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(s.apiKey ? { authorization: "Bearer " + s.apiKey } : {}),
      },
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        messages: [
          { role: "system", content: DEDUP_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`AI dedup HTTP ${res.status} ${(await res.text()).slice(0, 100)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonText = /\[[\s\S]*\]/.exec(content)?.[0];
    if (!jsonText) return out;
    const arr = JSON.parse(jsonText) as Array<{
      index?: unknown;
      duplicateOfId?: unknown;
      reason?: unknown;
    }>;
    if (!Array.isArray(arr)) return out;

    for (const row of arr) {
      const idx = typeof row?.index === "number" ? row.index : -1;
      const cand = idx >= 0 && idx < candidates.length ? candidates[idx] : null;
      const dupId = typeof row?.duplicateOfId === "number" ? row.duplicateOfId : null;
      if (!cand || dupId == null || dupId === cand.id) continue;
      // Only accept anchor IDs that really exist and are not future candidates (anchors, or candidates with a smaller index in the same batch)
      const earlierCandidate = candidates.slice(0, idx).some((prev) => prev.id === dupId);
      if (!validAnchorIds.has(dupId) && !(candidateIds.has(dupId) && earlierCandidate)) continue;
      const reason = typeof row?.reason === "string" ? row.reason.trim().slice(0, 60) : "AI semantic dedup";
      out.set(idx, { index: idx, duplicateOfId: dupId, reason });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    noteDegraded(msg);
    console.log("[ai-dedup] semantic dedup degraded, skipping:", msg);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Auto-clustering after review: compare newly approved items with items retained in the last N hours and write canonical_id to feed list folding and hot-topic grouping.
 */
export async function dedupeKeptItemsWithAi(
  itemIds: number[],
  settings?: AiSettings,
): Promise<{ merged: number }> {
  const s = settings ?? getAiSettings();
  if (!itemIds.length || !s.aiDedupEnabled || !aiReady(s)) return { merged: 0 };

  const uniqueIds = [...new Set(itemIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (!uniqueIds.length) return { merged: 0 };
  const ph = uniqueIds.map(() => "?").join(",");
  const rows = all<{
    id: number;
    title: string;
    summary: string | null;
    kind: string | null;
    category: string | null;
    canonical_id: number | null;
  }>(
    `SELECT id, title, summary, kind, category, canonical_id
       FROM items
      WHERE id IN (${ph}) AND status = 'active' AND ai_keep = 1 AND (kind IS NULL OR kind != 'noise')
      ORDER BY id ASC`,
    ...uniqueIds,
  );
  if (!rows.length) return { merged: 0 };

  const cutoff = new Date(Date.now() - s.aiDedupWindowHours * 3_600_000).toISOString();
  let merged = 0;

  // Group by kind to reduce irrelevant cross-channel comparisons
  const byKind = new Map<string, DedupCandidate[]>();
  for (const r of rows) {
    const k = r.kind ?? "freebie";
    const list = byKind.get(k) ?? [];
    list.push({
      id: r.id,
      title: r.title,
      summary: r.summary,
      kind: k,
      category: r.category,
      canonicalId: r.canonical_id,
    });
    byKind.set(k, list);
  }

  for (const [kind, cands] of byKind) {
    const excludeSet = new Set(cands.map((c) => c.id));
    // Comparing only 1-2 items with the LLM is not worth it (2-3s per call); leave those for the on-demand comparison before pushing
    if (cands.length < 3) continue;
    const anchorRows = all<{
      id: number;
      title: string;
      summary: string | null;
      kind: string | null;
      category: string | null;
      canonical_id: number | null;
    }>(
      `SELECT id, title, summary, kind, category, canonical_id
         FROM items
        WHERE status = 'active'
          AND ai_keep = 1
          AND COALESCE(kind, 'freebie') = ?
          AND COALESCE(published_at, first_seen_at) >= ?
          AND (canonical_id IS NULL OR canonical_id = id)
        ORDER BY COALESCE(pushed_at, '') DESC, score DESC, id DESC
        LIMIT 40`,
      kind,
      cutoff,
    ).filter((a) => !excludeSet.has(a.id));

    const anchors: DedupCandidate[] = anchorRows.map((a) => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      kind: a.kind,
      category: a.category,
      canonicalId: a.canonical_id,
    }));

    for (let i = 0; i < cands.length; i += 12) {
      const chunk = cands.slice(i, i + 12);
      const matches = await findSemanticDuplicatesWithAi(chunk, anchors, s);
      for (const [idx, m] of matches) {
        const cand = chunk[idx];
        if (!cand) continue;
        linkCanonicalCluster(cand.id, m.duplicateOfId);
        merged += 1;
        console.log(`[ai-dedup] cluster #${cand.id} -> #${m.duplicateOfId}: ${m.reason}`);
      }
      // Representatives in this batch that were not merged are also added to the anchor pool for later chunks
      for (let j = 0; j < chunk.length; j += 1) {
        if (!matches.has(j) && anchors.length < 40) anchors.push(chunk[j]!);
      }
    }
  }

  return { merged };
}

/**
 * Final semantic anti-duplicate gate before Telegram push:
 * 1. First, with zero tokens, intercept candidates that share a canonical_id with an already-pushed item;
 * 2. If AI semantic dedup is enabled, send the remaining candidates together with the last N hours of pushed records to the LLM for a second comparison; on a hit, persist the canonical_id and intercept the push.
 */
export async function filterPushDuplicatesWithAi<T extends DedupCandidate>(
  candidates: T[],
  pushedRows: DedupCandidate[],
  options?: { settings?: AiSettings; fetchImpl?: typeof fetch; persistLink?: boolean },
): Promise<{
  kept: T[];
  intercepted: Array<{ item: T; duplicateOfId: number; reason: string }>;
}> {
  if (!candidates.length) return { kept: [], intercepted: [] };

  const persistLink = options?.persistLink !== false;
  const pushedCanonical = new Map<number, number>();
  for (const p of pushedRows) {
    if (p.canonicalId != null && p.canonicalId > 0) {
      pushedCanonical.set(p.canonicalId, p.id);
    }
  }

  const afterRule: T[] = [];
  const intercepted: Array<{ item: T; duplicateOfId: number; reason: string }> = [];

  for (const c of candidates) {
    if (c.canonicalId != null && pushedCanonical.has(c.canonicalId)) {
      const targetId = pushedCanonical.get(c.canonicalId)!;
      intercepted.push({ item: c, duplicateOfId: targetId, reason: "same cluster already pushed" });
      continue;
    }
    afterRule.push(c);
  }

  const s = options?.settings ?? getAiSettings();
  if (!afterRule.length || !s.aiDedupEnabled || !aiReady(s)) {
    return { kept: afterRule, intercepted };
  }
  if (!pushedRows.length && afterRule.length < 2) {
    return { kept: afterRule, intercepted };
  }

  const matches = await findSemanticDuplicatesWithAi(afterRule, pushedRows.slice(0, 35), s, options?.fetchImpl);
  const kept: T[] = [];
  const keptCanonicalRoots = new Set<number>();

  for (let i = 0; i < afterRule.length; i += 1) {
    const item = afterRule[i]!;
    const hit = matches.get(i);
    if (hit) {
      if (persistLink) linkCanonicalCluster(item.id, hit.duplicateOfId);
      intercepted.push({ item, duplicateOfId: hit.duplicateOfId, reason: hit.reason });
      console.log(`[push] AI semantic dedup intercepted #${item.id} (duplicate of #${hit.duplicateOfId}): ${hit.reason}`);
      continue;
    }
    if (item.canonicalId != null && keptCanonicalRoots.has(item.canonicalId)) {
      intercepted.push({ item, duplicateOfId: item.canonicalId, reason: "duplicate within the same batch and cluster" });
      continue;
    }
    if (item.canonicalId != null) keptCanonicalRoots.add(item.canonicalId);
    kept.push(item);
  }

  return { kept, intercepted };
}

/** One-click AI dedup clustering over items retained in the last N hours (folds the list and prevents later duplicate pushes). */
export async function runAiDedupBackfill(limit = 80): Promise<{
  scanned: number;
  merged: number;
  clusters: number;
  skippedReason?: string;
}> {
  const s = getAiSettings();
  if (!aiReady(s)) {
    return { scanned: 0, merged: 0, clusters: 0, skippedReason: "AI review is not configured or not enabled" };
  }
  const cap = Math.min(Math.max(Math.round(limit) || 80, 10), 200);
  const cutoff = new Date(Date.now() - s.aiDedupWindowHours * 3_600_000).toISOString();

  const rows = all<{
    id: number;
    title: string;
    summary: string | null;
    kind: string | null;
    category: string | null;
    canonical_id: number | null;
    pushed_at: string | null;
  }>(
    `SELECT id, title, summary, kind, category, canonical_id, pushed_at
       FROM items
      WHERE status = 'active'
        AND (ai_keep = 1 OR ai_keep IS NULL)
        AND (kind IS NULL OR kind != 'noise')
        AND COALESCE(published_at, first_seen_at) >= ?
      ORDER BY (pushed_at IS NOT NULL) DESC, score DESC, id ASC
      LIMIT ?`,
    cutoff,
    cap,
  );
  if (rows.length < 2) return { scanned: rows.length, merged: 0, clusters: aiDedupStats().clusterCount };

  const byKind = new Map<string, DedupCandidate[]>();
  for (const r of rows) {
    const k = r.kind ?? "freebie";
    const list = byKind.get(k) ?? [];
    list.push({
      id: r.id,
      title: r.title,
      summary: r.summary,
      kind: k,
      category: r.category,
      canonicalId: r.canonical_id,
    });
    byKind.set(k, list);
  }

  let merged = 0;
  for (const [, list] of byKind) {
    if (list.length < 2) continue;
    const anchors: DedupCandidate[] = [];
    const pending: DedupCandidate[] = [];
    for (const item of list) {
      if (item.canonicalId == null || item.canonicalId === item.id) {
        if (anchors.length < 30 && item.canonicalId === item.id) anchors.push(item);
        else pending.push(item);
      }
    }
    if (!anchors.length && pending.length >= 2) {
      anchors.push(pending.shift()!);
    }
    for (let i = 0; i < pending.length; i += 12) {
      const chunk = pending.slice(i, i + 12);
      const matches = await findSemanticDuplicatesWithAi(chunk, anchors, s);
      for (const [idx, m] of matches) {
        const cand = chunk[idx];
        if (!cand) continue;
        linkCanonicalCluster(cand.id, m.duplicateOfId);
        merged += 1;
      }
      for (let j = 0; j < chunk.length; j += 1) {
        if (!matches.has(j) && anchors.length < 40) anchors.push(chunk[j]!);
      }
    }
  }

  return { scanned: rows.length, merged, clusters: aiDedupStats().clusterCount };
}

export function aiDedupStats(): { mergedItems: number; clusterCount: number } {
  const row = get<{ mergedItems: number | null; clusterCount: number | null }>(
    `SELECT
       SUM(CASE WHEN canonical_id IS NOT NULL AND id != canonical_id THEN 1 ELSE 0 END) AS mergedItems,
       COUNT(DISTINCT canonical_id) AS clusterCount
     FROM items
     WHERE status = 'active' AND canonical_id IS NOT NULL`,
  );
  return {
    mergedItems: row?.mergedItems ?? 0,
    clusterCount: row?.clusterCount ?? 0,
  };
}
