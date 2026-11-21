import { all, get, run, txImmediate } from "./db.ts";
import { config, isPublicSite } from "./config.ts";
import { generateInviteCode } from "./crypto.ts";

/* ------------------------------------------------------------------ *
 * Operational config: login/registration toggles, landing announcement.
 * All stored in the settings table, hot-editable from admin, no restart needed.
 * ------------------------------------------------------------------ */

const ACCESS_KEY = "access_control";
const ONBOARDING_KEY = "onboarding";

export type RegistrationMode = "open" | "invite" | "closed";

export type AccessControl = {
  /** Master switch for the web login entry; turning it off only affects "new logins", existing users are unaffected by default */
  loginEnabled: boolean;
  /** Whether closing login also suspends the personal side of already-logged-in users (maintenance mode) */
  suspendUserSessionsOnClose: boolean;
  /** Registration mode: open / invite code / stop new signups (existing users can always log in) */
  registrationMode: RegistrationMode;
  /** Minimum LINUX DO trust level */
  minTrustLevel: number;
  /** Total account cap (0 = unlimited); when full, existing users still log in, only new signups are blocked */
  maxUsers: number;
};

export type Onboarding = {
  enabled: boolean;
  title: string;
  content: string;
  /** Feature onboarding cards (guest isolation / login and personal Bot / public RSS) */
  showGuideCards: boolean;
  /** Version number: incremented when the admin clicks "show again"; the front end uses it to decide whether to show the dialog */
  version: number;
};

const DEFAULT_ONBOARDING_CONTENT = [
  "Resource Radar aggregates info from communities, game platforms, free-software sites, GitHub, Reddit, Bluesky, Telegram and custom RSS,",
  "first through rule-based prefiltering and a shared blocklist, then AI semantic grading, and finally pushed to Telegram by your rules.",
  "",
  "· Browse all public content without logging in; \"hide / star / read\" state lives only in your own browser and never affects others.",
  "· Log in with LINUX DO to sync preferences across devices and bind your own Telegram Bot for pushes by your personal rules.",
  "· Every resource carries its original link; verify redemption codes and deadlines yourself. This site only aggregates and filters and is not responsible for the validity of third-party campaigns.",
].join("\n");

function numOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function defaultAccessControl(): AccessControl {
  return {
    loginEnabled: isPublicSite,
    suspendUserSessionsOnClose: false,
    // The public site defaults to invite-code registration as a safer choice: AI review plus personal Bot push both consume server resources,
    // so an operator who wants it wide open can switch to open in one click.
    registrationMode: isPublicSite ? "invite" : "closed",
    minTrustLevel: config.linuxdoMinTrustLevel,
    maxUsers: 0,
  };
}

export function getAccessControl(): AccessControl {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", ACCESS_KEY);
  const base = defaultAccessControl();
  if (!row) return base;
  try {
    const raw = JSON.parse(row.value) as Partial<AccessControl>;
    return {
      loginEnabled: typeof raw.loginEnabled === "boolean" ? raw.loginEnabled : base.loginEnabled,
      suspendUserSessionsOnClose:
        typeof raw.suspendUserSessionsOnClose === "boolean" ? raw.suspendUserSessionsOnClose : base.suspendUserSessionsOnClose,
      registrationMode:
        raw.registrationMode === "open" || raw.registrationMode === "invite" || raw.registrationMode === "closed"
          ? raw.registrationMode
          : base.registrationMode,
      minTrustLevel: numOr(raw.minTrustLevel, base.minTrustLevel, 0, 4),
      maxUsers: numOr(raw.maxUsers, base.maxUsers, 0, 100000),
    };
  } catch {
    return base;
  }
}

export function saveAccessControl(patch: Partial<AccessControl>): AccessControl {
  const cur = getAccessControl();
  const next: AccessControl = {
    loginEnabled: typeof patch.loginEnabled === "boolean" ? patch.loginEnabled : cur.loginEnabled,
    suspendUserSessionsOnClose:
      typeof patch.suspendUserSessionsOnClose === "boolean" ? patch.suspendUserSessionsOnClose : cur.suspendUserSessionsOnClose,
    registrationMode:
      patch.registrationMode === "open" || patch.registrationMode === "invite" || patch.registrationMode === "closed"
        ? patch.registrationMode
        : cur.registrationMode,
    minTrustLevel: numOr(patch.minTrustLevel, cur.minTrustLevel, 0, 4),
    maxUsers: numOr(patch.maxUsers, cur.maxUsers, 0, 100000),
  };
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ACCESS_KEY,
    JSON.stringify(next),
    new Date().toISOString(),
  );
  return next;
}

/** Quota check: maxUsers=0 means unlimited; when full only new signups are blocked, existing users still log in */
export function userQuota(): { used: number; max: number; full: boolean } {
  const max = getAccessControl().maxUsers;
  const used = get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
  return { used, max, full: max > 0 && used >= max };
}

/** Single gate before admitting a new user; returning null means allow */
export function admissionBlocked(): string | null {
  const q = userQuota();
  if (q.full) return `Site is full (${q.used}/${q.max}); new signups are temporarily closed`;
  return null;
}
export function getOnboarding(): Onboarding {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", ONBOARDING_KEY);
  const base: Onboarding = {
    enabled: true,
    title: "Welcome to Resource Radar",
    content: DEFAULT_ONBOARDING_CONTENT,
    showGuideCards: true,
    version: 1,
  };
  if (!row) return base;
  try {
    const raw = JSON.parse(row.value) as Partial<Onboarding>;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 60) : base.title,
      content: typeof raw.content === "string" ? raw.content.slice(0, 4000) : base.content,
      showGuideCards: typeof raw.showGuideCards === "boolean" ? raw.showGuideCards : base.showGuideCards,
      version: numOr(raw.version, base.version, 1, Number.MAX_SAFE_INTEGER),
    };
  } catch {
    return base;
  }
}

/** With bumpVersion=true the version is incremented so every visitor sees the dialog again on their next visit */
export function saveOnboarding(patch: Partial<Onboarding> & { bumpVersion?: boolean }): Onboarding {
  const cur = getOnboarding();
  const next: Onboarding = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim().slice(0, 60) : cur.title,
    content: typeof patch.content === "string" ? patch.content.slice(0, 4000) : cur.content,
    showGuideCards: typeof patch.showGuideCards === "boolean" ? patch.showGuideCards : cur.showGuideCards,
    version: patch.bumpVersion ? cur.version + 1 : cur.version,
  };
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ONBOARDING_KEY,
    JSON.stringify(next),
    new Date().toISOString(),
  );
  return next;
}

/* ------------------------------------------------------------------ *
 * Invite codes
 * ------------------------------------------------------------------ */

export type InviteCode = {
  id: number;
  code: string;
  max_uses: number;
  used_count: number;
  disabled: number;
  note: string | null;
  expires_at: string | null;
  created_at: string;
};

export type InviteRedemptionRow = { code: string; username: string; redeemed_at: string };

export function listInviteCodes(): { codes: InviteCode[]; redemptions: InviteRedemptionRow[] } {
  const codes = all<InviteCode>(
    "SELECT id, code, max_uses, used_count, disabled, note, expires_at, created_at FROM invite_codes ORDER BY id DESC",
  );
  const redemptions = all<InviteRedemptionRow>(
    `SELECT c.code AS code, u.username AS username, r.redeemed_at AS redeemed_at
       FROM invite_redemptions r
       JOIN invite_codes c ON c.id = r.invite_id
       JOIN users u ON u.id = r.user_id
      ORDER BY r.id DESC LIMIT 200`,
  );
  return { codes, redemptions };
}

export function createInviteCodes(opts: {
  count: number;
  maxUses: number;
  note?: string;
  expiresDays?: number;
  customCode?: string;
}): InviteCode[] {
  const count = Math.min(Math.max(Math.round(opts.count) || 1, 1), 50);
  const maxUses = Math.min(Math.max(Math.round(opts.maxUses) || 1, 1), 10000);
  const note = (opts.note ?? "").trim().slice(0, 120) || null;
  const expiresAt =
    opts.expiresDays && opts.expiresDays > 0
      ? new Date(Date.now() + Math.min(opts.expiresDays, 3650) * 86_400_000).toISOString()
      : null;
  const now = new Date().toISOString();
  const created: InviteCode[] = [];
  for (let i = 0; i < count; i += 1) {
    const custom = i === 0 ? (opts.customCode ?? "").trim().toUpperCase() : "";
    const code = custom || generateInviteCode();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) continue;
    const exists = get<{ id: number }>("SELECT id FROM invite_codes WHERE code = ?", code);
    if (exists) continue;
    const res = run(
      "INSERT INTO invite_codes (code, max_uses, used_count, disabled, note, expires_at, created_at) VALUES (?, ?, 0, 0, ?, ?, ?)",
      code,
      maxUses,
      note,
      expiresAt,
      now,
    );
    const id = Number(res.lastInsertRowid);
    created.push({ id, code, max_uses: maxUses, used_count: 0, disabled: 0, note, expires_at: expiresAt, created_at: now });
  }
  return created;
}

export function toggleInviteCode(id: number, disabled: boolean): boolean {
  const res = run("UPDATE invite_codes SET disabled = ? WHERE id = ?", disabled ? 1 : 0, id);
  return Number(res.changes) > 0;
}

export function deleteInviteCode(id: number): boolean {
  const res = run("DELETE FROM invite_codes WHERE id = ?", id);
  return Number(res.changes) > 0;
}

export type RedeemResult =
  | { ok: true; inviteId: number; maxUses: number; usedCount: number }
  | { ok: false; error: string };

/**
 * Atomic redemption: BEGIN IMMEDIATE takes the write lock → validate → used_count+1 → record redeemer.
 * All conditions live in the UPDATE's WHERE and success is judged by changes===1, preventing concurrent over-issue.
 */
export function redeemInviteCode(code: string, userId: number): RedeemResult {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { ok: false, error: "Enter an invite code" };
  return txImmediate<RedeemResult>(() => {
    const row = get<InviteCode>(
      "SELECT id, code, max_uses, used_count, disabled, note, expires_at, created_at FROM invite_codes WHERE code = ?",
      normalized,
    );
    if (!row) return { ok: false, error: "Invite code not found" };
    if (row.disabled === 1) return { ok: false, error: "This invite code has been disabled" };
    if (row.expires_at && row.expires_at <= new Date().toISOString()) return { ok: false, error: "This invite code has expired" };
    if (row.used_count >= row.max_uses) return { ok: false, error: "This invite code has been used up" };
    const res = run(
      `UPDATE invite_codes SET used_count = used_count + 1
        WHERE id = ? AND disabled = 0 AND used_count < max_uses
          AND (expires_at IS NULL OR expires_at > ?)`,
      row.id,
      new Date().toISOString(),
    );
    if (Number(res.changes) !== 1) return { ok: false, error: "This invite code was just used up, pick another" };
    run(
      "INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at) VALUES (?, ?, ?) ON CONFLICT(invite_id, user_id) DO NOTHING",
      row.id,
      userId,
      new Date().toISOString(),
    );
    return { ok: true, inviteId: row.id, maxUses: row.max_uses, usedCount: row.used_count + 1 };
  });
}

/** Whether this LINUX DO account is already waiting to supply an invite code (do not recreate the account on re-entry) */
export function findUserByLinuxdoId(linuxdoId: number) {
  return get<{
    id: number;
    linuxdo_id: number;
    username: string;
    name: string | null;
    avatar_url: string | null;
    trust_level: number;
    disabled: number;
    rss_token: string;
    invited_by_id: number | null;
    created_at: string;
    last_login_at: string;
  }>("SELECT * FROM users WHERE linuxdo_id = ?", linuxdoId);
}

export type AdminUserRow = {
  id: number;
  linuxdo_id: number;
  username: string;
  name: string | null;
  avatar_url: string | null;
  trust_level: number;
  disabled: number;
  created_at: string;
  last_login_at: string;
  hidden: number;
  starred: number;
  push_enabled: number;
};

export function listUsers(limit = 200): AdminUserRow[] {
  return all<AdminUserRow>(
    `SELECT u.id, u.linuxdo_id, u.username, u.name, u.avatar_url, u.trust_level, u.disabled,
            u.created_at, u.last_login_at,
            COALESCE(s.hidden, 0) AS hidden,
            COALESCE(s.starred, 0) AS starred,
            COALESCE(p.enabled, 0) AS push_enabled
       FROM users u
       LEFT JOIN (
         SELECT user_id, SUM(hidden) AS hidden, SUM(starred) AS starred
           FROM user_item_states GROUP BY user_id
       ) s ON s.user_id = u.id
       LEFT JOIN user_push_configs p ON p.user_id = u.id
      ORDER BY u.id DESC LIMIT ?`,
    Math.min(Math.max(limit, 1), 500),
  );
}

export function setUserDisabled(id: number, disabled: boolean): boolean {
  const res = run("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, id);
  if (disabled) run("DELETE FROM sessions WHERE user_id = ?", id);
  return Number(res.changes) > 0;
}

export function countUsers(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
}