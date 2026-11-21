import { cleanText, guessExpiry, normalizeUrl, sanitizeImageUrl, urlKey } from "./normalize.ts";
import type { RawItem } from "../collectors/types.ts";
import { extractCodes } from "./codes.ts";
import { extractPrice } from "./pricing.ts";

import { OPENSOURCE_HINT, PROMO_HINT } from "./noise.ts";
import { guessObtain } from "./obtain.ts";
import { guessKind, isContentKind, KIND_LABEL, resolveKind, type ContentKind } from "./kind.ts";
import { CATEGORY_LABEL, isCategory, type Category } from "../../shared/taxonomy.ts";
import { categoryForSource, type SourceHints } from "../../shared/source-classification.ts";
import { contentSignals, isSharedResource } from "./evidence.ts";

export { guessKind, isContentKind, KIND_LABEL, resolveKind, type ContentKind };
export type { Category };
export { CATEGORY_LABEL, isCategory };

type Rule = { category: Category; weight: number; keywords: string[]; exclude?: RegExp; require?: RegExp };

/** Offline-scene words: only a hit here can make it a real-world event; "free" alone is not enough */
const OFFLINE_SCENE_RE =
  /现场|到店|进店|门店|实体店|快闪|商场|专柜|自提|打卡|试吃|试饮|派样|派发|店庆|开业|线下|凭手机|凭截图|排队领|附近|博会|展会|展览|市集|集市|庙会|漫展|车展/;
/** Claim actions: something must actually be claimable, otherwise it is just a place word that collides */
const OFFLINE_CLAIM_RE =
  /(?:免费领取|免费领|现场领|领取|免费送|免费赠|赠送|白送|白给|0元|零元|一分钱|打卡[^\s]{0,4}(?:送|领)|试吃|试饮|派样|派发|小样|礼品|手幅|周边)/;
/** News / help requests / chit-chat: a hit means it should not be treated as a physical freebie */
const OFFLINE_EXCLUDE_RE =
  /记者|直播|直击|发布会|峰会|论坛|通报|白皮书|签署|备忘录|抽检|不合格|检测结果|召回|处罚|罚款|我想|有吗|有没有人|求租|转租|合租/;
/** Physical / everyday freebies: claiming online also counts as a "physical freebie", no longer requiring a store visit */
const PHYSICAL_RE =
  /实物|食品|零食|饮料|奶茶|咖啡|薯条|汉堡|炸鸡|披萨|餐|水果|生鲜|纸巾|日用品|洗护|小样|试用装|周边|手幅|徽章|玩偶|礼品|礼盒|礼包|书|教材|电子书|体检|话费|流量|红包|立减金|代金券|优惠券|充值卡|京豆|积分兑|会员|月卡|季卡|年卡|羊毛|现金|余额|\d+\s*(?:元|块|r)\b/;
/** Reviews / buying advice / news: a hit inside the goods category is neither a deal nor a freebie */
const GOODS_EDITORIAL_RE =
  /测评|评测|实测|使用记录|使用体验|使用感受|选购|怎么选|如何选|科普|榜单|排行|对比|值不值|开箱|避坑|踩雷|横评|盘点|攻略|差价|降价|涨价|调价|假货|验真|备案|增项|单价|差在哪|先分清|先查|别硬熬|被点名|一衣难求|成本|赚几|只能升不能降|降档墙|降到|便宜|放心买|能买吗|该不该|划不划算|值得吗|买前/;

const RULES: Rule[] = [
  {
    category: "ai",
    weight: 1.15,
    keywords: ["gpt", "chatgpt", "openai", "claude", "gemini", "grok", "llm", "大模型", "api", "token", "额度", "算力", "算力券", "代金券", "qwen", "deepseek", "kimi", "glm", "cursor", "copilot", "midjourney", "sora", "colab", "notebook", "gpu", "体验金", "中转", "codex", "积分", "多模型", "智能体", "ai 模型", "credits", "tokens", "codearts", "mcp", "skill", "agent"],
  },
  {
    category: "vps",
    weight: 1.15,
    keywords: ["vps", "云服务器", "云主机", "独立服务器", "独服", "小鸡", "kvm", "nat", "cn2", "gia", "9929", "cmin2", "三网", "家宽", "现车", "racknerd", "dmit", "bandwagon", "搬瓦工", "bwh", "claw", "ovh", "hetzner", "netcup", "dedirock", "inmotion", "deluxhost", "cloudcone", "greencloud", "virmach", "动态ip", "公网ip", "vps 测试", "年付", "月付"],
  },
  {
    category: "cloud",
    weight: 1.1,
    keywords: ["对象存储", "oss", "s3", "r2", "cdn", "带宽", "数据库", "容器", "k8s", "serverless", "免费层", "free tier", "试用金", "额度", "cloud", "azure", "aws", "虚拟机", "存储", "egress", "requests", "代理流量"],
  },
  {
    category: "domain",
    weight: 1.05,
    keywords: ["域名", "domain", "ssl", "证书", "dns", "主机", "虚拟主机", "建站", "托管"],
  },
  {
    // Only strong signals count: an explicit mention of open source, GitHub or self-hosting, so generic words like "tool" or "plugin" cannot steal other categories
    category: "opensource",
    weight: 1.0,
    keywords: ["开源", "open source", "opensource", "github.com", "github 仓库", "github项目", "gitlab", "self-host", "selfhosted", "自托管", "自建服务", "awesome-", "mit 协议", "apache 协议", "gpl", "源码", "pull request", "开源项目", "开源软件", "开源工具", "开源库"],
  },
  {
    category: "dev",
    weight: 1.0,
    keywords: ["sdk", "cli", "ide", "vscode", "vs code", "docker", "kubernetes", "git", "rust", "golang", "typescript", "python", "框架", "编译器", "api 文档", "debugger", "devtool", "browser extension", "chrome extension", "脚本", "自动化", "workflow", "ci/cd", "数据库工具", "编程语言"],
  },
  {
    category: "design",
    weight: 1.05,
    keywords: ["字体", "font", "fonts", "icon", "icons", "图标", "ui kit", "figma", "sketch", "psd", "svg", "模板", "template", "壁纸", "wallpaper", "插画", "illustration", "3d asset", "mockup", "素材", "音效", "sfx", "lut", "预设", "preset", "配色"],
  },
  {
    category: "security",
    weight: 1.05,
    keywords: ["漏洞", "cve", "零日", "0day", "安全公告", "防火墙", "firewall", "vpn", "wireguard", "tailscale", "零信任", "加密", "密码学", "隐私", "渗透", "内网穿透", "反诈", "sandbox", "2fa", "passkey"],
  },
  {
    category: "hardware",
    weight: 1.0,
    keywords: ["硬件", "cpu", "gpu", "显卡", "rtx", "nas", "路由器", "软路由", "旁路由", "显示器", "键盘", "鼠标", "耳机", "ssd", "固态硬盘", "内存条", "macbook", "mac mini", "iphone", "ipad", "树莓派", "raspberry pi", "开发板", "充电头", "数码"],
  },
  {
    category: "software",
    weight: 1.0,
    keywords: ["激活码", "序列号", "license", "授权", "正版", "绿色版", "注册机", "兑换码", "office", "windows", "adobe", "jetbrains", "photoshop", "会员版", "商业软件", "软件授权", "解锁", "remote desktop", "永久授权", "免费版", "freemium", "lifetime", "lifetime access", "限免", "ios", "android", "macos", "app"],
  },
  {
    category: "media",
    weight: 1.05,
    keywords: ["会员", "影音", "netflix", "奈飞", "spotify", "youtube", "bilibili", "爱奇艺", "优酷", "腾讯视频", "芒果", "emby", "plex", "音乐", "vip", "影视", "韩剧", "美剧", "日剧", "剧集", "电影", "4k", "1080p", "更至", "配音", "动漫", "短剧", "short drama", "short dramas", "听书", "漫画", "小说"],
  },
  {
    category: "game",
    weight: 1.05,
    keywords: ["游戏", "epic", "steam", "喜加一", "激活", "游戏本体", "礼包", "cdkey", "xbox", "psn", "switch", "手游", "内测资格", "gog", "itch.io", "indiegala", "giveaway", "key 赠送", "白给", "免费入库", "humble", "皮肤", "dlc", "bundle", "game", "free game", "steam key", "金钥匙", "shift code", "free weekend", "免费周末"],
  },
  {
    category: "carpool",
    weight: 1.25,
    keywords: ["拼车", "合租", "车位", "发车", "家庭组", "family plan", "team 车", "3缺1", "4缺1", "5缺1", "季付车", "月付车", "年付车", "车主", "开车", "上车"],
  },
  {
    category: "trade",
    weight: 1.1,
    keywords: ["出鸡", "收鸡", "转让", "过户", "出号", "成品号", "带原油", "带原邮", "原邮", "剩余价值", "明盘", "闲置出", "折价出", "转手", "出个", "出一台", "出闲置"],
  },
  {
    category: "headline",
    weight: 1.05,
    keywords: ["国务院", "央行", "新规", "法规", "政策", "法案", "国常会", "发改委", "工信部", "通告", "白皮书", "监管", "国务院办公厅", "政府工作", "教育部", "卫健委", "医保", "商保", "人社部", "两会", "全会", "央视", "焦点访谈"],
  },
  {
    category: "world",
    weight: 1.05,
    keywords: ["外交部", "联合国", "峰会", "关税", "制裁", "大使馆", "多国", "欧盟", "白宫", "俄乌", "中东", "亚太", "apec", "g20", "国际社会", "国外", "海外"],
  },
  {
    category: "stock",
    weight: 1.1,
    keywords: ["a股", "港股", "美股", "纳斯达克", "标普", "道指", "恒生", "上证", "沪指", "创业板", "科创板", "etf", "股票", "股市", "涨停", "跌停", "牛市", "熊市", "券商", "北向资金", "股价", "市值", "ipo", "上市", "分红", "回购", "板块", "指数"],
  },
  {
    category: "finance",
    weight: 1.05,
    keywords: ["财报", "营收", "融资", "并购", "收购", "降息", "加息", "通胀", "汇率", "油价", "黄金", "美联储", "gdp", "基金", "债券", "业绩", "利润", "估值", "宏观经济", "资本市场", "货币政策"],
  },
  {
    category: "tech",
    weight: 1.0,
    keywords: ["科技", "芯片", "半导体", "光刻机", "英伟达", "nvidia", "amd", "intel", "苹果", "华为", "小米", "特斯拉", "机器人", "具身智能", "量子计算", "航天", "卫星", "新能源", "自动驾驶", "操作系统", "鸿蒙", "大模型发布", "互联网", "商用飞机"],
  },
  {
    category: "news",
    weight: 0.75,
    keywords: ["新闻", "快讯", "要闻", "播报", "周刊", "日报", "changelog", "release notes"],
  },
  {
    // Physical freebies: items claimed in person at offline stores / pop-ups / malls, kept separate from online freebies so the "physical / discount" bucket does not swallow them
    category: "offline",
    weight: 1.2,
    keywords: [
      "现场领取", "现场可领", "现场免费", "现场送", "到店", "进店", "门店", "实体店", "快闪", "商场", "专柜", "自提",
      "打卡", "试吃", "试饮", "派样", "派发", "店庆", "开业活动", "新店开业", "附近", "线下", "凭手机", "凭截图领取", "排队领",
    ],
    // Place words like "nearby / offline / on site" are not enough on their own: a "claim action" must appear as well, otherwise chit-chat and industry news all get pulled in
    require: OFFLINE_CLAIM_RE,
    // "On site" in a news item or launch event is not a physical freebie; inspection notices or roommate-wanted posts are not either
    exclude: OFFLINE_EXCLUDE_RE,
  },
  {
    category: "goods",
    weight: 0.95,
    keywords: ["包邮", "free shipping", "优惠券", "优惠码", "券码", "满减", "零元", "一分钱", "实物", "试用装", "小样", "京东", "淘宝", "拼多多", "天猫", "羊毛", "折扣", "降价", "元起", "% off", "deal", "clearance", "bogo", "话费", "流量", "立减金", "红包", "外卖", "奶茶", "咖啡", "充值卡", "京豆", "cashback", "gift card"],
  },
  {
    category: "invite",
    weight: 0.9,
    keywords: ["邀请码", "邀请链接", "注册码", "开放注册", "注册送", "新用户", "内测", "资格", "名额"],
  },
  {
    // Cloud-drive resources: emphasises the "drive / cloud storage / resource collection" itself, so it does not blend into media memberships or cloud services
    category: "pan",
    weight: 0.95,
    keywords: ["网盘", "云盘", "夸克网盘", "阿里云盘", "百度网盘", "百度云", "天翼云盘", "115网盘", "迅雷网盘", "uc网盘", "资源合集", "资源分享", "网盘资源", "不限速", "转存", "提取码", "分享链接"],
  },
  {
    // Courses / tutorials: the course content itself; deployment and installation tutorials still belong to dev
    category: "course",
    weight: 1.0,
    keywords: ["网课", "课程", "公开课", "训练营", "视频教程", "系列教程", "教学视频", "配套课件", "课件", "讲义", "mooc", "udemy", "coursera", "极客时间", "拉钩", "慕课"],
  },
  {
    category: "edu",
    weight: 0.95,
    keywords: ["考试", "题库", "真题", "教材", "电子书", "ebook", "ebooks", "audiobook", "audiobooks", "论文", "学习资料", "证书", "备考", "考研", "四六级", "雅思", "托福"],
  },
];

const DEAL_WORDS = ["免费", "白嫖", "领取", "报名领", "领积分", "赠送", "送", "白送", "白给", "0元", "零元", "试用", "体验", "兑换", "激活码", "福利", "优惠", "折扣", "开通", "送额度", "注册送", "限免", "积分", "代金券", "算力", "free", "giveaway", "coupon", "credits", "tokens"];
const SCARCITY_WORDS = ["限时", "限量", "仅限", "前100", "前 100", "名额", "抽奖", "开放注册", "先到先得", "今日", "今晚", "截止", "最后", "limited", "ends", "until", "last chance", "24h", "while supplies"];
const NOISE_PATTERNS = [/怎么(?:领取|申请|弄|搞)/, /有没有/, /求(?:一个|个|推荐|问)/, /请问/, /值得买吗/, /是什么体验/, /怎么样/, /如何评价/];

const URL_NOISE_RE = /https?:\/\/\S+|\b(?:buff\.ly|ow\.ly|redd\.it|bit\.ly|t\.co|tinyurl\.com|dlvr\.it|goo\.gl|youtu\.be|is\.gd|t\.me)\/\S+/gi;
const ASCII_ONLY_RE = /^[a-z0-9\s./+_-]+$/i;
const KW_REGEX_CACHE = new Map<string, RegExp>();

function stripUrls(s: string): string {
  return s.replace(URL_NOISE_RE, " ");
}

function matchKeyword(textLower: string, kw: string): boolean {
  const k = kw.toLowerCase();
  if (!ASCII_ONLY_RE.test(k)) return textLower.includes(k);
  let re = KW_REGEX_CACHE.get(k);
  if (!re) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
    KW_REGEX_CACHE.set(k, re);
  }
  return re.test(textLower);
}

const SOURCE_BONUS: Record<string, number> = {
  "linuxdo-welfare": 8,
  "v2ex-free": 8,
  "epic-free": 8,
  "gamerpower": 7,
  "gamerpower-loot": 7,
  "openrouter-free": 8,
  "rss-itch-free": 6,
  "rss-freesteamkeys": 6,
  "rss-isthereanydeal": 7,
  "cheapshark-free": 6,
  "rss-sharewareonsale": 6,
  "rss-tickcoupon": 6,
  "tg-freegames": 6,
  "rss-reddit-freegames": 6,
  "bsky-gamedeals": 5,
  "rss-reddit-gamedeals": 5,
  "rss-reddit-efreebies": 5,
  "rss-reddit-freegamesonsteam": 5,
  "rss-keylol": 5,
  "rss-nodeseek": 5,
  "rss-indiegamebundles": 4,
  "linuxdo-resource": 4,
  "linuxdo-develop": 3,
  "linuxdo-news": 3,
  "linuxdo-domestic": 3,
  "tg-cn-deals": 4,
  "github-free-for-dev": 3,
  "rss-ithome": 3,
  "rss-smzdm": 3,
  "rss-fuliba": 2,
  "zhihu-search": 4,
  "xhs-search": 4,
  "xiaoheihe-search": 4,
};

export type EnrichedItem = RawItem & {
  category: Category;
  tags: string[];
  codes: string[];
  price: number | null;
  isFree: boolean;
  /** Rule content score (scoreItem's raw result); the combined score is recomputed from it plus the AI quality score */
  baseScore: number;
  score: number;
  url: string;
  urlKey: string;
  expiresAt: string | null;
  imageUrl: string | null;
  kind: ContentKind;
  keep: boolean;
  reason: string;
};
export {
  mergeKey,
  extractMergeKeys,
  TitleDeduper,
  dedupeByTitle,
  type DedupeEntry,
} from "./dedup.ts";
export function classify(
  title: string,
  summary: string,
  opts?: { excludeCategories?: readonly Category[] },
): { category: Category; tags: string[] } {
  const text = stripUrls(`${title} ${summary}`).toLowerCase();
  const skip = opts?.excludeCategories;
  let best: { category: Category; hits: string[]; score: number } = { category: "other", hits: [], score: 0 };
  for (const rule of RULES) {
    if (skip?.includes(rule.category)) continue;
    if (rule.exclude && rule.exclude.test(text)) continue;
    if (rule.require && !rule.require.test(text)) continue;
    const hits = rule.keywords.filter((k) => matchKeyword(text, k));
    if (!hits.length) continue;
    const score = hits.length * rule.weight;
    if (score > best.score) best = { category: rule.category, hits, score };
  }
  const tags = best.hits.slice(0, 6);
  if (best.category === "pan" && !isSharedResource(title, summary) && /网盘|云盘/.test(text) && /会员|容量|扩容|套餐|不限速|空间/.test(text)) {
    return { category: /会员|不限速/.test(text) ? "media" : "cloud", tags };
  }
  return { category: best.category, tags };
}
/**
 * Full definition of a physical freebie: it must first be a freebie (kind=freebie) and then be on-site (offline scene + claim action + Chinese text).
 * The AI also labels US online promos and in-store deals as offline, so both the rule result and the AI output must pass this gate.
 */
export function isOfflineWorthy(title: string, summary: string, kind: string | null): boolean {
  if (kind !== "freebie") return false;
  const text = `${title} ${summary}`;
  if (!OFFLINE_CLAIM_RE.test(text)) return false;
  if (OFFLINE_EXCLUDE_RE.test(text)) return false;
  // All-English overseas local promos mean nothing to a Chinese-language site
  if ((text.match(/[\u4e00-\u9fff]/g) ?? []).length < 2) return false;
  // 1 claim in person at an offline store (original scope) 2 claim a physical / everyday freebie online (new scope)
  return OFFLINE_SCENE_RE.test(text) || PHYSICAL_RE.test(text);
}

/**
 * Single funnel: any source (rules / AI review / reclassification) that marks an item offline must pass isOfflineWorthy,
 * and anything that fails falls back to fallback (the default category).
 */
export function demoteOfflineCategory(
  category: string | null,
  kind: string | null,
  title = "",
  summary = "",
  fallback: string | null = "other",
): string | null {
  if (category !== "offline") return category;
  if (isOfflineWorthy(title, summary, kind)) return category;
  return fallback && fallback !== "offline" ? fallback : "other";
}

/**
 * "Reviews / usage logs / buying guides / rankings" inside the goods category are neither a deal nor a freebie.
 * The AI often labels SMZDM reviews as goods+freebie, so they leak into the "real freebies" and "deals" channels
 * (channels filter by category and ignore kind). With no price, no promo and no claim evidence it drops to tech,
 * keeping it only in the "industry news" channel.
 */
export function demoteEditorialGoods(
  category: string | null,
  kind: string | null,
  input: { title: string; summary?: string; obtain?: string | null; price?: number | null },
): string | null {
  if (category !== "goods") return category;
  if (kind === "noise" || kind === "news") return category;
  // Reviews / buying advice / price news: neither a deal nor a freebie
  if (GOODS_EDITORIAL_RE.test(input.title)) return "tech";
  const text = `${input.title} ${input.summary ?? ""}`;
  const signals = contentSignals(input.title, input.summary ?? "");
  const paidish = input.obtain === "paid" || (typeof input.price === "number" && input.price > 0);
  // Free physical / everyday items -> physical freebie (offline) category
  if (kind === "freebie" && signals.claim && PHYSICAL_RE.test(text)) return "offline";
  // Price or promo present -> keep goods (deal)
  if (paidish || signals.promotion) return category;
  // No price, no promo, no claim evidence -> review / news
  return "tech";
}

/** News categories: content here is reportage and can never be a "free giveaway", so an AI freebie verdict is always downgraded to info. */
const EDITORIAL_CATEGORIES = new Set(["headline", "world", "finance", "stock", "news"]);

/**
 * Neutral categories: the category itself does not imply "there is something to claim". When the AI labels them freebie, the title must contain claim evidence,
 * otherwise consumer reviews and price-comparison posts like "buying this is cheaper" leak into the real-freebie channel
 * e.g. the "after Moutai ended its queueing, is buying for banquets and gifts cheaper than before?" post was labelled freebie + tech + 74 points).
 */
const CLAIM_NEEDED_CATEGORIES = new Set(["tech", "hardware", "other", "headline", "world", "finance", "stock", "news"]);

/** Phrasings that contentSignals().claim does not cover but that still mean "something is really claimable" in the title. */
const TITLE_CLAIM_RE = /免费|可领|能领|领了|到账|\b(?:free|giveaway|coupon)\b/i;

/** Price / market-talk wording: if it appears in the body, the post is about "is it worth buying / is it cheaper", not about "getting it free". */
const PRICE_TALK_RE =
  /\d+(?:\.\d+)?\s*(?:元|块|美元)|[¥￥$]\s*\d|价格|标价|售价|定价|行情|差价|涨价|降价|跌价|调价|折扣|几折|划算|性价比|成本|省下|省钱|赚几|降到|跌到/;

/** Lottery: free to enter but winning is not certain, so obtain is recorded as lottery and it stays out of "real freebies". Giveaway does not count (Steam/Epic game giveaways use it all the time). */
const LOTTERY_TITLE_RE = /sweepstakes|\bwinners?\b|抽奖|抽选|抽签|摇号|赢取/i;
/** An explicit price is not a freebie: "Only $9.99", "selling for", "final price". */
const PRICED_TITLE_RE = /only\s*\$|仅售|到手价|售价\s*[$￥¥]?\s*\d|现价\s*[$￥¥]?\s*\d/i;

/** Body fields the evidence check needs: summary, redemption codes, source (pure-freebie sources are exempt). */
export type FreebieEvidenceExtra = {
  summary?: string | null;
  codes?: readonly string[] | null;
  sourceId?: string | null;
};

/**
 * Freebie evidence check (reject-only, never confirms):
 * - Lottery: free to enter but an uncertain outcome -> obtain=lottery, excluded from the real-freebie channel
 * - Explicitly priced: not a freebie -> kind drops to deal
 * - News category: reportage cannot have anything claimable -> kind drops to info
 * - Neutral category + no claim evidence + price talk throughout: "cheaper" is not a freebie -> kind drops to info
 * It does not decide "is this a freebie"; it only rules out cases that are certainly not a confirmed freebie.
 * Returned obtain semantics: undefined = no opinion (keep the caller's value), null = explicitly clear it, a string = overwrite.
 */
export function enforceFreebieEvidence(
  kind: ContentKind,
  obtain: string | null,
  title: string,
  category?: string | null,
  extra: FreebieEvidenceExtra = {},
): { kind: ContentKind; obtain?: string | null; category?: string | null } {
  if (kind !== "freebie") return { kind, category };
  if (LOTTERY_TITLE_RE.test(title)) return { kind, obtain: "lottery", category: "lottery" };
  if (PRICED_TITLE_RE.test(title)) {
    return { kind: "deal", obtain: obtain === "free" || !obtain ? "paid" : obtain, category };
  }
  // A news category cannot contain a "free giveaway": the AI occasionally labels new civilian policies or industry news as freebie
  // e.g. the "new EV insurance clause passed, your premium now follows your car model" post was labelled freebie + 82 and entered the real-freebie channel).
  // Once the category is clearly news, the kind cannot be freebie.
  if (category && EDITORIAL_CATEGORIES.has(category)) {
    return { kind: "info", obtain: null, category };
  }
  // Consumer reviews and long price-comparison posts in a neutral category: no claim evidence in the title, nothing but price talk in the body -> not a freebie.
  // Pure-freebie sources (Epic game giveaways, the "xi jia yi" freebie lists, ...) guarantee a free object by definition, so they are exempt.
  if (
    category &&
    CLAIM_NEEDED_CATEGORIES.has(category) &&
    !(extra.sourceId && FREEBIE_ONLY_SOURCES.has(extra.sourceId)) &&
    !(extra.codes && extra.codes.length)
  ) {
    const hasClaim = contentSignals(title).claim || TITLE_CLAIM_RE.test(title);
    const text = `${title} ${extra.summary ?? ""}`.slice(0, 3000);
    if (!hasClaim && PRICE_TALK_RE.test(text)) {
      return { kind: "info", obtain: null, category };
    }
  }
  return { kind, category };
}

function ageDays(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return (Date.now() - t) / 86_400_000;
}

/** Dedicated pure-freebie / game-giveaway sources (titles sometimes omit "Free", e.g. r/FreeGameFindings). */
export const FREEBIE_ONLY_SOURCES = new Set([
  "epic-free",
  "steam-free",
  "gamerpower",
  "gamerpower-loot",
  "openrouter-free",
  "rss-itch-free",
  "rss-freesteamkeys",
  "rss-isthereanydeal",
  "rss-reddit-freegames",
  "rss-reddit-freegamesonsteam",
  "rss-reddit-efreebies",
  "rss-reddit-freebies",
  "rss-heyitsfree",
  "rss-freebieshark",
  "rss-giveawayoftheday",
  "rss-tickcoupon",
  "rss-indiegamebundles",
]);
export function scoreItem(input: {
  title: string;
  summary: string;
  publishedAt: string | null;
  sourceId: string;
  category: Category;
  tags: string[];
  expiresAt: string | null;
  isFree?: boolean;
  price?: number | null;
  codes?: string[];
  kind?: ContentKind;
}): { score: number; reason: string } {
  const text = stripUrls(`${input.title} ${input.summary}`).toLowerCase();
  const notes: string[] = [];
  let score = 30;

  if (input.isFree) {
    score += 15;
    notes.push("completely free");
  } else if (input.price !== null && input.price !== undefined) {
    if (input.price <= 5) {
      score += 8;
      notes.push("low price ≤5 CNY");
    } else if (input.price > 30 && input.kind !== "deal") {
      score -= 10;
      notes.push("pay-in-full >30 CNY");
    }
  } else if (FREEBIE_ONLY_SOURCES.has(input.sourceId)) {
    score += 12;
    notes.push("pure-freebie source");
  }

  if (input.codes?.length) {
    score += 12;
    notes.push("contains redemption code");
  }

  const dealHits = DEAL_WORDS.filter((w) => matchKeyword(text, w));
  if (dealHits.length) {
    const add = dealHits.length >= 2 ? 14 : 10;
    score += add;
    notes.push(`freebie words ×${dealHits.length}`);
  } else if (input.kind === "deal" && PROMO_HINT.test(text)) {
    score += 10;
    notes.push("discount signal");
  } else if (input.kind === "opensource" && (input.category === "opensource" || OPENSOURCE_HINT.test(text))) {
    score += 10;
    notes.push("open-source project");
  } else if (input.kind === "news" || input.kind === "info") {
    if (OPENSOURCE_HINT.test(text)) {
      score += 8;
      notes.push("practical guide");
    } else {
      score += 4;
      notes.push(input.kind === "news" ? "important news" : "industry news");
    }
  } else {
    score -= 8;
    notes.push("no freebie words");
  }

  const scarcity = SCARCITY_WORDS.filter((w) => matchKeyword(text, w));
  if (scarcity.length) {
    score += scarcity.length >= 2 ? 8 : 5;
    notes.push(`scarcity ×${scarcity.length}`);
  }

  if (NOISE_PATTERNS.some((p) => p.test(input.title))) {
    score -= 18;
    notes.push("question/resource request");
  }

  const days = ageDays(input.publishedAt);
  if (input.publishedAt) {
    if (days <= 1) {
      score += 16;
      notes.push("within 24h");
    } else if (days <= 3) {
      score += 11;
      notes.push("within 3 days");
    } else if (days <= 7) {
      score += 6;
      notes.push("within a week");
    } else if (days > 45) {
      score -= 12;
      notes.push("stale");
    }
  }

  if (input.expiresAt) {
    const left = (new Date(input.expiresAt).getTime() - Date.now()) / 86_400_000;
    if (left < 0) {
      return { score: 0, reason: [...notes, "expired"].join(" · ") };
    } else if (left <= 3) {
      score += 6;
      notes.push("closing soon");
    }
  }

  score += SOURCE_BONUS[input.sourceId] ?? 0;

  if (input.title.length < 6) {
    score -= 10;
    notes.push("title too short");
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reason: notes.join(" · ") };
}

export function enrichItem(
  raw: RawItem,
  sourceId: string,
  hints?: SourceHints,
): EnrichedItem | null {
  const title = cleanText(raw.title, 200);
  if (!title) return null;
  const summary = cleanText(raw.summary ?? "", 400);
  const url = normalizeUrl(raw.url);
  if (!url) return null;

  const guessed = classify(title, summary);
  const hintCat = raw.categoryHint ?? hints?.categoryHint ?? null;
  let category: Category = guessed.category === "other" && isCategory(hintCat) ? hintCat : guessed.category;
  if (isSharedResource(title, raw.summary ?? "", raw.content ?? "", raw.url)) category = "pan";
  category = categoryForSource(sourceId, category, hints);
  let tags = guessed.tags;
  const codes = extractCodes(title, raw.content ?? raw.summary ?? "");
  const priceInfo = extractPrice(title, summary);
  const expiresAt = raw.expiresAt ?? guessExpiry(`${title} ${summary}`);
  const obtain = guessObtain(title, summary);
  const kindInput = {
    title,
    summary,
    sourceId,
    category,
    obtain,
    isFree: priceInfo.isFree,
    price: priceInfo.price,
    freebieOnlySource: FREEBIE_ONLY_SOURCES.has(sourceId),
    kindHint: raw.kindHint ?? hints?.kindHint ?? null,
    guardEnabled: hints?.guardEnabled,
  };
  let kind = guessKind(kindInput);
  // A physical freebie must be one "claimable at a store": deals and news / chit-chat that merely collide with a place word are all pushed back
  if (category === "offline" && !isOfflineWorthy(title, summary, kind)) {
    const again = classify(title, summary, { excludeCategories: ["offline"] });
    category =
      again.category === "other" && isCategory(hintCat) && hintCat !== "offline" ? hintCat : again.category;
    tags = again.tags;
    kind = guessKind({ ...kindInput, category });
  }
  const { score, reason } = scoreItem({
    title,
    summary,
    publishedAt: raw.publishedAt ?? null,
    sourceId,
    category,
    tags,
    expiresAt,
    isFree: priceInfo.isFree,
    price: priceInfo.price,
    codes,
    kind,
  });

  const expired = Boolean(expiresAt && new Date(expiresAt).getTime() < Date.now());

  return {
    ...raw,
    codes,
    price: priceInfo.price,
    isFree: priceInfo.isFree,
    title,
    summary,
    url,
    urlKey: urlKey(url),
    category,
    tags,
    expiresAt,
    baseScore: score,
    score,
    imageUrl: sanitizeImageUrl(raw.imageUrl, url),
    kind,
    keep: !expired,
    reason,
  };
}
