const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "spm", "scm", "from", "from_source", "share_source", "share_medium", "share_plat",
  "share_session_id", "share_tag", "timestamp", "ref", "referrer", "fbclid", "gclid",
  "yclid", "igshid", "mc_cid", "mc_eid", "s_cid", "sr_share", "isappinstalled",
  "appuid", "apptime", "share_from_user_hidden", "xsec_source", "xsec_token",
]);

/** Strip tracking params, fragments and trailing slash, unify host case; keep meaningful query params. */
export function normalizeUrl(input: string, base?: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return raw;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    if (/^(utm_|spm|share_)/i.test(k)) continue;
    keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/** Dedup key: the same resource under different params should produce the same key. */
export function urlKey(input: string, base?: string): string {
  const normalized = normalizeUrl(input, base);
  try {
    const u = new URL(normalized);
    return `${u.hostname}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+|#39);/gi, (m, name: string) => ENTITIES[name] ?? m);
}

/** Crude but good-enough HTML -> plain text. */
export function cleanText(input: string | null | undefined, maxLength = 400): string {
  if (!input) return "";
  const text = decodeEntities(
    String(input)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function parseDate(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    const ms = input > 1e12 ? input : input * 1000;
    return new Date(ms).toISOString();
  }
  const s = input.trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extract "deadline / valid until" style dates from text, used to downweight expired items. */
export function guessExpiry(text: string): string | null {
  const now = Date.now();
  const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
  if (m) {
    const year = new Date().getFullYear();
    const d = new Date(year, Number(m[1]) - 1, Number(m[2]), 23, 59, 59);
    if (d.getTime() < now - 86_400_000) d.setFullYear(year + 1);
    return d.toISOString();
  }
  const rel = /(\d+)\s*(天|日)\s*(?:内|后)?(?:有效|截止|过期)/.exec(text);
  if (rel) return new Date(now + Number(rel[1]) * 86_400_000).toISOString();
  return null;
}

const NOISE_IMG_RE = /(?:spacer|pixel|blank|1x1|tracking|beacon|gravatar\.com\/avatar|emoji|twemoji|\/avatars\/|user_avatar|badge|shields\.io|data:image)/i;

/** Validate and clean a cover image URL: keep only valid http(s) addresses, filter out tracking pixels / avatars / badges. */
export function sanitizeImageUrl(input: unknown, base?: string): string | null {
  if (typeof input !== "string") return null;
  let s = decodeEntities(input).trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;
  if (NOISE_IMG_RE.test(s)) return null;
  try {
    const u = new URL(s, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const full = u.toString();
    return full.length <= 600 ? full : null;
  } catch {
    return null;
  }
}

/** Extract the first valid content image URL from an HTML fragment. */
export function extractImageFromHtml(html: string | null | undefined, base?: string): string | null {
  if (!html) return null;
  const re = /<img\b[^>]*\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0] ?? "";
    const widthM = /\bwidth\s*=\s*["']?(\d+)/i.exec(tag);
    const heightM = /\bheight\s*=\s*["']?(\d+)/i.exec(tag);
    if ((widthM && Number(widthM[1]) > 0 && Number(widthM[1]) < 32) || (heightM && Number(heightM[1]) > 0 && Number(heightM[1]) < 32)) {
      continue;
    }
    const clean = sanitizeImageUrl(m[1], base);
    if (clean) return clean;
  }
  return null;
}
