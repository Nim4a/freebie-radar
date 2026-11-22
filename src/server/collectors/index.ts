import { aiEnabled, config, pushEnabled } from "../config.ts";
import { all, get, run, tx } from "../db.ts";
import { demoteEditorialGoods, demoteOfflineCategory, enforceFreebieEvidence, enrichItem, FREEBIE_ONLY_SOURCES, isCategory, resolveKind, type ContentKind } from "../enrich/index.ts";
import { calibrateScoreByObtain, resolveDbMergeKey } from "../enrich/alias.ts";
import { getAiSettings, matchesEntryNoise, shouldPassSourceToAi, shouldReview, type AiVerdict } from "../enrich/ai.ts";
import { enqueueForAi, reviewFreshNow, setPostReviewHandler } from "../enrich/ai-queue.ts";
import { guessObtain, type ObtainMode } from "../enrich/obtain.ts";
import { isBlocked, loadActiveBlockRules } from "../enrich/blocklist.ts";
import { getRetention } from "../retention.ts";
import { hasCookieConfiguredForSource } from "../cookie-store.ts";
import { getPushSettings, pushInstant, pushReviewedByIds } from "../instant.ts";
import { dispatchUserPush, dispatchUserPushByIds, hasEnabledUserPush } from "../user-push.ts";

// After a background AI re-review passes: push globally first, then dispatch once per user according to their personal rules
setPostReviewHandler(async (sourceId, ids) => {
  const n = await pushReviewedByIds(sourceId, ids);
  await dispatchUserPushByIds(sourceId, ids).catch((err) => {
    console.error("[user-push] backfill dispatch failed:", err instanceof Error ? err.message : err);
  });
  return n;
});
import { createHttp, type HttpClient } from "../http.ts";
import { mockCollector } from "./mock.ts";
import { linuxdoCollector } from "./linuxdo.ts";
import { v2exCollector } from "./v2ex.ts";
import { githubCollector } from "./github.ts";
import { rssCollector } from "./rss.ts";
import { telegramCollector } from "./telegram.ts";
import { gamerpowerCollector } from "./gamerpower.ts";
import { epicCollector } from "./epic.ts";
import { gogCollector } from "./gog.ts";
import { steamCollector } from "./steam.ts";
import { cheapsharkCollector } from "./cheapshark.ts";
import { openrouterCollector } from "./openrouter.ts";
import { bskyCollector } from "./bsky.ts";
import { cctvCollector } from "./cctv.ts";
import { cookieIngestCollector } from "./cookie.ts";
import { ngaCollector } from "./nga.ts";
import { biliCollector } from "./bili.ts";
import { weiboCollector } from "./weibo.ts";
import type { Collector, RawItem, SourceSeed } from "./types.ts";
import { getSourceHints, applyManualClassification } from "../source-settings.ts";
import { categoryForSource } from "../../shared/source-classification.ts";
import { isSharedResource } from "../enrich/evidence.ts";
export { getSourceHints } from "../source-settings.ts";

export const COLLECTORS: Collector[] = [
  mockCollector, linuxdoCollector, v2exCollector, githubCollector, rssCollector, telegramCollector,
  gamerpowerCollector, epicCollector, gogCollector, steamCollector, cheapsharkCollector, bskyCollector, openrouterCollector, cctvCollector, cookieIngestCollector,
  ngaCollector, biliCollector, weiboCollector,
];
const BY_KIND = new Map(COLLECTORS.map((c) => [c.kind, c]));

/** Built-in source list; append here once a collector lands. */
export const SEEDS: SourceSeed[] = [
  { id: "linuxdo-welfare", name: "LINUX DO · Welfare Deals", kind: "linuxdo", enabled: true, intervalSec: 90, config: { categoryId: 36, rssSlug: "welfare", categoryName: "福利羊毛" } },
  { id: "linuxdo-resource", name: "LINUX DO · Resource Hub", kind: "linuxdo", enabled: false, intervalSec: 180, config: { categoryId: 14, rssSlug: "resource", categoryName: "资源荟萃", fixedCategory: "pan" } },
  { id: "linuxdo-develop", name: "LINUX DO · Development & Tuning", kind: "linuxdo", enabled: true, intervalSec: 600, config: { categoryId: 4, rssSlug: "develop", categoryName: "开发调优" } },
  { id: "linuxdo-news", name: "LINUX DO · Frontier News", kind: "linuxdo", enabled: true, intervalSec: 600, config: { categoryId: 34, rssSlug: "news", categoryName: "前沿快讯" } },
  { id: "linuxdo-domestic", name: "LINUX DO · Domestic Alternatives", kind: "linuxdo", enabled: true, intervalSec: 1800, config: { categoryId: 98, rssSlug: "domestic", categoryName: "国产替代" } },
  { id: "v2ex-free", name: "V2EX · Free Giveaways", kind: "v2ex", enabled: true, intervalSec: 120, config: { node: "free" } },
  { id: "v2ex-deals", name: "V2EX · Deals", kind: "v2ex", enabled: true, intervalSec: 300, config: { node: "deals" } },
  { id: "v2ex-cloud", name: "V2EX · Cloud Computing", kind: "v2ex", enabled: false, intervalSec: 1800, config: { node: "cloud" } },
  { id: "v2ex-share", name: "V2EX · Shared Discoveries", kind: "v2ex", enabled: false, intervalSec: 600, config: { node: "share" } },
  { id: "v2ex-promotions", name: "V2EX · Promotions & Signup Gifts", kind: "v2ex", enabled: false, intervalSec: 600, config: { node: "promotions" } },

  // === AI / Cloud / Developer Freebies ===
  { id: "openrouter-free", name: "OpenRouter · New Free LLMs", kind: "openrouter", enabled: true, intervalSec: 3600, config: { maxAgeDays: 14 } },
  {
    id: "rss-nodeseek",
    name: "NodeSeek · Freebie Intel",
    kind: "rss",
    enabled: true,
    intervalSec: 300,
    config: {
      feeds: [
        {
          id: "nodeseek",
          url: "https://rss.nodeseek.com/",
          limit: 40,
          includeCategories: ["info", "promotion", "trade"],
        },
      ],
    },
  },
  { id: "rss-deepflood", name: "DeepFlood · AI & Practical Resources", kind: "rss", enabled: true, intervalSec: 900, config: { feeds: [{ id: "deepflood", url: "https://www.deepflood.com/rss.xml", limit: 30 }] } },
  { id: "rss-nodeloc", name: "NodeLoc · CN Deals & VPS", kind: "rss", enabled: true, intervalSec: 900, config: { feeds: [{ id: "nodeloc", url: "https://www.nodeloc.com/latest.rss", limit: 30 }] } },
  { id: "rss-meta-appinn", name: "Appinn Forum · Discovery", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "meta-appinn", url: "https://meta.appinn.net/c/faxian/10.rss", limit: 25 }] } },
  { id: "rss-lowendtalk", name: "LowEndTalk · Black Friday / VPS Firsthand", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "lowendtalk", url: "https://lowendtalk.com/categories/offers/feed.rss", limit: 25, categoryHint: "vps" }] } },
  { id: "rss-lowendspirit", name: "LowEndSpirit · Budget Hosting", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "lowendspirit", url: "https://lowendspirit.com/discussions/feed.rss", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-vpsgo", name: "VPSGO · Hosting Promos", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpsgo", url: "https://www.vpsgo.com/feed", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-vpsxb", name: "VPS Xiaozhan · Bargain Hosting", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpsxb", url: "https://www.vpsxb.net/feed/", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-lowendbox", name: "LowEndBox · VPS Deals", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "lowendbox", url: "https://lowendbox.com/feed/", limit: 20 }] } },
  // Chinese hosting-niche promo blogs (RSS verified working 2026-11-15, reachable directly from CN)
  { id: "rss-vpsjxw", name: "VPS Jingxuan · CN Hosting Deals", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpsjxw", url: "https://www.vpsjxw.com/feed", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-laozuo", name: "LaoZuo Blog · VPS Deals", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "laozuo", url: "https://www.laozuo.org/feed", limit: 15, categoryHint: "vps" }] } },
  { id: "rss-veidc", name: "VEIDC · Hosting Promos", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "veidc", url: "https://www.veidc.com/feed", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-vpser", name: "VPS Detective · Hosting Deals", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpser", url: "https://www.vpser.net/feed", limit: 15, categoryHint: "vps" }] } },
  { id: "rss-banwagong", name: "Banwagong CN · Plans & Deals", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "banwagong", url: "https://www.banwagong.net/feed", limit: 15, categoryHint: "vps" }] } },

  // === Game Freebies / Keys / Loot ===
  { id: "epic-free", name: "Epic Games · This Week's Freebies", kind: "epic", enabled: true, intervalSec: 3600, config: { includeUpcoming: false } },
  { id: "steam-free", name: "Steam · Limited-time Free", kind: "steam", enabled: true, intervalSec: 1800, config: { count: 50 } },
  { id: "gamerpower", name: "GamerPower · Free Game Aggregator", kind: "gamerpower", enabled: true, intervalSec: 900, config: { query: "type=game", limit: 60 } },
  { id: "gamerpower-loot", name: "GamerPower · Free Loot & Keys", kind: "gamerpower", enabled: true, intervalSec: 1800, config: { query: "type=loot", limit: 40 } },
  { id: "cheapshark-free", name: "CheapShark · Free & ≤$1 Games", kind: "cheapshark", enabled: true, intervalSec: 900, config: { upperPrice: 1, pageSize: 40 } },
  { id: "rss-itch-free", name: "itch.io · 100% Off Games", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "itch-free", url: "https://itch.io/games/on-sale.xml", limit: 25, only100Off: true }] } },
  { id: "rss-isthereanydeal", name: "IsThereAnyDeal · Giveaways", kind: "rss", enabled: true, intervalSec: 900, config: { feeds: [{ id: "itad", url: "https://isthereanydeal.com/feeds/US/giveaways.rss", limit: 30 }] } },
  { id: "rss-indiegamebundles", name: "IndieGameBundles · Free Games", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "indiegamebundles", url: "https://www.indiegamebundles.com/category/free/feed/", limit: 25 }] } },
  { id: "rss-freesteamkeys", name: "FreeSteamKeys · Steam Freebies", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freesteamkeys", url: "https://freesteamkeys.com/feed/", limit: 25 }] } },
  { id: "rss-ggdeals", name: "GG.deals · Freebies & News", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "ggdeals", url: "https://gg.deals/news/feed/", limit: 25 }] } },
  { id: "rss-keylol", name: "Keylol", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "keylol", url: "https://keylol.com/forum.php?mod=rss", limit: 30 }] } },
  { id: "tg-freegames", name: "TG · Free Game Intel", kind: "telegram", enabled: true, intervalSec: 300, config: { channels: ["freegamesnews", "steamfreebies"] } },
  { id: "tg-pan-yunpan", name: "TG · Cloud Drive Collections (Xunlei / Aliyun / Quark)", kind: "telegram", enabled: true, intervalSec: 600, config: { channels: ["yunpanxunlei", "sharealiyun", "yunpans"], fixedCategory: "pan" } },
  { id: "tg-pan-yiove", name: "TG · Yiove General Resources (Docs / Books / Games)", kind: "telegram", enabled: true, intervalSec: 900, config: { channels: ["YioveComplex"], fixedCategory: "pan", splitNumbered: true } },
  { id: "gog-free", name: "GOG · Limited-time Free", kind: "gog", enabled: false, config: {} },

  // === Licensed Software Giveaways / Tools ===
  { id: "rss-giveawayoftheday", name: "Giveaway of the Day · Daily Free Software", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "giveawayoftheday", url: "https://www.giveawayoftheday.com/feed/", limit: 20 }] } },
  { id: "rss-tickcoupon", name: "TickCoupon · Lifetime Free Software", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "tickcoupon", url: "https://giveaway.tickcoupon.com/feed/", limit: 20 }] } },
  {
    id: "rss-sharewareonsale",
    name: "SharewareOnSale · 100% Off",
    kind: "rss",
    enabled: true,
    intervalSec: 1800,
    config: { feeds: [{ id: "sharewareonsale", url: "https://sharewareonsale.com/feed", limit: 25, titleKeywords: ["100% discount", "free"] }] },
  },
  { id: "rss-ghxi", name: "Guohe Bokee · Free Software Resources", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "ghxi", url: "https://www.ghxi.com/feed", limit: 20 }] } },
  { id: "rss-yxssp", name: "Yixing Software Space · Free Software", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "freebie", categoryHint: "software", feeds: [{ id: "yxssp", url: "https://www.yxssp.com/feed", limit: 20, categoryHint: "software" }] } },
  { id: "rss-freegroup", name: "FreeGroup · Free Resource Community", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "freebie", feeds: [{ id: "freegroup", url: "https://free.com.tw/feed/", limit: 20 }] } },
  { id: "rss-iplaysoft", name: "Iplaysoft Software World", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "iplaysoft", url: "https://www.iplaysoft.com/feed", limit: 25 }] } },

  // === High-purity Reddit freebie communities (interval stretched a little to avoid 429) ===
  { id: "rss-reddit-freegames", name: "Reddit · FreeGameFindings", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freegamefindings", url: "https://www.reddit.com/r/FreeGameFindings/hot.rss", limit: 30 }] } },
  { id: "rss-reddit-freebies", name: "Reddit · freebies", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freebies", url: "https://www.reddit.com/r/freebies/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-efreebies", name: "Reddit · eFreebies", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "efreebies", url: "https://www.reddit.com/r/efreebies/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-apphookup", name: "Reddit · AppHookup (App Freebies)", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "apphookup", url: "https://www.reddit.com/r/AppHookup/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-freeebooks", name: "Reddit · FreeEBOOKS", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freeebooks", url: "https://www.reddit.com/r/FreeEBOOKS/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-freegamesonsteam", name: "Reddit · FreeGamesOnSteam", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freegamesonsteam", url: "https://www.reddit.com/r/FreeGamesOnSteam/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-gamedeals", name: "Reddit · GameDeals (incl. Discounts)", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "gamedeals", url: "https://www.reddit.com/r/GameDeals/hot.rss", limit: 30 }] } },
  { id: "rss-reddit-googleplay", name: "Reddit · GooglePlayDeals", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "googleplaydeals", url: "https://www.reddit.com/r/googleplaydeals/hot.rss", limit: 30 }] } },

  // === General Samples & Regional Deals ===
  { id: "rss-freebieshark", name: "FreebieShark · Free Samples", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freebieshark", url: "https://www.freebieshark.com/feed/", limit: 25 }] } },
  { id: "rss-heyitsfree", name: "HeyItsFree · Free Samples", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "heyitsfree", url: "https://heyitsfree.net/feed/", limit: 30 }] } },
  { id: "rss-ozbargain", name: "OzBargain · AU Free Deals", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "ozbargain", url: "https://www.ozbargain.com.au/feed", limit: 25 }] } },
  { id: "rss-freestufftimes", name: "FreeStuffTimes · $0 Samples", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "freebie", feeds: [{ id: "freestufftimes", url: "https://www.freestufftimes.com/feed", limit: 25 }] } },
  { id: "rss-freeflys", name: "FreeFlys · $0 Samples", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "freebie", feeds: [{ id: "freeflys", url: "https://www.freeflys.com/feed/", limit: 20 }] } },

  // === Logged-in sites (scheduled collection via VPS-hosted cookies / or local userscript report-back) ===
  { id: "zhihu-search", name: "Zhihu · Freebie Search", kind: "ingest", enabled: true, intervalSec: 3600, config: { keyword: "免费领取" } },
  { id: "xhs-search", name: "Xiaohongshu · Freebie Search", kind: "ingest", enabled: true, intervalSec: 3600, config: { keyword: "免费领取" } },
  { id: "xiaoheihe-search", name: "Xiaoheihe · Freebie Search", kind: "ingest", enabled: true, intervalSec: 3600, config: { keyword: "免费" } },
  // NGA needs session cookies (ngaPassportUid / ngaPassportCid): fid=570 Deals & Shopping Guide, the main CN freebie hub
  { id: "nga-deals", name: "NGA · Deals & Shopping Guide", kind: "nga", enabled: true, intervalSec: 600, config: { fid: 570, forumName: "优惠信息购物指南" } },
  // 570 / 613 / 498 are all sub-forums under "Chatter > Consumer Electronics IT News (436)"; 613 is group-buy pooling, 498 is secondhand trading
  { id: "nga-carpool", name: "NGA · Buyer Mutual Aid (Group Buys)", kind: "nga", enabled: true, intervalSec: 900, config: { fid: 613, forumName: "分享活动买家互助", categoryHint: "goods" } },
  { id: "nga-trade", name: "NGA · Secondhand Trading", kind: "nga", enabled: true, intervalSec: 1200, config: { fid: 498, forumName: "二手交易", categoryHint: "trade" } },
// Bilibili keyword search: the wbi signature works without login; grabs "free game / freebie / limited-time free" videos; the content is video, so the first AI pass decides kind
  { id: "bili-freebies", name: "Bilibili · Free-Stuff Search", kind: "bili", enabled: true, intervalSec: 1800, config: { keywords: ["免费领取", "白嫖", "喜加一", "限时免费"], limitPerKeyword: 15 } },
// Weibo: PC ajax search + user-watching, needs a weibo.com login cookie (SUB); no official RSS, and public RSSHub instances are all dead
  // Keyword-search results measured extremely noisy (borderline image packs, mobile-game private servers, "free milk tea tutorial" spam), so off by default;
  // To enable it, prefer watch mode: set uids: ["<freebie blogger uid>", ...] in config, which is far higher quality than keyword search
  { id: "weibo-freebies", name: "Weibo · Freebie Search (noisy, off by default)", kind: "weibo", enabled: false, intervalSec: 1800, config: { keywords: ["免费领取", "白嫖攻略", "羊毛"], limitPerKeyword: 20 } },

  // === Opt-in low-purity / proxy-required / extended sources (off by default to stay low-noise and lightweight) ===
  { id: "tg-cn-deals", name: "TG · CN Tech / VPS / Deals", kind: "telegram", enabled: false, intervalSec: 300, config: { channels: ["zaihuapd", "zaihuanews", "v2ex_channel", "appinnfeed"] } },
  { id: "bsky-gamedeals", name: "Bluesky · Game Deals Accounts", kind: "bsky", enabled: false, intervalSec: 1800, config: { actors: ["freegamefindings.bsky.social", "freegamealert.bsky.social", "wario64.bsky.social", "cheapassgamer.com", "dekudeals.com", "steamdb.bsky.social"], limitPerActor: 10 } },
  { id: "bsky-plugins", name: "Bluesky · Free Plugins & General", kind: "bsky", enabled: false, intervalSec: 1800, config: { actors: ["plugindeals.net", "frugalfreebies.bsky.social", "freebies.bsky.social"], limitPerActor: 10 } },
  { id: "rss-hip2save", name: "Hip2Save · US Deals", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "hip2save", url: "https://hip2save.com/feed/", limit: 30 }] } },
  { id: "rss-vonbeau", name: "VonBeau · Free Samples (anti-bot bypass needed)", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "vonbeau", url: "https://www.vonbeau.com/feed/", limit: 30 }] } },
  { id: "rss-slickdeals", name: "Slickdeals (anti-bot bypass needed)", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "slickdeals", url: "https://slickdeals.net/newsearch.php?rss=1&searcharea=deals&searchin=first", limit: 30 }] } },
  { id: "rss-appinn", name: "Appinn", kind: "rss", enabled: false, config: { feeds: [{ id: "appinn", url: "https://www.appinn.com/feed/", limit: 20 }] } },
  { id: "rss-sspai", name: "SSPAI", kind: "rss", enabled: false, config: { feeds: [{ id: "sspai", url: "https://sspai.com/feed", limit: 20 }] } },
  // === Top News (CCTV News / China News Service / authoritative international Chinese media; goes straight into the "Top News" channel; shopping-guide and community sources must not mix in) ===
  {
    id: "cctv-news",
    name: "CCTV News · Top News",
    kind: "cctv",
    enabled: true,
    intervalSec: 1800,
    config: {
      channels: [
        { channel: "news", cb: "news", categoryHint: "headline", limit: 20 },
        { channel: "china", cb: "china", categoryHint: "headline", limit: 15 },
        { channel: "world", cb: "world", categoryHint: "world", limit: 15 },
        { channel: "society", cb: "society", categoryHint: "headline", limit: 10 },
        { channel: "law", cb: "law", categoryHint: "headline", limit: 10 },
      ],
    },
  },
  { id: "rss-chinanews-china", name: "China News · Domestic Politics", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "chinanews-china", url: "https://www.chinanews.com.cn/rss/china.xml", limit: 20, categoryHint: "headline" }] } },
  { id: "rss-chinanews-world", name: "China News · World News", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "chinanews-world", url: "https://www.chinanews.com.cn/rss/world.xml", limit: 20, categoryHint: "world" }] } },
  { id: "rss-chinanews-scroll", name: "China News · Rolling News", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "chinanews-scroll", url: "https://www.chinanews.com.cn/rss/scroll-news.xml", limit: 25, categoryHint: "headline" }] } },
  { id: "rss-gnews-cn", name: "Google News · Chinese Top News", kind: "rss", enabled: false, intervalSec: 1800, config: { feeds: [{ id: "gnews-cn", url: "https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 25, categoryHint: "headline" }] } },
  { id: "rss-gnews-world", name: "Google News · World Headlines", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "gnews-world", url: "https://news.google.com/rss/headlines/section/topic/WORLD?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "world" }] } },
  { id: "rss-bbc-zh", name: "BBC Chinese · World News", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "bbc-zh", url: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml", limit: 20, categoryHint: "world" }] } },
  { id: "rss-dw-cn", name: "DW · Chinese Top News", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "dw-cn", url: "https://rss.dw.com/xml/rss-chi-all", limit: 20, categoryHint: "world" }] } },
  { id: "rss-rfi-cn", name: "RFI Chinese · World & Politics", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "rfi-cn", url: "https://www.rfi.fr/cn/rss", limit: 20, categoryHint: "world" }] } },
  { id: "rss-nikkei-cn", name: "Nikkei Chinese · Asia Politics & Business", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "news", categoryHint: "world", feeds: [{ id: "nikkei-cn", url: "https://cn.nikkei.com/rss.html", limit: 20, categoryHint: "world" }] } },
  { id: "rss-voa-cn", name: "VOA Chinese · World News", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "news", categoryHint: "world", feeds: [{ id: "voa-cn", url: "https://www.voachinese.com/api/", limit: 20, categoryHint: "world" }] } },

  // === Industry News (economy / stocks / tech / AI / gadgets; goes straight into the "Industry News" channel) ===
  {
    id: "cctv-economy",
    name: "CCTV News · Finance & Economy",
    kind: "cctv",
    enabled: true,
    intervalSec: 3600,
    config: { channels: [{ channel: "economy_zixun", cb: "economy_zixun", categoryHint: "finance", limit: 15 }] },
  },
  {
    id: "cctv-tech",
    name: "CCTV News · Tech Frontier",
    kind: "cctv",
    enabled: true,
    intervalSec: 3600,
    config: { channels: [{ channel: "tech", cb: "tech", categoryHint: "tech", limit: 15 }] },
  },
  { id: "rss-wallstreetcn", name: "WallstreetCN · Economy & Stocks", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "wallstreetcn", url: "https://dedicated.wallstreetcn.com/rss.xml", limit: 25 }] } },
  { id: "rss-qbitai", name: "QbitAI · AI Frontier", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "info", categoryHint: "ai", feeds: [{ id: "qbitai", url: "https://www.qbitai.com/feed", limit: 20, categoryHint: "ai" }] } },
  { id: "rss-leiphone", name: "Leiphone · AI & Tech", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "leiphone", url: "https://www.leiphone.com/feed", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-tmtpost", name: "TMTPost · Business & Tech", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "tmtpost", url: "https://www.tmtpost.com/rss.xml", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-ifanr", name: "ifanr · Digital Frontier", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "ifanr", url: "https://www.ifanr.com/feed", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-gnews-biz", name: "Google News · Business Headlines", kind: "rss", enabled: false, intervalSec: 1800, config: { kindHint: "info", categoryHint: "finance", feeds: [{ id: "gnews-biz", url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 25, categoryHint: "finance" }] } },
  { id: "rss-gnews-cls", name: "Cailian Press News (Google News)", kind: "rss", enabled: false, intervalSec: 1800, config: { kindHint: "info", categoryHint: "stock", feeds: [{ id: "gnews-cls", url: "https://news.google.com/rss/search?q=site:cls.cn&hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "stock" }] } },
  { id: "rss-gnews-yicai", name: "Yicai (Google News)", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "finance", feeds: [{ id: "gnews-yicai", url: "https://news.google.com/rss/search?q=site:yicai.com&hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "finance" }] } },
  { id: "rss-gnews-tech", name: "Google News · Tech Headlines", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "gnews-tech", url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-openai-blog", name: "OpenAI Official Blog", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "ai", feeds: [{ id: "openai-blog", url: "https://openai.com/news/rss.xml", limit: 15, categoryHint: "ai" }] } },
  { id: "rss-cloudflare-blog", name: "Cloudflare Tech Blog", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "cloud", feeds: [{ id: "cloudflare-blog", url: "https://blog.cloudflare.com/rss/", limit: 15, categoryHint: "cloud" }] } },
  { id: "rss-chinanews-finance", name: "China News · Finance", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "chinanews-finance", url: "https://www.chinanews.com.cn/rss/finance.xml", limit: 20 }] } },
  { id: "rss-chinanews-it", name: "China News · IT & Tech", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "chinanews-it", url: "https://www.chinanews.com.cn/rss/it.xml", limit: 20 }] } },
  { id: "rss-solidot", name: "Solidot · Geek Tech", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "solidot", url: "https://www.solidot.org/index.rss", limit: 20 }] } },
  { id: "rss-ithome", name: "ITHome", kind: "rss", enabled: false, config: { feeds: [{ id: "ithome", url: "https://www.ithome.com/rss/", limit: 25 }] } },
  { id: "rss-smzdm", name: "SMZDM", kind: "rss", enabled: false, config: { feeds: [{ id: "smzdm", url: "https://www.smzdm.com/rss/", limit: 20 }] } },
  { id: "rss-fuliba", name: "Fuliba", kind: "rss", enabled: false, config: { feeds: [{ id: "fuliba", url: "https://fuliba.net/feed", limit: 30 }] } },
  // The 52pojie site-wide RSS measured as a mix of crack tutorials and resource requests (2026-11-15), too low a freebie ratio, so kept disabled
  { id: "rss-52pojie", name: "52pojie", kind: "rss", enabled: false, config: { feeds: [{ id: "52pojie", url: "https://www.52pojie.cn/forum.php?mod=rss", limit: 20 }] } },
  { id: "rss-9to5toys", name: "9to5Toys Deals", kind: "rss", enabled: false, config: { feeds: [{ id: "9to5toys", url: "https://9to5toys.com/feed/", limit: 25 }] } },
  { id: "rss-producthunt", name: "Product Hunt", kind: "rss", enabled: false, config: { feeds: [{ id: "producthunt", url: "https://www.producthunt.com/feed", limit: 25 }] } },
  { id: "rss-hnrss", name: "Hacker News (100+ points)", kind: "rss", enabled: false, config: { feeds: [{ id: "hnrss", url: "https://hnrss.org/frontpage?points=100", limit: 25 }] } },
  { id: "rss-ruanyifeng", name: "Ruan Yifeng · Tech Enthusiast Weekly", kind: "rss", enabled: false, intervalSec: 21600, config: { feeds: [{ id: "ruanyifeng", url: "https://www.ruanyifeng.com/blog/atom.xml", limit: 10 }] } },
  { id: "github-free-for-dev", name: "GitHub · free-for-dev", kind: "github-readme", enabled: false, config: { repos: [{ repo: "ripienaar/free-for-dev", limit: 60 }] } },
  { id: "github-public-apis", name: "GitHub · Free Public APIs", kind: "github-readme", enabled: false, config: { repos: [{ repo: "public-apis/public-apis", limit: 40 }] } },
  { id: "github-awesome-ai", name: "GitHub · AI Tools List", kind: "github-readme", enabled: false, config: { repos: [{ repo: "mahseema/awesome-ai-tools", limit: 40 }] } },
  { id: "github-selfhosted", name: "GitHub · Self-hosted List", kind: "github-readme", enabled: false, config: { repos: [{ repo: "awesome-selfhosted/awesome-selfhosted", limit: 40 }] } },
  { id: "tg-channels", name: "Telegram Deals Channel", kind: "telegram", enabled: false, config: { channels: [] } },
];

/** Lets the local Playwright collector report results back to the server; also backfills runs / sources status so /status keeps a record. */
/**
 * First-pass pre-screen, AI semantic review and push scheduling for new items:
 * - Rule pre-screen (matchesEntryNoise): when enabled, first filter out help requests / update patches / custom noise words
 * - Per-source routing (shouldPassSourceToAi): lets freebie-only sources straight through unreviewed, or excludes / reviews only specific sources
 * - Push timing is decided by PushSettings.pushTiming:
 *   - wait_ai (default): the first syncPrePushLimit items are pushed after they pass AI; the rest enter a background queue and are auto back-filled once reviewed
 *   - instant_first (instant code grab): push by rules first; items needing review enter the background queue for backfill (once approved and not yet pushed, auto back-filled)
 */
async function dispatchFresh(
  sourceId: string,
  fresh: FreshItem[],
  log: (msg: string) => void = console.log,
): Promise<void> {
  if (!fresh.length) return;
  const reviewOn = shouldReview();
  const aiSettings = reviewOn ? getAiSettings() : null;
  const pushSettings = getPushSettings();

  if (!reviewOn || !aiSettings) {
    await pushInstant(sourceId, fresh);
    await dispatchUserPush(sourceId, fresh).catch((err) => {
      console.error("[user-push] dispatch failed:", err instanceof Error ? err.message : err);
    });
    return;
  }

  const blockRules = loadActiveBlockRules();
  const nonNoise = fresh.filter(
    (f) => !matchesEntryNoise(f.title, aiSettings) && !isBlocked({ title: f.title, summary: f.summary, sourceId }, blockRules),
  );
  if (!nonNoise.length) return;

  if (!shouldPassSourceToAi(sourceId, aiSettings)) {
    if (aiSettings.skipFreebieSources && FREEBIE_ONLY_SOURCES.has(sourceId)) {
      const autoReason = "freebie-only source, auto-approved without AI review";
      const reviewedAt = new Date().toISOString();
      tx(() => {
        for (const f of nonNoise) {
          const verdict = {
            index: 0,
            keep: true,
            kind: "freebie" as const,
            category: f.category ?? "other",
            obtain: (f.obtain as ObtainMode | undefined) ?? "free",
            quality: 4,
            reason: autoReason,
          };
          f.aiKeep = true;
          f.kind = "freebie";
          f.aiReason = autoReason;
          run(
            "UPDATE items SET ai = ?, ai_keep = 1, kind = 'freebie', ai_quality = 4, obtain = COALESCE(obtain, 'free'), ai_reviewed_at = ? WHERE id = ? AND ai IS NULL",
            JSON.stringify(verdict),
            reviewedAt,
            f.id,
          );
        }
      });
      log(`[${sourceId}] freebie-only source skips AI, ${nonNoise.length} items passed through`);
    }
    await pushInstant(sourceId, nonNoise);
    await dispatchUserPush(sourceId, nonNoise).catch((err) => {
      console.error("[user-push] dispatch failed:", err instanceof Error ? err.message : err);
    });
    return;
  }

  if (pushSettings.pushTiming === "wait_ai") {
    const ranked = [...nonNoise].sort(
      (a, b) => (b.codes.length > 0 ? 1 : 0) - (a.codes.length > 0 ? 1 : 0) || b.score - a.score,
    );
    const limit = pushSettings.syncPrePushLimit;
    const syncBatch = ranked.slice(0, limit);
    const restBatch = ranked.slice(limit);
    const verdicts = await reviewFreshNow(
      syncBatch.map((f) => ({ itemId: f.id, sourceId, url: f.url, title: f.title, summary: f.summary ?? "", content: f.content ?? null })),
    );
    for (const f of syncBatch) {
      const v = verdicts.get(f.id);
      if (!v) continue;
      f.aiKeep = v.aiKeep;
      f.kind = v.kind;
      if (v.category) f.category = v.category;
      if (v.obtain) f.obtain = v.obtain;
      if (v.reason) f.aiReason = v.reason;
      f.score = v.score;
    }
    log(`[${sourceId}] pre-push AI review of ${syncBatch.length} items (blocked ${syncBatch.filter((f) => f.aiKeep === false).length})`);
    await pushInstant(sourceId, syncBatch);
    await dispatchUserPush(sourceId, syncBatch).catch((err) => {
      console.error("[user-push] dispatch failed:", err instanceof Error ? err.message : err);
    });
    if (restBatch.length) {
      enqueueForAi(
        restBatch.map((f) => ({
          itemId: f.id,
          sourceId,
          url: f.url,
          title: f.title,
          summary: f.summary ?? "",
          content: f.content ?? null,
          pushOnApprove: pushSettings.pushAfterBackfill,
        })),
      );
      log(`[${sourceId}] remaining ${restBatch.length} items queued for background AI`);
    }
    return;
  }

  await pushInstant(sourceId, fresh);
  await dispatchUserPush(sourceId, fresh).catch((err) => {
    console.error("[user-push] dispatch failed:", err instanceof Error ? err.message : err);
  });
  enqueueForAi(
    nonNoise.map((f) => ({
      itemId: f.id,
      sourceId,
      url: f.url,
      title: f.title,
      summary: f.summary ?? "",
      content: f.content ?? null,
      pushOnApprove: pushSettings.pushAfterBackfill,
    })),
  );
  log(`[${sourceId}] ${nonNoise.length}/${fresh.length} items queued for async AI review`);
}
export function ingestItems(sourceId: string, items: RawItem[]): { inserted: number; skipped: number } {
  ensureSources();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runRow = run("INSERT INTO runs (source_id, started_at, status) VALUES (?, ?, 'running')", sourceId, startedAt);
  const runId = Number(runRow.lastInsertRowid);
  try {
    const saved = persist(sourceId, items, null);
    // Personal Bot push is decoupled from the global Bot: the push pipeline must still run when no global TELEGRAM_BOT_TOKEN is configured
    if (saved.fresh.length && (shouldReview() || pushEnabled || hasEnabledUserPush())) {
      void dispatchFresh(sourceId, saved.fresh).catch(() => {});
    }
    const durationMs = Date.now() - t0;
    run(
      "UPDATE runs SET finished_at = ?, status = 'ok', fetched = ?, inserted = ?, skipped = ?, duration_ms = ? WHERE id = ?",
      new Date().toISOString(), items.length, saved.inserted, saved.skipped, durationMs, runId,
    );
    run("UPDATE sources SET last_run_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?", startedAt, sourceId);
    return saved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      "UPDATE runs SET finished_at = ?, status = 'failed', fetched = ?, error = ?, duration_ms = ? WHERE id = ?",
      new Date().toISOString(), items.length, message, Date.now() - t0, runId,
    );
    run("UPDATE sources SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?", startedAt, message.slice(0, 300), sourceId);
    throw err;
  }
}

/** The local collector reports "session expired / rate-limited / nothing scraped": writes runs and marks sources status so /status reflects it truthfully. */
export function markSourceFailure(
  sourceId: string,
  reason: string,
  status: "degraded" | "failed" = "degraded",
): { ok: true; status: string } {
  ensureSources();
  const now = new Date().toISOString();
  run(
    "INSERT INTO runs (source_id, started_at, finished_at, status, fetched, inserted, skipped, duration_ms, error) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)",
    sourceId, now, now, status, reason.slice(0, 500),
  );
  run("UPDATE sources SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?", now, status, reason.slice(0, 300), sourceId);
  return { ok: true, status };
}

type SourceRow = {
  id: string;
  name: string;
  kind: string;
  enabled: number;
  config: string;
  cursor: string | null;
};

export function ensureSources(seeds: SourceSeed[] = SEEDS): void {
  const now = new Date().toISOString();
  for (const s of seeds) {
    run(
      `INSERT INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind`,
      s.id,
      s.name,
      s.kind,
      s.enabled === false ? 0 : 1,
      JSON.stringify(s.config ?? {}),
      s.intervalSec ?? 10800,
      now,
    );
  }
  // Smooth upgrade for old DBs: refresh filter rules only when a historical source still has the old default config; never overwrite user-edited config or enable/disable toggles
  const upgrades: Array<[string, string, string]> = [
    [
      "rss-nodeseek",
      JSON.stringify({ feeds: [{ id: "nodeseek", url: "https://rss.nodeseek.com/", limit: 30 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-nodeseek")?.config ?? {}),
    ],
    [
      "rss-nodeseek",
      JSON.stringify({
        feeds: [{
          id: "nodeseek",
          url: "https://rss.nodeseek.com/",
          limit: 30,
          includeCategories: ["info", "promotion"],
          titleKeywords: ["免费", "白嫖", "cdk", "兑换", "限免", "福利", "赠", "领", "送", "free", "0元"],
        }],
      }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-nodeseek")?.config ?? {}),
    ],
    [
      "rss-nodeseek",
      JSON.stringify({ feeds: [{ id: "nodeseek", url: "https://rss.nodeseek.com/", limit: 30, includeCategories: ["info", "promotion"] }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-nodeseek")?.config ?? {}),
    ],
    [
      "rss-sharewareonsale",
      JSON.stringify({ feeds: [{ id: "sharewareonsale", url: "https://sharewareonsale.com/feed", limit: 25 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-sharewareonsale")?.config ?? {}),
    ],
    [
      "cctv-news",
      JSON.stringify({
        channels: [
          { channel: "news", cb: "news", categoryHint: "headline", limit: 20 },
          { channel: "world", cb: "world", categoryHint: "world", limit: 15 },
        ],
      }),
      JSON.stringify(SEEDS.find((s) => s.id === "cctv-news")?.config ?? {}),
    ],
    [
      "rss-chinanews-scroll",
      JSON.stringify({ feeds: [{ id: "chinanews-scroll", url: "https://www.chinanews.com.cn/rss/scroll-news.xml", limit: 25 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-chinanews-scroll")?.config ?? {}),
    ],
    [
      "rss-chinanews-world",
      JSON.stringify({ feeds: [{ id: "chinanews-world", url: "https://www.chinanews.com.cn/rss/world.xml", limit: 20 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-chinanews-world")?.config ?? {}),
    ],
    [
      "tg-freegames",
      JSON.stringify({ channels: ["FreeGamesInfo", "freegamesnews"] }),
      JSON.stringify(SEEDS.find((s) => s.id === "tg-freegames")?.config ?? {}),
    ],
    [
      "tg-cn-deals",
      JSON.stringify({ channels: ["zaihuapd", "vps_offers"] }),
      JSON.stringify(SEEDS.find((s) => s.id === "tg-cn-deals")?.config ?? {}),
    ],
  ];
  for (const [id, oldCfg, nextCfg] of upgrades) {
    run("UPDATE sources SET config = ? WHERE id = ? AND config = ?", nextCfg, id, oldCfg);
  }
  run("DELETE FROM sources WHERE id = 'mock-source' AND NOT EXISTS (SELECT 1 FROM items WHERE source_id = 'mock-source')");
}

export type RunSummary = {
  sourceId: string;
  status: "ok" | "degraded" | "failed";
  fetched: number;
  inserted: number;
  skipped: number;
  durationMs: number;
  error: string | null;
  cursor: string | null;
};

export type FreshItem = {
  id: number;
  title: string;
  url: string;
  score: number;
  codes: string[];
  expiresAt: string | null;
  /** Normalized CNY price; null means unknown */
  price?: number | null;
  /** Explicitly free */
  isFree?: boolean;
  /** AI semantic verdict: false means judged not to be a freebie */
  aiKeep?: boolean | null;
  /** One-line AI reason, shown when pushing */
  aiReason?: string | null;
  /** Normalized category, used for push category filtering */
  /** Content kind: freebie / deal / opensource / info / noise */
  kind?: ContentKind | string | null;
  category?: string | null;
  /** Acquisition method: only free counts as a full freebie; lotteries / trials / promos are not pushed by default */
  obtain?: string | null;
  /** Summary text, used for subscription keyword matching */
  summary?: string | null;
  /** Full body text (Zhihu / Xiaohongshu / Xiaoheihe detail scrapes, etc.), for detail display and clickbait checking */
  content?: string | null;
  /** AI semantic dedup cluster ID: multi-source reports of the same campaign/event share one canonicalId */
  canonicalId?: number | null;
  /** Publish time, used to block re-pushing of old history posts */
  publishedAt?: string | null;
  /** English rendering of `title` (see enrich/translate.ts). Display only — matchers keep reading the original `title`. */
  title_en?: string | null;
  /** English rendering of `summary`. Display only. */
  summary_en?: string | null;
  /** Persian rendering of `title` for the Telegram surfaces (see enrich/translate.ts). Display only. */
  title_fa?: string | null;
  /** Persian rendering of `summary` for the Telegram surfaces. Display only. */
  summary_fa?: string | null;
};

/** Use AI's obtain when provided, otherwise fall back to keyword heuristics. */
function obtainOf(e: { title: string; summary?: string | null }, verdict?: AiVerdict | null): ObtainMode {
  return verdict?.obtain ?? guessObtain(e.title, e.summary ?? "");
}

function persist(
  sourceId: string,
  items: RawItem[],
  aiMap?: Map<number, AiVerdict> | null,
): { inserted: number; skipped: number; fresh: FreshItem[] } {
  let inserted = 0;
  const fresh: FreshItem[] = [];
  let skipped = 0;
  const now = new Date().toISOString();
  const staleCutoffMs = Date.now() - Math.max(getRetention().keptDays, 7) * 86_400_000;
  const srcHints = getSourceHints(sourceId);
  tx(() => {
    for (let index = 0; index < items.length; index += 1) {
      const raw = items[index]!;
      const e = enrichItem(raw, sourceId, srcHints);
      if (!e) {
        skipped += 1;
        continue;
      }

      const verdict = aiMap?.get(index) ?? null;
      const effectiveObtainRaw = obtainOf(e, verdict);
      const effectiveKindRaw = verdict
        ? resolveKind(verdict.kind, verdict.keep, {
            title: e.title,
            summary: e.summary ?? undefined,
            sourceId,
            category: categoryForSource(sourceId, verdict.category || e.category, srcHints),
            obtain: effectiveObtainRaw,
            isFree: e.isFree,
            price: e.price,
            freebieOnlySource: FREEBIE_ONLY_SOURCES.has(sourceId),
            kindHint: srcHints.kindHint,
            guardEnabled: srcHints.guardEnabled,
          })
        : e.kind;
      // Freebie evidence check: lottery → lottery, explicit price → deal (only negates, never confirms a freebie on AI's behalf)
      // The category must be passed in: a wrong freebie verdict under a news category (politics / world / finance / stocks) is demoted here
      const evidenced = enforceFreebieEvidence(effectiveKindRaw, effectiveObtainRaw, e.title, verdict?.category ?? e.category, {
        summary: e.summary,
        codes: e.codes,
        sourceId,
      });
      const effectiveKind = evidenced.kind;
      const effectiveObtain = evidenced.obtain === undefined ? effectiveObtainRaw : evidenced.obtain;
      const kindCategory = evidenced.category ?? undefined;
      // The AI-provided category takes priority over keyword rules (previously only the rule result was used here, discarding AI's correct category);
      // then a unified clamp: news / water posts must not fall into physical-goods freebies
      const effectiveCategory = demoteEditorialGoods(
        demoteOfflineCategory(
          categoryForSource(sourceId, isSharedResource(raw.title, raw.summary ?? "", raw.content ?? "", raw.url) ? "pan" : kindCategory ?? (verdict?.category && isCategory(verdict.category) ? verdict.category : e.category), srcHints),
          effectiveKind,
          e.title,
          e.summary ?? "",
          e.category,
        ),
        effectiveKind,
        { title: e.title, summary: e.summary ?? "", obtain: effectiveObtain, price: e.price },
      );
      const effectiveQuality =
        typeof verdict?.quality === "number" && Number.isFinite(verdict.quality)
          ? Math.min(5, Math.max(1, Math.round(verdict.quality)))
          : null;
const scoreCtx = {
        title: e.title,
        summary: e.summary ?? "",
        publishedAt: e.publishedAt ?? null,
        sourceId,
        codes: e.codes,
        price: e.price,
      };
      const score = calibrateScoreByObtain(
        e.baseScore,
        effectiveObtain,
        verdict ? verdict.keep : null,
        effectiveQuality,
        effectiveKind,
        scoreCtx,
      );
      const aiJson = verdict ? JSON.stringify({ ...verdict, kind: effectiveKind, category: effectiveCategory }) : null;
      const status = e.keep ? "active" : "expired";
      const titleKey = resolveDbMergeKey(e.title);

      const existing = get<{
        id: number;
        title: string;
        ai_keep: number | null;
        obtain: string | null;
        ai: string | null;
        kind: string | null;
        ai_quality: number | null;
        canonical_id: number | null;
      }>(
        "SELECT id, title, ai_keep, obtain, ai, kind, ai_quality, canonical_id FROM items WHERE source_id = ? AND external_id = ?",
        sourceId,
        e.externalId,
      );
      if (existing) {
        let existingQuality: number | null = existing.ai_quality ?? null;
        if (existingQuality === null && existing.ai) {
          try {
            const q = (JSON.parse(existing.ai) as { quality?: number }).quality;
            if (typeof q === "number") existingQuality = q;
          } catch {
            existingQuality = null;
          }
        }
        const promotedFromUpcoming =
          existing.ai_keep === 0 &&
          /即将免费|预告/.test(existing.title) &&
          /本周免费|限时免费/.test(e.title);
        if (promotedFromUpcoming) {
          run("UPDATE items SET ai = NULL, ai_keep = NULL, ai_quality = NULL WHERE id = ?", existing.id);
          existing.ai = null;
          existing.ai_keep = null;
          existing.kind = null;
        }
        // The already-stored AI category wins: on re-collection, keyword rules must not overwrite AI's correct category.
        // The old logic overwrote unconditionally with effectiveCategory (the rule result), causing ai.category=trade
        // while items.category became goods/tech/other, splitting the data (667 rows DB-wide).
        let storedAiCategory: string | null = null;
        if (existing.ai) {
          try {
            const parsed = JSON.parse(existing.ai) as { category?: unknown };
            if (isCategory(parsed.category) && parsed.category !== "other") storedAiCategory = parsed.category;
          } catch { /* keep the old value */ }
        }
        const proposedCategory = verdict && isCategory(verdict.category) ? verdict.category : (storedAiCategory ?? e.category);
        const baseCategory = demoteEditorialGoods(
          demoteOfflineCategory(
            categoryForSource(sourceId, isSharedResource(raw.title, raw.summary ?? "", raw.content ?? "", raw.url) ? "pan" : proposedCategory, srcHints),
            verdict ? effectiveKind : existing.kind ?? e.kind,
            e.title,
            e.summary ?? "",
            e.category,
          ),
          verdict ? effectiveKind : existing.kind ?? e.kind,
          { title: e.title, summary: e.summary ?? "", obtain: existing.obtain, price: e.price },
        );
        const nextClassification = applyManualClassification(existing.id, baseCategory, verdict ? effectiveKind : resolveKind(existing.kind, existing.ai_keep === null ? null : existing.ai_keep === 1, {
          title: e.title, summary: e.summary ?? "", sourceId, category: baseCategory, obtain: existing.obtain,
          isFree: e.isFree, price: e.price, kindHint: srcHints.kindHint, guardEnabled: srcHints.guardEnabled,
          freebieOnlySource: FREEBIE_ONLY_SOURCES.has(sourceId),
        }));
        const nextKind = nextClassification.kind;
        const nextScore = verdict && nextKind === effectiveKind
          ? score
          : calibrateScoreByObtain(
              e.baseScore,
              existing.obtain,
              existing.ai_keep === null ? null : existing.ai_keep === 1,
              existingQuality,
              nextKind,
              scoreCtx,
            );
        run(
          `UPDATE items SET url = ?, url_key = ?, title = ?, title_key = ?, summary = ?, author = ?, category = ?,
             tags = ?, base_score = ?, score = ?, expires_at = ?, published_at = ?, raw = ?, last_seen_at = ?,
             price = ?, is_free = ?,
             ai = COALESCE(?, ai),
             obtain = COALESCE(?, obtain),
             ai_keep = COALESCE(?, ai_keep),
             kind = COALESCE(?, kind),
             ai_quality = COALESCE(?, ai_quality),
             image_url = COALESCE(?, image_url),
             content = COALESCE(?, content),
             status = CASE WHEN status = 'ignored' THEN 'ignored' ELSE ? END
           WHERE id = ?`,
          e.url,
          e.urlKey,
          e.title,
          titleKey,
          e.summary ?? "",
          e.author ?? null,
          nextClassification.category,
          JSON.stringify(e.tags),
          e.baseScore,
          nextScore,
          e.expiresAt,
          e.publishedAt ?? null,
          JSON.stringify(e.raw ?? {}),
          now,
          e.price,
          e.isFree ? 1 : 0,
          aiJson,
          verdict?.obtain ?? null,
          verdict ? (verdict.keep ? 1 : 0) : null,
          nextKind,
          effectiveQuality,
          e.imageUrl,
          e.content ?? null,
          status,
          existing.id,
        );
        skipped += 1;
        continue;
      }
      if (e.publishedAt) {
        const pubMs = Date.parse(e.publishedAt);
        if (!Number.isNaN(pubMs) && pubMs < staleCutoffMs) {
          skipped += 1;
          continue;
        }
      }
      try {
        const res = run(
`INSERT INTO items (source_id, external_id, url, url_key, title, title_key, summary, author, category,
             tags, base_score, score, expires_at, published_at, raw, status, ai, obtain, ai_keep, kind, ai_quality, image_url, content, codes, price, is_free, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sourceId,
          e.externalId,
          e.url,
          e.urlKey,
          e.title,
          titleKey,
          e.summary ?? "",
          e.author ?? null,
          effectiveCategory,
          JSON.stringify(e.tags),
          e.baseScore,
          score,
          e.expiresAt,
          e.publishedAt ?? null,
          JSON.stringify(e.raw ?? {}),
          status,
          aiJson,
          effectiveObtain,
          verdict ? (verdict.keep ? 1 : 0) : null,
          effectiveKind,
          effectiveQuality,
          e.imageUrl,
          e.content ?? null,
          JSON.stringify(e.codes),
          e.price,
          e.isFree ? 1 : 0,
          now,
          now,
        );
        inserted += 1;
        fresh.push({
          id: Number(res.lastInsertRowid),
          title: e.title,
          url: e.url,
          score,
          codes: e.codes,
          expiresAt: e.expiresAt,
          price: e.price,
          isFree: e.isFree,
          aiKeep: verdict ? verdict.keep : null,
          aiReason: verdict?.reason ?? null,
          kind: effectiveKind,
          category: effectiveCategory,
          obtain: effectiveObtain,
          summary: e.summary ?? null,
          content: e.content ?? null,
canonicalId: null,
          publishedAt: e.publishedAt ?? null,
        });
      } catch (err) {
        if (/UNIQUE/i.test(String(err))) {
          skipped += 1;
        } else {
          throw err;
        }
      }
    }
  });

  return { inserted, skipped, fresh };
}

export async function runSource(
  sourceId: string,
  options: { http?: HttpClient; maxItems?: number; log?: (message: string) => void } = {},
): Promise<RunSummary> {
  ensureSources();
  const log = options.log ?? ((m: string) => console.log(m));
  const source = get<SourceRow>("SELECT * FROM sources WHERE id = ?", sourceId);
  if (!source) throw new Error(`unknown source: ${sourceId}`);

  const collector = BY_KIND.get(source.kind);
  if (!collector) throw new Error(`no collector registered for kind: ${source.kind}`);

  const http =
    options.http ??
    createHttp({ proxy: config.httpsProxy || config.httpProxy, timeoutMs: config.fetchTimeoutMs, gapMs: config.minRequestGapMs });
  const maxItems = options.maxItems ?? config.maxItemsPerRun;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runRow = run(
    "INSERT INTO runs (source_id, started_at, status) VALUES (?, ?, 'running')",
    sourceId,
    startedAt,
  );
  const runId = Number(runRow.lastInsertRowid);

  let status: RunSummary["status"] = "ok";
  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let error: string | null = null;
  let cursor = source.cursor;

  try {
    const result = await collector.collect({
      sourceId,
      config: JSON.parse(source.config || "{}") as Record<string, unknown>,
      cursor: source.cursor,
      maxItems,
      http,
      log: (m) => log(`[${sourceId}] ${m}`),
    });
    fetched = result.items.length;
    const saved = persist(sourceId, result.items, null);
    inserted = saved.inserted;
    skipped = saved.skipped;
    if (saved.fresh.length) {
      await dispatchFresh(sourceId, saved.fresh, log);
    }
    if (result.cursor !== undefined) cursor = result.cursor;
    if (result.degraded) {
      status = "degraded";
      error = result.degraded;
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const durationMs = Date.now() - t0;
  const finishedAt = new Date().toISOString();

  run(
    "UPDATE runs SET finished_at = ?, status = ?, fetched = ?, inserted = ?, skipped = ?, duration_ms = ?, error = ? WHERE id = ?",
    finishedAt,
    status,
    fetched,
    inserted,
    skipped,
    durationMs,
    error,
    runId,
  );
  run(
    "UPDATE sources SET cursor = ?, last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?",
    cursor,
    startedAt,
    status,
    error,
    sourceId,
  );

  log(
    `[collect] ${sourceId} fetched=${fetched} inserted=${inserted} skipped=${skipped} duration=${durationMs}ms status=${status}${
      error ? ` error=${error}` : ""
    }`,
  );

  return { sourceId, status, fetched, inserted, skipped, durationMs, error, cursor };
}

export async function runAll(
  options: { http?: HttpClient; maxItems?: number; log?: (message: string) => void } = {},
): Promise<RunSummary[]> {
  ensureSources();
  // kind="ingest" joins scheduled runs only when the server hosts the matching site cookie and an executor is configured; otherwise it is left to local report-back
  const rows = all<{ id: string; kind: string }>("SELECT id, kind FROM sources WHERE enabled = 1 ORDER BY id")
    .filter((r) => BY_KIND.has(r.kind) && (r.kind !== "ingest" || hasCookieConfiguredForSource(r.id)))
    .map((r) => r.id);
  const filter = config.enabledSources;
  const targets = filter.length ? rows.filter((id) => filter.includes(id)) : rows;
  const out: RunSummary[] = [];
  for (const id of targets) {
    try {
      out.push(await runSource(id, options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (options.log ?? console.log)(`[collect] ${id} failed to start: ${message}`);
      out.push({ sourceId: id, status: "failed", fetched: 0, inserted: 0, skipped: 0, durationMs: 0, error: message, cursor: null });
    }
    // Leave a gap between sources: sites like Reddit return 429 on consecutive requests from the same IP
    if (config.sourceGapMs > 0) await new Promise((r) => setTimeout(r, config.sourceGapMs));
  }
  return out;
}

export const BUILTIN_SOURCE_IDS = new Set(SEEDS.map((s) => s.id));

export function addCustomRssSource(input: {
  id?: string;
  name: string;
  url: string;
  intervalSec?: number;
  kindHint?: string;
  categoryHint?: string;
  fixedCategory?: string;
}): string {
  const cleanUrl = input.url.trim();
  const slug = (input.id || input.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  const id = slug.startsWith("rss-") ? slug : "rss-" + (slug || Date.now());
  const feedId = id.replace(/^rss-/, "");
  const feed: Record<string, unknown> = { id: feedId, url: cleanUrl, limit: 30 };
  if (input.categoryHint?.trim()) feed.categoryHint = input.categoryHint.trim();
  const cfg: Record<string, unknown> = { feeds: [feed] };
  if (input.kindHint?.trim()) cfg.kindHint = input.kindHint.trim();
  if (input.categoryHint?.trim()) cfg.categoryHint = input.categoryHint.trim();
  if (input.fixedCategory?.trim()) cfg.fixedCategory = input.fixedCategory.trim();
  run(
    `INSERT INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
     VALUES (?, ?, 'rss', 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, interval_sec = excluded.interval_sec, enabled = 1`,
    id,
    input.name.trim(),
    JSON.stringify(cfg),
    input.intervalSec ?? 1800,
    new Date().toISOString(),
  );
  return id;
}

export function deleteCustomSource(id: string): { ok: true } | { ok: false; error: string } {
  if (BUILTIN_SOURCE_IDS.has(id)) {
    return { ok: false, error: "Built-in preset sources cannot be deleted; to disable one, just turn off its toggle" };
  }
  const existing = get<{ id: string }>("SELECT id FROM sources WHERE id = ?", id);
  if (!existing) return { ok: false, error: "Source does not exist" };
  run("DELETE FROM runs WHERE source_id = ?", id);
  run("DELETE FROM sources WHERE id = ?", id);
  return { ok: true };
}
