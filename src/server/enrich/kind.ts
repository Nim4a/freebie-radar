import { DEAL_HINT, isNoiseTitle, OPENSOURCE_HINT, PROMO_HINT } from "./noise.ts";
import { KIND_LABEL, KIND_SET, isContentKind, type ContentKind } from "../../shared/taxonomy.ts";
import { contentSignals } from "./evidence.ts";

export type { ContentKind };
export { KIND_LABEL, isContentKind };
/** Kept for the old name: every kind that can be recognised (including noise). */
export { KIND_SET as VALID_KINDS };

const OPENSOURCE_SOURCES = new Set([
  "github-free-for-dev",
  "github-public-apis",
  "github-awesome-ai",
  "github-selfhosted",
]);

const DEAL_SOURCES = new Set([
  "rss-lowendbox",
  "rss-lowendtalk",
  "rss-lowendspirit",
  "rss-vpsgo",
  "rss-vpsxb",
  "rss-reddit-gamedeals",
  "rss-reddit-googleplay",
  "rss-9to5toys",
  "rss-slickdeals",
  "rss-hip2save",
  "rss-ozbargain",
  "rss-smzdm",
]);

export const NEWS_SOURCES = new Set([
  "cctv-news",
  "rss-chinanews-scroll",
  "rss-chinanews-china",
  "rss-chinanews-world",
  "rss-bbc-zh",
  "rss-dw-cn",
  "rss-rfi-cn",
  "rss-gnews-cn",
  "rss-gnews-world",
  "rss-nikkei-cn",
  "rss-voa-cn",
]);

export function isAuthoritativeNewsSource(
  sourceId: string | null | undefined,
  kindHint?: string | null,
): boolean {
  return kindHint === "news" || Boolean(sourceId && NEWS_SOURCES.has(sourceId));
}

const INFO_SOURCES = new Set([
  "cctv-economy",
  "cctv-tech",
  "rss-wallstreetcn",
  "rss-chinanews-finance",
  "rss-chinanews-it",
  "rss-ruanyifeng",
  "rss-sspai",
  "rss-appinn",
  "rss-producthunt",
  "rss-hnrss",
  "rss-ithome",
  "rss-v2ex-tech",
  "rss-solidot",
]);

/**
 * Rule fallback for inferring the content kind (used when the AI has not reviewed the item or returned no kind).
 * Principles: hard noise -> noise; clearly open source with no pure-freebie wording -> opensource; paid / Black Friday / discount promo -> deal;
 * authoritative politics / world news -> news; economy / stocks / tech / in-depth guides -> info; everything else lands by its free signal.
 */
export function guessKind(input: {
  title: string;
  summary?: string;
  sourceId?: string;
  category?: string | null;
  obtain?: string | null;
  isFree?: boolean;
  price?: number | null;
  freebieOnlySource?: boolean;
  kindHint?: string | null;
  guardEnabled?: boolean;
}): ContentKind {
  const title = input.title ?? "";
  const text = `${title} ${input.summary ?? ""}`;
  const guard = input.guardEnabled !== false;
  const signals = contentSignals(title, input.summary);
  if (isNoiseTitle(title)) return "noise";
  if (input.freebieOnlySource) return "freebie";
  if (input.kindHint && isContentKind(input.kindHint) && input.kindHint !== "noise") {
    if (!guard || !["freebie", "deal", "opensource"].includes(input.kindHint) ||
        (input.kindHint === "freebie" && signals.claim) || (input.kindHint === "deal" && signals.promotion) ||
        (input.kindHint === "opensource" && signals.repository)) return input.kindHint;
  }
  if (guard && signals.editorial) return isAuthoritativeNewsSource(input.sourceId, input.kindHint) ? "news" : "info";

  const hasDealWord = guard ? signals.claim : DEAL_HINT.test(title);
  const hasPromoWord = guard ? signals.promotion : PROMO_HINT.test(text);
  const hasOpenSource = guard ? signals.repository : input.category === "opensource" || OPENSOURCE_HINT.test(text);

  if (hasOpenSource && !hasDealWord && input.obtain !== "paid") {
    return "opensource";
  }
  if (input.sourceId && OPENSOURCE_SOURCES.has(input.sourceId) && !hasDealWord && (!guard || signals.repository)) {
    return "opensource";
  }

  const hasPaidPrice = !input.isFree && typeof input.price === "number" && input.price > 0;
  if ((input.obtain === "paid" || hasPaidPrice) && (!guard || signals.promotion)) {
    return "deal";
  }
  if (hasPromoWord && !hasDealWord && !input.isFree) {
    return "deal";
  }
  // Trade / carpool: the category itself already confirms "listed for sale / leaving for a shared slot", so no extra promo word is required
  // ("50 chu" / "premium 50 chu" / "seat for rent..." carry no promo word, which is why the old logic labelled them info)
  if ((input.category === "carpool" || input.category === "trade") && !hasDealWord) {
    return "deal";
  }
  if (input.sourceId && DEAL_SOURCES.has(input.sourceId) && !input.isFree && !hasDealWord && (!guard || signals.promotion)) {
    return "deal";
  }

  if (input.sourceId && NEWS_SOURCES.has(input.sourceId)) return "news";
  if ((!guard && input.isFree) || hasDealWord) return "freebie";
  if (input.sourceId && INFO_SOURCES.has(input.sourceId)) return "info";
  if (input.category === "opensource" && (!guard || signals.repository)) return "opensource";
  if (
    input.category === "headline" ||
    input.category === "world" ||
    input.category === "stock" ||
    input.category === "finance" ||
    input.category === "tech" ||
    input.category === "news" ||
    input.category === "edu"
  ) {
    // Non-authoritative news sources (e.g. SMZDM / ITHome / community sites) must not land in news; they map to info (advice sites are already blocked above by DEAL_SOURCES)
    return "info";
  }
  return guard ? "info" : "freebie";
}

function coerceNonNewsKind(fallbackInput: Parameters<typeof guessKind>[0]): ContentKind {
  if (
    fallbackInput.sourceId &&
    DEAL_SOURCES.has(fallbackInput.sourceId) &&
    !fallbackInput.isFree &&
    !DEAL_HINT.test(fallbackInput.title ?? "") && fallbackInput.guardEnabled === false
  ) {
    return "deal";
  }
  const guessed = guessKind(fallbackInput);
  return guessed === "noise" || (guessed === "news" && !isAuthoritativeNewsSource(fallbackInput.sourceId, fallbackInput.kindHint)) ? "info" : guessed;
}

const TRADE_LIKE_CATEGORIES = new Set(["trade", "carpool", "goods"]);

/**
 * Category/kind consistency constraint (the last gate).
 * When the category is already confirmed as "second-hand trade / carpool / physical discount", the kind cannot be "industry news":
 * This used to downgrade in one direction only (the AI said deal but there was no promo word, so it was pushed back to info), which produced
 * self-contradictory category=trade + kind=info combinations (500+ rows in the whole DB).
 */
export function alignKindWithCategory(
  kind: ContentKind,
  input: Parameters<typeof guessKind>[0],
): ContentKind {
  if (kind === "noise" || kind === "news") return kind;
  const category = input.category;
  if (!category || !TRADE_LIKE_CATEGORIES.has(category)) return kind;
  if (input.freebieOnlySource) return kind;
  const signals = contentSignals(input.title, input.summary);
  const paidish = input.obtain === "paid" || (typeof input.price === "number" && input.price > 0);
  // Physical freebies with clear claim / give-away evidence and no payment go to freebie (e.g. "free VPS giveaway", "free claim on PDD");
  // a paid "claim a coupon" is still a deal - the word "claim" alone must not turn it into a freebie
  if (signals.claim && !paidish) return "freebie";
  // Editorial content (earnings / accidents / policy coverage) that trips a trade word is not force-changed
  if (signals.editorial && !signals.promotion) return kind;
  // Trade / carpool: the category already says listed transfer or departure, so the kind is deal
  if (category === "trade" || category === "carpool") return "deal";
  // goods (physical/discount) is not news by default: when the AI gives no kind, land it by price / free signal
  if (category === "goods" && kind === "info") {
    if (signals.claim) return "freebie";
    if (paidish) return "deal";
    // Note: obtain=free only means "no price detected", it is not freebie evidence;
    // using it as the fallback labelled every SMZDM review as a freebie.
  }
  // goods: only price or promo evidence makes it a deal; otherwise keep the original verdict
  return paidish || signals.promotion ? "deal" : kind;
}

/** Normalises the final kind from the AI output plus the rule context. */
export function resolveKind(
  aiKind: unknown,
  aiKeep: boolean | null | undefined,
  fallbackInput: Parameters<typeof guessKind>[0],
): ContentKind {
  return alignKindWithCategory(resolveKindRaw(aiKind, aiKeep, fallbackInput), fallbackInput);
}

function resolveKindRaw(
  aiKind: unknown,
  aiKeep: boolean | null | undefined,
  fallbackInput: Parameters<typeof guessKind>[0],
): ContentKind {
  if (aiKeep === false) return "noise";
  if (isContentKind(aiKind)) {
    if (fallbackInput.guardEnabled !== false) {
      const signals = contentSignals(fallbackInput.title, fallbackInput.summary);
      if ((aiKind === "deal" && !signals.promotion) ||
          (aiKind === "freebie" && !signals.claim && !fallbackInput.freebieOnlySource) ||
          (aiKind === "opensource" && !signals.repository)) return coerceNonNewsKind(fallbackInput);
    }
    if (fallbackInput.guardEnabled !== false && aiKind === "noise" && aiKeep === true) return coerceNonNewsKind(fallbackInput);
    if (aiKind === "noise" && aiKeep === true) return guessKind(fallbackInput);
    if (aiKind === "opensource" && (fallbackInput.category === "headline" || fallbackInput.category === "world" || fallbackInput.category === "stock")) {
      return guessKind(fallbackInput);
    }
    // Important news is strictly limited to authoritative news sources; advice / shopping / ordinary community sites (SMZDM, ITHome, ...) must not be mixed into "important news"
    if (aiKind === "news" && !isAuthoritativeNewsSource(fallbackInput.sourceId, fallbackInput.kindHint)) {
      return coerceNonNewsKind(fallbackInput);
    }
    return aiKind;
  }
  if (aiKeep === true) {
    if (fallbackInput.guardEnabled !== false) return coerceNonNewsKind(fallbackInput);
    if (fallbackInput.category === "opensource") return "opensource";
    if (fallbackInput.obtain === "paid" || (!fallbackInput.isFree && typeof fallbackInput.price === "number" && fallbackInput.price > 0)) {
      return "deal";
    }
    const guessed = guessKind(fallbackInput);
    return guessed === "noise" ? "freebie" : guessed;
  }
  return guessKind(fallbackInput);
}
