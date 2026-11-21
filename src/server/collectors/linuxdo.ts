import { XMLParser } from "fast-xml-parser";
import { flaresolverrGet, hasFlare } from "../flaresolverr.ts";
import { cleanText, extractImageFromHtml, parseDate } from "../enrich/normalize.ts";
import type { Collector, RawItem } from "./types.ts";

/**
 * linux.do collector: uses Discourse RSS, not JSON.
 *
 * Why not JSON:
 *  a direct request to /c/36/l/latest.json returns 403 and only FlareSolverr gets through, taking 40-70 seconds per round,
 *  which eats the timeliness of code-giveaway posts. RSS is an order of magnitude smaller and Cloudflare is far more lenient with it.
 *
 * Two ways to fetch the RSS:
 *  1. direct request (curl gets a 200 in a few hundred milliseconds)
 *  2. when the direct request is blocked, fall back to FlareSolverr -- Node's fetch uses undici,
 *     whose TLS fingerprint differs from curl's, so linux.do returns 403 specifically for it; this path has to stay.
 *     with session reuse a single request takes about 1.4 seconds, still far faster than 40-70 seconds for JSON.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  processEntities: false,
});

type FeedItem = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t;
    if (typeof t === "number") return String(t);
  }
  return "";
}

function parseRss(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as { channel?: { item?: FeedItem | FeedItem[] } } | undefined;
  if (!rss?.channel) throw new Error("不是合法的 RSS");
  return asArray(rss.channel.item);
}

/** extract the topic id from https://linux.do/t/xxx/3166375 */
function topicIdOf(link: string): string | null {
  const m = /\/t\/(?:[^/]+\/)?(\d+)/.exec(link);
  return m ? m[1]! : null;
}

function toRawItem(it: FeedItem, categoryName: string): RawItem | null {
  const title = textOf(it.title).trim();
  const link = textOf(it.link).trim();
  if (!title || !link) return null;
  const id = topicIdOf(link);
  if (!id) return null;

  const description = textOf(it.description);
  return {
    externalId: id,
    url: link,
    title: cleanText(title, 200),
    summary: cleanText(description, 400),
    // the RSS description is the first-post summary, which is enough to judge「送什么、什么条件」(what is given and on what terms),
    // and it also removes the previous one-body-request-per-post (5 posts = 5 FlareSolverr runs)
    content: cleanText(description, 1200),
    author: textOf(it["dc:creator"]) || null,
    publishedAt: parseDate(textOf(it.pubDate)),
    imageUrl: extractImageFromHtml(description, link),
    tags: [categoryName],
    raw: { category: categoryName, via: "rss" },
  };
}

type Ctx = {
  http: { text(url: string): Promise<{ status: number; body: string }> };
  log(msg: string): void;
};

/** rate-limit signal: the collector uses it to mark the round degraded instead of failed. */
export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

async function fetchRss(ctx: Ctx, url: string): Promise<string> {
  let lastStatus = 0;
  let lastName = "";
  try {
    const res = await ctx.http.text(url);
    if (res.status === 200 && res.body.includes("<rss")) {
      ctx.log(`直连 RSS ok ${url}`);
      return res.body;
    }
    // 429 is a rate limit, not a block. Falling back to FlareSolverr spends 30 seconds re-solving the challenge for the same data,
    // and would still fetch the rate-limited content -- pure waste. Give this round up and wait for the next cycle.
    if (res.status === 429) {
      ctx.log(`直连被限流（HTTP 429），本轮跳过，不回落 FlareSolverr`);
      throw new RateLimited("HTTP 429 限流，本轮跳过");
    }
    lastStatus = res.status;
    ctx.log(`直连 RSS HTTP ${res.status}，切 FlareSolverr`);
  } catch (err) {
    if (err instanceof RateLimited) throw err;
    lastName = err instanceof Error ? err.message : String(err);
    ctx.log(`直连 RSS 失败（${lastName}），切 FlareSolverr`);
  }

  if (!hasFlare()) {
    throw new Error(
      lastName ? `直连失败（${lastName}）且未配置 FLARESOLVERR_URL` : `直连 HTTP ${lastStatus} 且未配置 FLARESOLVERR_URL`,
    );
  }
  const res = await flaresolverrGet(url);
  // FlareSolverr can hit the rate limit too, and that should not be treated as a retryable failure either
  if (res.status === 429) throw new RateLimited("FlareSolverr 也返回 429，本轮跳过");
  if (res.status !== 200) throw new Error("FlareSolverr 取 RSS HTTP " + res.status);
  return res.body;
}

type Cfg = { categoryId: number; rssSlug: string; categoryName: string };

export const linuxdoCollector: Collector = {
  kind: "linuxdo",
  label: "LINUX DO",
  defaults: { config: { categoryId: 36, rssSlug: "welfare", categoryName: "福利羊毛" } },
  async collect(ctx) {
    const cfg: Cfg = {
      categoryId: Number(ctx.config.categoryId ?? 36),
      rssSlug: String(ctx.config.rssSlug ?? ""),
      categoryName: String(ctx.config.categoryName ?? ""),
    };

    let items: RawItem[] = [];
    let degraded: string | null = null;

    // 1) category RSS: precise, only the target board
    if (cfg.rssSlug) {
      try {
        const xml = await fetchRss(ctx as Ctx, `https://linux.do/c/${cfg.rssSlug}/${cfg.categoryId}.rss`);
        items = parseRss(xml)
          .map((it) => toRawItem(it, cfg.categoryName))
          .filter((x): x is RawItem => x !== null);
        ctx.log(`分类 RSS ${items.length} 条`);
      } catch (err) {
        // when rate-limited, do not try latest.rss: the second feed will 429 as well, wasting a round
        if (err instanceof RateLimited) {
          ctx.log(`${err.message}（本轮直接结束，不回落）`);
          return { items: [], cursor: ctx.cursor, degraded: err.message };
        }
        degraded = "分类 RSS 失败: " + (err instanceof Error ? err.message : String(err));
        ctx.log(degraded);
      }
    }

    // 2) fallback: latest.rss + filter by category (only the latest 30 entries, covering all boards)
    if (!items.length) {
      try {
        const xml = await fetchRss(ctx as Ctx, "https://linux.do/latest.rss");
        const all = parseRss(xml);
        const filtered = cfg.categoryName ? all.filter((it) => textOf(it.category).trim() === cfg.categoryName) : all;
        items = filtered.map((it) => toRawItem(it, cfg.categoryName)).filter((x): x is RawItem => x !== null);
        ctx.log(`latest.rss ${all.length} 条，命中「${cfg.categoryName}」${items.length} 条`);
        if (!items.length) degraded = (degraded ? degraded + "; " : "") + "latest.rss 未命中板块";
      } catch (err) {
        if (err instanceof RateLimited) {
          ctx.log(`${err.message}（兜底也限流，本轮结束）`);
          return { items: [], cursor: ctx.cursor, degraded: err.message };
        }
        throw err;
      }
    }

    const cursor = items.length ? String(Math.max(...items.map((i) => Number(i.externalId) || 0))) : ctx.cursor;
    return { items: items.slice(0, ctx.maxItems), cursor, degraded };
  },
};
