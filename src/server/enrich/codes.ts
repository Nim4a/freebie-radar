/** Extracts directly usable credentials such as redemption codes and invite codes from the title/body. */

const EXPLICIT = /(?:邀请码|兑换码|激活码|优惠码|注册码|礼品码|口令|code|invite\s*code)[\s:：是]{0,4}([A-Za-z0-9][A-Za-z0-9_\-]{3,39})/gi;
const DASHED = /\b([A-Z0-9]{4}(?:-[A-Z0-9]{4}){2,5})\b/g;
const LONG_UPPER = /\b([A-Z0-9]{10,40})\b/g;
const URLISH = /^(?:https?|www|linux|topic|app|store|game)/i;
const STOP = new Set([
  "FREE", "WINNER", "HTTP", "HTTPS", "HTML", "NULL", "TRUE", "FALSE", "LOGIN", "REGISTER",
  "STEAM", "EPIC", "GAMES", "GIVEAWAY", "BONUS", "COUPON", "WELCOME", "SUPPORT", "ACCOUNT",
  "DOWNLOAD", "PASSWORD", "USERNAME", "VERIFY", "PLEASE", "THANKS", "UPDATE", "VERSION",
]);

function plausible(code: string): boolean {
  if (code.length < 4 || code.length > 40) return false;
  if (STOP.has(code.toUpperCase())) return false;
  if (URLISH.test(code)) return false;
  if (/^\d+$/.test(code)) return false; // all-digits values are usually a price or a quantity
  // must contain at least one letter
  if (!/[A-Za-z]/.test(code)) return false;
  return true;
}

/**
 * Returns the deduplicated list of credentials (at most limit entries).
 * Only three kinds count: explicitly labelled ones (invite code / redemption code ...), hyphenated segmented codes, and very long uppercase strings.
 */
export function extractCodes(title: string, content: string | null | undefined, limit = 6): string[] {
  const text = title + " " + (content ?? "");
  const found: string[] = [];
  const push = (c: string | undefined) => {
    const v = (c ?? "").trim().replace(/[.,;:)]}"']+$/, "");
    if (plausible(v) && !found.includes(v)) found.push(v);
  };

  for (const m of text.matchAll(EXPLICIT)) push(m[1]);
  for (const m of text.matchAll(DASHED)) push(m[1]);
  for (const m of text.matchAll(LONG_UPPER)) push(m[1]);

  return found.slice(0, limit);
}

/** The "act fast, nearly gone" signals all live in enrich/noise.ts so the rules are not scattered. */
export { URGENT } from "./noise.ts";
