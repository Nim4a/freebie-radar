import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DATABASE_PATH = ":memory:";
// 让推送通道看起来是通的，才能走到 pushInstant / flushBatch 里的上限逻辑
process.env.PUSH_CHANNEL = "telegram";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "test-chat";

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { ensureSources } = await import("../src/server/collectors/index.ts");
const {
  DEFAULT_SETTINGS,
  planInstant,
  previewPush,
  pushInstant,
  flushBatch,
  queueSize,
  recentPushLog,
  savePushSettings,
} = await import("../src/server/push.ts");


before(() => {
  migrate();
  ensureSources();
});

after(() => {
  closeDb();
});

/** 拦截真实 Telegram 请求，只记录发出去的正文 */
const outbox: string[] = [];
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  outbox.push(String(init?.body ?? ""));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let seq = 0;
function seedItem(title: string, score: number, sourceId = "linuxdo-welfare"): number {
  seq += 1;
  const now = new Date().toISOString();
  run(
    `INSERT INTO items (source_id, external_id, url, url_key, title, title_key, category, kind, score, published_at,
                        status, is_free, obtain, ai, ai_keep, codes, price, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ai', 'freebie', ?, ?, 'active', 1, 'free', ?, 1, '[]', 0, ?, ?)`,
    sourceId,
    "ext-" + seq,
    "https://example.com/" + seq,
    "example/" + seq,
    title,
    "tk-" + seq,
    score,
    now,
    JSON.stringify({ keep: true, kind: "freebie", category: "ai", obtain: "free", quality: 5, reason: "新免费额度" }),
    now,
    now,
  );
  return (get<{ id: number }>("SELECT last_insert_rowid() AS id") as { id: number }).id;
}

function freshOf(id: number, title: string, score: number) {
  return {
    id,
    title,
    url: "https://example.com/" + id,
    score,
    codes: [] as string[],
    expiresAt: null,
    publishedAt: new Date().toISOString(),
    price: 0,
    isFree: true,
    aiKeep: true,
    aiReason: "新免费额度",
    kind: "freebie",
    category: "ai",
    obtain: "free",
    summary: "",
  };
}

test("planInstant：每轮即时上限 / 每小时额度 / 额度耗尽三种情况", () => {
  const s = { ...DEFAULT_SETTINGS, maxPerInstant: 3, maxPerHour: 10 };

  // 每轮即时上限先卡住
  assert.deepEqual(planInstant(8, s, 0), { send: 3, defer: 5, budget: 10 });
  // 小时额度比每轮上限更紧时，额度优先
  assert.deepEqual(planInstant(8, s, 8), { send: 2, defer: 6, budget: 2 });
  // 额度耗尽：一条都不即时发，全部顺延
  assert.deepEqual(planInstant(8, s, 12), { send: 0, defer: 8, budget: 0 });
  // 不够上限时全发，不产生顺延
  assert.deepEqual(planInstant(2, s, 0), { send: 2, defer: 0, budget: 10 });
});

test("即时推送超出上限的条目转进攒批队列，不会被无声丢弃", async () => {
  const s = { ...DEFAULT_SETTINGS, maxPerInstant: 3, maxPerHour: 100, batchIntervalMin: 30, dedupeByTitle: false, quietEnabled: false };
  savePushSettings(s);
  run("UPDATE items SET pushed_at = NULL");

  const rows = Array.from({ length: 8 }, (_, i) => {
    const title = "超出上限也不会丢测试福利 " + i;
    const id = seedItem(title, 90 - i);
    return freshOf(id, title, 90 - i);
  });

  const sent = await pushInstant("linuxdo-welfare", rows);
  assert.equal(sent, 3, "每轮即时上限 3 条，只应发 3 条");
  assert.equal(queueSize(), 5, "剩下 5 条必须进攒批队列，而不是消失");

  // 攒批按 maxPerBatch + 小时额度发，剩下的继续留在队列
  savePushSettings({ ...s, maxPerBatch: 2 });
  const flushed = await flushBatch(true);
  assert.equal(flushed, 2, "单批最多合并 2 条");
  assert.equal(queueSize(), 3, "没发出去的继续留在队列等下一轮");
});

test("推送记录带上「为什么推它」的原因", async () => {
  const logs = recentPushLog(10) as { kind: string; reason: string | null }[];
  assert.ok(logs.length > 0, "应该有推送记录");
  const instantLogs = logs.filter((l) => l.kind === "instant");
  assert.ok(instantLogs.length > 0);
  assert.ok(instantLogs.every((l) => typeof l.reason === "string" && l.reason.length > 0), "即时推送必须写明命中原因");
  const batchLogs = logs.filter((l) => l.kind === "batch");
  assert.ok(batchLogs.length > 0, "攒批也应该有记录");
  assert.ok(batchLogs.every((l) => typeof l.reason === "string" && l.reason.length > 0), "攒批要给出原因摘要");
});

test("预览与真实推送共用同一套上限算法：能发几条、顺延几条口径一致", () => {
  // 只让预览看这一批测试数据，避免被前面用例留下的条目干扰
  savePushSettings({
    ...DEFAULT_SETTINGS,
    maxPerInstant: 2,
    maxPerHour: 100,
    batchIntervalMin: 30,
    quietEnabled: false,
    dedupeByTitle: false,
    sourceMode: "include",
    sourceIds: ["preview-src"],
  });
  run("UPDATE items SET pushed_at = NULL WHERE pushed_at IS NOT NULL");
  for (let i = 0; i < 6; i += 1) seedItem("预览口径一致测试 " + i, 95 - i, "preview-src");

  const pv = previewPush(3);
  assert.equal(pv.instantTotal, 6, "6 条都够格即时");
  assert.equal(pv.sendableInstant, 2, "每轮即时上限 2 条");
  assert.equal(pv.deferred, 4, "其余 4 条顺延");
  assert.equal(pv.batchTotal, 4, "顺延的 4 条算进攒批");
  assert.equal(pv.caps.maxPerInstant, 2);
  assert.ok(pv.instant.length <= 3, "展示条数受 limit 约束，但统计不受影响");
  assert.equal(pv.batch.length, 0, "超出展示上限的即时条目不应漏进攒批预览框");
});

test("free AI / domain / VPS posts tagged deal or info still pass the kind gate", async () => {
  const { coreFreeKindAllowed, passesPushFilters } = await import("../src/server/push.ts");
  // the sources file free AI / domain / VPS as "deal" | "info" — those must reach the digest
  assert.equal(coreFreeKindAllowed({ kind: "deal", category: "vps", obtain: "free" }, ["freebie"]), true);
  assert.equal(
    coreFreeKindAllowed(
      { kind: "info", category: "domain", obtain: "free", isFree: true, title: "免费领取 .dev 域名一年" },
      ["freebie"],
    ),
    true,
  );
  // plain industry chatter in a core category is NOT a freebie
  assert.equal(
    coreFreeKindAllowed(
      { kind: "info", category: "vps", obtain: "free", isFree: true, title: "关于香港32区IP被墙及更换恢复的通知" },
      ["freebie"],
    ),
    false,
  );
  assert.equal(
    coreFreeKindAllowed(
      { kind: "info", category: "ai", obtain: "free", isFree: true, title: "这个 Leaflow 的 Token 越用越多啊" },
      ["freebie"],
    ),
    false,
  );
  assert.equal(coreFreeKindAllowed({ kind: "deal", category: "ai", obtain: null, price: 0 }, ["freebie"]), true);
  // never widen outside the core categories, never for noise, never for a paid post
  assert.equal(coreFreeKindAllowed({ kind: "deal", category: "pan", obtain: "free" }, ["freebie"]), false);
  assert.equal(coreFreeKindAllowed({ kind: "noise", category: "vps", obtain: "free" }, ["freebie"]), false);
  assert.equal(coreFreeKindAllowed({ kind: "deal", category: "vps", obtain: "paid" }, ["freebie"]), false);
  assert.equal(coreFreeKindAllowed({ kind: "info", category: "game", obtain: "free" }, ["freebie"]), false);
  // kind=freebie keeps behaving exactly as before, everywhere
  assert.equal(coreFreeKindAllowed({ kind: "freebie", category: "pan", obtain: "free" }, ["freebie"]), true);
  const settings = { ...DEFAULT_SETTINGS, maxAgeHours: 240, dedupeByTitle: false };
  assert.equal(
    passesPushFilters(
      {
        sourceId: "v2ex-cloud",
        title: "Free VPS trial with 1 vCPU and 10GB traffic",
        score: 90,
        codes: [],
        isFree: true,
        aiKeep: true,
        kind: "deal",
        category: "vps",
        obtain: "free",
        publishedAt: new Date().toISOString(),
      },
      settings,
    ),
    true,
    "a free VPS deal passes the shared push+digest filter",
  );
});
