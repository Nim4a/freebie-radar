import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Loaded once; containers normally use real environment variables directly
for (const file of [".env.local", ".env"]) {
  const p = resolve(process.cwd(), file);
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* Ignore a corrupt env file */
    }
  }
}

const str = (key: string, fallback = "") => (process.env[key] ?? fallback).trim();
const num = (key: string, fallback: number) => {
  const raw = Number(str(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
const bool = (key: string, fallback: boolean) => {
  const raw = str(key).toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

export const config = {
  port: num("PORT", 8788),
  host: str("HOST", "127.0.0.1"),
  databasePath: str("DATABASE_PATH", "./data/radar.db"),
  databaseDir: str("DATABASE_DIR", ""),

  httpProxy: str("HTTP_PROXY"),
  httpsProxy: str("HTTPS_PROXY"),
  fetchTimeoutMs: num("FETCH_TIMEOUT_MS", 20_000),
  minRequestGapMs: num("MIN_REQUEST_GAP_MS", 2_000),
  /** Delay between sources, so sites like Reddit do not return 429 for back-to-back requests from the same IP */
  sourceGapMs: num("SOURCE_GAP_MS", 3_000),

  flaresolverrUrl: str("FLARESOLVERR_URL"),
  flaresolverrTimeoutMs: num("FLARESOLVERR_TIMEOUT_MS", 60_000),

  enabledSources: str("ENABLED_SOURCES")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxItemsPerRun: num("MAX_ITEMS_PER_RUN", 50),

  githubToken: str("GITHUB_TOKEN"),

  collectCron: str("COLLECT_CRON", "0 */2 * * *"),
  dailyCron: str("DAILY_CRON", "30 8 * * *"),
  enableScheduler: bool("ENABLE_SCHEDULER", true),

  dailyTopN: num("DAILY_TOP_N", 12),
  publicBaseUrl: str("PUBLIC_BASE_URL"),
  pushChannel: str("PUSH_CHANNEL", "none"),
  telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
  telegramChatId: str("TELEGRAM_CHAT_ID"),
  telegramApiBase: str("TELEGRAM_API_BASE", "https://api.telegram.org"),
  telegramProxy: str("TELEGRAM_PROXY"),

  aiBaseUrl: str("AI_BASE_URL"),
  aiApiKey: str("AI_API_KEY"),
  aiModel: str("AI_MODEL"),
  aiMaxItems: num("AI_MAX_ITEMS", 60),

  /* English rendering of Chinese scraped titles/summaries (see enrich/translate.ts).
     Empty TRANSLATE_BASE_URL/API_KEY/MODEL fall back to the AI settings above. */
  translateEnabled: bool("TRANSLATE_ENABLED", true),
  translateBaseUrl: str("TRANSLATE_BASE_URL"),
  translateApiKey: str("TRANSLATE_API_KEY"),
  translateModel: str("TRANSLATE_MODEL"),
  /** Rows translated per tick (1-200) */
  translateBatch: num("TRANSLATE_BATCH", 30),
  /** Rows per upstream request (2-20) */
  translateBatchSize: num("TRANSLATE_BATCH_SIZE", 8),
  /** Minutes between ticks */
  translateIntervalMin: num("TRANSLATE_INTERVAL_MIN", 5),

  ingestToken: str("INGEST_TOKEN"),
  /** On-demand headless Cookie runner on the VPS (listens on the private network/bridge only; 0 MB of browser memory when idle) */
  cookieRunnerUrl: str("COOKIE_RUNNER_URL", "http://172.17.0.1:18790"),
  /** Mainland-China egress proxy for Xiaohongshu (e.g. http://47.110.65.20:8888), so a Hong Kong / overseas VPS avoids the international redirect */
  xhsProxyUrl: str("XHS_PROXY_URL"),
  /**
   * Site shape: selfhost = single-operator install (global state, same behavior as the old version);
   * public = public site (public content is read-only and shared, personal state is isolated per logged-in user);
   * auto = behaves as public when LINUXDO_CLIENT_ID is set, otherwise selfhost.
   */
  siteMode: str("SITE_MODE", "auto"),

  /* ---- LINUX DO Connect OAuth2 ---- */
  linuxdoClientId: str("LINUXDO_CLIENT_ID"),
  linuxdoClientSecret: str("LINUXDO_CLIENT_SECRET"),
  linuxdoRedirectUri: str("LINUXDO_REDIRECT_URI"),
  linuxdoMinTrustLevel: num("LINUXDO_MIN_TRUST_LEVEL", 0),
  linuxdoAuthorizeUrl: str("LINUXDO_AUTHORIZE_URL", "https://connect.linux.do/oauth2/authorize"),
  linuxdoTokenUrl: str("LINUXDO_TOKEN_URL", "https://connect.linux.do/oauth2/token"),
  linuxdoUserUrl: str("LINUXDO_USER_URL", "https://connect.linux.do/api/user"),
  /** OAuth-only proxy: direct connections to connect.linux.do are often poisoned/blocked on mainland networks, and we do not want all collection to go through a proxy */
  linuxdoProxy: str("LINUXDO_PROXY"),
  githubClientId: str("GITHUB_CLIENT_ID"),
  githubClientSecret: str("GITHUB_CLIENT_SECRET"),
  githubRedirectUri: str("GITHUB_REDIRECT_URI"),
  /** Proxy used by GitHub OAuth; empty falls back to LINUXDO_PROXY -> HTTP(S)_PROXY */
  githubProxy: str("GITHUB_PROXY"),
  githubAuthorizeUrl: str("GITHUB_AUTHORIZE_URL", "https://github.com/login/oauth/authorize"),
  githubTokenUrl: str("GITHUB_TOKEN_URL", "https://github.com/login/oauth/access_token"),
  githubUserUrl: str("GITHUB_USER_URL", "https://api.github.com/user"),

  /** Signing key for sessions / temporary tokens; empty generates a random one on first start and writes it into the settings table */
  sessionSecret: str("SESSION_SECRET"),
  /** Encryption key for personal Bot Tokens; empty reuses sessionSecret or generates one */
  tokenEncryptionKey: str("TOKEN_ENCRYPTION_KEY"),

  /** Local mock-login switch: only takes effect outside production and when explicitly enabled */
  authDevMock: bool("AUTH_DEV_MOCK", false),

  /* ---- Personal push guardrails (stops one user from saturating the egress proxy) ---- */
  userPushMaxPerHour: num("USER_PUSH_MAX_PER_HOUR", 40),
  userPushMaxPerInstant: num("USER_PUSH_MAX_PER_INSTANT", 5),

  /* ---- Version check and one-click update ---- */
  selfUpdateRemote: str("SELF_UPDATE_REMOTE", "origin"),
  selfUpdateBranch: str("SELF_UPDATE_BRANCH", "main"),
  selfUpdateRestartCmd: str("SELF_UPDATE_RESTART_CMD"),
  updateWebhookUrl: str("UPDATE_WEBHOOK_URL"),
  updateWebhookToken: str("UPDATE_WEBHOOK_TOKEN"),
  appCommit: str("APP_COMMIT"),
  appBuildTime: str("APP_BUILD_TIME"),
  appRepo: str("APP_REPO", "ZiChuanLan/freebie-radar"),
  /** Admin password; when empty the admin API is open in selfhost and locked down in public (safety fallback) */
  adminToken: str("ADMIN_TOKEN"),
  /** Empty keeps single-domain deployments working; once set, the admin API only accepts credentials on these Hosts. */
  adminHosts: str("ADMIN_HOSTS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  /**
   * Categories invisible to logged-out visitors. A public demo site blocks pan/course by default:
   * those two categories aggregate third-party cloud-drive share links (movies / courses / software), a copyright risk to show publicly.
   * Self-hosted installs that want them all visible can set GUEST_HIDDEN_CATEGORIES= to an empty string.
   */
  guestHiddenCategories: str("GUEST_HIDDEN_CATEGORIES", "pan,course").split(",").map((s) => s.trim()).filter(Boolean),
  /** Only turn on when the origin is closed and the reverse proxy overwrites forwarding headers. */
  trustProxy: bool("TRUST_PROXY", false),
  rateLimitEnabled: bool("RATE_LIMIT_ENABLED", true),
  /** Only selfhost can explicitly allow private-network Webhooks; a public site always forbids them. */
  webhookAllowPrivate: bool("WEBHOOK_ALLOW_PRIVATE", false),
} as const;

/**
 * Site shape resolution: auto = run as a public site when LINUX DO OAuth is configured, otherwise as a single-operator install.
 * The core difference of a public site is "personal state isolated per logged-in user"; a self-hosted site keeps the old global behavior.
 */
export const siteMode: "selfhost" | "public" =
  config.siteMode === "selfhost" || config.siteMode === "public"
    ? config.siteMode
    : (config.linuxdoClientId && config.linuxdoClientSecret) || (config.githubClientId && config.githubClientSecret)
      ? "public"
      : "selfhost";

export const isPublicSite = siteMode === "public";

/** Whether OAuth is fully configured (the frontend hides the login button when credentials are missing) */
export const linuxdoConfigured = Boolean(config.linuxdoClientId && config.linuxdoClientSecret);
/** Whether GitHub OAuth is fully configured */
export const githubConfigured = Boolean(config.githubClientId && config.githubClientSecret);

/** Local mock login: usable only outside production and when explicitly enabled */
export const devMockEnabled = config.authDevMock && process.env.NODE_ENV === "development";

/**
 * A public site, and any production environment without ADMIN_TOKEN, must lock the admin area down.
 * Non-production self-hosted sites stay backward compatible; the default listen address is loopback.
 */
export const adminLocked = (isPublicSite || process.env.NODE_ENV === "production") && !config.adminToken;

export const aiEnabled = Boolean(config.aiBaseUrl && config.aiModel);
export const pushEnabled = config.pushChannel !== "none" && Boolean(config.telegramBotToken && config.telegramChatId);
