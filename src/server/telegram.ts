import { config } from "./config.ts";

const proxyAgents = new Map<string, import("undici").ProxyAgent>();
async function proxyFetch(proxy: string) {
  const undici = await import("undici");
  let agent = proxyAgents.get(proxy);
  if (!agent) { agent = new undici.ProxyAgent(proxy); proxyAgents.set(proxy, agent); }
  return { agent, fetch: undici.fetch as unknown as typeof fetch };
}

export type TelegramTarget = {
  botToken: string;
  chatId: string;
  apiBase?: string;
  proxy?: string;
};

/**
 * Single send entry point: the global Bot and the personal Bots share one implementation;
 * they differ only in where token / chat_id come from (config, or decrypted from user_push_configs).
 */
export type SendOptions = { parseMode?: "HTML" | "Markdown" };

export async function sendTelegramWith(
  target: TelegramTarget,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  const base = (target.apiBase ?? config.telegramApiBase).replace(/\/+$/, "");
  const url = base + "/bot" + target.botToken + "/sendMessage";
  const init: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: target.chatId,
      text,
      disable_web_page_preview: true,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  };
  const proxy = target.proxy ?? config.telegramProxy;
  let doFetch: typeof fetch = fetch;
  if (proxy) {
    // Must use the fetch from the bundled undici: Node's built-in undici (7.x) and the one in node_modules
    // undici (8.x) speak different dispatcher handler protocols, and mixing them throws
    // InvalidArgumentError: invalid onRequestStart method
    const client = await proxyFetch(proxy);
    init.dispatcher = client.agent;
    doFetch = client.fetch;
  }
  const res = await doFetch(url, init);
  if (!res.ok) throw new Error("Telegram HTTP " + res.status + " " + (await res.text()).slice(0, 150));
}

export async function sendTelegram(text: string, opts: SendOptions = {}): Promise<void> {
  await sendTelegramWith(
    { botToken: config.telegramBotToken, chatId: config.telegramChatId },
    text,
    opts,
  );
}

export type DetectedChat = { chatId: string; title: string; type: string };

/**
 * Saves users from the "what do I put in chat_id" trap: call getUpdates to list the conversations
 * they recently had with this Bot. They only need to send /start to their own Bot first.
 */
export async function detectTelegramChatIds(botToken: string): Promise<DetectedChat[]> {
  const base = config.telegramApiBase.replace(/\/+$/, "");
  const url = base + "/bot" + botToken + "/getUpdates?limit=20&allowed_updates=" + encodeURIComponent('["message","channel_post"]');
  const init: RequestInit & { dispatcher?: unknown } = {
    method: "GET",
    signal: AbortSignal.timeout(12_000),
  };
  let doFetch: typeof fetch = fetch;
  if (config.telegramProxy) {
    const client = await proxyFetch(config.telegramProxy);
    init.dispatcher = client.agent;
    doFetch = client.fetch;
  }
  const res = await doFetch(url, init);
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: Array<{
      message?: { chat?: { id?: number; title?: string; username?: string; type?: string } };
      channel_post?: { chat?: { id?: number; title?: string; username?: string; type?: string } };
    }>;
  };
  if (!res.ok || body.ok === false) {
    throw new Error(body.description ?? "Telegram getUpdates failed (HTTP " + res.status + ")");
  }
  const seen = new Map<string, DetectedChat>();
  for (const upd of body.result ?? []) {
    const chat = upd.message?.chat ?? upd.channel_post?.chat;
    if (!chat?.id) continue;
    const chatId = String(chat.id);
    if (seen.has(chatId)) continue;
    seen.set(chatId, {
      chatId,
      title: chat.title ?? (chat.username ? "@" + chat.username : chatId),
      type: chat.type ?? "private",
    });
  }
  return [...seen.values()];
}
