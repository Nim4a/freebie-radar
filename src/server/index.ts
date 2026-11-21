import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { Server as HttpServer } from "node:http";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import { config } from "./config.ts";
import { getDb, migrate, run } from "./db.ts";
import { registerApi, warmClusterCache } from "./routes.ts";
import { startPushScheduler } from "./push.ts";
import { digestExists, runDaily } from "./digest.ts";
import { startIntervalScheduler, startScheduler } from "./cron.ts";
import { getRetention, runCleanup } from "./retention.ts";
import { ensureSources } from "./collectors/index.ts";
import { releaseFlareSession } from "./flaresolverr.ts";
import { pushUserDaily, startUserPushScheduler } from "./user-push.ts";
import { purgeExpiredSessions } from "./auth.ts";
import { getBuildInfo } from "./updater.ts";
import { registerSecurity } from "./security.ts";
import { reconcileFixedSourceCategories } from "./source-settings.ts";
import { startTranslateScheduler, translatePending } from "./enrich/translate.ts";

migrate();
ensureSources();
const rerouted = reconcileFixedSourceCategories();
if (rerouted) console.log(`[sources] realigned fixed categories for ${rerouted} historical items (no AI or push triggered)`);
// A previous unexpected exit may leave status='running' rows behind; close them out at startup
run(
  "UPDATE runs SET status = 'failed', finished_at = ?, error = COALESCE(error, 'interrupted by process restart') WHERE status = 'running'",
  new Date().toISOString(),
);
const app = new Hono();
registerSecurity(app);
// JSON responses run tens of KB, so compress before sending; /api/items?limit=100 drops from 75KB to ~15KB
app.use("*", compress());
app.use("*", logger((message, ...rest) => console.log(
  message.replace(/\/rss\/u\/[^?\s\u001b]+/g, "/rss/u/[redacted]").replace(/([?&](?:code|state|invite)=)[^&\s\u001b]+/g, "$1[redacted]"),
  ...rest,
)));

app.get("/health", async (c) => {
  const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
  // After a one-click update the front end polls /health waiting for the commit to change, confirming the new build is really up
  const build = await getBuildInfo().catch(() => null);
  return c.json({
    ok: row?.ok === 1,
    version: build?.version ?? "0.1.0",
    commit: build?.commitShort ?? null,
    runtimeMode: build?.runtimeMode ?? null,
    time: new Date().toISOString(),
    sources: config.enabledSources.length || "all",
  });
});

registerApi(app);

// Hono's serveStatic resolves root/path relative to process.cwd(); an absolute path would produce a wrong path.
// Hashed assets should be cached long-term, but index.html must be no-store or users get stale HTML (blank page) after a release.
const webDistAbs = fileURLToPath(new URL("../../dist/web", import.meta.url));
if (existsSync(webDistAbs)) {
  const relRoot = relative(process.cwd(), webDistAbs).split(sep).join("/") || ".";
  app.use(
    "/assets/*",
    serveStatic({
      root: relRoot,
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.use(
    "/*",
    serveStatic({
      root: relRoot,
      // Responses that hit index.html must never be cached, or after a release browsers fetch deleted old JS with stale HTML
      onFound: (p, c) => {
        if (p.endsWith(".html")) c.header("Cache-Control", "no-store, must-revalidate");
      },
    }),
  );
  app.get(
    "*",
    serveStatic({
      path: relRoot + "/index.html",
      onFound: (_path, c) => {
        c.header("Cache-Control", "no-store, must-revalidate");
      },
    }),
  );
} else {
  app.get("/", (c) => c.text("freebie-radar API is running. Front end not built — run pnpm build or pnpm dev:web."));
}

if (config.enableScheduler) {
  // Collection: each source polls on its own interval_sec (linux.do 90s, RSS 15min, GitHub 6h)
  startIntervalScheduler();
  // Cluster cache warm-up: the public list hits 40+ (kind,category) combos, and a cold single pass takes 4-5s.
  // Wait 5 seconds for collection to start, then build indexes in background batches so the first user request hits cache.
  setTimeout(() => { void warmClusterCache(); }, 2_000);
  // Push: the batch queue merges and sends on the batchIntervalMin timer (quiet hours are skipped automatically)
  startPushScheduler();
  // Per-user Bot batching: each user dequeues on their own schedule, independent of the global batch
  startUserPushScheduler();
  // English rendering of scraped Chinese titles/summaries (TRANSLATE_* env); runs every few minutes
  startTranslateScheduler();
  // Daily digest: still triggered by DAILY_CRON
  startScheduler({
    collect: async () => undefined,
    daily: async () => {
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (digestExists(day)) return;
      // Make sure the picks go out in English even for items collected minutes before the digest
      await translatePending(config.dailyTopN * 3).catch((err) => {
        console.error("[translate] pre-digest pass failed:", err instanceof Error ? err.message : err);
      });
      await runDaily({ date: now });
      // Once the daily picks are stored, send a copy to each user with "personal daily digest" enabled
      await pushUserDaily().catch((err) => {
        console.error("[user-push] personal daily digest failed:", err instanceof Error ? err.message : err);
      });
    },
  });

  // Cleanup: run once a day, deleting expired items and logs per the retention policy (starred items are never deleted)
  const tickCleanup = () => {
    try {
      const cfg = getRetention();
      if (!cfg.auto) return;
      const r = runCleanup(cfg);
      const total = Object.values(r.deleted).reduce((a, b) => a + b, 0);
      if (total > 0) console.log("[cleanup]", JSON.stringify(r.deleted), "remaining", r.remaining);
    } catch (err) {
      console.error("[cleanup] failed:", err instanceof Error ? err.message : err);
    }
  };
  tickCleanup();
  // Purge expired login sessions so the sessions table does not grow unbounded
  try {
    const n = purgeExpiredSessions();
    if (n > 0) console.log("[auth]", n, "expired sessions purged");
  } catch {
    /* ignore */
  }
  setInterval(tickCleanup, 12 * 3600_000);
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[radar] listening on http://${config.host}:${info.port}`);
});
if (server instanceof HttpServer) {
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    Promise.race([releaseFlareSession(), new Promise((r) => setTimeout(r, 800))]).finally(() => {
      process.exit(0);
    });
  });
}
