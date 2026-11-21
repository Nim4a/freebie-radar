import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { all, get, run } from "./db.ts";
import {
  adminLocked,
  config,
  devMockEnabled,
  isPublicSite,
  linuxdoConfigured,
  githubConfigured,
  siteMode,
} from "./config.ts";
import { createHttp } from "./http.ts";
import { randomToken, signToken, timingSafeEqualStr, verifySignedToken } from "./crypto.ts";
import { adminHostAllowed } from "./security.ts";
import {
  admissionBlocked,
  findUserByLinuxdoId,
  getAccessControl,
  getOnboarding,
  redeemInviteCode,
  type AccessControl,
} from "./access.ts";

export const SESSION_COOKIE = "radar_session";
const STATE_COOKIE = "radar_oauth_state";
const PENDING_COOKIE = "radar_pending_reg";
const SESSION_TTL_MS = 30 * 86_400_000;

export type AuthUser = {
  id: number;
  linuxdoId: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  trustLevel: number;
  rssToken: string;
  disabled: boolean;
};

type UserRow = {
  id: number;
  linuxdo_id: number;
  username: string;
  name: string | null;
  avatar_url: string | null;
  trust_level: number;
  disabled: number;
  rss_token: string;
  invited_by_id?: number | null;
};

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    linuxdoId: row.linuxdo_id,
    username: row.username,
    name: row.name,
    avatarUrl: row.avatar_url,
    trustLevel: row.trust_level,
    rssToken: row.rss_token,
    disabled: row.disabled === 1,
  };
}

export type Identity = {
  siteMode: "selfhost" | "public";
  user: AuthUser | null;
  /** Admin rights are gated by ADMIN_TOKEN only, fully orthogonal to the OAuth identity */
  isAdmin: boolean;
  /** Whether the admin area is locked out for lack of a usable password */
  adminLocked: boolean;
  access: AccessControl;
  /** When login is closed and "pause personal side too" is checked, all personal write endpoints are rejected */
  personalSuspended: boolean;
};

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? "";
  if (proto.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function createSession(c: Context, userId: number): void {
  const id = randomToken(32);
  const now = new Date();
  run(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    id,
    userId,
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    now.toISOString(),
  );
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecureRequest(c),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function destroySession(c: Context): void {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) run("DELETE FROM sessions WHERE id = ?", id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function userFromSession(c: Context): AuthUser | null {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;
  const row = get<UserRow & { expires_at: string }>(
    `SELECT u.id, u.linuxdo_id, u.username, u.name, u.avatar_url, u.trust_level, u.disabled, u.rss_token, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    sid,
  );
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    run("DELETE FROM sessions WHERE id = ?", sid);
    return null;
  }
  if (row.disabled === 1) return null;
  return toAuthUser(row);
}

/**
 * Resolve the request identity. Admin-rights decision order:
 *   1. public site with no ADMIN_TOKEN configured → never admin (admin area locked)
 *   2. selfhost with no ADMIN_TOKEN configured → treated as admin (backward compatible with old deployments)
 *   3. Bearer equals the fixed-length digest of ADMIN_TOKEN → admin
 * Never escalate to admin merely because the user "logged in with LINUX DO".
 */
export function resolveIdentity(c: Context): Identity {
  const access = getAccessControl();
  const user = userFromSession(c);
  const token = config.adminToken;
  let isAdmin = false;
  if (!token) {
    isAdmin = !adminLocked && adminHostAllowed(c);
  } else {
    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    isAdmin = adminHostAllowed(c) && Boolean(given) && timingSafeEqualStr(given, token);
  }
  return {
    siteMode,
    user,
    isAdmin,
    adminLocked,
    access,
    personalSuspended: !access.loginEnabled && access.suspendUserSessionsOnClose,
  };
}

/** Used by routes to read the identity (a middleware already resolved it; this just reads the context variable) */
export function identityOf(c: Context): Identity {
  const cached = c.get("identity" as never) as Identity | undefined;
  return cached ?? resolveIdentity(c);
}

/* ------------------------------------------------------------------ *
 * LINUX DO Connect OAuth2
 * ------------------------------------------------------------------ */

type LinuxdoProfile = {
  id: number;
  username: string;
  name: string | null;
  avatar_url: string | null;
  trust_level: number;
  active: boolean;
  silenced: boolean;
};

/** avatar_template is a relative path like `/user_avatar/linux.do/x/{size}.png`; expand it to an absolute URL */
function absolutizeAvatar(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return v.replace("{size}", "120");
  if (v.startsWith("/")) return ("https://linux.do" + v).replace("{size}", "120");
  return null;
}

function normalizeProfile(data: unknown): LinuxdoProfile | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const idRaw = o.id ?? o.user_id;
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return null;
  const username = typeof o.username === "string" && o.username.trim() ? o.username.trim() : `user${id}`;
  return {
    id,
    username,
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    avatar_url: absolutizeAvatar(o.avatar_url) ?? absolutizeAvatar(o.avatar_template),
    trust_level: Number.isFinite(Number(o.trust_level)) ? Math.max(0, Math.min(4, Number(o.trust_level))) : 0,
    active: o.active !== false,
    silenced: o.silenced === true,
  };
}

function oauthHttp(proxy?: string) {
  return createHttp({
    // Prefer the OAuth-only proxy so logging in does not route all site-wide collection through the proxy
    proxy: proxy || config.linuxdoProxy || config.httpsProxy || config.httpProxy || undefined,
    gapMs: 0,
    timeoutMs: 15_000,
  });
}

function redirectUri(c: Context): string {
  if (config.linuxdoRedirectUri) return config.linuxdoRedirectUri;
  const base = config.publicBaseUrl || new URL(c.req.url).origin;
  return base.replace(/\/+$/, "") + "/api/auth/linuxdo/callback";
}

function githubRedirectUri(c: Context): string {
  if (config.githubRedirectUri) return config.githubRedirectUri;
  const base = config.publicBaseUrl || new URL(c.req.url).origin;
  return base.replace(/\/+$/, "") + "/api/auth/github/callback";
}

async function exchangeCode(code: string, redirect: string): Promise<string> {
  const http = oauthHttp();
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: config.linuxdoClientId,
    client_secret: config.linuxdoClientSecret,
  });
  const basic = Buffer.from(`${config.linuxdoClientId}:${config.linuxdoClientSecret}`).toString("base64");
  const res = await http.json<{ access_token?: string; error?: string; error_description?: string }>(config.linuxdoTokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: "Basic " + basic,
    },
    body: form.toString(),
  });
  if (res.status !== 200 || !res.data?.access_token) {
    throw new Error(`failed to exchange access_token: ${res.data?.error_description ?? res.data?.error ?? res.status}`);
  }
  return res.data.access_token;
}

async function fetchProfile(accessToken: string): Promise<LinuxdoProfile> {
  const http = oauthHttp();
  const res = await http.json<unknown>(config.linuxdoUserUrl, {
    headers: { authorization: "Bearer " + accessToken, accept: "application/json" },
  });
  if (res.status !== 200) throw new Error("failed to read LINUX DO user info: " + res.status);
  const profile = normalizeProfile(res.data);
  if (!profile) throw new Error("unrecognizable user info returned by LINUX DO");
  return profile;
}

function upsertUser(profile: LinuxdoProfile, invitedById: number | null): UserRow {
  const now = new Date().toISOString();
  const existing = findUserByLinuxdoId(profile.id);
  if (existing) {
    run(
      "UPDATE users SET username = ?, name = ?, avatar_url = ?, trust_level = ?, last_login_at = ? WHERE id = ?",
      profile.username,
      profile.name,
      profile.avatar_url,
      profile.trust_level,
      now,
      existing.id,
    );
    return { ...existing, ...profile, avatar_url: profile.avatar_url, last_login_at: now } as unknown as UserRow;
  }
  run(
    `INSERT INTO users (linuxdo_id, username, name, avatar_url, trust_level, disabled, rss_token, invited_by_id, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    profile.id,
    profile.username,
    profile.name,
    profile.avatar_url,
    profile.trust_level,
    randomToken(24),
    invitedById,
    now,
    now,
  );
  const row = findUserByLinuxdoId(profile.id);
  if (!row) throw new Error("failed to create user");
  return row;
}

/** New-user admission check: returns null to allow, otherwise the error anchor to redirect to */
function rejectReason(profile: LinuxdoProfile, access: AccessControl): string | null {
  if (!profile.active) return "inactive";
  if (profile.silenced) return "silenced";
  if (profile.trust_level < access.minTrustLevel) return "trust";
  return null;
}

function frontendRedirect(c: Context, hash: string) {
  return c.redirect("/#" + hash.replace(/^#/, ""));
}

export function registerAuthRoutes(app: Hono): void {
  /** Fetched once by the front end at startup: site mode, login toggle, announcement, current identity */
  app.get("/api/site/bootstrap", (c) => {
    const id = resolveIdentity(c);
    return c.json({
      siteMode: id.siteMode,
      loginEnabled: id.access.loginEnabled,
      registrationMode: id.access.registrationMode,
      suspendUserSessionsOnClose: id.access.suspendUserSessionsOnClose,
      minTrustLevel: id.access.minTrustLevel,
      oauthConfigured: linuxdoConfigured,
      githubConfigured,
      devMockEnabled,
      adminConfigured: Boolean(config.adminToken),
      adminLocked: id.adminLocked,
      isAdmin: id.isAdmin,
      user: id.user,
      onboarding: getOnboarding(),
      features: { rss: true, userPush: true, personalRegex: false },
    });
  });

  app.get("/api/auth/me", (c) => {
    const id = resolveIdentity(c);
    return c.json({ user: id.user, isAdmin: id.isAdmin, siteMode: id.siteMode });
  });

/**
 * Shared tail of the login admission flow: account creation, invite code, quota and ban for both
 * OAuth channels (LINUX DO / GitHub) all happen here; only the way the profile is obtained differs, so the two paths cannot slowly drift apart.
 */
function finishLogin(c: Context, profile: LinuxdoProfile, invite: string): Response {
  const access = getAccessControl();
  const existing = findUserByLinuxdoId(profile.id);
  if (existing) {
    if (existing.disabled === 1) return frontendRedirect(c, "login-banned");
    upsertUser(profile, existing.invited_by_id ?? null);
    createSession(c, existing.id);
    return frontendRedirect(c, "home");
  }

  if (access.registrationMode === "closed") return frontendRedirect(c, "register-closed");
  // Quota cap: when full only new signups are blocked; existing users were already allowed above
  if (admissionBlocked()) return frontendRedirect(c, "quota-full");

  if (access.registrationMode === "open") {
    const row = upsertUser(profile, null);
    createSession(c, row.id);
    return frontendRedirect(c, "home");
  }

  // invite mode: with a code, create the account and redeem immediately; without one, issue a 10-minute "code pending" token
  if (invite) {
    const row = upsertUser(profile, null);
    const redeemed = redeemInviteCode(invite, row.id);
    if (!redeemed.ok) {
      run("DELETE FROM users WHERE id = ?", row.id);
      return frontendRedirect(c, "invite-invalid");
    }
    createSession(c, row.id);
    return frontendRedirect(c, "home");
  }

  setCookie(c, PENDING_COOKIE, signToken({ profile }, 600), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecureRequest(c),
    maxAge: 600,
  });
  return frontendRedirect(c, "invite-required");
}
  app.get("/api/auth/linuxdo/login", (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    if (!linuxdoConfigured) return frontendRedirect(c, "login-unconfigured");
    const invite = (c.req.query("invite") ?? "").trim().toUpperCase().slice(0, 32);
    const state = randomToken(16);
    // Sign the state together with the prefilled invite code into a short-lived cookie, verified on callback, to block CSRF and invite-code tampering
    setCookie(c, STATE_COOKIE, signToken({ state, invite }, 300), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: isSecureRequest(c),
      maxAge: 300,
    });
    const url = new URL(config.linuxdoAuthorizeUrl);
    url.searchParams.set("client_id", config.linuxdoClientId);
    url.searchParams.set("redirect_uri", redirectUri(c));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read");
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/api/auth/linuxdo/callback", async (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const rawState = getCookie(c, STATE_COOKIE) ?? "";
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const statePayload = rawState ? verifySignedToken<{ state: string; invite: string }>(rawState) : null;
    if (!code) return frontendRedirect(c, "login-failed");
    if (!statePayload || statePayload.state !== state) return frontendRedirect(c, "login-state-mismatch");

    try {
      const accessToken = await exchangeCode(code, redirectUri(c));
      const profile = await fetchProfile(accessToken);
      const blocked = rejectReason(profile, access);
      if (blocked) return frontendRedirect(c, "login-" + blocked);

      const existing = findUserByLinuxdoId(profile.id);
      return finishLogin(c, profile, statePayload.invite);
    } catch (err) {
      console.error("[auth] OAuth callback failed:", err instanceof Error ? err.message : err);
      return frontendRedirect(c, "login-failed");
    }
  });


  /** GitHub login: shares the admission chain with LINUX DO; only the way the profile is fetched differs */
  app.get("/api/auth/github/login", (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    if (!githubConfigured) return frontendRedirect(c, "login-unconfigured");
    const invite = (c.req.query("invite") ?? "").trim().toUpperCase().slice(0, 32);
    const state = randomToken(16);
    setCookie(c, STATE_COOKIE, signToken({ state, invite }, 300), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: isSecureRequest(c),
      maxAge: 300,
    });
    const url = new URL(config.githubAuthorizeUrl);
    url.searchParams.set("client_id", config.githubClientId);
    url.searchParams.set("redirect_uri", githubRedirectUri(c));
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/api/auth/github/callback", async (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const rawState = getCookie(c, STATE_COOKIE) ?? "";
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const statePayload = rawState ? verifySignedToken<{ state: string; invite: string }>(rawState) : null;
    if (!code) return frontendRedirect(c, "login-failed");
    if (!statePayload || statePayload.state !== state) return frontendRedirect(c, "login-state-mismatch");

    try {
      const http = oauthHttp(config.githubProxy);
      const tokenJson = await http.json<{ access_token?: string; error_description?: string }>(config.githubTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          code,
          redirect_uri: githubRedirectUri(c),
        }).toString(),
      });
      const tokenData = tokenJson.data;
      const accessToken = tokenData.access_token ?? "";
      if (!accessToken) throw new Error(tokenData.error_description ?? "GitHub did not return access_token");

      const userRes = await http.json<{ id?: number; login?: string; name?: string | null; avatar_url?: string | null }>(config.githubUserUrl, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "freebie-radar" },
      });
      const gh = userRes.data;
      if (!gh.id) throw new Error("GitHub user info is missing id");

      // Store the GitHub id negated as a namespace so it never collides with a LINUX DO id (the two id spaces are unrelated)
      const profile: LinuxdoProfile = {
        id: -Math.abs(gh.id),
        username: gh.login ?? `gh_${gh.id}`,
        name: gh.name ?? gh.login ?? null,
        avatar_url: gh.avatar_url ?? null,
        trust_level: 0,
        active: true,
        silenced: false,
      };
      return finishLogin(c, profile, statePayload.invite);
    } catch (err) {
      console.error("[auth] GitHub callback failed:", err instanceof Error ? err.message : err);
      return frontendRedirect(c, "login-failed");
    }
  });
  /** A code-pending user submits an invite code: create the account only after a successful redemption, so a failure does not leave an empty user */
  app.post("/api/auth/redeem-invite", async (c) => {
    const raw = getCookie(c, PENDING_COOKIE) ?? "";
    const pending = raw ? verifySignedToken<{ profile: LinuxdoProfile }>(raw) : null;
    if (!pending?.profile) return c.json({ error: "Registration token expired, please log in with LINUX DO again", expired: true }, 400);
    const body = (await c.req.json().catch(() => null)) as { code?: string } | null;
    const code = (body?.code ?? "").trim();
    if (!code) return c.json({ error: "Enter an invite code" }, 400);

    const access = getAccessControl();
    if (!access.loginEnabled) return c.json({ error: "Login is currently closed on this site" }, 403);
    if (access.registrationMode === "closed") return c.json({ error: "New signups are currently closed on this site" }, 403);
    const blocked = admissionBlocked();
    if (blocked) return c.json({ error: blocked }, 403);

    const existing = findUserByLinuxdoId(pending.profile.id);
    if (existing) {
      // Duplicate submission: already created, just log in so the user is not stuck on the code page
      createSession(c, existing.id);
      deleteCookie(c, PENDING_COOKIE, { path: "/" });
      return c.json({ ok: true, user: toAuthUser(existing) });
    }

    const row = upsertUser(pending.profile, null);
    const redeemed = redeemInviteCode(code, row.id);
    if (!redeemed.ok) {
      run("DELETE FROM users WHERE id = ?", row.id);
      return c.json({ error: redeemed.error }, 400);
    }
    createSession(c, row.id);
    deleteCookie(c, PENDING_COOKIE, { path: "/" });
    return c.json({ ok: true, user: toAuthUser(row) });
  });

  app.post("/api/auth/logout", (c) => {
    destroySession(c);
    return c.json({ ok: true });
  });

  /** Local mock login: available only off-production and when explicitly enabled, to verify multi-account isolation and dual-Bot push */
  app.post("/api/auth/dev-login", async (c) => {
    if (!devMockEnabled || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname)) return c.json({ error: "local mock login is not enabled" }, 403);
    const access = getAccessControl();
    if (!access.loginEnabled) return c.json({ error: "Login is currently closed on this site" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { preset?: string; trustLevel?: number; invite?: string };
    const preset = body.preset === "bob" ? "bob" : "alice";
    const linuxdoId = preset === "bob" ? 900002 : 900001;
    const username = preset === "bob" ? "bob_ld" : "alice_ld";
    const profile: LinuxdoProfile = {
      id: linuxdoId,
      username,
      name: preset === "bob" ? "Test account B" : "Test account A",
      avatar_url: null,
      trust_level: Number.isFinite(Number(body.trustLevel)) ? Number(body.trustLevel) : 3,
      active: true,
      silenced: false,
    };
    const existing = findUserByLinuxdoId(linuxdoId);
    if (existing) {
      if (existing.disabled === 1) return c.json({ error: "This test account has been disabled" }, 403);
      upsertUser(profile, existing.invited_by_id ?? null);
      createSession(c, existing.id);
      return c.json({ ok: true, user: toAuthUser(existing) });
    }
    if (access.registrationMode === "closed") return c.json({ error: "New signups are currently closed on this site" }, 403);
    const blocked = admissionBlocked();
    if (blocked) return c.json({ error: blocked }, 403);
    // In invite-code mode, local mock login also goes through real admission: with a code, redeem it; without one, issue a "code pending" token
    if (access.registrationMode === "invite") {
      const invite = (body.invite ?? "").trim();
      if (!invite) {
        setCookie(c, PENDING_COOKIE, signToken({ profile }, 600), {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          secure: isSecureRequest(c),
          maxAge: 600,
        });
        return c.json({ ok: false, needInvite: true, message: "This site requires an invite code; enter one to finish signing up" });
      }
      const row = upsertUser(profile, null);
      const redeemed = redeemInviteCode(invite, row.id);
      if (!redeemed.ok) {
        run("DELETE FROM users WHERE id = ?", row.id);
        return c.json({ ok: false, needInvite: true, error: redeemed.error });
      }
      createSession(c, row.id);
      return c.json({ ok: true, user: toAuthUser(row) });
    }
    const row = upsertUser(profile, null);
    createSession(c, row.id);
    return c.json({ ok: true, user: toAuthUser(row) });
  });

  /** Reset the personal RSS token */
  app.post("/api/me/rss-token/reset", (c) => {
    const id = identityOf(c);
    if (!id.user) return c.json({ error: "Login required" }, 401);
    if (id.personalSuspended) return c.json({ error: "Personal features are suspended on this site" }, 403);
    const token = randomToken(24);
    run("UPDATE users SET rss_token = ? WHERE id = ?", token, id.user.id);
    return c.json({ ok: true, rssToken: token });
  });
}

/** Look up a user by rss_token (for RSS, not via cookie) */
export function userByRssToken(token: string): AuthUser | null {
  if (!token || token.length < 8) return null;
  const row = get<UserRow>("SELECT * FROM users WHERE rss_token = ?", token);
  if (!row || row.disabled === 1) return null;
  return toAuthUser(row);
}

export function sessionCount(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", new Date().toISOString())?.n ?? 0;
}

export function purgeExpiredSessions(): number {
  const res = run("DELETE FROM sessions WHERE expires_at <= ?", new Date().toISOString());
  return Number(res.changes);
}

/** Batch-read personal state: the list endpoint reads it all in one query to avoid N+1 per row */
export function loadUserStates(
  userId: number,
  itemIds: readonly number[],
): Map<number, { hidden: boolean; starred: boolean; read: boolean }> {
  const out = new Map<number, { hidden: boolean; starred: boolean; read: boolean }>();
  if (!userId || !itemIds.length) return out;
  const ph = itemIds.map(() => "?").join(",");
  const rows = all<{ item_id: number; hidden: number; starred: number; read_at: string | null }>(
    `SELECT item_id, hidden, starred, read_at FROM user_item_states WHERE user_id = ? AND item_id IN (${ph})`,
    userId,
    ...itemIds,
  );
  for (const r of rows) {
    out.set(r.item_id, { hidden: r.hidden === 1, starred: r.starred === 1, read: Boolean(r.read_at) });
  }
  return out;
}
