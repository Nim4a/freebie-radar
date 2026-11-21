/**
 * Single source of truth for categories, content kinds, obtain modes and channels (presets).
 *
 * The same category list used to live in 5 places (enrich rules, push allowlist
 * validation, AI prompts, the front-end label table, the source ops dropdown);
 * adding a category anywhere meant syncing the rest by hand, and missing one left
 * the home page, push and source fallbacks disagreeing. Both server and front end import from here.
 */

/* ------------------------------------------------------------------ *
 * Categories (sub-categories)
 * ------------------------------------------------------------------ */

export const CATEGORY_KEYS = [
  "ai",
  "cloud",
  "vps",
  "domain",
  "opensource",
  "software",
  "dev",
  "design",
  "security",
  "hardware",
  "media",
  "game",
  "carpool",
  "trade",
  "headline",
  "world",
  "finance",
  "stock",
  "tech",
  "news",
  "goods",
  "lottery",
  "offline",
  "invite",
  "edu",
  "pan",
  "course",
  "other",
] as const;

export type Category = (typeof CATEGORY_KEYS)[number];

const CATEGORY_LABEL_BY_KEY = {
  ai: "AI Credits",
  cloud: "Cloud Services",
  vps: "VPS / Hosting",
  domain: "Domains / Sites",
  opensource: "Open Source",
  software: "Software Licenses",
  dev: "Dev / Engineering",
  design: "Design / Assets",
  security: "Security / Network",
  hardware: "Hardware / Gadgets",
  media: "Streaming Memberships",
  game: "Games",
  carpool: "Carpools / Group Plans",
  trade: "Second-hand / Trading",
  headline: "Politics & Policy",
  world: "World News",
  finance: "Economy / Business",
  stock: "Stocks / Markets",
  tech: "Tech News",
  news: "General News",
  goods: "Goods / Deals",
  lottery: "Lotteries / Draws",
  offline: "Physical Freebies",
  invite: "Invite Codes",
  edu: "Education / Exams",
  pan: "Cloud Drive Files",
  course: "Courses / Tutorials",
  other: "Other",
} satisfies Record<Category, string>;

/** Public API uses a loose index type: callers may pass any string (from the database or AI). */
export const CATEGORY_LABEL: Record<string, string> = CATEGORY_LABEL_BY_KEY;

/** One line saying what this category covers, for dropdowns and hover tooltips. */
export const CATEGORY_DESC: Record<Category, string> = {
  ai: "LLM credits / tokens / compute / API trials",
  cloud: "Cloud services beyond hosts: object storage / CDN / databases / proxy traffic",
  vps: "Dedicated servers / VPS boxes / ready machines / home broadband",
  domain: "Domains / SSL / DNS / shared hosting / site building",
  opensource: "GitHub and GitLab repos, plus self-hostable projects",
  software: "Genuine licenses / activation codes / freebie and buyout software",
  dev: "Frameworks / CLI / SDK / plugins / deployment guides",
  design: "Fonts / icons / UI templates / assets / presets",
  security: "Vulnerabilities / VPN / privacy and security tools",
  hardware: "Hardware / routers / NAS / tech peripherals",
  media: "Streaming memberships / shows / music / anime",
  game: "Free giveaways / all-time lows / game copies and bundles",
  carpool: "Compliant carpools / shared subscriptions / family-plan slots",
  trade: "Listed hosting boxes / account and device transfers",
  headline: "Domestic politics / policy and law / livelihood news",
  world: "World affairs / diplomacy / overseas news",
  finance: "Macroeconomics / earnings / funding and M&A / currencies",
  stock: "A-shares / Hong Kong / US stocks / ETF / IPO",
  tech: "Frontier tech / chips / internet / aerospace and new energy",
  news: "General briefs and other news",
  goods: "Everyday freebies / coupons / phone credit and red packets / physical goods",
  lottery: "Free-to-enter but uncertain draws / sweepstakes / raffles (not counted as guaranteed freebies)",
  offline: "Physical freebies: in-store pickup (shops / pop-ups / expos) or free physical goods and everyday perks claimed online (food / household items / books / phone credit / red packets / memberships); pure news, inspection notices and roommate matching don't count",
  invite: "Invite codes / open registration / beta access",
  edu: "Question banks / past exams / textbooks / e-books / exam prep",
  pan: "Quark / Aliyun Drive / Baidu Netdisk shares and saves",
  course: "Open courses / bootcamps / video courses / lecture handouts",
  other: "Fallback category",
};

/** Top-level groups: the front-end dropdown and the push allowlist share one set, matching the home page channels. */
export type CategoryGroupKey = "freebie" | "tech" | "content" | "news" | "other";

export const CATEGORY_GROUPS: { key: CategoryGroupKey; label: string; categories: Category[] }[] = [
  {
    key: "freebie",
    label: "Freebies & Trades",
    categories: ["ai", "cloud", "vps", "domain", "software", "media", "game", "carpool", "trade", "goods", "lottery", "offline", "invite"],
  },
  {
    key: "tech",
    label: "Tech & Tools",
    categories: ["opensource", "dev", "design", "security", "hardware"],
  },
  {
    key: "content",
    label: "Content & Learning",
    categories: ["pan", "course", "edu"],
  },
  {
    key: "news",
    label: "News & Information",
    categories: ["headline", "world", "finance", "stock", "tech", "news"],
  },
  {
    key: "other",
    label: "Other",
    categories: ["other"],
  },
];

export const CATEGORY_SET: ReadonlySet<string> = new Set<string>(CATEGORY_KEYS);

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

export function categoryLabel(category: string | null | undefined): string {
  const key = (category ?? "other") as Category;
  return CATEGORY_LABEL[key] ?? category ?? "Other";
}

/** Column names for news/information views (so tech news doesn't show up as "AI Credits"). */
export const NEWS_CATEGORY_LABEL: Record<string, string> = {
  headline: "Politics & Policy",
  world: "World News",
  finance: "Economy / Business",
  stock: "Stocks / Markets",
  tech: "Tech Frontier",
  ai: "AI Frontier",
  dev: "Dev Engineering",
  opensource: "Open Source Ecosystem",
  security: "Security / Vulnerabilities",
  cloud: "Cloud & Architecture",
  vps: "Hosting / Network",
  hardware: "Hardware & Gadgets",
  software: "Software / Apps",
  game: "Game News",
  design: "Design & UX",
  edu: "Education / Exams",
  pan: "Cloud Drive Files",
  course: "Courses / Tutorials",
  news: "General News",
  other: "Other News",
};

/* ------------------------------------------------------------------ *
 * Channels (home page top-level presets)
 * ------------------------------------------------------------------ */

/** Categories that make up the real-freebie channel: cloud drives, courses and physical freebies have their own channels and don't mix in here */
export const FREEBIE_CATEGORY_KEYS: Category[] = [
  "ai", "software", "game", "cloud", "vps", "domain", "media", "design", "dev", "edu", "goods", "lottery", "invite", "opensource", "security", "hardware", "other",
];

/**
 * A channel is a top-level group at the top of the home page; the category allowlist
 * defaults to it and push rules apply it in one click. Categories in exclude are dropped from the channel even if they also appear in categories.
 */
export const CHANNELS: { key: string; label: string; categories: Category[]; exclude?: Category[] }[] = [
  { key: "verified", label: "Verified Freebies", categories: FREEBIE_CATEGORY_KEYS, exclude: ["pan", "course", "offline", "lottery"] },
  { key: "free", label: "All Free Stuff", categories: FREEBIE_CATEGORY_KEYS },
  { key: "offline", label: "Physical Freebies", categories: ["offline"] },
  { key: "news", label: "Top News", categories: ["headline", "world", "finance", "tech", "stock", "news", "security", "other"], exclude: ["pan", "course"] },
  { key: "opensource", label: "Open Source", categories: ["ai", "dev", "opensource", "security", "cloud", "vps", "software", "tech", "design", "hardware", "edu", "other"], exclude: ["pan", "course"] },
  { key: "deal", label: "Best Deals", categories: ["vps", "carpool", "trade", "game", "software", "cloud", "domain", "ai", "media", "hardware", "goods", "design", "dev", "security", "edu", "other"], exclude: ["pan", "course"] },
  { key: "info", label: "Industry News", categories: ["finance", "stock", "tech", "ai", "dev", "hardware", "security", "cloud", "software", "game", "opensource", "design", "edu", "news", "other"], exclude: ["pan", "course"] },
  { key: "pan", label: "Cloud Drives / Courses", categories: ["pan", "course"] },
];

/** Categories this channel excludes (the home page query joins them into excludeCategory so no category pill leads to an empty result). */
export function channelExcluded(preset: string): Category[] {
  return CHANNELS.find((c) => c.key === preset)?.exclude ?? [];
}

/** Unknown presets (e.g. codes / urgent / starred) return every category. */
export function categoriesForPreset(preset: string): string[] {
  const channel = CHANNELS.find((c) => c.key === preset);
  if (!channel) return [...CATEGORY_KEYS];
  const excluded = new Set<string>(channel.exclude ?? []);
  return channel.categories.filter((key) => !excluded.has(key));
}
export function categoryLabelForPreset(category: string, preset: string): string {
  if (preset === "news" || preset === "info") {
    return NEWS_CATEGORY_LABEL[category] ?? categoryLabel(category);
  }
  return categoryLabel(category);
}

export function categoryLabelForKind(
  category: string | null | undefined,
  kind: string | null | undefined,
): string {
  const key = category || "other";
  if (kind === "news" || kind === "info") {
    return NEWS_CATEGORY_LABEL[key] ?? categoryLabel(key);
  }
  return categoryLabel(key);
}

/* ------------------------------------------------------------------ *
 * Content kinds
 * ------------------------------------------------------------------ */

export const CONTENT_KIND_KEYS = ["freebie", "deal", "opensource", "news", "info", "noise"] as const;

export type ContentKind = (typeof CONTENT_KIND_KEYS)[number];

const KIND_LABEL_BY_KEY = {
  freebie: "Freebies",
  deal: "Deals",
  opensource: "Open Source",
  news: "Top News",
  info: "Industry News",
  noise: "Noise / Off-topic",
} satisfies Record<ContentKind, string>;

export const KIND_LABEL: Record<string, string> = KIND_LABEL_BY_KEY;

/** Kinds that can be assigned or filtered (noise is a blocked result, not a filter option). */
export const KIND_ORDER = ["freebie", "deal", "opensource", "news", "info"] as const;

export const KIND_SET: ReadonlySet<string> = new Set<string>(CONTENT_KIND_KEYS);

export function isContentKind(v: unknown): v is ContentKind {
  return typeof v === "string" && KIND_SET.has(v);
}

/* ------------------------------------------------------------------ *
 * Obtain modes
 * ------------------------------------------------------------------ */

export const OBTAIN_KEYS = ["free", "conditional", "lottery", "trial", "promo", "paid"] as const;

export type ObtainMode = (typeof OBTAIN_KEYS)[number];

const OBTAIN_LABEL_BY_KEY = {
  free: "Grab It Free",
  conditional: "Has Conditions",
  lottery: "Lottery",
  trial: "Trial / Limited Time",
  promo: "Promo / Ad",
  paid: "Paid",
} satisfies Record<ObtainMode, string>;

export const OBTAIN_LABEL: Record<string, string> = OBTAIN_LABEL_BY_KEY;

const OBTAIN_HINT_BY_KEY = {
  free: "Claim it right away; no posting, invites or draws required",
  conditional: "Requires replying, posting, sharing, following, inviting, or real-name card binding",
  lottery: "Draws for limited slots; you may not win",
  trial: "Free for N days or free for the first month, then paid",
  promo: "Essentially a vendor promoting its own paid service; the freebie is the hook",
  paid: "You have to actually pay to get it",
} satisfies Record<ObtainMode, string>;

export const OBTAIN_HINT: Record<string, string> = OBTAIN_HINT_BY_KEY;

export const OBTAIN_ORDER = ["free", "conditional", "lottery", "trial", "promo", "paid"] as const;

export const OBTAIN_SET: ReadonlySet<string> = new Set<string>(OBTAIN_KEYS);

export function isObtainMode(v: unknown): v is ObtainMode {
  return typeof v === "string" && OBTAIN_SET.has(v);
}

/* ------------------------------------------------------------------ *
 * Dropdown options (shared by source ops and push rules)
 * ------------------------------------------------------------------ */

/** Category options grouped by top-level group, for <optgroup> or multi-column panel rendering. */
export function categoryOptionGroups(): { label: string; options: { value: Category; label: string; desc: string }[] }[] {
  return CATEGORY_GROUPS.map((g) => ({
    label: g.label,
    options: g.categories.map((key) => ({ value: key, label: CATEGORY_LABEL_BY_KEY[key], desc: CATEGORY_DESC[key] })),
  }));
}
