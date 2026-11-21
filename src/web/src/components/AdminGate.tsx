import { useEffect, useState } from "react";
import { KeyRound, Loader2, Lock, ShieldCheck } from "lucide-react";
import { getToken, setToken, clearToken, verifyToken, ADMIN_AUTH_EVENT } from "../lib/auth.ts";

/**
 * Admin login gate: blocks #/admin/* routes.
 * Passes through when the server has no ADMIN_TOKEN set (protectedMode=false).
 */
export function AdminGate({
  protectedMode,
  entryAllowed = true,
  onAuthChange,
  children,
}: {
  protectedMode: boolean;
  entryAllowed?: boolean;
  onAuthChange?: (authed: boolean) => void;
  children: React.ReactNode;
}) {
  const [authed, setAuthed] = useState(false);
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  // When server protection is off, the gate does nothing
  useEffect(() => {
    let alive = true;
    if (!entryAllowed) setAuthed(false);
    else if (!protectedMode) setAuthed(true);
    else if (getToken()) {
      setChecking(true);
      void verifyToken(getToken()).then((ok) => {
        if (alive) { setAuthed(ok); onAuthChange?.(ok); }
      }).catch(() => { if (alive) setError("Could not verify admin credentials, please retry"); })
        .finally(() => { if (alive) setChecking(false); });
    }
    return () => { alive = false; };
  }, [protectedMode, onAuthChange, entryAllowed]);

  useEffect(() => {
    const expire = () => { setAuthed(false); setError("Admin credentials expired, please log in again"); onAuthChange?.(false); };
    window.addEventListener(ADMIN_AUTH_EVENT, expire);
    return () => window.removeEventListener(ADMIN_AUTH_EVENT, expire);
  }, [onAuthChange]);

  if (!entryAllowed) {
    return <div role="alert" className="panel mx-auto max-w-sm p-6 text-[13px] leading-relaxed text-ink-600">Admin login is not open on this domain. Use the dedicated admin entry configured by the site owner. Regular login and personal push are unaffected.</div>;
  }
  if (!protectedMode || authed) {
    return (
      <div className="space-y-3">
        {protectedMode && (
          <div className="panel flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-600">
              <ShieldCheck size={13} className="text-deal" /> Signed in to admin
            </span>
            <button
              type="button"
              onClick={() => {
                clearToken();
                setAuthed(false);
                onAuthChange?.(false);
                setInput("");
              }}
              className="text-[12px] font-medium text-accent hover:underline"
            >
              Sign out
            </button>
          </div>
        )}
        {children}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm">
      <div className="panel space-y-4 p-6">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-subtle text-accent">
            <Lock size={17} />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold text-ink-900">Admin area requires a password</h2>
            <p className="text-[11.5px] text-ink-500">The ADMIN_TOKEN set in .env</p>
          </div>
        </div>

        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const v = input.trim();
            if (!v) return;
            setChecking(true);
            setError("");
            try {
              if (await verifyToken(v)) {
                setToken(v);
                setAuthed(true);
                onAuthChange?.(true);
              } else {
                setError("Incorrect password");
              }
            } catch {
              setError("Cannot reach the server");
            } finally {
              setChecking(false);
            }
          }}
        >
          <div className="relative">
            <KeyRound size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Admin password"
              autoFocus
              className="w-full rounded-lg border border-ink-200 bg-surface py-2 pl-8 pr-2.5 text-[13px] text-ink-900 outline-none focus:border-brand"
            />
          </div>
          {error && <p className="text-[11.5px] text-alert">{error}</p>}
          <button
            type="submit"
            disabled={checking || !input.trim()}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-[13px] font-medium text-white hover:bg-brand-hover disabled:opacity-60"
          >
            {checking ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Enter admin area
          </button>
        </form>

        <p className="text-[11.5px] leading-relaxed text-ink-500">
          Credentials are kept only in this tab and are not saved after it closes. The feed and daily picks do not need an admin password.
        </p>
      </div>
    </div>
  );
}
