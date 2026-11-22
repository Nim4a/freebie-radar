/**
 * Interest filter — free AI credits, free domains, free VPS/cloud, nothing else.
 *
 * The user asked for exactly these topics and explicitly not for free-internet /
 * proxy-node giveaways ("机场", VPN trials), game giveaways or general freebies.
 * The rule lives in code, not only in the editable block-rule table, so a settings
 * reset, a re-classified item or a brand-new source cannot quietly push the off-topic
 * stuff back into the Bot or the digest.
 *
 * Two gates, in this order:
 *   1. hard reject — the category is one of the always-irrelevant buckets (games,
 *      movie/网盘 rips, retail deals, news, proxy trading) or the text carries
 *      off-topic wording (proxy/VPN/机场, Steam/Epic, Netflix/话费…).
 *   2. accept — the category is one of the core topics, OR the text itself talks about
 *      AI / domains / servers, so a VPS freebie that a source filed under "dev" or
 *      "opensource" still reaches the user.
 */

/** The topics the user asked for; anything in this set is accepted outright. */
export const INTEREST_CATEGORIES: readonly string[] = ["ai", "cloud", "vps", "domain"];
const CORE = new Set(INTEREST_CATEGORIES);

/** Buckets that never belong in a free-AI/domain/VPS digest, whatever the wording. */
const OFF_TOPIC_CATEGORY = new Set([
  "game", "gaming", "gamegift",
  "pan", "netdisk", "movie", "tv", "anime", "comic", "novel", "ebook", "music",
  "goods", "shopping", "coupon", "food", "travel",
  "news", "world", "headline", "finance", "sports", "entertainment", "media",
  "carpool", "trade", "lottery", "stock", "btc", "crypto",
]);

/**
 * Off-topic wording matched in the TITLE. Deliberately narrow: bare 节点 / 订阅 mean
 * "compute node" and "subscription" in AI posts, so they only match with a proxy word.
 */
const OFF_TOPIC_TITLE: RegExp[] = [
  // free internet / proxy nodes
  /机场/, /科学上网/, /翻墙/, /梯子/, /加速器/, /免费上网/, /上网工具/, /代理工具/,
  /免费节点/, /节点订阅/, /节点分享/, /订阅链接/, /订阅地址/, /白嫖节点/,
  /\bclash\b/i, /\bv2ray\b/i, /\bv2fly\b/i, /\bxray\b/i, /\bvmess\b/i, /\bvless\b/i,
  /\btrojan\b/i, /\bshadowsocks\b/i, /\bssr\b/i, /\bhysteria\b/i, /\bsing-?box\b/i,
  /\bnaiveproxy\b/i, /\bvpngate\b/i, /\bpsiphon\b/i, /\bwarp\s*(plus|\+)\b/i,
  /\bvpn\b/i, /\bfree\s+(proxy|vpn|node)s?\b/i, /\bproxy\s+(node|list|trial)s?\b/i,
  // game giveaways / launchers
  /游戏/, /手游/, /页游/, /\bsteam\b/i, /\bepic\s*games\b/i, /\bgog\.com\b/i,
  /\bhumble\s*bundle\b/i, /\bitch\.io\b/i, /\bgame\s*pass\b/i, /\bprime\s*gaming\b/i,
  // entertainment memberships and telecom perks (neither AI nor domain nor VPS)
  /影视/, /电影/, /影院/, /追剧/, /剧集/, /动漫/, /漫画/, /小说/, /听书/,
  /话费/, /流量包/, /手机卡/,
  /\bkyc\b/i, /身份证/, /实名/,
  /\bnetflix\b/i, /\bspotify\b/i, /\bdisney\b/i, /\bhbo\s*(max|go)\b/i, /\bprime\s*video\b/i,
];

/**
 * Off-topic wording also matched in the SUMMARY, where a word is far more likely to be
 * incidental — so this is the explicit subset only: a VPS blurb that merely *mentions*
 * it could run a proxy is still a VPS the user wants, a blurb selling nodes is not.
 */
const OFF_TOPIC_SUMMARY: RegExp[] = [
  /机场/, /免费节点/, /节点订阅/, /节点分享/, /订阅链接/, /订阅地址/,
  /\bclash\b/i, /\bv2ray\b/i, /\bv2fly\b/i, /\bxray\b/i, /\bvmess\b/i, /\bvless\b/i,
  /\btrojan\b/i, /\bshadowsocks\b/i, /\bhysteria\b/i, /\bsing-?box\b/i, /\bpsiphon\b/i,
  /\bfree\s+(proxy|vpn)s?\b/i, /\bproxy\s+(node|list|trial)s?\b/i,
  /游戏/, /\bsteam\b/i, /\bepic\s*games\b/i, /\bgog\.com\b/i, /\bhumble\s*bundle\b/i,
];

/**
 * When a source files a genuine freebie under a neutral bucket ("dev", "opensource",
 * "tech", "other"), the text decides. One of these words must be present.
 */
const TOPIC_WORDS: RegExp[] = [
  // AI / model / API credit
  /\bai\b/i, /\bllm\b/i, /\bgpt\b/i, /\bopenai\b/i, /\bchatgpt\b/i, /\bclaude\b/i,
  /\banthropic\b/i, /\bgemini\b/i, /\bdeepseek\b/i, /\bqwen\b/i, /\bmistral\b/i,
  /\bgrok\b/i, /\bcopilot\b/i, /\bmidjourney\b/i, /\bmodel\b/i, /\bapi\b/i,
  /\bcredits?\b/i, /\btokens?\b/i, /\bgpu\b/i, /\bagents?\b/i, /\bmcp\b/i,
  /算力/, /大模型/, /模型/, /额度/, /token/i, /\bai\b/,
  // domains / DNS / certificates / CDN
  /\bdomains?\b/i, /\bdns\b/i, /域名/, /\bsubdomain\b/i, /\bssl\b/i,
  /\bcertificat\w*/i, /\bcloudflare\b/i, /\bnamesilo\b/i, /\bnamecheap\b/i,
  /\bporkbun\b/i, /\bwhois\b/i, /\bcdn\b/i,
  // VPS / cloud / servers
  /\bvps\b/i, /\bvds\b/i, /\bhosting\b/i, /\bservers?\b/i, /\bcloud\b/i,
  /\binstances?\b/i, /\bcontainers?\b/i, /\bkubernetes\b/i, /\bk8s\b/i,
  /\baws\b/i, /\bgcp\b/i, /\bazure\b/i, /\boracle\b/i, /\bhetzner\b/i,
  /\bdigitalocean\b/i, /\bvultr\b/i, /\blinode\b/i, /\bracknerd\b/i, /\bovh\b/i,
  /服务器/, /主机/, /云主机/, /免费云/, /白嫖服务器/,
];

export type InterestItem = {
  title?: string | null;
  title_en?: string | null;
  summary?: string | null;
  summary_en?: string | null;
  category?: string | null;
};

/** The matched off-topic word, or null when the text is fine. */
export function offTopicReason(item: { title?: string | null; summary?: string | null }): string | null {
  for (const re of OFF_TOPIC_TITLE) {
    const m = re.exec(item.title ?? "");
    if (m) return m[0];
  }
  const summary = item.summary ?? "";
  if (summary) {
    for (const re of OFF_TOPIC_SUMMARY) {
      const m = re.exec(summary);
      if (m) return m[0];
    }
  }
  return null;
}

/** Category must be one of the topics the user asked for. */
export function interestingCategory(category: string | null | undefined): boolean {
  return Boolean(category && CORE.has(String(category).trim().toLowerCase()));
}

/** Why the item was dropped, or null when the user wants to see it. */
export function offInterestReason(item: InterestItem): string | null {
  const cat = String(item.category ?? "").trim().toLowerCase();
  if (OFF_TOPIC_CATEGORY.has(cat)) return "category:" + cat;
  const title = [item.title, item.title_en].filter(Boolean).join(" \n ");
  const hit = offTopicReason({ title });
  if (hit) return "title:" + hit;
  const summary = [item.summary, item.summary_en].filter(Boolean).join(" \n ");
  const hit2 = offTopicReason({ title: "", summary });
  if (hit2) return "summary:" + hit2;
  if (CORE.has(cat)) return null;
  const text = title + " \n " + summary;
  for (const re of TOPIC_WORDS) if (re.test(text)) return null;
  return "off-topic:" + (cat || "unknown");
}

/** True only for free AI / domain / VPS / cloud material. */
export function passesInterest(item: InterestItem): boolean {
  return offInterestReason(item) === null;
}
