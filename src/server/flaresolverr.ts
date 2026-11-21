import { config } from "./config.ts";
import { decodeEntities } from "./enrich/normalize.ts";

export type FlareResult = { status: number; body: string; url: string };

const SESSION = "radar";
/** Tear down the FlareSolverr browser instance after 90 seconds idle, so Chromium is not resident eating 300MB+ */
const SESSION_IDLE_MS = 90_000;

function endpointOf(base: string): string {
  return /\/v\d+$/.test(base) ? base : base.replace(/\/+$/, "") + "/v1";
}

type FlarePayload = {
  status?: string;
  message?: string;
  solution?: { status?: number; url?: string; response?: string };
};

async function post(endpoint: string, body: Record<string, unknown>, timeoutMs = config.flaresolverrTimeoutMs + 15_000): Promise<FlarePayload> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as FlarePayload;
  } catch {
    throw new Error(`FlareSolverr returned non-JSON (${res.status}): ${text.slice(0, 160)}`);
  }
}

let sessionUp = false;
let lastSessionUse = 0;
let idleTimer: NodeJS.Timeout | null = null;

function touchSessionIdle(endpoint: string): void {
  lastSessionUse = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (sessionUp && Date.now() - lastSessionUse >= SESSION_IDLE_MS - 1000) {
      void dropSession(endpoint);
    }
  }, SESSION_IDLE_MS);
  idleTimer.unref?.();
}

async function ensureSession(endpoint: string): Promise<void> {
  if (sessionUp && Date.now() - lastSessionUse < 20 * 60_000) return;
  const created = await post(endpoint, { cmd: "sessions.create", session: SESSION });
  if (created.status !== "ok" && !/already exists/i.test(created.message ?? "")) {
    throw new Error(`session create failed: ${created.message ?? created.status}`);
  }
  sessionUp = true;
  touchSessionIdle(endpoint);
}

async function dropSession(endpoint: string): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  sessionUp = false;
  try {
    await post(endpoint, { cmd: "sessions.destroy", session: SESSION }, 10_000);
  } catch {
    /* destroy failure is harmless; the session gets recreated next time */
  }
}

export async function releaseFlareSession(): Promise<void> {
  if (!sessionUp || !config.flaresolverrUrl) return;
  await dropSession(endpointOf(config.flaresolverrUrl));
}

async function request(endpoint: string, url: string, timeoutMs: number, session: string | null): Promise<FlareResult> {
  const payloadBody: Record<string, unknown> = { cmd: "request.get", url, maxTimeout: timeoutMs };
  if (session) payloadBody.session = session;

  const payload = await post(endpoint, payloadBody, timeoutMs + 15_000);
  if (payload.status !== "ok" || !payload.solution) {
    throw new Error(
      `FlareSolverr failed: ${payload.message ?? payload.status ?? "unknown"} (${JSON.stringify(payload).slice(0, 120)})`,
    );
  }
  const raw = String(payload.solution.response ?? "");
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(raw);
  if (session) touchSessionIdle(endpoint);
  return {
    status: payload.solution.status ?? 0,
    url: payload.solution.url ?? url,
    body: pre ? decodeEntities(pre[1]!) : raw,
  };
}

/**
 * Fetch a page through FlareSolverr, reusing a session and destroying it after 90 seconds idle to free browser memory.
 */
export async function flaresolverrGet(url: string, timeoutMs = config.flaresolverrTimeoutMs): Promise<FlareResult> {
  if (!config.flaresolverrUrl) throw new Error("FLARESOLVERR_URL is not configured; cannot reach sources protected by Cloudflare");
  const endpoint = endpointOf(config.flaresolverrUrl);

  await ensureSession(endpoint);
  try {
    return await request(endpoint, url, timeoutMs, SESSION);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/session|not found|invalid/i.test(message)) {
      await dropSession(endpoint);
      await ensureSession(endpoint);
      return request(endpoint, url, timeoutMs, SESSION);
    }
    return request(endpoint, url, timeoutMs, null);
  }
}

export function hasFlare(): boolean {
  return Boolean(config.flaresolverrUrl);
}
