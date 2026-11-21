import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { get, run } from "./db.ts";

/**
 * Key source priority: environment variable -> the auto-generated internal_secret
 * in the settings table. Auto-generation is what makes it "work out of the box": it runs
 * without SESSION_SECRET, and a restart keeps Sessions and encrypted personal Bot Tokens working.
 */
let masterKeyCache: Buffer | null = null;

function masterKey(): Buffer {
  if (masterKeyCache) return masterKeyCache;
  let secret = config.tokenEncryptionKey || config.sessionSecret;
  if (!secret) {
    const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", "internal_secret");
    if (row?.value) {
      secret = row.value;
    } else {
      secret = randomBytes(32).toString("hex");
      run(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        "internal_secret",
        secret,
        new Date().toISOString(),
      );
    }
  }
  masterKeyCache = createHash("sha256").update(secret).digest();
  return masterKeyCache;
}

/** For tests: clear the cache when rotating the key or resetting */
export function resetCryptoCache(): void {
  masterKeyCache = null;
}

const ENC_PREFIX = "v1";

/** AES-256-GCM encryption; emits `v1.<iv>.<tag>.<cipher>` (all base64url, safe to store in a TEXT column) */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

/** Throws on decryption failure (key rotated / data tampered); callers fall back to "not configured" themselves */
export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) throw new Error("unsupported ciphertext format");
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Masked display: `123456:AA***9xyz`. The frontend only ever sees this; plaintext never leaves the server */
export function maskBotToken(token: string): string {
  const t = token.trim();
  if (!t) return "";
  if (t.length <= 10) return t.slice(0, 2) + "***";
  return t.slice(0, Math.min(8, t.length - 4)) + "***" + t.slice(-4);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

const INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Invite code: ambiguous characters such as 0/O/1/I are omitted; looks like `FR-7K9M-2P4X` */
export function generateInviteCode(prefix = "FR"): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) out += "-";
    out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

/** Fixed-length digest comparison; avoids length leaks and early returns on short plaintexts */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sign(data: string): string {
  return createHmac("sha256", masterKey()).update(data).digest("base64url");
}

/** Short-lived signed token (invite-code backfill proof, update receipt, ...), format `<payloadB64>.<sig>` */
export function signToken(payload: Record<string, unknown>, ttlSec = 600): string {
  const body = { ...payload, exp: Date.now() + ttlSec * 1000 };
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return data + "." + sign(data);
}

export function verifySignedToken<T = Record<string, unknown>>(token: string): T | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const data = token.slice(0, idx);
  const given = token.slice(idx + 1);
  if (!timingSafeEqualStr(given, sign(data))) return null;
  try {
    const body = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof body.exp !== "number" || body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}