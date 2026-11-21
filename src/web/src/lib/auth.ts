/**
 * Admin credentials: stored only in sessionStorage, gone when the tab closes.
 * A global fetch wrapper attaches Authorization so no call site has to change.
 */
const KEY = "radar-admin-token";

export function getToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* Unavailable in private mode; degrade to not saving */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Same as above */
  }
}

let installed = false;
export const ADMIN_AUTH_EVENT = "radar-admin-auth-change";

/** Call once in main.tsx: every fetch automatically carries the admin password. */
export function installAuthFetch(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = getToken();
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (!token || url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return orig(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return orig(input, { ...init, headers }).then((response) => {
      if (response.status === 401 && headers.get("authorization") === `Bearer ${token}`) {
        // Personal-session expiry must not log the administrator out.
        if (!url.pathname.startsWith("/api/me/")) {
          clearToken();
          window.dispatchEvent(new Event(ADMIN_AUTH_EVENT));
        }
      }
      return response;
    });
  }) as typeof fetch;
}

/** Verify the password: returns true on a match. */
export async function verifyToken(token: string): Promise<boolean> {
  const r = await fetch("/api/auth/check", { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  return Boolean(((await r.json()) as { isAdmin?: boolean }).isAdmin);
}
