import { getCookieSettings } from "../cookie-store.ts";
import { cleanText, parseDate, sanitizeImageUrl } from "../enrich/normalize.ts";
import type { Collector, RawItem } from "./types.ts";

/**
 * Weibo collector (PC ajax API, requires a logged-in weibo.com cookie).
 *
 * Measured 2026-11-15 with a real login cookie:
 * - `weibo.com/ajax/statuses/search?q=<kw>&page=1` → 200 / 340KB / `statuses[]` 48-50 entries,
 *   `total_number` is the total hit count ("免费领取" = 2269246); the `sort=hot|time` parameter has no effect, results are always in time order;
 * - `weibo.com/ajax/statuses/mymblog?uid=<uid>&page=1&feature=0` → 200 / `data.list[]` 20 entries (watching specific accounts);
 * - `m.weibo.cn/api/container/getIndex` returns `ok:-100` (login redirect) with a PC cookie -- **the mobile domain does not accept weibo.com's SUB**,
 *   so the PC ajax API is the only option;
 * - Weibo has no official RSS, and RSSHub's weibo routes are all down on public instances (rsshub.app unreachable / rssforever 503), while self-hosting is expensive.
 *
 * There is a lot of noise (marketing accounts spamming `#SVIP体验卡免费领#`, mobile-game private-server ads), so:
 * - when the same copy is reposted by dozens of accounts, merge by body fingerprint and keep only the most engaged one;
 * - the title is the first sentence of the body (Weibo has no title field).
 */

type WeiboConfig = {
  /** keyword search */
  keywords?: string[];
  /** list of uids to watch (uses mymblog) */
  uids?: string[];
  limitPerKeyword?: number;
  limitPerUser?: number;
  /** the body must match at least one of these; defaults to the freebie whitelist */
  titleKeywords?: string[];
  /** a body matching any of these is dropped */
  excludeKeywords?: string[];
  categoryHint?: string;
};

const DEFAULT_TITLE_KEYWORDS = [
  "免费",
  "白嫖",
  "领取",
  "羊毛",
  "福利",
  "抽奖",
  "券",
  "优惠",
  "0元",
  "限免",
  "兑换",
  "会员",
];

/** measured as the two most spammy kinds: marketing templates and private-server ads */
const DEFAULT_EXCLUDE_KEYWORDS = [
  "获取原图",
  "街拍",
  "写真",
  "套图",
  "我已成功领取",
  "快来点击卡片领取",
  "私服",
  "首充",
  "充值返利",
  "加微",
  "加V",
];

function cookieHeader(): string {
  const entry = getCookieSettings().sites.weibo;
  const cookies = entry?.cookies ?? [];
  if (!cookies.length) {
    throw new Error("未配置微博 Cookie，请在「数据源运维 → Cookie 托管」粘贴 weibo.com 登录后的 Cookie（需含 SUB）");
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Status = Record<string, unknown>;

function textOf(s: Status): string {
  return cleanText(String(s.text_raw ?? s.text ?? ""), 600);
}

/** Weibo has no title, so take the first sentence of the body (freebie info usually says everything in the first sentence) */
function titleOf(text: string): string {
  const cut = text.split(/[。！!？?，,；;\n]/)[0] ?? text;
  const t = cut.trim();
  return (t.length >= 4 ? t : text).slice(0, 100);
}

function toRawItem(s: Status): RawItem | null {
  const mid = String(s.mid ?? s.idstr ?? s.id ?? "");
  const mblogid = typeof s.mblogid === "string" ? s.mblogid : "";
  const user = (s.user ?? {}) as Record<string, unknown>;
  const uid = String(user.idstr ?? user.id ?? "");
  if (!mid) return null;

  const url = uid && mblogid ? `https://weibo.com/${uid}/${mblogid}` : `https://m.weibo.cn/detail/${mid}`;
  const text = textOf(s);
  if (!text) return null;

  const picIds = Array.isArray(s.pic_ids) ? (s.pic_ids as string[]) : [];
  const pageInfo = (s.page_info ?? {}) as Record<string, unknown>;
  const pagePic = typeof pageInfo.page_pic === "string" ? pageInfo.page_pic : "";
  const imageUrl = picIds[0]
    ? `https://wx1.sinaimg.cn/large/${picIds[0]}.jpg`
    : typeof pagePic === "string" && /^https?:\/\//.test(pagePic)
      ? pagePic
      : "";

  return {
    externalId: mid,
    url,
    title: titleOf(text),
    summary: text.slice(0, 400),
    author: typeof user.screen_name === "string" ? user.screen_name : null,
    publishedAt: parseDate(typeof s.created_at === "string" ? s.created_at : null),
    imageUrl: imageUrl ? sanitizeImageUrl(imageUrl) : null,
    tags: ["weibo"],
    raw: {
      mid,
      mblogid,
      attitudes: s.attitudes_count ?? null,
      reposts: s.reposts_count ?? null,
      comments: s.comments_count ?? null,
    },
  };
}

/** body fingerprint: the first 40 characters after stripping emoji / topic markers and whitespace, used to merge marketing spam */
function fingerprint(text: string): string {
  return text
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .slice(0, 40)
    .toLowerCase();
}

function engagement(it: RawItem): number {
  const raw = it.raw as { attitudes?: unknown; reposts?: unknown; comments?: unknown } | undefined;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return n(raw?.attitudes) + n(raw?.reposts) + n(raw?.comments);
}

type SearchResponse = { ok?: number; statuses?: Status[]; total_number?: number; msg?: string };
type MymblogResponse = { ok?: number; data?: { list?: Status[]; since_id?: string }; msg?: string };

export const weiboCollector: Collector = {
  kind: "weibo",
  label: "微博搜索与博主",
  defaults: { config: { keywords: ["免费领取", "白嫖"] } },
  async collect(ctx) {
    const cfg = ctx.config as Partial<WeiboConfig>;
    const keywords = (cfg.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
    const uids = (cfg.uids ?? []).map((u) => String(u).trim()).filter(Boolean);
    if (!keywords.length && !uids.length) throw new Error("未配置 keywords 或 uids");

    const limitPerKeyword = Math.min(Math.max(Number(cfg.limitPerKeyword ?? 20), 1), 50);
    const limitPerUser = Math.min(Math.max(Number(cfg.limitPerUser ?? 20), 1), 20);
    const titleKws = (cfg.titleKeywords ?? DEFAULT_TITLE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const excludeKws = (cfg.excludeKeywords ?? DEFAULT_EXCLUDE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const categoryHint = typeof cfg.categoryHint === "string" ? cfg.categoryHint : null;
    const cookie = cookieHeader();
    const headers = {
      cookie,
      referer: "https://weibo.com/",
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    };

    const items: RawItem[] = [];
    const problems: string[] = [];
    let ok = 0;

    const accept = (s: Status, tag: string): RawItem | null => {
      const raw = toRawItem(s);
      if (!raw) return null;
      const hay = `${raw.title} ${raw.summary ?? ""}`.toLowerCase();
      if (titleKws.length && !titleKws.some((k) => hay.includes(k))) return null;
      if (excludeKws.some((k) => hay.includes(k))) return null;
      if (categoryHint) raw.categoryHint = categoryHint;
      raw.tags = ["weibo", tag];
      return raw;
    };

    for (const keyword of keywords) {
      try {
        const res = await ctx.http.json<SearchResponse>(
          `https://weibo.com/ajax/statuses/search?q=${encodeURIComponent(keyword)}&page=1`,
          { headers },
        );
        if (res.data?.ok !== 1) {
          problems.push(`${keyword}: ${res.data?.msg ?? "ok=" + String(res.data?.ok)}`);
          continue;
        }
        const list = res.data.statuses ?? [];
        let kept = 0;
        for (const s of list) {
          if (kept >= limitPerKeyword) break;
          const raw = accept(s, keyword);
          if (!raw) continue;
          items.push(raw);
          kept += 1;
        }
        ok += 1;
        ctx.log(`${keyword} total=${res.data.total_number ?? "?"} fetched=${list.length} kept=${kept}`);
      } catch (err) {
        problems.push(`${keyword}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const uid of uids) {
      try {
        const res = await ctx.http.json<MymblogResponse>(
          `https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(uid)}&page=1&feature=0`,
          { headers },
        );
        const list = res.data?.data?.list ?? [];
        if (!list.length) {
          problems.push(`uid=${uid}: 无数据（uid 是否正确？）`);
          continue;
        }
        let kept = 0;
        for (const s of list) {
          if (kept >= limitPerUser) break;
          const raw = accept(s, uid);
          if (!raw) continue;
          items.push(raw);
          kept += 1;
        }
        ok += 1;
        ctx.log(`uid=${uid} fetched=${list.length} kept=${kept}`);
      } catch (err) {
        problems.push(`uid=${uid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!ok && problems.length) throw new Error("微博采集全部失败: " + problems.join("; "));

    // dedupe by mid + merge marketing spam by body fingerprint (keeping the most engaged entry)
    const byId = new Map<string, RawItem>();
    for (const it of items) if (!byId.has(it.externalId)) byId.set(it.externalId, it);
    const unique = [...byId.values()].sort((a, b) => engagement(b) - engagement(a));
    const kept: RawItem[] = [];
    const keptPrints = new Set<string>();
    for (const it of unique) {
      const fp = fingerprint(`${it.title} ${it.summary ?? ""}`);
      if (fp && keptPrints.has(fp)) continue;
      if (fp) keptPrints.add(fp);
      kept.push(it);
    }
    if (kept.length < unique.length) ctx.log(`同文案合并 ${unique.length} → ${kept.length}`);

    return {
      items: kept.slice(0, ctx.maxItems),
      cursor: null,
      degraded: problems.length ? problems.join("; ") : null,
    };
  },
};

/** exposed for tests */
export const __weiboInternals = { toRawItem, titleOf, fingerprint, engagement, cookieHeader };