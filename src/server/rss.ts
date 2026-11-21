import { CATEGORY_LABEL, KIND_LABEL } from "../shared/taxonomy.ts";
import { createHash } from "node:crypto";

export type RssItem = {
  id: number;
  source_id: string;
  title: string;
  url: string;
  summary: string | null;
  content?: string | null;
  category: string | null;
  kind: string | null;
  score: number;
  price: number | null;
  is_free: number;
  obtain: string | null;
  codes: string;
  published_at: string | null;
  first_seen_at: string;
  expires_at: string | null;
  image_url?: string | null;
  ai: string | null;
};

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 forbids control characters; strip them outright or readers fail on the whole document
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** The only thing to handle inside CDATA is the `]]>` sequence; split it apart */
function cdata(input: string): string {
  return "<![CDATA[" + input.replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
}

function parseCodes(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseAi(raw: string | null): { reason?: string; quality?: number } {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as { reason?: string; quality?: number };
    return { reason: typeof o.reason === "string" ? o.reason : undefined, quality: typeof o.quality === "number" ? o.quality : undefined };
  } catch {
    return {};
  }
}

function priceLabel(item: RssItem): string | null {
  if (item.is_free === 1 || item.price === 0) return "Free";
  if (typeof item.price === "number" && item.price > 0) return (item.price < 1 ? "<¥1" : "¥" + Math.round(item.price));
  return null;
}

function describe(item: RssItem): string {
  const parts: string[] = [];
  const cat = CATEGORY_LABEL[item.category ?? "other"] ?? item.category ?? "Other";
  const kind = KIND_LABEL[item.kind ?? "freebie"] ?? item.kind ?? "";
  parts.push(`${cat}${kind ? " · " + kind : ""}`);
  const price = priceLabel(item);
  if (price) parts.push(price);
  if (item.score) parts.push(Math.round(item.score) + " pts");
  if (item.expires_at) {
    const days = Math.ceil((Date.parse(item.expires_at) - Date.now()) / 86_400_000);
    if (days >= 0 && days <= 30) parts.push(days === 0 ? "expires today" : `${days} days left`);
  }
  const codes = parseCodes(item.codes);
  if (codes.length) parts.push("Codes: " + codes.join(" / "));
  const ai = parseAi(item.ai);
  const lines = [parts.join(" · ")];
  if (item.summary) lines.push("", item.summary);
  if (ai.reason) lines.push("", "💡 " + ai.reason);
  if (item.url) lines.push("", item.url);
  return lines.join("\n");
}

export type RssFeedOptions = {
  title: string;
  link: string;
  description: string;
  /** Own URL, written into atom:link rel=self so readers can de-duplicate */
  selfUrl: string;
  /** Item cap, 50 by default */
  limit?: number;
};

/**
 * Emits RSS 2.0. Descriptions wrap the plain-text summary in CDATA (not HTML),
 * so no reader mistakes a `<` in the body for a tag.
 */
export function buildRssXml(items: readonly RssItem[], opts: RssFeedOptions): string {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const now = new Date().toUTCString();
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<channel>",
    `<title>${escapeXml(opts.title)}</title>`,
    `<link>${escapeXml(opts.link)}</link>`,
    `<description>${escapeXml(opts.description)}</description>`,
    `<language>zh-CN</language>`,
    `<lastBuildDate>${now}</lastBuildDate>`,
    `<generator>freebie-radar</generator>`,
    `<atom:link href="${escapeXml(opts.selfUrl)}" rel="self" type="application/rss+xml"/>`,
  ];
  const body: string[] = [];
  for (const item of items.slice(0, limit)) {
    const pub = item.published_at ?? item.first_seen_at;
    const pubDate = pub ? new Date(pub) : null;
    body.push("<item>");
    body.push(`<title>${escapeXml(item.title)}</title>`);
    body.push(`<link>${escapeXml(item.url)}</link>`);
    body.push(`<guid isPermaLink="false">radar-${item.id}</guid>`);
    if (pubDate && !Number.isNaN(pubDate.getTime())) body.push(`<pubDate>${pubDate.toUTCString()}</pubDate>`);
    body.push(`<category>${escapeXml(CATEGORY_LABEL[item.category ?? "other"] ?? "Other")}</category>`);
    body.push(`<dc:source>${escapeXml(item.source_id)}</dc:source>`);
    if (item.image_url && /^https?:\/\//i.test(item.image_url)) {
      body.push(`<enclosure url="${escapeXml(item.image_url)}" type="image/jpeg" length="0"/>`);
    }
    body.push(`<description>${cdata(describe(item))}</description>`);
    body.push("</item>");
  }
  return [...head, ...body, "</channel>", "</rss>"].join("\n");
}

/** Classification/summary edits must change the ETag even when IDs and dates do not. */
export function rssEtag(items: readonly RssItem[], salt: string): string {
  return `W/"${createHash("sha256").update(salt).update(JSON.stringify(items)).digest("hex").slice(0, 24)}-${items.length}"`;
}
