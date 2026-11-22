/**
 * Interest filter — free AI credits, free domains, free VPS/cloud, nothing else.
 *
 * The user asked for exactly these topics and explicitly not for free-internet /
 * proxy-node giveaways ("机场", VPN trials), game giveaways or general freebies.
 * The rule lives in code, not only in the editable block-rule table, so a settings
 * reset, a re-classified item or a brand-new source cannot quietly push the off-topic
 * stuff back into the Bot or the digest.
 */

/** The only categories the user wants to hear about */
export const INTEREST_CATEGORIES: readonly string[] = ["ai", "cloud", "vps", "domain"];

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
  return Boolean(category && INTEREST_CATEGORIES.includes(category));
}

/** Kept only when the category is on-topic and no off-topic wording is present. */
export function passesInterest(item: {
  title?: string | null;
  summary?: string | null;
  category?: string | null;
}): boolean {
  return interestingCategory(item.category) && offTopicReason(item) === null;
}
