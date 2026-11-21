import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlignJustify,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  EyeOff,
  Lock,
  LayoutGrid,
  Loader2,
  Radar,
  RefreshCw,
  Search,
  ShieldBan,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  FolderOpen,
  Wrench,
  X,
  Zap,
  Code,
  CheckCheck,
  Flame,
  Newspaper,
  TrendingUp,
  MapPin,
  User,
  Globe2,
  Github,
  BookOpen,
  LogOut,
} from "lucide-react";
import { CompactRow, ItemCard, ItemDetailDrawer, QuickBlockModal } from "./components/ItemView.tsx";
import { AdminGate } from "./components/AdminGate.tsx";
import { ADMIN_AUTH_EVENT } from "./lib/auth.ts";
import {
  guestAddBlock,
  guestBatch,
  guestBlocks,
  guestPatch,
  importGuestToAccount,
  selectGuestItems,
  readGuest,
  useBootstrap,
  type GuestState,
} from "./lib/session.ts";
import { AuthModal } from "./components/AuthModal.tsx";
import { WelcomeModal } from "./components/WelcomeModal.tsx";
import { RssModal } from "./components/RssModal.tsx";
import { KIND_LABEL, KIND_ORDER, OBTAIN_HINT, OBTAIN_LABEL, SOURCE_GROUPS, categoriesForPreset, categoryLabelForPreset, channelExcluded, formatInterval, groupOfSource } from "./lib/sources.ts";

// Lazily load the big panels in the admin area and secondary tabs: the first paint only ships the code the feed really needs
const DigestPanel = lazy(async () => ({ default: (await import("./components/DigestPanel.tsx")).DigestPanel }));
const HotPanel = lazy(async () => ({ default: (await import("./components/HotPanel.tsx")).HotPanel }));
const RulesPanel = lazy(async () => ({ default: (await import("./components/RulesPanel.tsx")).RulesPanel }));
const PushPanel = lazy(async () => ({ default: (await import("./components/PushPanel.tsx")).PushPanel }));
const AiPanel = lazy(async () => ({ default: (await import("./components/AiPanel.tsx")).AiPanel }));
const OpsPanel = lazy(async () => ({ default: (await import("./components/OpsPanel.tsx")).OpsPanel }));
const SiteAdminPanel = lazy(async () => ({ default: (await import("./components/SiteAdminPanel.tsx")).SiteAdminPanel }));
const UserPushPanel = lazy(async () => ({ default: (await import("./components/UserPushPanel.tsx")).UserPushPanel }));
import type {
  BlockPreset,
  BlockRule,
  HotReport,
  HotScope,
  Item,
  PushLogItem,
  AiPayload,
  PushPayload,
  PushPreview,
  PushSettings,
  Run,
  Source,
  Stats,
  Subscription,
} from "./types.ts";

const SOURCE_LABEL: Record<string, string> = {
  "linuxdo-welfare": "LINUX DO · Freebies",
  "linuxdo-resource": "LINUX DO · Resource roundup",
  "v2ex-free": "V2EX · Free giveaways",
  "github-free-for-dev": "GitHub · free-for-dev",
  "rss-fuliba": "Fuliba Forum",
  "rss-52pojie": "52pojie Forum",
  "rss-smzdm": "SMZDM",
  "zhihu-search": "Zhihu · Freebie search",
  "xhs-search": "Xiaohongshu · Freebie search",
  "xiaoheihe-search": "Xiaoheihe · Freebie search",
  "tg-channels": "Telegram channels",
  gamerpower: "GamerPower · Free games",
  "epic-free": "Epic Games · Weekly free game",
  "rss-reddit-freegames": "Reddit · FreeGameFindings",
  "rss-reddit-efreebies": "Reddit · eFreebies",
  "rss-reddit-gamedeals": "Reddit · GameDeals",
  "rss-slickdeals": "Slickdeals",
  "rss-heyitsfree": "HeyItsFree",
  "rss-keylol": "Keylol",
  "openrouter-free": "OpenRouter · New free LLMs",
  "gamerpower-loot": "GamerPower · Free loot and keys",
  "rss-itch-free": "itch.io · 100% off free games",
  "rss-freesteamkeys": "FreeSteamKeys · Steam freebies",
  "rss-ghxi": "GHXi · Free software",
};

let SOURCE_NAMES: Record<string, string> = { ...SOURCE_LABEL };
const sourceName = (id: string) => SOURCE_NAMES[id] ?? SOURCE_LABEL[id] ?? id;

type Tab = "feed" | "hot" | "digest" | "me" | "rules" | "push" | "ai" | "ops";

function useApi<T>(url: string | null, scope = ""): { data: T | null; loading: boolean; error: string | null; reload: () => void; update: (updater: (current: T | null) => T | null) => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const key = (url ?? "") + ":" + scope;
  const update = useCallback((updater: (current: T | null) => T | null) => {
    setData(updater);
    setLoadedKey(key);
  }, [key]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    fetch(url, { signal: ac.signal, cache: nonce > 0 ? "no-cache" : "default" })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `${r.status} ${r.statusText}`);
        }
        return (await r.json()) as T;
      })
      .then((d) => {
        if (!ac.signal.aborted) { setData(d); setLoadedKey(key); setError(null); }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setLoadedKey(key);
        setData(null);
        setError(String(e));
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [url, nonce, key]);

  return { data: url && loadedKey === key ? data : null, loading: Boolean(url) && (loading || loadedKey !== key), error, reload, update };
}

function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="status" aria-live="polite" className="toast-enter fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3.5 py-2 text-[12.5px] font-medium text-white shadow-lg">
      <Bell size={14} className="text-ink-300" />
      {message}
    </div>
  );
}

type Preset = { key: string; label: string; icon: typeof Sparkles };

const PRIMARY_CHANNELS: Preset[] = [
  { key: "verified", label: "Verified Freebies", icon: Sparkles },
  { key: "offline", label: "Physical Freebies", icon: MapPin },
  { key: "news", label: "Top News", icon: Newspaper },
  { key: "opensource", label: "Open Source", icon: Code },
  { key: "deal", label: "Best Deals", icon: Flame },
  { key: "info", label: "Industry News", icon: TrendingUp },
  { key: "pan", label: "Cloud Drives / Courses", icon: FolderOpen },
];

/**
 * Once the cloud drives / courses channel is disabled on the public demo site, these placeholder lines suggest what the channel looks like.
 * Every entry is fictional and contains no real resource titles or links - the real data is filtered out server-side.
 */
const PAN_DEMO_ROWS = [
  { title: "Sample coding course bundle · 42 lessons", meta: "TG · Cloud Drive Collection · Cloud drive", score: "82" },
  { title: "Sample design asset pack · fonts / brushes / templates", meta: "LINUX DO · Resource roundup · Cloud drive", score: "76" },
  { title: "Sample ebook bundle · PDF/EPUB", meta: "TG · General Resources · Cloud drive", score: "71" },
  { title: "Sample office software toolkit · portable build", meta: "TG · Cloud Drive Collection · Cloud drive", score: "68" },
  { title: "Sample past-exam collection · with answers", meta: "LINUX DO · Resource roundup · Online courses", score: "64" },
  { title: "Sample video editing course · assets + project files", meta: "TG · General Resources · Online courses", score: "59" },
];

const SECONDARY_VIEWS: Preset[] = [
  { key: "codes", label: "With codes", icon: Zap },
  { key: "urgent", label: "Ends today", icon: Bell },
  { key: "starred", label: "My saved", icon: Check },
  { key: "all", label: "All items", icon: AlignJustify },
  { key: "hidden", label: "Dismissed", icon: EyeOff },
];

const PRESETS: Preset[] = [...PRIMARY_CHANNELS, ...SECONDARY_VIEWS];


// Main repo URL: the top-bar GitHub icon points here
const REPO_URL = "https://github.com/ZiChuanLan/freebie-radar";
// One shared size for the mobile top-bar icon buttons, so five in a row is not cramped
const ICON_BTN =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950";
// Public area: anyone can see it without logging in. Everything else belongs to the admin area.
const PUBLIC_TABS = new Set<Tab>(["feed", "digest"]);
const ADMIN_TABS = new Set<Tab>(["rules", "push", "ai", "ops"]);

export function App() {
  const initialTab = (): Tab => {
    if (typeof location === "undefined") return "feed";
    const h = location.hash.replace("#", "");
    return h === "hot" || h === "digest" || h === "me" || h === "rules" || h === "push" || h === "ai" || h === "ops"
      ? (h as Tab)
      : "feed";
  };

  const [tab, setTab] = useState<Tab>(initialTab);
  const [detail, setDetail] = useState<Item | null>(null);
  const [quickBlock, setQuickBlock] = useState<Item | null>(null);
  // Expanded merge group: records the expanded item id and the other sources for the same freebie
  const [relatedOpen, setRelatedOpen] = useState<number | null>(null);
  const [relatedMap, setRelatedMap] = useState<Record<number, (Item & { sourceName?: string })[]>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const mobileNavRef = useRef<HTMLElement | null>(null);
  // When a merge group is expanded, lazily fetch the other sources' posts (siblings sharing the same title_key)
  useEffect(() => {
    const id = relatedOpen;
    if (!id || relatedMap[id]) return;
    let alive = true;
    fetch(`/api/items/${id}/related`, { headers: { accept: "application/json" } })
      .then((r) => { if (!r.ok) throw new Error("Could not load related sources"); return r.json(); })
      .then((d: { items?: (Item & { sourceName?: string })[] }) => {
        if (alive && Array.isArray(d.items)) setRelatedMap((m) => ({ ...m, [id]: d.items! }));
      })
      .catch(() => {
        if (alive) { setRelatedOpen(null); setToast("Could not load related sources. Please try again."); }
      });
    return () => { alive = false; };
    return () => {
      alive = false;
    };
  }, [relatedOpen, relatedMap]);
  // Whether the server has an admin password enabled (decides whether the admin area is gated)
  const [authChecked, setAuthChecked] = useState(false);
  const [protectedMode, setProtectedMode] = useState(false);
  const [adminEntryAllowed, setAdminEntryAllowed] = useState(true);
  const [adminAuthed, setAdminAuthed] = useState(false);
  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((j: { protected?: boolean; isAdmin?: boolean; adminHostAllowed?: boolean }) => {
        const prot = Boolean(j.protected);
        setProtectedMode(prot);
        setAdminAuthed(Boolean(j.isAdmin));
        setAdminEntryAllowed(j.adminHostAllowed !== false);
      })
      .catch(() => undefined)
      .finally(() => setAuthChecked(true));
  }, []);
  const adminReady = authChecked && adminAuthed;

  const boot = useBootstrap();
  const bootData = boot.data;
  useEffect(() => { boot.reload(); }, [adminAuthed, boot.reload]);
  useEffect(() => {
    const expire = () => setAdminAuthed(false);
    window.addEventListener(ADMIN_AUTH_EVENT, expire);
    return () => window.removeEventListener(ADMIN_AUTH_EVENT, expire);
  }, []);
  const me = bootData?.user ?? null;
  useEffect(() => {
    const nav = mobileNavRef.current;
    if (!nav || window.matchMedia("(min-width: 1024px)").matches) return;
    const selected = nav.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (!selected) return;
    const bounds = nav.getBoundingClientRect(), item = selected.getBoundingClientRect();
    if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
  }, [tab, me?.id, adminReady]);
  const isPublicSite = bootData?.siteMode === "public";
  const [authOpen, setAuthOpen] = useState(false);
  const [authHash, setAuthHash] = useState<string | null>(null);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [rssOpen, setRssOpen] = useState(false);
  const [guest, setGuest] = useState<GuestState>(() => readGuest());

  // While logged out on the public site, all personal state lives in localStorage; after login it syncs via /api/me/*
  const guestMode = isPublicSite && !me;
  const syncGuest = useCallback(() => setGuest(readGuest()), []);

  // Announcement: recorded once per version, so bumping the version after an edit shows it again
  useEffect(() => {
    if (!bootData?.onboarding?.enabled) return;
    const key = "radar_onboarding_seen_v" + bootData.onboarding.version;
    try {
      if (!localStorage.getItem(key)) setWelcomeOpen(true);
    } catch {
      /* In private mode it pops up every time, which is acceptable */
    }
  }, [bootData?.onboarding?.enabled, bootData?.onboarding?.version]);

  // When the OAuth redirect comes back with #invite-required / #login-*, open the login dialog and show the matching error
  useEffect(() => {
    const h = location.hash.replace("#", "");
    if (!h) return;
    if (h === "invite-required" || h.startsWith("login-") || h.startsWith("register-") || h === "invite-invalid" || h === "quota-full") {
      setAuthHash(h);
      setAuthOpen(true);
    }
  }, []);

  const closeWelcome = useCallback(() => {
    setWelcomeOpen(false);
    if (bootData?.onboarding) {
      try {
        localStorage.setItem("radar_onboarding_seen_v" + bootData.onboarding.version, "1");
      } catch {
        /* ignore */
      }
    }
  }, [bootData?.onboarding]);

  const logout = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) { setToast("Could not log out. Please try again."); return; }
      setTab("feed");
      setDetail(null);
      boot.reload();
    } catch { setToast("Network error - log-out did not finish. Please try again."); }
  }, [boot]);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [source, setSource] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [catOpen, setCatOpen] = useState(false);
  const catRef = useRef<HTMLDivElement | null>(null);
  const [lang, setLang] = useState<"all" | "zh" | "en">("all");
  const [sort, setSort] = useState("newest");
  const [range, setRange] = useState("auto");
  const [priceCap, setPriceCap] = useState("auto");
  const [minScore, setMinScore] = useState("all");
  const [obtain, setObtain] = useState("auto");
  const [kindFilter, setKindFilter] = useState("auto");
  const [preset, setPreset] = useState("verified");
  const [viewMode, setViewMode] = useState<"compact" | "grid2" | "grid3">(() => {
    if (typeof localStorage === "undefined") return "compact";
    const saved = localStorage.getItem("radar_view_mode");
    return saved === "grid2" || saved === "grid3" || saved === "compact" ? saved : "compact";
  });
  const [showRowSummary, setShowRowSummary] = useState(() => {
    try { return localStorage.getItem("radar_row_summary") === "true"; } catch { return false; }
  });
  const toggleRowSummary = () => {
    setShowRowSummary((current) => {
      const next = !current;
      try { localStorage.setItem("radar_row_summary", String(next)); } catch { /* optional preference */ }
      return next;
    });
  };
  const updateViewMode = useCallback((m: "compact" | "grid2" | "grid3") => {
    setViewMode(m);
    try {
      localStorage.setItem("radar_view_mode", m);
    } catch {
      /* ignore */
    }
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showAllSources, setShowAllSources] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  /** Mobile: expanded state of the top filter panel (quick views, sources and filter bar) */
  const [mobileFilterBar, setMobileFilterBar] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1900);
  }, []);

  const copyCode = useCallback(
    (code: string) => {
      void navigator.clipboard?.writeText(code);
      notify("Copied code " + code);
    },
    [notify],
  );

  useEffect(() => {
    if (typeof location === "undefined") return;
    if (tab === "feed") history.replaceState(null, "", location.pathname + location.search);
    else history.replaceState(null, "", "#" + tab);
  }, [tab]);

  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace("#", "");
      setTab(h === "hot" || h === "digest" || h === "me" || h === "rules" || h === "push" || h === "ai" || h === "ops" ? (h as Tab) : "feed");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (typeof location === "undefined") return;
    const sp = new URLSearchParams(location.search);
    const site = sp.get("login_ok");
    if (!site) return;
    sp.delete("login_ok");
    const nextSearch = sp.toString();
    history.replaceState(null, "", location.pathname + (nextSearch ? "?" + nextSearch : "") + "#ops");
    setTab("ops");
    notify(`Signed in to ${site} and sent back public freebies (cookie stays on this machine)`);
  }, [notify]);

  const [, bumpNames] = useState(0);
  useEffect(() => {
    fetch("/api/sources")
      .then((r) => r.json())
      .then((d: { sources: { id: string; name: string }[] }) => {
        const m: Record<string, string> = { ...SOURCE_LABEL };
        for (const s of d.sources) if (s.name) m[s.id] = s.name;
        SOURCE_NAMES = m;
        bumpNames((n) => n + 1);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!catOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [catOpen]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set("preset", preset);
    if (debounced) p.set("search", debounced);
    if (source) p.set("source", source);
    if (categories.length) p.set("category", categories.join(","));
    if (lang !== "all") p.set("lang", lang);
    if (sort) p.set("sort", sort);

    if (preset === "verified") {
      p.set("unexpired", "1");
      p.set("aiOnly", "1");
      if (kindFilter === "auto") p.set("kind", "freebie");
      if (obtain === "auto") p.set("obtain", "free,conditional");
      if (range === "auto") p.set("maxAgeDays", "7");
      // Cloud-drive resources and online courses are long-lived reference material, so they get their own channel instead of mixing into Verified Freebies
      const excludedCats = channelExcluded("verified");
      if (categories.length === 0 && excludedCats.length) p.set("excludeCategory", excludedCats.join(","));
    } else if (preset === "offline") {
      // Physical freebies get their own channel: offline, in-store or on-site pickup, never mixed into Verified Freebies
      p.set("unexpired", "1");
      p.set("hideRejected", "1");
      if (categories.length === 0) p.set("category", "offline");
    } else if (preset === "pan") {
      p.set("unexpired", "1");
      if (kindFilter === "auto") p.set("kind", "freebie,deal,info,opensource,news");
      if (categories.length === 0) p.set("category", "pan,course");
      p.set("hideRejected", "1");
    } else if (preset === "deal") {
      p.set("unexpired", "1");
      if (kindFilter === "auto") p.set("kind", "deal");
      p.set("hideRejected", "1");
    } else if (preset === "opensource") {
      if (kindFilter === "auto") p.set("kind", "opensource");
      p.set("hideRejected", "1");
    } else if (preset === "news") {
      if (kindFilter === "auto") p.set("kind", "news");
      p.set("hideRejected", "1");
    } else if (preset === "info") {
      if (kindFilter === "auto") p.set("kind", "info");
      p.set("hideRejected", "1");
    } else if (preset === "codes") {
      p.set("unexpired", "1");
      p.set("hasCodes", "1");
    } else if (preset === "urgent") {
      p.set("expiring", "1");
    } else if (preset === "starred") {
      p.set("starred", "1");
    } else if (preset === "hidden") {
      p.set("status", "ignored");
    }
    if (preset === "all") p.set("hideRejected", "1");

    if (kindFilter === "all") p.set("kind", "");
    else if (kindFilter !== "auto") p.set("kind", kindFilter);

    if (priceCap === "free") p.set("freeOnly", "1");
    else if (priceCap !== "auto" && priceCap !== "all") p.set("maxPrice", priceCap);

    if (obtain === "all") p.set("obtain", "");
    else if (obtain !== "auto" && obtain) p.set("obtain", obtain);
    if (minScore !== "all") p.set("minScore", minScore);
    if (unreadOnly) p.set("unread", "1");

    const DAYS: Record<string, number> = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 };
    const days = DAYS[range];
    if (days) p.set("since", new Date(Date.now() - days * 86_400_000).toISOString());
    p.set("limit", "100");
    return p.toString();
  }, [debounced, source, categories, lang, sort, range, priceCap, preset, kindFilter, obtain, minScore, unreadOnly]);

  const statsQuery = useMemo(() => {
    const p = new URLSearchParams(query);
    p.delete("category");
    p.delete("sort");
    p.delete("limit");
    return p.toString();
  }, [query]);

  const switchPreset = useCallback((nextKey: string) => {
    setPreset(nextKey);
    setKindFilter("auto");
    setObtain("auto");
    setPriceCap("auto");
    setCategories((cur) => {
      const allowed = new Set(categoriesForPreset(nextKey));
      return cur.filter((c) => allowed.has(c));
    });
  }, []);

  const activeFilterCount =
    [
      source,
      categories.length > 0,
      lang !== "all",
      debounced,
      minScore !== "all",
      unreadOnly,
      kindFilter !== "auto",
      priceCap !== "auto",
      obtain !== "auto",
      range !== "auto",
      sort !== "newest",
    ].filter(Boolean).length;

  const resetFilters = useCallback(() => {
    setSource("");
    setCategories([]);
    setLang("all");
    setSearch("");
    setDebounced("");
    setMinScore("all");
    setUnreadOnly(false);
    setKindFilter("auto");
    setPriceCap("auto");
    setObtain("auto");
    setRange("auto");
    setSort("newest");
  }, []);
  const identityScope = `${me?.id ?? "guest"}:${adminReady}`;
  const stats = useApi<Stats>(statsQuery ? `/api/stats?${statsQuery}` : "/api/stats", identityScope);
  const guestIds = guestMode && (preset === "starred" || preset === "hidden")
    ? `&ids=${(preset === "starred" ? guest.starred : guest.hidden).slice(0, 100).join(",") || "0"}` : "";
  const items = useApi<{ total: number; items: Item[] }>(`/api/items?${query}${guestIds}`, identityScope);
  // On the public site, logged-in users read and write their own follows and block words; self-hosted installs and the admin area keep the global endpoints
  const rulesBase = adminReady ? "/api" : isPublicSite && me ? "/api/me" : null;
  // Push rules come in two sets as well: the site owner edits the global ones, logged-in users edit their own (same panel, different endpoints)
  const pushBase = adminReady ? "/api/push" : isPublicSite && me ? "/api/me/push" : null;
  const subs = useApi<{ subscriptions: Subscription[] }>(rulesBase ? rulesBase + "/subscriptions" : null, identityScope);
  const sources = useApi<{ sources: Source[] }>("/api/sources", identityScope);
  const runs = useApi<{ runs: Run[] }>(adminReady ? "/api/runs?limit=40" : null);
  const blockRules = useApi<{ rules: BlockRule[]; totalBlocked: number; presets: BlockPreset[] }>(
    rulesBase ? rulesBase + "/block-rules" : null,
    identityScope,
  );
  const digests = useApi<{ digests: { date: string; created_at: string; pushed_at: string | null; kind: string; count: number }[] }>(
    "/api/digests",
  );
  const [hotHours, setHotHours] = useState(24);
  const [hotScope, setHotScope] = useState<HotScope>("all");
  const hot = useApi<HotReport>(tab === "hot" ? `/api/hot?hours=${hotHours}&scope=${hotScope}` : null);
  // Admin endpoints are only requested once ready, to avoid a burst of 401s on the public site and to keep password-less mode from stalling
  const push = useApi<PushPayload>(pushBase, identityScope);
  const ai = useApi<AiPayload>(adminReady && tab === "ai" ? "/api/ai" : null);
  const pushLogs = useApi<{ logs: PushLogItem[] }>(pushBase && tab === "push" ? pushBase + "/log?limit=40" : null, identityScope);
  const [pushPreview, setPushPreview] = useState<PushPreview | null>(null);
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const activeDate = pickedDate ?? digests.data?.digests?.[0]?.date ?? null;
  const digestDetail = useApi<{
    date: string;
    text: string;
    count: number;
    created_at: string;
    pushed_at: string | null;
    items: Item[];
  }>(activeDate && tab === "digest" ? "/api/digests/" + activeDate : null);

  const [blockedPreview, setBlockedPreview] = useState<Item[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  useEffect(() => {
    setDetail(null); setRelatedOpen(null); setRelatedMap({}); setPushPreview(null); setBlockedPreview(null);
  }, [identityScope]);
  const detailId = detail?.id;
  useEffect(() => {
    if (!detailId) return;
    const ac = new AbortController();
    setDetailLoading(true); setDetailError(null);
    fetch(`/api/items/${detailId}`, { signal: ac.signal }).then(async (res) => {
      if (!res.ok) throw new Error("Could not load details. Please try again.");
      return await res.json() as Item;
    }).then((full) => {
      if (!ac.signal.aborted) setDetail((current) => current?.id === detailId ? { ...current, ...full } : current);
    }).catch((err: unknown) => { if (!ac.signal.aborted) setDetailError(String(err)); })
      .finally(() => { if (!ac.signal.aborted) setDetailLoading(false); });
    return () => ac.abort();
  }, [detailId, detailNonce]);

  const patch = useCallback(
    async (id: number, body: Record<string, unknown>) => {
      if (!bootData) { notify("Site config is still loading. Please try again shortly"); return; }
      // Public site, logged out: only touches local localStorage, sends no request, affects nobody
      if (guestMode) {
        guestPatch(id, body as { starred?: boolean; read?: boolean; status?: string });
        syncGuest();
        if (detail && detail.id === id) {
          const next = readGuest();
          setDetail({
            ...detail,
            starred: next.starred.includes(id),
            read: next.read.includes(id),
          });
        }
        return;
      }
      const url = isPublicSite ? `/api/me/items/${id}` : `/api/items/${id}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        notify(err.error ?? "Action failed");
        return;
      }
      items.reload();
      stats.reload();
      if (detail && detail.id === id) {
        const next = await fetch(`/api/items/${id}`).then((r) => r.json());
        setDetail((current) => current?.id === id ? next as Item : current);
      }
    },
    [items, stats, detail, guestMode, isPublicSite, syncGuest, notify, bootData],
  );

  const addRule = useCallback(
    async (pattern: string, mode: "keyword" | "regex", scope: string) => {
      // Public site: logged-in users write their own rules, guests write to local localStorage
      if (guestMode) {
        guestAddBlock(pattern);
        syncGuest();
        notify("Blocked " + pattern + " on this machine");
        items.reload();
        return;
      }
      const ruleUrl = rulesBase + "/block-rules";
      const res = await fetch(ruleUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern, mode, scope }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        notify(err.error ?? "Could not add");
        throw new Error(err.error ?? "Could not add");
      }
      notify("Blocked " + pattern);
      blockRules.reload();
      items.reload();
      stats.reload();
      setBlockedPreview(null);
      setRelatedMap({});
    },
    [blockRules, items, stats, notify, guestMode, rulesBase, syncGuest],
  );

  const quickBlockAdd = useCallback(
    async (pattern: string, scope: string) => {
      await addRule(pattern, "keyword", scope);
    },
    [addRule],
  );

  const addSubscription = useCallback(
    async (kw: string) => {
      if (guestMode) {
        notify("Log in to follow keywords (guest preferences stay on this machine)");
        return;
      }
      const res = await fetch(rulesBase + "/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword: kw }),
      });
      if (!res.ok) { notify(((await res.json()) as { error?: string }).error ?? "Could not follow"); throw new Error("Could not follow"); }
      subs.reload();
      items.reload();
      notify("Following " + kw);
    },
    [subs, items, notify, guestMode, rulesBase],
  );

  const removeSubscription = useCallback(
    async (id: number) => {
      const res = await fetch(rulesBase + "/subscriptions/" + id, { method: "DELETE" });
      if (!res.ok) { notify("Could not delete the follow word"); return; }
      subs.reload();
      items.reload();
    },
    [subs, items, rulesBase, notify],
  );

  const refreshAll = useCallback(() => {
    items.reload();
    stats.reload();
    sources.reload();
    runs.reload();
    blockRules.reload();
    setRelatedMap({});
  }, [items, stats, sources, runs, blockRules]);

  const markVisibleRead = useCallback(async () => {
    const page = guestMode ? selectGuestItems(items.data?.items ?? [], guest, preset, unreadOnly) : items.data?.items ?? [];
    const unreadIds = page.filter((i) => !i.read).map((i) => i.id);
    if (!unreadIds.length) return;
    if (guestMode) {
      guestBatch(unreadIds, "read");
      syncGuest();
      notify(`Marked ${unreadIds.length} items as read on this machine`);
      return;
    }
    const res = await fetch(isPublicSite ? "/api/me/items/batch" : "/api/items/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: unreadIds, action: "read" }),
    });
    if (!res.ok) { notify("Could not mark as read. Please try again."); return; }
    notify(`Marked ${unreadIds.length} items on this page as read`);
    items.reload();
    stats.reload();
  }, [items, stats, notify, guestMode, isPublicSite, syncGuest, guest, preset, unreadOnly]);

// Guest dismissals / saves / read state and local block words apply on the client; for logged-in users the server filters by user_item_states
  const visible = guestMode ? selectGuestItems(items.data?.items ?? [], guest, preset, unreadOnly) : items.data?.items ?? [];
  const currentIndex = detail ? visible.findIndex((i) => i.id === detail.id) : -1;

  const enabledSources = (sources.data?.sources ?? []).filter((s) => s.enabled || showAllSources);
  const grouped = SOURCE_GROUPS.map((g) => ({
    ...g,
    sources: enabledSources.filter((s) => groupOfSource(s) === g.key),
  })).filter((g) => g.sources.length > 0);

  // The public area shows "Resource stream / Hot topics / Daily digest"; the other tabs appear only after entering the admin area
  const tabs: { key: Tab | "admin"; label: string; icon: typeof Activity; badge?: number }[] = [
    { key: "feed", label: "Resource stream", icon: Activity },
    { key: "hot", label: "Hot topics", icon: Flame },
    { key: "digest", label: "Daily digest", icon: Radar },
    ...(me ? [{ key: "me" as Tab, label: "My space", icon: User }] : []),
    ...(!adminReady && me
      ? [
          { key: "rules" as Tab, label: "My follows and blocks", icon: ShieldBan, badge: stats.data?.totals.blockRules },
          { key: "push" as Tab, label: "My push rules", icon: Zap, badge: push.data?.stats.queued },
        ]
      : []),
    ...(adminReady
      ? [
          { key: "rules" as Tab, label: "Follows and blocks", icon: ShieldBan, badge: stats.data?.totals.blockRules },
          { key: "push" as Tab, label: "Push rules", icon: Zap, badge: push.data?.stats.queued },
          { key: "ai" as Tab, label: "AI engine", icon: Bot },
          { key: "ops" as Tab, label: "Source ops", icon: Wrench },
        ]
      : [{ key: "admin" as const, label: "Admin", icon: Lock }]),
  ];

  const handleTab = (key: Tab | "admin") => {
    if (key === "admin") {
      setTab("admin" as Tab);
      return;
    }
    setTab(key);
  };


  const exportUrl = "/api/export?format=md&" + query.replace(/limit=\d+/, "limit=300");


  // About / RSS entry points: the desktop sidebar and the mobile brand row share the same buttons so the markup is not duplicated
  const helpRssNode = (
    <>
      <button
        type="button"
        onClick={() => setWelcomeOpen(true)}
        className={ICON_BTN}
        title="About the site and how to use it"
      >
        <BookOpen size={14} />
      </button>
      <button
        type="button"
        onClick={() => setRssOpen(true)}
        className={ICON_BTN}
        title="RSS feed URL"
      >
        <Globe2 size={14} />
      </button>
    </>
  );

  // Main repo entry: the GitHub icon, used by both the mobile brand row and the desktop sidebar
  const githubNode = (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      className={ICON_BTN}
      title="Main repo · GitHub"
      aria-label="GitHub main repo"
    >
      <Github size={14} />
    </a>
  );

  // Account state: on mobile it sits at the right of the nav row, on desktop it stays on the sidebar's second line
  const accountNode = me ? (
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" onClick={() => setTab("me")} aria-label="Open my space" title="My space and push channels" className="flex min-w-0 items-center gap-1 rounded hover:bg-ink-100">
      {me.avatarUrl ? (
        <img src={me.avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full border border-ink-200" />
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[10px] font-semibold text-ink-600">
          {(me.name ?? me.username).slice(0, 1).toUpperCase()}
        </span>
      )}
      <span
        className="hidden min-w-0 truncate text-[11.5px] font-medium text-ink-800 sm:inline"
        title={`${me.name ?? me.username} · ${me.linuxdoId < 0 ? "GitHub" : `LINUX DO trust level ${me.trustLevel}`}`}
      >
        {me.name ?? me.username}
      </span>
      </button>
      <button
        type="button"
        onClick={() => void logout()}
        className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-900"
        title="Log out"
      >
        <LogOut size={12} />
      </button>
    </div>
  ) : bootData?.loginEnabled ? (
    <button
      type="button"
      onClick={() => {
        setAuthHash(null);
        setAuthOpen(true);
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-ink-950 px-2 py-1 text-[11.5px] font-medium whitespace-nowrap text-white hover:bg-brand-hover"
      title="Log in with LINUX DO"
    >
      <User size={12} /> Log in
    </button>
  ) : null;

  // Quick views + source tree: always visible in the desktop sidebar, folded into the "Filters" panel on mobile
  const sourcePanelNode = (
    <>
      <div className="pt-1">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <span className="text-[11px] font-medium text-ink-400">Quick views</span>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-0.5 text-[11px] font-medium text-accent hover:underline"
              title="Clear all filters"
            >
              <RotateCcw size={10} /> Clear {activeFilterCount}
            </button>
          )}
        </div>
        <div className="space-y-0.5">
          {SECONDARY_VIEWS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => switchPreset(p.key)}
              className={
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors " +
                (preset === p.key
                  ? "bg-canvas-subtle font-semibold text-ink-950"
                  : "font-medium text-ink-600 hover:bg-canvas-subtle/60 hover:text-ink-950")
              }
            >
              <p.icon size={13} className={preset === p.key ? "text-accent" : "text-ink-400"} />
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-ink-200 pt-3">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <span className="text-[11px] font-medium text-ink-400">Sources</span>
          <button
            type="button"
            onClick={() => setShowAllSources((v) => !v)}
            className="text-[11px] text-ink-400 hover:text-ink-700"
          >
            {showAllSources ? "Hide disabled" : "Show all"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setSource("")}
          className={
            "mb-1 w-full rounded-md px-2.5 py-1 text-left text-[12px] transition-colors " +
            (source === ""
              ? "bg-canvas-subtle font-semibold text-ink-950"
              : "font-medium text-ink-600 hover:bg-canvas-subtle/60")
          }
        >
          All sources
        </button>
        {grouped.map((g) => {
          const collapsed = collapsedGroups[g.key] ?? !g.sources.some((s) => s.id === source);
          const total = g.sources.reduce((n, s) => n + s.items, 0);
          return (
            <div key={g.key} className="mb-1">
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() => setCollapsedGroups((m) => ({ ...m, [g.key]: !m[g.key] }))}
                className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-ink-400 hover:text-ink-700"
              >
                {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                <span className="flex-1 text-left">{g.label}</span>
                <span className="font-mono tabular-nums">{total}</span>
              </button>
              {!collapsed && (
                <div className="space-y-0.5">
                  {g.sources.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSource(s.id === source ? "" : s.id)}
                      className={
                        "flex w-full items-center justify-between rounded-md px-2.5 py-1 text-left text-[12px] transition-colors " +
                        (source === s.id
                          ? "bg-canvas-subtle font-semibold text-ink-950"
                          : "text-ink-600 hover:bg-canvas-subtle/60") +
                        (s.enabled ? "" : " opacity-45")
                      }
                      title={s.id + " · Collection interval " + formatInterval(s.interval_sec)}
                    >
                      <span className="truncate">{s.name}</span>
                      <span className="ml-1.5 shrink-0 font-mono text-[11px] tabular-nums text-ink-400">{s.items}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div className="workspace-shell flex min-h-screen flex-col bg-surface lg:flex-row">
      {/* Left rail (collapses into the top area on mobile) */}
      <aside className="workspace-rail w-full shrink-0 border-b border-ink-200 bg-canvas/70 px-3.5 py-3 lg:flex lg:w-[240px] lg:flex-col lg:gap-4 lg:border-r lg:border-b-0 lg:bg-canvas lg:px-3 lg:py-4">
        {/* Brand row: about / RSS / GitHub / export / refresh all live on this row, saving a whole second column */}
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
            <h1 className="text-[14.5px] font-semibold tracking-tight text-ink-950">Resource Radar</h1>
          </div>
          <span className="hidden font-mono text-[11px] tabular-nums text-ink-400 lg:inline">
            {stats.data?.totals.aiKept ?? "—"} picks
          </span>
          <div className="flex items-center gap-1 lg:hidden">
            {helpRssNode}
            {githubNode}
            {tab === "feed" && <a href={exportUrl} className={ICON_BTN} title="Export the current filters as Markdown">
              <Download size={14} />
            </a>}
            <button type="button" onClick={refreshAll} className={ICON_BTN} title="Refresh data">
              <RefreshCw size={14} className={items.loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {/* Desktop sidebar second row: about/RSS + account; on mobile both entries are already merged into the brand row and the nav row */}
        <div className="mt-2 hidden items-center gap-1 px-1 lg:mt-0 lg:flex">
          {helpRssNode}
          {githubNode}
          <div className="ml-auto min-w-0">{accountNode}</div>
        </div>

        {isPublicSite && (guest.hidden.length > 0 || guest.starred.length > 0 || guest.read.length > 0 || guest.blocked.length > 0) && (
          <div className="mt-2 rounded-md border border-ink-200 bg-surface-hover px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-600">
            Saved on this machine: {guest.starred.length} saved · {guest.read.length} read · {guest.hidden.length} dismissed
            {bootData?.loginEnabled && (
              <button
                type="button"
                onClick={async () => {
                  if (!me) { setAuthOpen(true); return; }
                  const r = await importGuestToAccount(guest);
                  if (r.ok) {
                    notify(`Merged ${r.imported} preferences into your account`);
                    syncGuest();
                    items.reload();
                    stats.reload();
                    blockRules.reload();
                  } else {
                    notify(r.error ?? "Merge failed");
                  }
                }}
                className="ml-1 font-medium text-accent hover:underline"
              >
                {me ? "Merge into current account" : "Log in to merge"}
              </button>
            )}
          </div>
        )}
        {/* Search box (press / to focus) */}
        <div className="relative mt-2.5 lg:mt-0">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-400" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (search) {
                  setSearch("");
                  setDebounced("");
                } else {
                  e.currentTarget.blur();
                }
              }
            }}
            placeholder="Search freebies, redemption codes..."
            className="h-8 w-full rounded-md border border-ink-200 bg-surface pr-8 pl-8 text-[12.5px] text-ink-950 transition-colors outline-none placeholder:text-ink-400 focus:border-accent"
          />
          {search ? (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setDebounced("");
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
              title="Clear search"
            >
              <X size={12} />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-ink-200 bg-canvas px-1.5 py-0.5 font-mono text-[10.5px] text-ink-400 lg:inline">
              /
            </kbd>
          )}
        </div>

        {/* Nav: horizontally scrollable on phones with the account on the right, a vertical borderless list on desktop */}
        <div className="-mx-3.5 mt-2.5 flex items-center gap-1.5 px-3.5 pb-0.5 lg:mx-0 lg:mt-0 lg:block lg:px-0 lg:pb-0">
          <nav ref={mobileNavRef} aria-label="Page navigation" className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:block lg:flex-none lg:space-y-0.5 lg:overflow-visible">
          {tabs.slice(0, 3).map((t) => (
            <button
              key={t.key}
              type="button"
              data-tab={t.key}
              aria-label={t.label}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => handleTab(t.key)}
              className={
                "flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors lg:w-full " +
                (tab === t.key
                  ? "bg-ink-950 text-white lg:bg-canvas-subtle lg:font-semibold lg:text-ink-950"
                  : "text-ink-600 hover:bg-canvas-subtle/70 hover:text-ink-950")
              }
            >
              <span className="flex items-center gap-2">
                <t.icon size={14} className={tab === t.key ? "lg:text-accent" : "text-ink-400"} />
                {t.label}
              </span>
              {t.key === "feed" && (stats.data?.totals.unread ?? 0) > 0 && (
                <span
                  className={
                    "hidden font-mono text-[11px] tabular-nums lg:inline " +
                    (tab === t.key ? "text-ink-600" : "text-ink-400")
                  }
                >
                  {stats.data?.totals.unread}
                </span>
              )}
            </button>
          ))}
          <div className="mx-1 h-4 w-px shrink-0 self-center bg-ink-200 lg:hidden" />
          <div className="hidden px-2.5 pt-3 pb-1 text-[11px] font-medium text-ink-400 lg:block">
            {adminReady ? "Admin" : me ? "My space" : "Admin"}
          </div>
          {tabs.slice(3).map((t) => (
            <button
              key={t.key}
              type="button"
              data-tab={t.key}
              aria-label={t.label}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => handleTab(t.key)}
              className={
                "flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors lg:w-full " +
                (tab === t.key
                  ? "bg-ink-950 text-white lg:bg-canvas-subtle lg:font-semibold lg:text-ink-950"
                  : "text-ink-600 hover:bg-canvas-subtle/70 hover:text-ink-950")
              }
            >
              <span className="flex items-center gap-2">
                <t.icon size={14} className={tab === t.key ? "lg:text-accent" : "text-ink-400"} />
                {t.label}
              </span>
              {typeof t.badge === "number" && t.badge > 0 && (
                <span
                  className={
                    "rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums " +
                    (tab === t.key
                      ? "bg-white/20 text-white lg:bg-surface lg:text-ink-700"
                      : "bg-ink-200/80 text-ink-600")
                  }
                >
                  {t.badge}
                </span>
              )}
            </button>
          ))}
          </nav>
          {/* Mobile account entry: sits right next to the nav instead of taking its own row */}
          <div className="shrink-0 lg:hidden">{accountNode}</div>
        </div>
        {/* Scenario presets & sources: always visible in the desktop sidebar, folded into the main area's "Filters" panel on mobile */}
        {tab === "feed" && (
          <div className="mt-3 hidden lg:mt-0 lg:block">
            <div className="space-y-4">{sourcePanelNode}</div>
          </div>
        )}
      </aside>

      {/* Pure white main workspace on the right */}
      <div className="flex min-w-0 flex-1 flex-col bg-surface">
        {/* 48px desktop top bar */}
        <header className="sticky top-0 z-20 hidden h-12 items-center justify-between gap-4 border-b border-ink-200 bg-surface/95 px-6 backdrop-blur-sm lg:flex">
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="text-ink-500">{adminReady && ADMIN_TABS.has(tab) ? "Admin console" : tab === "me" || (me && (tab === "rules" || tab === "push")) ? "My space" : "Public content"}</span>
            <ChevronRight size={12} className="text-ink-300" />
            <span className="font-medium text-ink-900">{tabs.find((t) => t.key === tab)?.label ?? "Admin"}</span>
          </div>

          <div className="flex shrink-0 items-center gap-3 text-[12px] text-ink-500">
            {tab === "feed" && <><span className="font-mono tabular-nums">
              24h <strong className="font-semibold text-ink-900">+{stats.data?.totals.last24h ?? "—"}</strong>
            </span>
            <span className="text-ink-300" aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              With codes <strong className="font-semibold text-ink-900">{stats.data?.totals.withCodes ?? "—"}</strong>
            </span>
            {(stats.data?.totals.aiRejected ?? 0) > 0 && (
              <>
                <span className="text-ink-300" aria-hidden="true">·</span>
                <span>Filtered out {stats.data?.totals.aiRejected} low-value posts</span>
              </>
            )}
            <a
              href={exportUrl}
              className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-ink-200 bg-surface px-2.5 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-950"
              title="Export the current filters as Markdown"
            >
              <Download size={12} /> Export
            </a>
            </>}
            <button
              type="button"
              onClick={refreshAll}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950"
              title="Refresh data"
            >
              <RefreshCw size={13} className={items.loading ? "animate-spin" : ""} />
            </button>
          </div>
        </header>

        {/* Main content area */}
        <main className={tab === "feed" ? "workspace-content min-w-0 flex-1" : "workspace-content min-w-0 flex-1 px-3.5 py-3.5 sm:px-6 sm:py-5"}>
          {/* Lightweight placeholder the first time a lazily loaded panel opens, to avoid a full-page white flash */}
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-1.5 px-6 py-10 text-[12.5px] text-ink-400">
                <Loader2 size={13} className="animate-spin" /> Loading...
              </div>
            }
          >
          {((tab as string) === "admin" || (ADMIN_TABS.has(tab) && !adminReady && !((tab === "rules" || tab === "push") && me))) && (
            <AdminGate protectedMode={protectedMode} entryAllowed={adminEntryAllowed} onAuthChange={setAdminAuthed}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { key: "rules" as Tab, label: "Follows and blocks", desc: "Keyword follows, block-word firewall", icon: ShieldBan },
                  { key: "push" as Tab, label: "Push rules", desc: "Push timing, thresholds, format and quiet hours", icon: Zap },
                  { key: "ai" as Tab, label: "AI engine", desc: "Rule pre-filter, review model, prompts and re-review", icon: Bot },
                  { key: "ops" as Tab, label: "Source ops", desc: "Collection toggles, intervals, data cleanup", icon: Wrench },
                ].map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => setTab(entry.key)}
                    className="panel flex flex-col items-start gap-1.5 p-4 text-left transition-colors hover:border-ink-400"
                  >
                    <entry.icon size={16} className="text-accent" />
                    <span className="text-[13.5px] font-semibold text-ink-950">{entry.label}</span>
                    <span className="text-[12px] leading-relaxed text-ink-500">{entry.desc}</span>
                  </button>
                ))}
              </div>
            </AdminGate>
          )}

          {tab === "feed" && (
            <>
              {/* Mobile: channel pills + filter/view controls on one row, saving two full-width button rows */}
              <div className="flex items-stretch border-b border-ink-100 bg-surface">
                <div className="channel-nav no-scrollbar min-w-0 flex-1" role="group" aria-label="Content channels">
                  {PRIMARY_CHANNELS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      aria-pressed={preset === p.key}
                      onClick={() => switchPreset(p.key)}
                      className="whitespace-nowrap transition-colors"
                    >
                      <p.icon size={11} />
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="relative flex shrink-0 items-center gap-1 border-l border-ink-100 bg-surface px-2 lg:hidden">
                  {/* Fade on the left so a horizontally scrolled channel pill is not cut in half */}
                  <span className="pointer-events-none absolute inset-y-0 -left-4 w-4 bg-gradient-to-l from-surface to-transparent" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => setMobileFilterBar((v) => !v)}
                    className={
                      "relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors " +
                      (mobileFilterBar
                        ? "border-ink-950 bg-ink-950 text-white"
                        : "border-ink-200 bg-surface text-ink-600")
                    }
                    title="Filters"
                    aria-label="Filters"
                    aria-expanded={mobileFilterBar}
                  >
                    <SlidersHorizontal size={14} />
                    {activeFilterCount > 0 && (
                      <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 font-mono text-[9px] leading-none text-white">
                        {activeFilterCount}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => updateViewMode(viewMode === "compact" ? "grid2" : "compact")}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-600 transition-colors hover:text-ink-950"
                    title={viewMode === "compact" ? "Switch to the card grid" : "Switch to the compact list"}
                    aria-label="Switch view"
                  >
                    {viewMode === "compact" ? <LayoutGrid size={14} /> : <AlignJustify size={14} />}
                  </button>
                </div>
              </div>
              {/* Quick subcategory pill row: jump straight to the current channel's top subcategories instead of digging into the second-level dropdown */}
              {(() => {
                const countMap = new Map((stats.data?.byCategory ?? []).map((c) => [c.category ?? "other", c.n]));
                const allowed = categoriesForPreset(preset);
                const ordered = [...allowed].sort((a, b) => (countMap.get(b) ?? 0) - (countMap.get(a) ?? 0));
                // Only show categories that actually have content (plus the selected ones, so they can be unselected in one click); fall back to the channel's default order when everything is empty
                const withItems = ordered.filter((key) => (countMap.get(key) ?? 0) > 0 || categories.includes(key));
                const quickCats = (withItems.length ? withItems : ordered).slice(0, 10);
                return (
                  <div className="flex items-stretch border-b border-ink-100 bg-surface">
                    <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-3.5 py-1">
                    <button
                      type="button"
                      onClick={() => setCategories([])}
                      className={
                        "shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium transition-colors active:scale-[0.97] " +
                        (categories.length === 0
                          ? "bg-brand-subtle font-semibold text-accent"
                          : "text-ink-500 hover:bg-ink-100 hover:text-ink-900")
                      }
                    >
                      All {preset === "news" ? "top news" : preset === "info" ? "industry news" : "categories"}
                    </button>
                    {quickCats.map((key) => {
                      const n = countMap.get(key) ?? 0;
                      const active = categories.includes(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() =>
                            setCategories((cur) =>
                              cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key],
                            )
                          }
                          className={
                            "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] transition-colors active:scale-[0.97] " +
                            (active
                              ? "bg-ink-950 font-medium text-white"
                              : n > 0
                                ? "text-ink-600 hover:bg-ink-100 hover:text-ink-950"
                                : "text-ink-400 hover:bg-ink-100")
                          }
                        >
                          <span>{categoryLabelForPreset(key, preset)}</span>
                          {n > 0 && (
                            <span className={"font-mono text-[10.5px] tabular-nums " + (active ? "text-white/75" : "text-ink-400")}>
                              {n}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    </div>
                    {/* Mobile stats fold into the right end of this row instead of taking a row of their own */}
                    <div className="relative flex shrink-0 items-center border-l border-ink-100 bg-surface px-2.5 text-[11px] whitespace-nowrap text-ink-500 sm:hidden">
                      <span className="pointer-events-none absolute inset-y-0 -left-4 w-4 bg-gradient-to-l from-surface to-transparent" aria-hidden="true" />
                      <strong className="ml-1 font-mono font-semibold tabular-nums text-ink-900">{items.data?.total ?? 0}</strong>
                      <span className="ml-0.5">items</span>
                      {preset === "verified" && <span className="ml-1 font-medium text-deal">· verified</span>}
                    </div>
                  </div>
                );
              })()}

              {/* 40px thin filter bar (hides price/method filters that do not apply to the current channel) */}
              <div
                className={
                  "feed-controls border-b border-ink-200 bg-surface-hover px-3.5 py-2.5 sm:px-6 sm:py-2 " +
                  (mobileFilterBar ? "block" : "hidden sm:block")
                }
              >
                <div className="flex flex-wrap items-center gap-1">
                  {/* Category multi-select popover (expand to see all categories) */}
                  <div className="filter-category relative" ref={catRef}>
                    <button
                      type="button"
                      onClick={() => setCatOpen((v) => !v)}
                      className={
                        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors " +
                        (categories.length
                          ? "border-ink-950 bg-ink-950 font-medium text-white"
                          : "border-ink-200 bg-surface text-ink-700 hover:border-ink-300")
                      }
                    >
                      <span>
                        {categories.length === 0
                          ? "Category"
                          : categories.length === 1
                            ? `Category: ${categoryLabelForPreset(categories[0]!, preset)}`
                            : `Category: ${categories.length} selected`}
                      </span>
                      <ChevronDown size={12} />
                    </button>
                    {catOpen && (
                      <div className="pop-enter panel absolute top-full left-0 z-40 mt-1.5 w-[260px] p-2.5 shadow-lg">
                        <div className="mb-2 flex items-center justify-between text-[11px] text-ink-500">
                          <span>{preset === "news" ? "News sections (multi-select)" : preset === "info" ? "Industry news sections (multi-select)" : preset === "deal" ? "Deal categories (multi-select)" : preset === "opensource" ? "Open source areas (multi-select)" : "Freebie categories (multi-select)"}</span>
                          {categories.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setCategories([])}
                              className="font-medium text-accent hover:underline"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                        <div className="grid max-h-[240px] grid-cols-2 gap-1 overflow-auto">
                          {(() => {
                            const countMap = new Map((stats.data?.byCategory ?? []).map((c) => [c.category ?? "other", c.n]));
                            const allowed = categoriesForPreset(preset);
                            const ordered = [...allowed].sort((a, b) => (countMap.get(b) ?? 0) - (countMap.get(a) ?? 0));
                            return ordered.map((key) => {
                              const n = countMap.get(key) ?? 0;
                              const checked = categories.includes(key);
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  onClick={() =>
                                    setCategories((cur) =>
                                      cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key],
                                    )
                                  }
                                  className={
                                    "flex items-center justify-between rounded border px-2 py-1 text-left text-[11.5px] transition-colors " +
                                    (checked
                                      ? "border-ink-950 bg-ink-950 font-medium text-white"
                                      : n > 0
                                        ? "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100"
                                        : "border-ink-100 bg-canvas/70 text-ink-400 hover:bg-ink-100")
                                  }
                                >
                                  <span className="truncate">{categoryLabelForPreset(key, preset)}</span>
                                  <span className={"ml-1 font-mono text-[10.5px] " + (checked ? "text-white/70" : "text-ink-400")}>
                                    {n}
                                  </span>
                                </button>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Content type filter */}
                  {advancedFilters && <select
                    value={kindFilter}
                    onChange={(e) => setKindFilter(e.target.value)}
                    className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-[11.5px] text-ink-700 outline-none focus:border-accent"
                    title="Content type"
                  >
                    <option value="auto">Type: {preset === "verified" ? "freebies" : preset === "deal" ? "deals" : preset === "opensource" ? "open source" : preset === "news" ? "top news" : preset === "info" ? "industry news" : "all"}</option>
                    <option value="all">Type: all (including other)</option>
                    {KIND_ORDER.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>}

                  {/* Language filter */}
                  <select
                    value={lang}
                    onChange={(e) => setLang(e.target.value as "all" | "zh" | "en")}
                    className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-[11.5px] text-ink-700 outline-none focus:border-accent"
                    title="Filter by title language"
                  >
                    <option value="all">Language: all</option>
                    <option value="zh">Chinese only</option>
                    <option value="en">English only</option>
                  </select>

                  {preset !== "news" && preset !== "info" && preset !== "opensource" && (
                    <>
                      <select
                        value={priceCap}
                        onChange={(e) => setPriceCap(e.target.value)}
                        className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-[11.5px] text-ink-700 outline-none focus:border-accent"
                        title="Price cap"
                      >
                        <option value="auto">
                          Price: any
                        </option>
                        <option value="all">Price: any</option>
                        <option value="free">Free only (¥0)</option>
                        <option value="5">≤ ¥5</option>
                        <option value="10">≤ ¥10</option>
                        <option value="30">≤ ¥30</option>
                        <option value="100">≤ ¥100</option>
                      </select>

                      {advancedFilters && <select
                        value={obtain}
                        onChange={(e) => setObtain(e.target.value)}
                        className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-[11.5px] text-ink-700 outline-none focus:border-accent"
                        title={OBTAIN_HINT[obtain] ?? "How to get it"}
                      >
                        <option value="auto">
                          How to get: {preset === "verified" ? "free + conditions" : "any"}
                        </option>
                        <option value="all">How to get: all (incl. lottery / trial)</option>
                        <option value="free">Direct free grab only</option>
                        <option value="conditional">Has conditions</option>
                        <option value="lottery">Lottery / draw</option>
                        <option value="trial">Free trial</option>
                        <option value="promo">Promo / traffic bait</option>
                      </select>}
                    </>
                  )}

                  <select
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-[11.5px] text-ink-700 outline-none focus:border-accent"
                    title="Published within"
                  >
                    <option value="auto">
                      Time: {preset === "verified" ? "last 7 days" : "any"}
                    </option>
                    <option value="all">Time: any</option>
                    <option value="1d">Last 24 hours</option>
                    <option value="3d">Last 3 days</option>
                    <option value="7d">Last week</option>
                    <option value="30d">Last month</option>
                  </select>

                  {advancedFilters && <select
                    value={minScore}
                    onChange={(e) => setMinScore(e.target.value)}
                    className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-[11.5px] text-ink-700 outline-none focus:border-accent"
                    title="Minimum score"
                  >
                    <option value="all">Score: any</option>
                    <option value="50">Score ≥ 50</option>
                    <option value="60">Score ≥ 60</option>
                    <option value="70">Score ≥ 70</option>
                  </select>}
                  <button type="button" aria-label={advancedFilters ? "Hide advanced filters" : "Advanced filters"} aria-expanded={advancedFilters} onClick={() => setAdvancedFilters((v) => !v)} className="inline-flex items-center gap-1 rounded-md px-2 text-[12px] font-medium text-accent hover:bg-brand-subtle">
                    <SlidersHorizontal size={12} /> {advancedFilters ? "Hide advanced filters" : "Advanced filters"}
                    {(kindFilter !== "auto" || obtain !== "auto" || minScore !== "all") && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="Advanced filters are active" />}
                  </button>

                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-[11.5px] text-ink-700 outline-none focus:border-accent"
                    title="Sort order"
                  >
                    <option value="newest">Newest</option>
                    <option value="score">Top score</option>
                    <option value="oldest">Oldest</option>
                    <option value="expiring">Ending soon</option>
                    {preset !== "news" && preset !== "info" && <option value="price_asc">Lowest price</option>}
                  </select>

                  <button
                    type="button"
                    aria-pressed={unreadOnly}
                    onClick={() => setUnreadOnly((v) => !v)}
                    className={
                      "h-7 rounded-md border px-2.5 text-[12px] font-medium transition-colors active:scale-[0.97] " +
                      (unreadOnly
                        ? "border-ink-950 bg-ink-950 text-white"
                        : "border-ink-200 bg-surface text-ink-600 hover:border-ink-300")
                    }
                  >
                    Unread
                  </button>
                  {viewMode === "compact" && <button type="button" aria-pressed={showRowSummary} onClick={toggleRowSummary}
                    className={"inline-flex items-center gap-1 rounded-md border px-2.5 text-[12px] font-medium " + (showRowSummary ? "border-brand-border bg-brand-subtle text-accent" : "border-ink-200 bg-surface text-ink-600")}
                    title="Expand or collapse the AI summary on each item without changing the filter results">Show summary</button>}

                  {visible.some((i) => !i.read) && (
                    <button
                      type="button"
                      onClick={() => void markVisibleRead()}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-200 bg-surface px-2 text-[12px] font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950 active:scale-[0.97]"
                      title="Mark every unread item in the current list as read at once"
                    >
                      <CheckCheck size={12} /> Mark read
                    </button>
                  )}

                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-accent hover:bg-brand-subtle"
                    >
                      <RotateCcw size={11} /> Reset ({activeFilterCount})
                    </button>
                  )}

                  {/* Stats and view switch on the right */}
                  <div className="ml-auto hidden shrink-0 items-center gap-2 sm:flex">
                    <span className="text-[12px] text-ink-500">
                      {items.loading ? (
                        <span className="inline-flex items-center gap-1">
                          <Loader2 size={11} className="animate-spin" /> Loading...
                        </span>
                      ) : (
                        <>
                          <strong className="font-mono font-semibold tabular-nums text-ink-900">{items.data?.total ?? 0}</strong> items
                        </>
                      )}
                    </span>
                    <div className="flex items-center gap-0.5 rounded-md border border-ink-200 bg-surface p-0.5">
                      {[
                        { key: "compact" as const, icon: AlignJustify, label: "Compact list, good for quick scanning", text: "List" },
                        { key: "grid2" as const, icon: LayoutGrid, label: "Two-column card grid", text: "2 col" },
                        { key: "grid3" as const, icon: LayoutGrid, label: "Three-column card grid", text: "3 col" },
                      ].map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          onClick={() => updateViewMode(v.key)}
                          className={
                            "inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-medium transition-colors " +
                            (viewMode === v.key ? "bg-ink-950 text-white" : "text-ink-500 hover:text-ink-950")
                          }
                          title={v.label}
                        >
                          <v.icon size={12} />
                          <span>{v.text}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Mobile: quick views and sources fold into this panel, after the filter bar */}
                {tab === "feed" && (
                  <div className="mt-2.5 space-y-3 border-t border-ink-200 pt-2.5 lg:hidden">{sourcePanelNode}</div>
                )}

                {activeFilterCount > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-ink-100 pt-2 text-[11.5px]">
                    <span className="text-ink-400">Active filters:</span>
                    {debounced && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearch("");
                          setDebounced("");
                        }}
                        className="rounded bg-ink-100 px-2 py-0.5 text-ink-700 hover:bg-ink-200"
                      >
                        Search: {debounced} ×
                      </button>
                    )}
                    {source && (
                      <button
                        type="button"
                        onClick={() => setSource("")}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        Source: {sourceName(source)} ×
                      </button>
                    )}
                    {categories.map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategories((cur) => cur.filter((x) => x !== cat))}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        Category: {categoryLabelForPreset(cat, preset)} ×
                      </button>
                    ))}
                    {lang !== "all" && (
                      <button
                        type="button"
                        onClick={() => setLang("all")}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        Language: {lang === "zh" ? "Chinese only" : "English only"} ×
                      </button>
                    )}
                    {priceCap !== "auto" && (
                      <button
                        type="button"
                        onClick={() => setPriceCap("auto")}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        Price: {priceCap === "all" ? "any" : priceCap === "free" ? "free only" : `≤ ¥${priceCap}`} ×
                      </button>
                    )}
                    {obtain !== "auto" && (
                      <button
                        type="button"
                        onClick={() => setObtain("auto")}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        How to get: {obtain === "all" ? "all" : (OBTAIN_LABEL[obtain] ?? obtain)} ×
                      </button>
                    )}
                    {range !== "auto" && (
                      <button
                        type="button"
                        onClick={() => setRange("auto")}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        Time: {range === "all" ? "any" : range} ×
                      </button>
                    )}
                    {minScore !== "all" && (
                      <button
                        type="button"
                        onClick={() => setMinScore("all")}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        Score: ≥{minScore} ×
                      </button>
                    )}
                    {kindFilter !== "auto" && <button type="button" onClick={() => setKindFilter("auto")} className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70">Type: {kindFilter === "all" ? "all" : KIND_LABEL[kindFilter]} ×</button>}
                    {unreadOnly && (
                      <button
                        type="button"
                        onClick={() => setUnreadOnly(false)}
                        className="rounded bg-brand-subtle px-2 py-0.5 text-accent hover:bg-ink-200/70"
                      >
                        Unread only ×
                      </button>
                    )}
                    <button type="button" onClick={resetFilters} className="ml-auto font-medium text-accent hover:underline">Clear filters</button>
                  </div>
                )}
              </div>
              {activeFilterCount > 0 && !mobileFilterBar && <div className="flex items-center justify-between gap-3 border-b border-ink-100 bg-brand-subtle/40 px-3.5 py-2 text-[12px] sm:hidden">
                <button type="button" onClick={() => setMobileFilterBar(true)} className="min-w-0 truncate text-ink-700">{activeFilterCount} filters active{source ? ` · ${sourceName(source)}` : ""}{categories.length ? ` · ${categories.map((cat) => categoryLabelForPreset(cat, preset)).join(", ")}` : ""} · view filters</button>
                <button type="button" onClick={resetFilters} className="shrink-0 font-medium text-accent">Clear</button>
              </div>}


              {items.error && (
                <div role="alert" className="mx-3.5 my-3 rounded-lg border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert sm:mx-6">
                  Failed to load: {items.error} <button type="button" onClick={items.reload} className="ml-2 underline">Reload</button>
                </div>
              )}
              {items.loading && !visible.length && <div role="status" aria-label="Loading resources" className="divide-y divide-ink-100">
                {Array.from({ length: 5 }, (_, index) => <div key={index} className="flex items-center gap-4 px-6 py-5">
                  <div className="h-4 w-9 rounded bg-ink-100" /><div className="flex-1 space-y-2"><div className="h-3 w-2/3 rounded bg-ink-100" /><div className="h-2.5 w-1/3 rounded bg-ink-100" /></div>
                </div>)}
              </div>}

              {viewMode === "compact" ? (
                <div key={`compact-${preset}`} className="list-enter">
                  {visible.map((item) => (
                    <Fragment key={item.id}>
                      <CompactRow
                        item={item}
                        showSummary={showRowSummary}
                        sourceName={sourceName}
                        selected={detail?.id === item.id}
                        onPatch={patch}
                        onOpen={setDetail}
                        onQuickBlock={setQuickBlock}
                        onCopyCode={copyCode}
                        expanded={relatedOpen === item.id}
                        onToggleRelated={(id) => setRelatedOpen((cur) => (cur === id ? null : id))}
                      />
                      {relatedOpen === item.id && relatedMap[item.id] ? (
                        <div className="pop-enter border-b border-ink-100 bg-surface-hover px-3.5 py-2 sm:px-6">
                          <div className="mb-1 text-[11px] font-medium text-ink-500">
                            {relatedMap[item.id]!.length} more sources covering the same event / freebie
                          </div>
                          <ul className="space-y-1">
                            {relatedMap[item.id]!.map((r) => (
                              <li key={r.id} className="flex items-center gap-2 text-[12px]">
                                <span className="w-20 shrink-0 truncate text-ink-500 sm:w-28">{r.sourceName ?? r.source_id}</span>
                                <a
                                  href={r.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="truncate text-ink-700 hover:text-accent hover:underline"
                                >
                                  {r.title}
                                </a>
                                <span className="shrink-0 font-mono text-[11px] text-ink-400">
                                  {String(r.first_seen_at).slice(5, 16).replace("T", " ")}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </Fragment>
                  ))}
                </div>
              ) : (
                <div
                  key={`grid-${preset}-${viewMode}`}
                  className={
                    "list-enter " +
                    (viewMode === "grid3"
                      ? "grid grid-cols-1 gap-3.5 px-3.5 py-3 md:grid-cols-2 xl:grid-cols-3 sm:px-6 sm:py-4"
                      : "grid grid-cols-1 gap-3.5 px-3.5 py-3 md:grid-cols-2 sm:px-6 sm:py-4")
                  }
                >
                  {visible.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      sourceName={sourceName}
                      onPatch={patch}
                      onOpen={setDetail}
                      onQuickBlock={setQuickBlock}
                      onCopyCode={copyCode}
                      expanded={relatedOpen === item.id}
                      relatedItems={relatedOpen === item.id ? relatedMap[item.id] : undefined}
                      onToggleRelated={(id) => setRelatedOpen((cur) => (cur === id ? null : id))}
                    />
                  ))}
                </div>
              )}

              {!items.loading && !items.error && !visible.length && (
                preset === "pan" ? (
                  <div className="relative min-h-[520px]">
                    {/* Background sample items: only there to suggest what the channel looks like; all placeholder copy, no real resources */}
                    <div className="pointer-events-none select-none opacity-55 blur-[0.6px]" aria-hidden="true">
                      {PAN_DEMO_ROWS.map((row, i) => (
                        <div key={i} className="flex items-start gap-3 border-b border-ink-100 px-6 py-4">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-300" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[14px] text-ink-900">{row.title}</div>
                            <div className="mt-1 text-[11.5px] text-ink-400">{row.meta}</div>
                          </div>
                          <span className="shrink-0 font-mono text-[11px] text-ink-300">{row.score}</span>
                        </div>
                      ))}
                    </div>
                    {/* The explainer card floats above the sample list */}
                    <div className="absolute inset-0 flex items-start justify-center bg-gradient-to-b from-surface/35 via-surface/70 to-surface px-4 pt-10 sm:pt-16">
                      <div className="w-full max-w-xl rounded-lg border border-ink-200 bg-surface p-6 shadow-sm">
                        <div className="flex items-center gap-2 text-[15px] font-medium text-ink-900">
                          <FolderOpen size={16} className="text-ink-400" />
                          Cloud drives / courses are disabled on the public demo site
                        </div>
                        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-500">
                          This channel aggregates third-party cloud-drive share links, and showing them publicly carries copyright risk, so the demo site neither collects nor displays this content. The background items are placeholders, not real resources.
                        </p>
                        <div className="mt-4 border-t border-ink-100 pt-4">
                          <div className="text-[12px] font-medium text-ink-700">Capabilities (can be enabled on a self-hosted install)</div>
                          <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-ink-500">
                            <li>· Multi-source collection: TG channels, linux.do, RSS, GitHub Releases</li>
                            <li>· AI semantic sorting: automatically recognizes cloud-drive files, online courses, film and TV series</li>
                            <li>· A message with several resources is split into separate entries, and channel prefixes are stripped from titles</li>
                          </ul>
                        </div>
                        <a href={REPO_URL} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand hover:underline">
                          View the self-hosting docs →
                        </a>
                      </div>
                    </div>
                  </div>
                ) : (
                <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
                  <Radar size={28} className="text-ink-300" />
                  <div className="text-[15px] font-medium text-ink-900">{preset === "hidden" ? "Nothing dismissed yet" : preset === "starred" ? "No saved items match" : "Nothing matches the current filters"}</div>
                  <p className="max-w-md text-[12.5px] leading-relaxed text-ink-500">
                    {preset === "hidden" ? "Items you mark as not interested in the list show up here, and you can restore them later." : preset === "starred" ? "Click the star next to an item to save it; if saved items are missing, try clearing the filters first." : `"${PRESETS.find((p) => p.key === preset)?.label ?? "This channel"}" has no matching results yet - clear the filters or browse all items.`}
                  </p>
                  <div className="flex gap-2">
                    {activeFilterCount > 0 && <button type="button" onClick={resetFilters} className="rounded-md border border-ink-200 px-4 py-2 text-[12.5px] font-medium text-ink-700 hover:bg-ink-100">Clear filters</button>}
                    <button type="button" onClick={() => { resetFilters(); setPreset("all"); }} className="rounded-md bg-brand px-4 py-2 text-[12.5px] font-medium text-white hover:bg-brand-hover">Browse all items</button>
                  </div>
                </div>
                )
              )}
            </>
          )}

          {tab === "hot" && (
            <HotPanel
              report={hot.data}
              loading={hot.loading}
              error={hot.error}
              hours={hotHours}
              scope={hotScope}
              onHours={setHotHours}
              onScope={setHotScope}
              onReload={hot.reload}
              onSearchWord={(w) => {
                setSearch(w);
                switchPreset(hotScope === "news" ? "news" : hotScope === "info" ? "info" : hotScope === "deals" ? "verified" : "all");
                setTab("feed");
              }}
              onJumpCategory={(cat) => {
                const targetPreset =
                  hotScope === "news" || cat === "headline" || cat === "world"
                    ? "news"
                    : hotScope === "info" || cat === "stock" || cat === "tech" || cat === "finance"
                      ? "info"
                      : "all";
                switchPreset(targetPreset);
                setCategories([cat]);
                setTab("feed");
              }}
              onOpenItem={async (id) => {
                const found = items.data?.items?.find((it) => it.id === id);
                if (found) {
                  setDetail(found);
                  return;
                }
                try {
                  const res = await fetch("/api/items/" + id);
                  if (res.ok) {
                    const item = (await res.json()) as Item;
                    setDetail(item);
                    return;
                  }
                } catch {
                  /* fall back to the resource stream */
                }
                setTab("feed");
              }}
              sourceName={sourceName}
            />
          )}

          {tab === "digest" && (
            <DigestPanel
              digests={digests.data?.digests ?? []}
              detail={digestDetail}
              pickedDate={pickedDate}
              onPickDate={setPickedDate}
              canAdmin={adminReady}
              onRunDaily={async () => {
                notify("Generating today's digest...");
                const res = await fetch("/api/digests/run", { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as { date?: string; count?: number; error?: string };
                if (!res.ok) notify(data.error ?? "Could not generate");
                else notify(`Generated ${data.count ?? 0} digest items`);
                digests.reload();
                setPickedDate(res.ok && data.date ? data.date : null);
                digestDetail.reload();
              }}
              sourceName={sourceName}
              onPatch={patch}
              onOpen={setDetail}
              onQuickBlock={setQuickBlock}
              onCopyCode={copyCode}
              onRunWeekly={async () => {
                notify("Summarizing this week's digest...");
                const res = await fetch("/api/digests/weekly", { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as { date?: string; count?: number; error?: string; pushed?: boolean };
                if (!res.ok) notify(data.error ?? "Could not generate");
                else notify(`Weekly digest generated with ${data.count ?? 0} items${data.pushed ? ", sent to Telegram" : ""}`);
                digests.reload();
                setPickedDate(res.ok && data.date ? data.date : null);
                digestDetail.reload();
              }}
            />
          )}

          {(adminReady || me) && tab === "rules" && (
            <RulesPanel
              allowRegex={adminReady}
              subscriptions={subs.data?.subscriptions ?? []}
              rules={blockRules.data?.rules ?? []}
              presets={blockRules.data?.presets ?? []}
              totalBlocked={blockRules.data?.totalBlocked ?? 0}
              sources={sources.data?.sources ?? []}
              blockedPreview={blockedPreview}
              sourceName={sourceName}
              onAddSub={addSubscription}
              onRemoveSub={removeSubscription}
              onJumpToSubscribed={(kw) => {
                setSearch(kw);
                setPreset("all");
                setTab("feed");
              }}
              onAddRule={addRule}
              onImportPresets={async () => {
                const res = await fetch(rulesBase + "/block-rules", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ presets: true }),
                });
                if (!res.ok) { notify("Could not import the block words"); return; }
                blockRules.reload();
                items.reload();
                stats.reload();
                notify("Imported the common noise block words");
              }}
              onToggleRule={async (id, enabled) => {
                const res = await fetch(rulesBase + "/block-rules/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ enabled }),
                });
                if (!res.ok) { notify("Could not update the rule"); return; }
                blockRules.reload();
                items.reload();
                setBlockedPreview(null);
              }}
              onDeleteRule={async (id) => {
                const res = await fetch(rulesBase + "/block-rules/" + id, { method: "DELETE" });
                if (!res.ok) { notify("Could not delete the rule"); return; }
                blockRules.reload();
                items.reload();
                stats.reload();
                setBlockedPreview(null);
                notify("Rule deleted; the affected items are visible again");
              }}
              onLoadBlockedPreview={async () => {
                const res = await fetch("/api/items?includeBlocked=1&limit=80&sort=newest");
                const data = (await res.json()) as { items: Item[] };
                setBlockedPreview(data.items);
              }}
            />
          )}

          {pushBase && tab === "push" && (
            <PushPanel
              payload={push.data}
              preview={pushPreview}
              logs={pushLogs.data?.logs ?? []}
              sources={sources.data?.sources ?? []}
              onSave={async (p: Partial<PushSettings>) => {
                const res = await fetch(pushBase ?? "/api/push", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(p),
                });
                if (!res.ok) {
                  const error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save";
                  notify(error);
                  throw new Error(error);
                }
                push.reload();
                setPushPreview(null);
                notify("Push rules saved");
              }}
              onPreview={async () => {
                const res = await fetch((pushBase ?? "/api/push") + "/preview?limit=6");
                if (!res.ok) { notify("Could not run the preview. Please try again later."); return; }
                setPushPreview((await res.json()) as PushPreview);
              }}
              onFlush={async () => {
                const res = await fetch((pushBase ?? "/api/push") + "/flush", { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as { sent?: number; queued?: number; error?: string };
                if (!res.ok) { notify(data.error ?? "Could not send"); return; }
                notify(`Sent ${data.sent ?? 0} items, ${data.queued ?? 0} still queued`);
                push.reload();
                pushLogs.reload();
                setPushPreview(null);
              }}
              onTest={async () => {
                const res = await fetch((pushBase ?? "/api/push") + "/test", { method: "POST" });
                const data = await res.json().catch(() => ({})) as { error?: string };
                notify(res.ok ? "Test message sent to the current channel" : data.error ?? "Push is not enabled or the credentials are missing");
                pushLogs.reload();
              }}
            />
          )}

          {adminReady && tab === "ai" && (
            <AiPanel
              data={ai.data}
              sources={sources.data?.sources ?? []}
              reload={ai.reload}
              onNotify={notify}
              sourceName={sourceName}
              onOpenItem={async (id) => {
                const found = items.data?.items?.find((it) => it.id === id);
                if (found) {
                  setDetail(found);
                  return;
                }
                try {
                  const res = await fetch("/api/items/" + id);
                  if (res.ok) {
                    const item = (await res.json()) as Item;
                    setDetail(item);
                  }
                } catch {
                  /* ignore */
                }
              }}
            />
          )}

          {me && tab === "me" && bootData && <UserPushPanel key={me.id} boot={bootData} />}
          {adminReady && tab === "ops" && <SiteAdminPanel />}
          {adminReady && tab === "ops" && (
            <OpsPanel
              onClassificationChanged={() => { refreshAll(); hot.reload(); digestDetail.reload(); }}
              sources={sources.data?.sources ?? []}
              runs={runs.data?.runs ?? []}
              sourceName={sourceName}
              onCollectSource={async (id) => {
                const isCookieSite = id === "zhihu-search" || id === "xhs-search" || id === "xiaoheihe-search";
                notify(isCookieSite ? "Collecting through the VPS cookie (takes about 15-40 seconds)..." : "Collecting...");
                const res = await fetch(`/api/sources/${id}/collect`, { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as {
                  ok?: boolean;
                  error?: string;
                  summary?: { inserted: number; fetched: number; status: string };
                };
                if (!res.ok || data.ok === false || data.summary?.status === "failed") {
                  notify(data.error ?? "Collection failed");
                } else {
                  notify(`Done: fetched ${data.summary?.fetched ?? 0}, added ${data.summary?.inserted ?? 0}`);
                }
                refreshAll();
              }}
              onToggleSource={async (id, enabled) => {
                await fetch("/api/sources/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ enabled }),
                });
                sources.reload();
                notify(enabled ? "Source enabled" : "Source disabled");
              }}
              onChangeInterval={async (id, sec) => {
                await fetch("/api/sources/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ interval_sec: sec }),
                });
                sources.reload();
                notify("Collection interval changed to " + formatInterval(sec));
              }}
              onAddRss={async (name, url, intervalSec, kindHint, categoryHint, fixedCategory) => {
                notify("Adding the source and running a test collection...");
                const res = await fetch("/api/sources", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name, url, intervalSec, kindHint, categoryHint, fixedCategory }),
                });
                const data = (await res.json().catch(() => ({}))) as {
                  error?: string;
                  summary?: { fetched: number; inserted: number; status: string; error?: string };
                };
                if (!res.ok) notify(data.error ?? "Could not add");
                else if (data.summary?.status === "failed") notify("Added, but the first collection failed: " + (data.summary.error ?? ""));
                else notify(`Added; fetched ${data.summary?.fetched ?? 0} items, added ${data.summary?.inserted ?? 0}`);
                refreshAll();
              }}
              onUpdateSource={async (id, patch) => {
                const res = await fetch("/api/sources/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(patch),
                });
                const data = (await res.json().catch(() => ({}))) as { error?: string; reclassified?: number };
                if (!res.ok) {
                  notify(data.error ?? "Could not save");
                  return false;
                }
                // Commit the acknowledged config locally before closing/reopening the editor.
                // A background refresh must not make immediate re-edit show the previous values.
                sources.update((current) => current ? { ...current, sources: current.sources.map((source) => source.id === id ? { ...source, ...patch } : source) } : current);
                refreshAll();
                hot.reload();
                digestDetail.reload();
                notify(data.reclassified ? `Config updated; ${data.reclassified} existing items were reclassified` : "Source config updated");
                return true;
              }}
              onDeleteSource={async (id) => {
                const res = await fetch("/api/sources/" + id, { method: "DELETE" });
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                if (!res.ok) {
                  notify(data.error ?? "Could not delete");
                  return false;
                }
                refreshAll();
                notify("Custom source deleted");
                return true;
              }}
              onNotify={notify}
            />
          )}
          </Suspense>
        </main>

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-3.5 py-3 text-[11.5px] text-ink-400 sm:px-6">
          <span>Resource Radar · Multi-source aggregation · AI semantic sorting · What you filter is what gets pushed</span>
          <span className="font-mono tabular-nums">
            {stats.data?.totals.active ?? 0} items in the library · {stats.data?.totals.unread ?? 0} unread
          </span>
          <span className="w-full text-[11px] leading-relaxed text-ink-400/80">
            This site only aggregates resource titles and original links from public channels; it stores, proxies and re-hosts no files. If a rights holder considers the content infringing, please contact us for removal and we will take it down as soon as we receive the notice.
          </span>
        </footer>
      </div>

      {detail && (
        <ItemDetailDrawer
          item={detail}
          loading={detailLoading}
          error={detailError}
          onRetry={() => setDetailNonce((n) => n + 1)}
          sourceName={sourceName}
          hasPrev={currentIndex > 0}
          hasNext={currentIndex >= 0 && currentIndex < visible.length - 1}
          onPrev={() => currentIndex > 0 && setDetail(visible[currentIndex - 1] ?? null)}
          onNext={() => currentIndex >= 0 && currentIndex < visible.length - 1 && setDetail(visible[currentIndex + 1] ?? null)}
          onClose={() => setDetail(null)}
          onPatch={patch}
          onClassificationSave={adminReady ? async (id, update) => {
            const response = await fetch(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
            const result = await response.json() as { error?: string };
            if (!response.ok) throw new Error(result.error ?? "Could not save the classification");
            // A fresh detail carries personal state and manual metadata without crossing user/admin scopes.
            const fullResponse = await fetch(`/api/items/${id}`);
            if (fullResponse.ok) {
              const full = await fullResponse.json() as Item;
              setDetail((current) => current?.id === id ? full : current);
            }
            refreshAll(); hot.reload(); digestDetail.reload();
          } : undefined}
          onQuickBlock={setQuickBlock}
          onCopyCode={copyCode}
        />
      )}

      {quickBlock && (
        <QuickBlockModal
          item={quickBlock}
          sourceName={sourceName}
          onClose={() => setQuickBlock(null)}
          onIgnoreOne={(id) => patch(id, { status: "ignored" })}
          onAddRule={quickBlockAdd}
        />
      )}

      <Toast message={toast} />

      {welcomeOpen && bootData && (
        <WelcomeModal
          boot={bootData}
          onClose={closeWelcome}
          onLogin={() => {
            closeWelcome();
            setAuthHash(null);
            setAuthOpen(true);
          }}
        />
      )}

      {authOpen && bootData && (
        <AuthModal
          boot={bootData}
          initialHash={authHash}
          onClose={() => setAuthOpen(false)}
          onDone={() => {
            setAuthOpen(false);
            boot.reload();
            setTimeout(() => {
              items.reload();
              stats.reload();
            }, 300);
          }}
        />
      )}

      {rssOpen && bootData && <RssModal boot={bootData} currentQuery={query} onClose={() => setRssOpen(false)} />}
    </div>
  );
}
