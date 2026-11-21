import { getCookieSettings } from "../cookie-store.ts";
import { cleanText } from "../enrich/normalize.ts";
import type { Collector, RawItem } from "./types.ts";

/**
 * NGA player community (bbs.nga.cn) board collector.
 *
 * Measured 2026-11-15, home broadband in mainland China:
 * - every mirror domain (bbs.nga.cn / nga.178.com / ngabbs.com / g.nga.cn) returns
 *   403「15:访客不能直接访问」 to guests, and a guestJs timestamp cookie does not help either;
 * - a logged-in session needs only two cookies: ngaPassportUid + ngaPassportCid (the same approach third-party clients use).
 *
 * So this collector uses "HTTP + hosted cookie" and needs no headless browser:
 * 1. primary channel `thread.php?fid=<fid>` (GBK HTML), extracting the post list with a regex;
 * 2. fallback channel `thread.php?fid=<fid>&__output=11` (UTF-8 JSON), parsing data.__T.
 */

type NgaConfig = {
  /** board fid, e.g. 570 = deals and shopping guide */
  fid: number;
  /** board name, used only for logs and tags */
  forumName?: string;
  /** number of pages, default 1 */
  pages?: number;
  /** category hint, e.g. carpool / trade; written to RawItem.categoryHint */
  categoryHint?: string;
};

function cookieHeader(): string {
  const entry = getCookieSettings().sites.nga;
  const cookies = entry?.cookies ?? [];
  if (!cookies.length) {
    throw new Error("未配置 NGA Cookie，请在「数据源运维 → Cookie 托管」粘贴 ngaPassportUid / ngaPassportCid");
  }
  const now = Math.floor(Date.now() / 1000);
  const parts = cookies.map((c) => `${c.name}=${c.value}`);
  if (!cookies.some((c) => c.name === "guestJs")) parts.push(`guestJs=${now}`);
  return parts.join("; ");
}

function baseUrl(fid: number, page: number): string {
  return `https://bbs.nga.cn/thread.php?fid=${fid}&page=${page}`;
}

/**
 * Extract posts from the list-page HTML.
 *
 * Measured 2026-11-15 with ngaPassportUid/Cid, the list page structure is:
 * - attributes are all in **single quotes**: `<a href='/read.php?tid=12754195' id='t_12754195' class='topic'>title</a>`
 * - board rules and pinned posts live in `<div id='toptopics'>` and their anchors have **no** `class='topic'`, which alone filters them out;
 * - real posts always carry `class='topic'` (the row1/row2 row containers are not anchors).
 */
function parseHtml(html: string): RawItem[] {
  const out: RawItem[] = [];
  const seen = new Set<string>();
  const re = /<a\s([^>]{0,600}?)>([^<]{2,200})<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? "";
    if (!/class=['"][^'"]*\btopic\b[^'"]*['"]/.test(attrs)) continue;
    const tid = /href=['"]\/read\.php\?tid=(\d+)/.exec(attrs)?.[1] ?? "";
    const rawTitle = m[2] ?? "";
    if (!tid || seen.has(tid)) continue;
    const title = cleanText(rawTitle, 200);
    if (!title || title.length < 2) continue;
    if (/^(回复|收藏|举报|引用|编辑|删除|更多)$/.test(title)) continue;
    seen.add(tid);
    out.push({
      externalId: tid,
      url: `https://bbs.nga.cn/read.php?tid=${tid}`,
      title,
      summary: null,
      publishedAt: null,
      tags: ["nga"],
      raw: { tid },
    });
  }
  return out;
}

/** fallback channel: the __output=11 JSON. NGA represents posts as "compact objects" whose field indices change between versions, so this does structural probing. */
function parseJson(body: string): RawItem[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    const idx = body.indexOf("{");
    if (idx < 0) return [];
    data = JSON.parse(body.slice(idx));
  }
  const root = data as { data?: { __T?: unknown; __U?: unknown } };
  const list = root?.data?.__T;
  if (!Array.isArray(list)) return [];

  const users = (root.data?.__U ?? {}) as Record<string, unknown>;
  const authorOf = (uid: unknown): string | null => {
    const key = String(uid ?? "");
    const u = users[key];
    if (u && typeof u === "object") {
      const name = (u as Record<string, unknown>)["username"] ?? (u as Record<string, unknown>)["1"];
      if (typeof name === "string" && name.trim()) return name.trim();
    }
    return null;
  };

  const out: RawItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const values = Object.values(obj);
    const tid = values.find((v) => typeof v === "number" && v > 1000) as number | undefined;
    const title = values
      .filter((v): v is string => typeof v === "string")
      .map((s) => cleanText(s, 200))
      .find((s) => s.length >= 4 && /[\u4e00-\u9fa5A-Za-z]/.test(s));
    if (!tid || !title) continue;
    const uid = obj["2"];
    const ts = values.find((v) => typeof v === "number" && v > 1_500_000_000 && v < 2_000_000_000) as number | undefined;
    out.push({
      externalId: String(tid),
      url: `https://bbs.nga.cn/read.php?tid=${tid}`,
      title,
      summary: null,
      author: authorOf(uid),
      publishedAt: ts ? new Date(ts * 1000).toISOString() : null,
      tags: ["nga"],
      raw: { tid, entry },
    });
  }
  return out;
}

export const ngaCollector: Collector = {
  kind: "nga",
  label: "NGA 玩家社区",
  defaults: { config: { fid: 570, pages: 1 } },
  async collect(ctx) {
    const cfg = ctx.config as Partial<NgaConfig>;
    const fid = Number(cfg.fid ?? 570);
    const pages = Math.min(Math.max(Number(cfg.pages ?? 1), 1), 3);
    const cookie = cookieHeader();

    const items: RawItem[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= pages; page += 1) {
      const url = baseUrl(fid, page);
      let ok = false;

      try {
        const res = await ctx.http.text(url, {
          headers: { cookie, referer: "https://bbs.nga.cn/" },
        });
        if (res.status === 403) throw new Error("403 访客不能直接访问（Cookie 未生效或已过期）");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        const html = parseHtml(res.body);
        if (html.length) {
          for (const it of html) {
            if (seen.has(it.externalId)) continue;
            seen.add(it.externalId);
            items.push(it);
          }
          ok = true;
          ctx.log(`fid=${fid} p${page} html ok:${html.length}`);
        }
      } catch (err) {
        problems.push(`p${page} html: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!ok) {
        try {
          const res = await ctx.http.text(`${url}&__output=11`, {
            headers: { cookie, referer: "https://bbs.nga.cn/" },
          });
          if (res.status === 403) throw new Error("403 访客不能直接访问（Cookie 未生效或已过期）");
          if (res.status !== 200) throw new Error("HTTP " + res.status);
          const parsed = parseJson(res.body);
          if (!parsed.length) throw new Error("JSON 中未解析到帖子");
          for (const it of parsed) {
            if (seen.has(it.externalId)) continue;
            seen.add(it.externalId);
            items.push(it);
          }
          ok = true;
          ctx.log(`fid=${fid} p${page} json ok:${parsed.length}`);
        } catch (err) {
          problems.push(`p${page} json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!ok) break;
    }

    if (!items.length) {
      throw new Error("NGA 采集失败: " + (problems.join("; ") || "无数据"));
    }

    const categoryHint = typeof cfg.categoryHint === "string" ? cfg.categoryHint : null;
    if (categoryHint) for (const it of items) it.categoryHint = categoryHint;

    return {
      items: items.slice(0, ctx.maxItems),
      cursor: null,
      degraded: problems.length ? problems.join("; ") : null,
    };
  },
};

/** exposed for tests and troubleshooting */
export const __ngaInternals = { parseHtml, parseJson, baseUrl };
