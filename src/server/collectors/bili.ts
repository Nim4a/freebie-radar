import { createHash } from "node:crypto";
import { cleanText, parseDate, sanitizeImageUrl } from "../enrich/normalize.ts";
import type { HttpClient } from "../http.ts";
import type { Collector, RawItem } from "./types.ts";

/**
 * Bilibili keyword search collector.
 *
 * Measured 2026-11-15, home broadband in mainland China, not logged in:
 * - `x/web-interface/wbi/search/type` requires a wbi signature (`w_rid`), but the signing algorithm is public
 *   and **needs no cookie**: the `nav` endpoint returns img_key / sub_key, which are permuted by a fixed MIXIN table and truncated to 32 chars to form the key;
 * - without a signature it returns -403/-352; with one, code=0 and 20 real results per page;
 * - the fallback channel `x/web-interface/search/all/v2` is also usable without login (code=0) and is switched to automatically when wbi breaks.
 *
 * Collects「喜加一 / 白嫖 / 限免」-style videos (free-giveaway / freebie / limited-time-free): titles and descriptions usually list the game name, original price and claim link.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

type BiliConfig = {
  keywords: string[];
  /** video / article, default video */
  searchType?: "video" | "article";
  /** how many results to take per keyword, default 20 */
  limitPerKeyword?: number;
  /** the title must match one of these (case-insensitive); empty means no filtering */
  titleKeywords?: string[];
  /** a title matching any of these is dropped */
  excludeKeywords?: string[];
  /** category hint, passed through to the item */
  categoryHint?: string;
  /** merge similar titles within a batch, on by default */
  dedupeSimilar?: boolean;
  /** bigram Jaccard threshold, default 0.62 */
  similarityThreshold?: number;
};

const DEFAULT_TITLE_KEYWORDS = [
  "免费",
  "白嫖",
  "喜加一",
  "限免",
  "领取",
  "兑换码",
  "羊毛",
  "优惠券",
  "0元",
  "0 元",
  "白给",
  "史低",
];

const DEFAULT_EXCLUDE_KEYWORDS = ["录播", "直播回放", "reaction", "解说", "预告", "花絮"];

/** character bigrams of the normalized title, used to merge similar titles within a batch */
function bigrams(title: string): Set<string> {
  const t = title.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function playOf(it: RawItem): number {
  const raw = it.raw as { play?: unknown } | undefined;
  return typeof raw?.play === "number" ? raw.play : 0;
}

type WbiKeys = { key: string; at: number };
let cachedKeys: WbiKeys | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function pickKey(url: string): string {
  return url.split("/").pop()?.split(".")[0] ?? "";
}

function signQuery(params: Record<string, string | number>, key: string): string {
  const wts = Math.floor(Date.now() / 1000);
  const entries = [...new URLSearchParams({ ...params, wts: String(wts) } as Record<string, string>).entries()].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const query = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${createHash("md5").update(query + key).digest("hex")}`;
}

async function getWbiKey(http: HttpClient): Promise<string | null> {
  if (cachedKeys && Date.now() - cachedKeys.at < KEY_TTL_MS) return cachedKeys.key;
  const res = await http.json<{ code: number; data?: { wbi_img?: { img_url?: string; sub_url?: string } } }>(
    "https://api.bilibili.com/x/web-interface/nav",
    { headers: { referer: "https://www.bilibili.com/" } },
  );
  const wbi = res.data?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) return null;
  const raw = pickKey(wbi.img_url) + pickKey(wbi.sub_url);
  const key = MIXIN.map((i) => raw[i] ?? "").join("").slice(0, 32);
  if (!key) return null;
  cachedKeys = { key, at: Date.now() };
  return key;
}

type BiliItem = Record<string, unknown>;

function toRawItem(it: BiliItem, keyword: string): RawItem | null {
  const bvid = typeof it.bvid === "string" ? it.bvid : "";
  const aid = it.aid ?? it.id;
  const arcurl = typeof it.arcurl === "string" ? it.arcurl : "";
  const url = arcurl ? arcurl.replace(/^http:/, "https:") : bvid ? `https://www.bilibili.com/video/${bvid}` : "";
  const title = cleanText(String(it.title ?? "").replace(/<[^>]+>/g, ""), 200);
  if (!title || !url) return null;
  const id = bvid || String(aid ?? "");
  if (!id) return null;

  const pic = typeof it.pic === "string" ? it.pic : "";
  return {
    externalId: id,
    url,
    title,
    summary: cleanText(String(it.description ?? ""), 400) || null,
    author: typeof it.author === "string" ? it.author : null,
    publishedAt: parseDate(typeof it.pubdate === "number" ? it.pubdate : null),
    imageUrl: pic ? sanitizeImageUrl(pic.startsWith("//") ? `https:${pic}` : pic) : null,
    tags: ["bilibili", keyword].filter(Boolean),
    raw: {
      bvid,
      aid,
      play: it.play ?? null,
      duration: it.duration ?? null,
      typename: it.typename ?? null,
      tag: it.tag ?? null,
    },
  };
}

export const biliCollector: Collector = {
  kind: "bili",
  label: "B站搜索",
  defaults: { config: { keywords: ["免费领取", "白嫖", "喜加一"] } },
  async collect(ctx) {
    const cfg = ctx.config as Partial<BiliConfig>;
    const keywords = (cfg.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
    if (!keywords.length) throw new Error("未配置 keywords");
    const searchType = cfg.searchType ?? "video";
    const limitPerKeyword = Math.min(Math.max(Number(cfg.limitPerKeyword ?? 20), 1), 50);
    const titleKws = (cfg.titleKeywords ?? DEFAULT_TITLE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const excludeKws = (cfg.excludeKeywords ?? DEFAULT_EXCLUDE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const categoryHint = typeof cfg.categoryHint === "string" ? cfg.categoryHint : null;
    const http = ctx.http;

    const items: RawItem[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    let ok = 0;

    const wbiKey = await getWbiKey(http).catch(() => null);
    if (!wbiKey) problems.push("wbi keys 获取失败，走 legacy 搜索");

    for (const keyword of keywords) {
      let list: BiliItem[] = [];
      try {
        if (wbiKey) {
          const qs = signQuery({ search_type: searchType, keyword, page: 1 }, wbiKey);
          const res = await http.json<{ code: number; message?: string; data?: { result?: BiliItem[] } }>(
            `https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`,
            { headers: { referer: "https://www.bilibili.com/" } },
          );
          if (res.data?.code === 0) {
            list = res.data.data?.result ?? [];
          } else {
            problems.push(`${keyword} wbi: code=${res.data?.code} ${res.data?.message ?? ""}`);
          }
        }
      } catch (err) {
        problems.push(`${keyword} wbi: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!list.length) {
        try {
          const res = await http.json<{
            code: number;
            data?: { result?: Array<{ result_type?: string; data?: BiliItem[] }> };
          }>(
            `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=1`,
            { headers: { referer: "https://www.bilibili.com/" } },
          );
          if (res.data?.code === 0) {
            const groups = res.data.data?.result ?? [];
            const videoGroup = groups.find((g) => g.result_type === "video");
            list = videoGroup?.data ?? groups.flatMap((g) => g.data ?? []);
          } else {
            problems.push(`${keyword} legacy: code=${res.data?.code}`);
          }
        } catch (err) {
          problems.push(`${keyword} legacy: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!list.length) continue;
      ok += 1;

      let kept = 0;
      for (const it of list) {
        if (kept >= limitPerKeyword) break;
        const raw = toRawItem(it, keyword);
        if (!raw || seen.has(raw.externalId)) continue;
        // title keywords only look at the title: descriptions often contain words like「免费」, and filtering on them would bring in whole movie and tutorial categories
        const titleHay = raw.title.toLowerCase();
        const fullHay = `${raw.title} ${raw.summary ?? ""}`.toLowerCase();
        if (titleKws.length && !titleKws.some((k) => titleHay.includes(k))) continue;
        if (excludeKws.some((k) => fullHay.includes(k))) continue;
        if (categoryHint) raw.categoryHint = categoryHint;
        seen.add(raw.externalId);
        items.push(raw);
        kept += 1;
      }
      ctx.log(`${keyword} ok:${list.length} kept:${kept}`);
    }

    if (!ok && problems.length) throw new Error("B站搜索全部失败: " + problems.join("; "));

    // the same hot event gets retold by several uploaders (measured: BLG winning the championship produced 10 entries in one run), so merge by title.
    // only merge "different uploader + highly similar" titles: similar titles from the same uploader are usually a series (e.g. a weekly freebie roundup),
    // measured series titles score 0.39-0.47 similarity while the same event retold across uploaders scores 0.71-0.77, so a threshold of 0.7 separates the two.
    let merged = items;
    if (cfg.dedupeSimilar !== false && items.length > 1) {
      const threshold = Number(cfg.similarityThreshold ?? 0.7);
      const ranked = [...items].sort((a, b) => playOf(b) - playOf(a));
      const kept: RawItem[] = [];
      const keptGrams: Set<string>[] = [];
      for (const it of ranked) {
        const grams = bigrams(it.title);
        const dup = kept.some(
          (prev, i) => prev.author !== it.author && jaccard(keptGrams[i]!, grams) >= threshold,
        );
        if (dup) continue;
        kept.push(it);
        keptGrams.push(grams);
      }
      if (kept.length < items.length) ctx.log(`相似标题合并 ${items.length} → ${kept.length}`);
      merged = kept;
    }

    return {
      items: merged.slice(0, ctx.maxItems),
      cursor: null,
      degraded: problems.length ? problems.join("; ") : null,
    };
  },
};

/** exposed for tests */
export const __biliInternals = { signQuery, toRawItem, getWbiKey, resetKeyCache: () => (cachedKeys = null) };

