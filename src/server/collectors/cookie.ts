import { config } from "../config.ts";
import { all } from "../db.ts";
import { BASE_SITE_KEYWORDS, getCookieSettings, siteKeyOfSource, type CookieSiteKey } from "../cookie-store.ts";
import type { Collector, RawItem } from "./types.ts";

function keywordsForSite(site: CookieSiteKey, maxKeywords = 4): string[] {
  const base = BASE_SITE_KEYWORDS[site];
  if (site === "xiaoheihe") return base;
  const extra = all<{ keyword: string }>("SELECT keyword FROM subscriptions ORDER BY keyword").map((r) => r.keyword.trim()).filter(Boolean);
  const pool = [...new Set([...base, ...extra])].slice(0, maxKeywords);
  // Xiaohongshu has to go through the mainland proxy and render page by page: each round guarantees the core term plus 1 rotating term (2 terms take about 35-55 seconds), avoiding 4 terms in a row exceeding 3 minutes
  if (site === "xhs" && pool.length > 2) {
    const rot = pool.slice(1);
    const idx = Math.floor(Date.now() / 3_600_000) % rot.length;
    return [pool[0]!, rot[idx]!];
  }
  return pool;
}

type RunnerItem = {
  externalId?: string;
  url?: string;
  title?: string;
  summary?: string;
  content?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  imageUrl?: string | null;
  tags?: string[];
  raw?: Record<string, unknown>;
};

type RunnerResponse = {
  ok?: boolean;
  error?: string;
  needLogin?: boolean;
  items?: RunnerItem[];
};

/**
 * Server-side cookie-hosted collectors:
 * - on demand, request Zhihu / Xiaohongshu / Xiaoheihe through the lightweight headless executor on the VPS (vps-cookie-runner)
 * - the executor starts headless Chrome, injects the hosted cookies (Xiaohongshu automatically goes through the mainland proxy), scrapes and exits immediately, so it uses 0 MB of browser memory the rest of the time
 * - when no cookie or runnerUrl is configured it says so explicitly, and the local loopback / userscript path (POST /api/ingest) is still kept
 */
export const cookieIngestCollector: Collector = {
  kind: "ingest",
  label: "Cookie 托管采集",
  defaults: { config: {} },
  async collect(ctx) {
    const site = siteKeyOfSource(ctx.sourceId);
    if (!site) throw new Error(`未知登录态数据源: ${ctx.sourceId}`);

    const settings = getCookieSettings();
    const cookies = settings.sites[site]?.cookies ?? [];
    if (!cookies.length) {
      throw new Error(`未配置 ${site} Cookie，请先在「数据源运维 → Cookie 托管」粘贴 Cookie，或使用本机回环/油猴回传`);
    }
    const runnerUrl = settings.runnerUrl.replace(/\/+$/, "");
    if (!runnerUrl) {
      throw new Error("未配置 VPS Cookie 执行器地址（COOKIE_RUNNER_URL）");
    }

    const keywords = keywordsForSite(site);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.ingestToken) headers.authorization = `Bearer ${config.ingestToken}`;

    const res = await fetch(`${runnerUrl}/collect`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        site,
        cookies,
        keywords,
        proxy: site === "xhs" && settings.xhsProxy ? settings.xhsProxy : "",
      }),
      signal: AbortSignal.timeout(240_000),
    });

    const data = (await res.json().catch(() => ({}))) as RunnerResponse;
    if (!res.ok || !data.ok) {
      const msg = data.error || `Cookie 执行器异常 (HTTP ${res.status})`;
      throw new Error(data.needLogin ? `Cookie 已失效，请重新粘贴更新: ${msg}` : msg);
    }

    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items: RawItem[] = [];
    for (const it of rawItems.slice(0, ctx.maxItems)) {
      const title = String(it.title ?? "").trim();
      const url = String(it.url ?? "").trim();
      if (!title || !url) continue;
      items.push({
        externalId: String(it.externalId ?? url),
        url,
        title,
        summary: String(it.summary ?? ""),
        content: typeof it.content === "string" && it.content.trim() ? it.content.trim().slice(0, 4000) : null,
        author: it.author ?? null,
        publishedAt: it.publishedAt ?? null,
        imageUrl: it.imageUrl ?? null,
        tags: Array.isArray(it.tags) ? it.tags : [site, "cookie-vps"],
        raw: it.raw ?? { site, via: "vps-cookie-runner" },
      });
    }
    ctx.log(`${site}: 通过托管 Cookie 抓取 ${items.length} 条`);
    return { items, cursor: null, degraded: null };
  },
};
