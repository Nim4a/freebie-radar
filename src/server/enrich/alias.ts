import { all, get, run } from "../db.ts";
import { extractMergeKeys } from "./dedup.ts";
import { combineScore, type ScoreBreakdown, type ScoreCtx } from "./score.ts";

/**
 * Maps a single title to the unified canonical title_key via the title_aliases dictionary.
 * When an entry carries both a Chinese and an English name (e.g. the game Knightica),
 * it automatically creates a Chinese-alias -> English-primary-name mapping and merges existing rows sharing that Chinese name.
 */
export function resolveDbMergeKey(title: string): string {
  const keys = extractMergeKeys(title);
  if (!keys.length) return "";

  try {
    if (keys.length === 1) {
      const k = keys[0]!;
      const mapped = get<{ canonical: string }>("SELECT canonical FROM title_aliases WHERE alias = ?", k);
      return mapped?.canonical ?? k;
    }

    const placeholders = keys.map(() => "?").join(",");
    const existing = all<{ alias: string; canonical: string }>(
      `SELECT alias, canonical FROM title_aliases WHERE alias IN (${placeholders})`,
      ...keys,
    );
    const canonical = existing[0]?.canonical ?? keys[0]!;
    for (const k of keys) {
      if (k === canonical) continue;
      run(
        "INSERT INTO title_aliases (alias, canonical) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical",
        k,
        canonical,
      );
      run("UPDATE items SET title_key = ? WHERE title_key = ?", canonical, k);
    }
    return canonical;
  } catch {
    return keys[0]!;
  }
}

/**
 * Combined-score entry point: multi-dimensional weighting (see score.ts), led by the AI quality score.
 *
 * Keeps the original name and parameter order and additionally accepts an optional ctx (title/published time/source/redemption codes/price).
 * Without ctx those dimensions use neutral values, so it still works - but callers should pass it, otherwise the recency and source-trust dimensions do nothing.
 */
export function calibrateScoreByObtain(
  ruleScore: number,
  obtain: string | null | undefined,
  aiKeep: boolean | null,
  quality?: number | null,
  kind?: string | null,
  ctx: ScoreCtx = {},
): number {
  return combineScore(ruleScore, obtain, aiKeep, quality, kind, ctx).total;
}

/** Use this when you need to explain a score: it returns each dimension's score plus the penalty factor. */
export function explainScore(
  ruleScore: number,
  obtain: string | null | undefined,
  aiKeep: boolean | null,
  quality?: number | null,
  kind?: string | null,
  ctx: ScoreCtx = {},
): ScoreBreakdown {
  return combineScore(ruleScore, obtain, aiKeep, quality, kind, ctx);
}
