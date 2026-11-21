import { all } from "../db.ts";

export type BlockRule = {
  id: number;
  pattern: string;
  mode: "keyword" | "regex";
  scope: string;
  enabled: number;
  created_at: string;
};

/** Common non-freebie news / discussion noise; users can import it in the UI with one click, it is not written by default. */
export const PRESET_NOISE_PATTERNS: { pattern: string; mode: "keyword" | "regex"; scope: string; note: string }[] = [
  { pattern: "避坑", mode: "keyword", scope: "all", note: "buying-advice / consumer pitfall-avoidance articles" },
  { pattern: "测评", mode: "keyword", scope: "all", note: "long-term product reviews / unboxings" },
  { pattern: "横评", mode: "keyword", scope: "all", note: "multi-product comparison reviews" },
  { pattern: "怎么选", mode: "keyword", scope: "all", note: "buying guides" },
  { pattern: "值得买吗", mode: "keyword", scope: "all", note: "asking-for-advice posts" },
  { pattern: "致歉", mode: "keyword", scope: "all", note: "carmaker / brand announcement news" },
  { pattern: "股价", mode: "keyword", scope: "all", note: "finance news" },
  { pattern: "油价", mode: "keyword", scope: "all", note: "fuel price news" },
  { pattern: "漏电", mode: "keyword", scope: "all", note: "repair discussions" },
  { pattern: "研学", mode: "keyword", scope: "all", note: "consumer complaints" },
  { pattern: "冠军阵容", mode: "keyword", scope: "all", note: "esports news" },
  // This used to be one regex, ^(请问|求助|有没有|求推荐|求一个). A regex cannot be pushed down to SQL,
  // so every list request pulled 5000+ rows and ran a JS regex over them (5-40 s), hence the split into keywords.
  { pattern: "请问", mode: "keyword", scope: "all", note: "question post" },
  { pattern: "求助", mode: "keyword", scope: "all", note: "help-wanted post" },
  { pattern: "有没有", mode: "keyword", scope: "all", note: "asking whether something exists" },
  { pattern: "求推荐", mode: "keyword", scope: "all", note: "asking for recommendations" },
  { pattern: "求一个", mode: "keyword", scope: "all", note: "asking for resources" },
];

export function loadActiveBlockRules(): BlockRule[] {
  return all<BlockRule>("SELECT id, pattern, mode, scope, enabled, created_at FROM block_rules WHERE enabled = 1 ORDER BY id");
}

export function compileRule(rule: BlockRule): (text: string, sourceId: string) => boolean {
  const scope = rule.scope || "all";
  if (rule.mode === "regex") {
    let re: RegExp | null = null;
    if (!safeRegex(rule.pattern)) return () => false;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch {
      re = null;
    }
    return (text, sourceId) => {
      if (scope !== "all" && scope !== sourceId) return false;
      if (re) return re.test(text.slice(0, 2048));
      return text.toLowerCase().includes(rule.pattern.toLowerCase());
    };
  }
  const needle = rule.pattern.toLowerCase();
  return (text, sourceId) => {
    if (scope !== "all" && scope !== sourceId) return false;
    return text.toLowerCase().includes(needle);
  };
}

/** Conservative admin-only subset; unsafe legacy patterns are never executed. */
export function safeRegex(pattern: string): boolean {
  if (!pattern || pattern.length > 80 || /\\[1-9]|\(\?/.test(pattern)) return false;
  const tokens = pattern.replace(/\\./g, "_").replace(/\[(?:\\.|[^\]\\])*\]/g, "_");
  if (/\)[*+?{]/.test(tokens) || (tokens.match(/[*+{]/g)?.length ?? 0) > 1) return false;
  try { new RegExp(pattern, "i"); return true; } catch { return false; }
}

export function matchBlockRules(
  item: { title: string; summary?: string | null; source_id?: string; sourceId?: string },
  rules: BlockRule[],
): BlockRule | null {
  if (!rules.length) return null;
  const text = (item.title ?? "") + " " + (item.summary ?? "");
  const sourceId = item.source_id ?? item.sourceId ?? "";
  for (const rule of rules) {
    if (compileRule(rule)(text, sourceId)) return rule;
  }
  return null;
}

export function isBlocked(item: { title: string; summary?: string | null; source_id?: string; sourceId?: string }, rules?: BlockRule[]): boolean {
  const list = rules ?? loadActiveBlockRules();
  return matchBlockRules(item, list) !== null;
}
