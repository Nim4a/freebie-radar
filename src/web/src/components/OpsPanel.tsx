import { Fragment, useEffect, useRef, useState } from "react";
import { Activity, Check, Copy, Database, ExternalLink, Gauge, KeyRound, Loader2, Pencil, Play, Plus, Rss, Search, ShieldCheck, Trash2, X } from "lucide-react";
import {
  CATEGORY_LABEL,
  KIND_LABEL,
  KIND_ORDER,
  categoryOptionGroups,
  formatInterval,
  timeAgo,
} from "../lib/sources.ts";
import type { RetentionSettings, Run, Source, SourceQuality } from "../types.ts";
import { DEFAULT_FIXED_CATEGORIES } from "../../../shared/source-classification.ts";
import { ClassificationPanel } from "./ClassificationPanel.tsx";

const INTERVAL_OPTIONS = [
  { label: "60s", sec: 60 },
  { label: "90s", sec: 90 },
  { label: "2 min", sec: 120 },
  { label: "5 min", sec: 300 },
  { label: "15 min", sec: 900 },
  { label: "30 min", sec: 1800 },
  { label: "1 hr", sec: 3600 },
  { label: "6 hr", sec: 21600 },
];

/** Kind dropdown: from shared/taxonomy.ts, same source as push and home */
const KIND_HINT_OPTIONS = [
  { value: "", label: "Kind: auto-detect" },
  ...KIND_ORDER.map((key) => ({ value: key, label: `Kind: ${KIND_LABEL[key]}` })),
];

/** Category dropdown grouped by major category, covering every category (previously only 13 were listed, so cloud drives, courses and carpools could not be picked) */
const CATEGORY_HINT_GROUPS = categoryOptionGroups();

function categoryHintLabel(value: string): string {
  return value ? (CATEGORY_LABEL[value as keyof typeof CATEGORY_LABEL] ?? value) : "Auto-detect";
}

/**
 * The category/kind currently in effect for a source (as display labels): source level first, then the hint on the feed / channel.
 * When values differ, show "first +N" so a multi-column source is not described as a single category.
 */
function sourceHints(source: Source): { category: string; kind: string } {
  const cfg = source.config ?? {};
  const feeds = Array.isArray(cfg.feeds) ? (cfg.feeds as Array<Record<string, unknown>>) : [];
  const channels = Array.isArray(cfg.channels) ? (cfg.channels as unknown[]) : [];
  const pick = (key: "categoryHint" | "kindHint"): string => {
    const values = [
      cfg[key],
      ...feeds.map((f) => f?.[key]),
      ...channels.map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>)[key] : undefined)),
    ]
      .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
      .map((v) => v.trim());
    const unique = [...new Set(values)];
    if (!unique.length) return "";
    const labelOf = (v: string) => (key === "categoryHint" ? categoryHintLabel(v) : (KIND_LABEL[v] ?? v));
    if (unique.length === 1) return labelOf(unique[0]!);
    return `${labelOf(unique[0]!)} +${unique.length - 1}`;
  };
  const fixed = typeof cfg.fixedCategory === "string" ? cfg.fixedCategory : DEFAULT_FIXED_CATEGORIES[source.id];
  return { category: fixed ? `Fixed · ${categoryHintLabel(fixed)}` : pick("categoryHint"), kind: pick("kindHint") };
}

type OpsTab = "sources" | "runs" | "quality" | "retention";
type FeedRow = {
  url: string;
  limit: string;
  categoryHint: string;
  kindHint: string;
  titleKeywords: string;
  excludeTitleKeywords: string;
  includeCategories: string;
  excludeCategories: string;
};

function feedToRow(feed: Record<string, unknown>): FeedRow {
  return {
    url: typeof feed.url === "string" ? feed.url : "",
    limit: typeof feed.limit === "number" ? String(feed.limit) : "30",
    categoryHint: typeof feed.categoryHint === "string" ? feed.categoryHint : "",
    kindHint: typeof feed.kindHint === "string" ? feed.kindHint : "",
    titleKeywords: Array.isArray(feed.titleKeywords) ? (feed.titleKeywords as string[]).join(", ") : "",
    excludeTitleKeywords: Array.isArray(feed.excludeTitleKeywords) ? (feed.excludeTitleKeywords as string[]).join(", ") : "",
    includeCategories: Array.isArray(feed.includeCategories) ? (feed.includeCategories as string[]).join(", ") : "",
    excludeCategories: Array.isArray(feed.excludeCategories) ? (feed.excludeCategories as string[]).join(", ") : "",
  };
}

const EMPTY_FEED_ROW: FeedRow = { url: "", limit: "30", categoryHint: "", kindHint: "", titleKeywords: "", excludeTitleKeywords: "", includeCategories: "", excludeCategories: "" };

function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Category dropdown: grouped by major category, covering every category; unknown legacy values still display as-is */
function CategoryHintSelect({
  value,
  onChange,
  className,
  emptyLabel = "Category: auto-detect",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  const known = Boolean(value && value in CATEGORY_LABEL);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-label={ariaLabel}>
      <option value="">{emptyLabel}</option>
      {value && !known && <option value={value}>{value}(unknown category)</option>}
      {CATEGORY_HINT_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((opt) => (
            <option key={opt.value} value={opt.value} title={opt.desc}>
              {opt.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function SourceInlineEditor({
  source,
  onSave,
  onDelete,
  onCancel,
}: {
  source: Source;
  onSave: (patch: { name: string; interval_sec: number; config: Record<string, unknown> }) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  onCancel: () => void;
}) {
  const cfg = source.config ?? {};
  const feeds = Array.isArray(cfg.feeds) ? (cfg.feeds as Array<Record<string, unknown>>) : [];
  const channels = Array.isArray(cfg.channels) ? (cfg.channels as unknown[]).filter((c) => typeof c === "string") : [];

  const [name, setName] = useState(source.name);
  const [intervalSec, setIntervalSec] = useState(source.interval_sec);
  const [kindHint, setKindHint] = useState(typeof cfg.kindHint === "string" ? cfg.kindHint : "");
  const [categoryHint, setCategoryHint] = useState(typeof cfg.categoryHint === "string" ? cfg.categoryHint : "");
  const [fixedCategory, setFixedCategory] = useState(typeof cfg.fixedCategory === "string" ? cfg.fixedCategory : DEFAULT_FIXED_CATEGORIES[source.id] ?? "");
  const [feedRows, setFeedRows] = useState<FeedRow[]>(() =>
    feeds.length ? feeds.map(feedToRow) : [{ ...EMPTY_FEED_ROW }],
  );
  const [tgChannels, setTgChannels] = useState(channels.join(", "));
  const [showJson, setShowJson] = useState(source.kind !== "rss" && source.kind !== "telegram" && source.kind !== "linuxdo");
  const [rawJson, setRawJson] = useState(() => JSON.stringify(cfg, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const buildNextConfig = (): Record<string, unknown> | null => {
    setJsonErr(null);
    let base: Record<string, unknown>;
    if (showJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setJsonErr("JSON must be an object {}");
          return null;
        }
        base = parsed as Record<string, unknown>;
      } catch (e) {
        setJsonErr(e instanceof Error ? e.message : "JSON syntax error");
        return null;
      }
    } else {
      base = { ...cfg };
    }

    if (kindHint.trim()) base.kindHint = kindHint.trim();
    else delete base.kindHint;

    if (categoryHint.trim()) base.categoryHint = categoryHint.trim();
    else delete base.categoryHint;
    // Empty is explicit opt-out, so a built-in default does not silently reappear.
    base.fixedCategory = fixedCategory.trim();

    if (!showJson && source.kind === "rss") {
      base.feeds = feedRows.map((row, i) => {
        const prev = feeds[i] ?? {};
        const fallbackId = i === 0 ? source.id.replace(/^rss-/, "") : `${source.id.replace(/^rss-/, "")}-${i + 1}`;
        const next: Record<string, unknown> = {
          ...prev,
          id: typeof prev.id === "string" && prev.id ? prev.id : fallbackId,
          url: row.url.trim(),
          limit: Math.max(1, Math.min(100, Number(row.limit) || 30)),
        };
        if (row.categoryHint.trim()) next.categoryHint = row.categoryHint.trim();
        else delete next.categoryHint;
        if (row.kindHint.trim()) next.kindHint = row.kindHint.trim();
        else delete next.kindHint;
        for (const key of ["titleKeywords", "excludeTitleKeywords", "includeCategories", "excludeCategories"] as const) {
          const values = splitKeywords(row[key]);
          if (values.length) next[key] = values;
          else delete next[key];
        }
        return next;
      });
    }

    if (!showJson && source.kind === "telegram") {
      base.channels = tgChannels
        .split(/[,，\s]+/)
        .map((s) => s.replace(/^@/, "").trim())
        .filter(Boolean);
    }

    return base;
  };

  const updateFeed = (index: number, patch: Partial<FeedRow>) => {
    setFeedRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleSave = async () => {
    const nextConfig = buildNextConfig();
    if (!nextConfig || !name.trim()) return;
    setSaving(true);
    try {
      const ok = await onSave({ name: name.trim(), interval_sec: intervalSec, config: nextConfig });
      if (ok) onCancel();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-ink-200 bg-surface p-3.5 text-[12.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-ink-950">
          Edit source <span className="font-mono text-[11px] text-ink-400">{source.id}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!showJson) {
              const built = buildNextConfig();
              if (built) setRawJson(JSON.stringify(built, null, 2));
            }
            setShowJson((v) => !v);
          }}
          className="text-[11.5px] font-medium text-brand hover:underline"
        >
          {showJson ? "Back to form" : "Advanced JSON config"}
        </button>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-12">
        <label className="space-y-1 sm:col-span-4">
          <span className="text-[11px] text-ink-500">Display name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink-950 outline-none focus:border-brand"
          />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-[11px] text-ink-500">Collection interval</span>
          <select
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
          >
            {!INTERVAL_OPTIONS.some((o) => o.sec === intervalSec) && (
              <option value={intervalSec}>{formatInterval(intervalSec)}</option>
            )}
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.sec} value={o.sec}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 sm:col-span-3">
          <span className="text-[11px] text-ink-500">Source-level fallback kind (used when the feed does not specify one)</span>
          <select
            value={kindHint}
            onChange={(e) => setKindHint(e.target.value)}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
          >
            {KIND_HINT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 sm:col-span-3">
          <span className="text-[11px] text-ink-500">Fallback category (used when content cannot be classified)</span>
          <CategoryHintSelect
            value={categoryHint}
            onChange={setCategoryHint}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
          />
        </label>
      </div>

      <div className="grid gap-3 rounded-lg border border-brand-border bg-brand-subtle/40 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
        <div>
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-accent"><ShieldCheck size={14} /> Fixed category (hard rule)</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-600">Once set, every item from this source is forced into this category, ahead of keywords, RSS hints and AI (except per-item manual corrections). Saving also reorganizes existing items, without calling AI or pushing. Enable/disable and stars are unaffected. After clearing it, new items go back to automatic classification and existing items keep their category.</p>
        </div>
        <label className="space-y-1">
          <span className="text-[12px] font-medium text-ink-700">Fixed category</span>
          <CategoryHintSelect value={fixedCategory} onChange={setFixedCategory} emptyLabel="Not fixed · classify by content" ariaLabel="Fixed category" className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800 outline-none focus:border-brand" />
          {source.id === "linuxdo-resource" && <span className="block text-[11px] text-ink-500">Resource roundup recommendations: cloud-drive resources; real freebies no longer get mixed in.</span>}
        </label>
      </div>

      {!showJson && source.kind === "rss" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-ink-500">
              Feed URLs ({feedRows.length}) · each can set its own category/kind; leave blank to use the source-level fallback
            </span>
            <button
              type="button"
              onClick={() => setFeedRows((rows) => [...rows, { ...EMPTY_FEED_ROW }])}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-700 hover:border-brand-border hover:text-brand"
            >
              <Plus size={11} /> Add feed URL
            </button>
          </div>
          {feedRows.map((row, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-ink-200 bg-surface-hover p-2.5">
              <div className="grid gap-2 sm:grid-cols-12">
                <label className="space-y-1 sm:col-span-6">
                  <span className="text-[11px] text-ink-500">RSS / Atom URL #{i + 1}</span>
                  <input
                    value={row.url}
                    onChange={(e) => updateFeed(i, { url: e.target.value })}
                    placeholder="https://example.com/rss.xml"
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-brand"
                  />
                </label>
                <label className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-ink-500">Items per fetch</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={row.limit}
                    onChange={(e) => updateFeed(i, { limit: e.target.value })}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-brand"
                  />
                </label>
                <div className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-ink-500">Category</span>
                  <CategoryHintSelect
                    value={row.categoryHint}
                    onChange={(v) => updateFeed(i, { categoryHint: v })}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
                  />
                </div>
                <label className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-ink-500">Kind</span>
                  <select
                    value={row.kindHint}
                    onChange={(e) => updateFeed(i, { kindHint: e.target.value })}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
                  >
                    {KIND_HINT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[200px] flex-1 space-y-1">
                  <span className="text-[11px] text-ink-500">Title must contain keywords (comma separated; blank accepts all)</span>
                  <input
                    value={row.titleKeywords}
                    onChange={(e) => updateFeed(i, { titleKeywords: e.target.value })}
                    placeholder="e.g. 免费, 限免, free"
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] text-ink-950 outline-none focus:border-brand"
                  />
                </label>
                {feedRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFeedRows((rows) => rows.filter((_, x) => x !== i))}
                    className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[11.5px] font-medium text-alert hover:border-alert/40 hover:bg-alert-subtle"
                  >
                    <Trash2 size={11} /> Remove this one
                  </button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  { key: "includeCategories" as const, label: "Only these RSS columns", placeholder: "info, promotion" },
                  { key: "excludeCategories" as const, label: "Exclude these RSS columns", placeholder: "trade, discussion" },
                  { key: "excludeTitleKeywords" as const, label: "Exclude title keywords", placeholder: "e.g. 求助, 广告, 招募" },
                ].map((field) => <label key={field.key} className="space-y-1">
                  <span className="text-[11px] text-ink-500">{field.label}</span>
                  <input value={row[field.key]} onChange={(event) => updateFeed(i, { [field.key]: event.target.value })} placeholder={field.placeholder} className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] text-ink-950 outline-none focus:border-brand" />
                </label>)}
              </div>
              <p className="text-[11px] leading-relaxed text-ink-500">Comma separated; exclusions win. These columns are the origin site's RSS tags, not this site's categories. Filters take effect from the next fetch and never delete existing resources.</p>
            </div>
          ))}
        </div>
      )}

      {!showJson && source.kind === "telegram" && (
        <label className="block space-y-1">
          <span className="text-[11px] text-ink-500">Public Telegram channel names (comma or space separated)</span>
          <input
            value={tgChannels}
            onChange={(e) => setTgChannels(e.target.value)}
            placeholder="zaihuapd, vps_offers"
            className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-brand"
          />
        </label>
      )}

      {showJson && (
        <div className="space-y-1">
          <span className="text-[11px] text-ink-500">Source config JSON (add or remove columns / feeds / filter params directly)</span>
          <textarea
            rows={5}
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            className="w-full rounded-lg border border-ink-200 bg-surface p-2 font-mono text-[11.5px] text-ink-900 outline-none focus:border-brand"
          />
          {jsonErr && <div className="text-[11.5px] text-alert">{jsonErr}</div>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div>
          {!source.builtIn && onDelete && (
            <button
              type="button"
              onClick={async () => {
                if (!confirmDel) {
                  setConfirmDel(true);
                  return;
                }
                const ok = await onDelete();
                if (ok) onCancel();
              }}
              className={
                "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors " +
                (confirmDel
                  ? "border-alert bg-alert text-white"
                  : "border-ink-200 bg-surface text-alert hover:border-alert/40 hover:bg-alert-subtle")
              }
            >
              <Trash2 size={12} /> {confirmDel ? "Click again to confirm" : "Delete custom source"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-1 text-[12px] text-ink-600 hover:bg-ink-100"
          >
            <X size={12} /> Cancel
          </button>
          <button
            type="button"
            disabled={saving || !name.trim() || (!showJson && source.kind === "rss" && feedRows.some((row) => !/^https?:\/\//i.test(row.url.trim())))}
            onClick={() => void handleSave()}
            className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1 text-[12px] font-medium text-white hover:bg-brand-hover disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save config
          </button>
        </div>
      </div>
    </div>
  );
}

export function OpsPanel({
  sources,
  runs,
  sourceName,
  onCollectSource,
  onToggleSource,
  onChangeInterval,
  onAddRss,
  onClassificationChanged,
  onUpdateSource,
  onDeleteSource,
  onNotify,
}: {
  sources: Source[];
  runs: Run[];
  sourceName: (id: string) => string;
  onCollectSource: (id: string) => Promise<void>;
  onToggleSource: (id: string, enabled: boolean) => Promise<void>;
  onChangeInterval: (id: string, sec: number) => Promise<void>;
  onAddRss: (name: string, url: string, intervalSec: number, kindHint?: string, categoryHint?: string, fixedCategory?: string) => Promise<void>;
  onClassificationChanged?: () => void;
  onUpdateSource: (id: string, patch: { name?: string; interval_sec?: number; config?: Record<string, unknown> }) => Promise<boolean>;
  onDeleteSource: (id: string) => Promise<boolean>;
  onNotify?: (msg: string) => void;
}) {
  const [subTab, setSubTab] = useState<OpsTab>("sources");
  const [filterText, setFilterText] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "error" | "disabled">("all");
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const isRunning = (id: string) => runningIds.includes(id);
  const runSourceWithLock = async (id: string) => {
    setRunningIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    try {
      await onCollectSource(id);
    } finally {
      setRunningIds((prev) => prev.filter((x) => x !== id));
    }
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editingSource = sources.find((source) => source.id === editingId);
  useEffect(() => {
    if (editingId) editorRef.current?.scrollIntoView({ block: "nearest" });
  }, [editingId]);
  const [showAddRss, setShowAddRss] = useState(false);
  const [rssName, setRssName] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [rssInterval, setRssInterval] = useState(1800);
  const [rssKindHint, setRssKindHint] = useState("");
  const [rssCategoryHint, setRssCategoryHint] = useState("");
  const [rssFixedCategory, setRssFixedCategory] = useState("");
  const [addingRss, setAddingRss] = useState(false);
  const [showIngestGuide, setShowIngestGuide] = useState(false);
  const [cookieStatus, setCookieStatus] = useState<{
    runnerUrl: string;
    xhsProxy: string;
    sites: Record<
      "zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo",
      { site: "zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo"; configured: boolean; count: number; keyNames: string[]; hasAuthHint: boolean; updatedAt: string | null }
    >;
  } | null>(null);
  const [cookieInputs, setCookieInputs] = useState<Record<"zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo", string>>({
    zhihu: "",
    xhs: "",
    xiaoheihe: "",
    nga: "",
    weibo: "",
  });
  const [runnerUrlInput, setRunnerUrlInput] = useState("http://172.17.0.1:18790");
  const [xhsProxyInput, setXhsProxyInput] = useState("");
  const [cookieBusy, setCookieBusy] = useState<string | null>(null);
  const [runnerTest, setRunnerTest] = useState<{ ok?: boolean; busy?: boolean; chrome?: boolean; error?: string } | null>(null);

  const loadCookieStatus = async () => {
    try {
      const r = await fetch("/api/cookies");
      if (!r.ok) return;
      const d = (await r.json()) as NonNullable<typeof cookieStatus>;
      setCookieStatus(d);
      setRunnerUrlInput(d.runnerUrl || "http://172.17.0.1:18790");
      setXhsProxyInput(d.xhsProxy || "");
    } catch { /* ignore */ }
  };

  useEffect(() => {
    void loadCookieStatus();
  }, []);

  const saveCookiePatch = async (
    patch: { runnerUrl?: string; xhsProxy?: string; cookies?: Partial<Record<"zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo", string>> },
    busyKey: string,
    clearKey?: "zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo",
  ): Promise<boolean> => {
    setCookieBusy(busyKey);
    try {
      const r = await fetch("/api/cookies", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => ({}))) as NonNullable<typeof cookieStatus> & { error?: string };
      if (!r.ok) {
        onNotify?.(d.error ?? "Save failed");
        return false;
      }
      setCookieStatus(d);
      setRunnerUrlInput(d.runnerUrl || "");
      setXhsProxyInput(d.xhsProxy || "");
      if (clearKey) setCookieInputs((prev) => ({ ...prev, [clearKey]: "" }));
      onNotify?.("Cookie hosting config saved");
      return true;
    } finally {
      setCookieBusy(null);
    }
  };

  const testCookieRunner = async () => {
    setCookieBusy("test-runner");
    try {
      const r = await fetch("/api/cookies/test-runner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerUrl: runnerUrlInput }),
      });
      const d = (await r.json().catch(() => ({}))) as NonNullable<typeof runnerTest>;
      setRunnerTest(d);
      onNotify?.(d.ok ? "VPS cookie runner is online and ready" : "Runner not connected: " + (d.error ?? "check port/service"));
    } finally {
      setCookieBusy(null);
    }
  };
  const [helperUrl, setHelperUrl] = useState(() => {
    try {
      return localStorage.getItem("radar_loopback_helper") || "http://127.0.0.1:18789";
    } catch {
      return "http://127.0.0.1:18789";
    }
  });
  const [ingestTokenInput, setIngestTokenInput] = useState("");

  const siteKeyOf = (id: string) => (id.startsWith("zhihu") ? "zhihu" : id.startsWith("xhs") ? "xhs" : "xiaoheihe");

  const startLoopbackLogin = async (sourceId: string) => {
    const base = helperUrl.replace(/\/+$/, "");
    const site = siteKeyOf(sourceId);
    try {
      const probe = await fetch(base + "/status", { signal: AbortSignal.timeout(1500) });
      if (!probe.ok) throw new Error("not ok");
    } catch {
      setShowIngestGuide(true);
      onNotify?.("Local loopback helper not detected (start it with the guide below; cookies are never uploaded)");
      return;
    }
    const target = new URL(base + "/login");
    target.searchParams.set("site", site);
    target.searchParams.set("server", window.location.origin);
    target.searchParams.set("return_to", window.location.href.split("#")[0] ?? window.location.origin);
    if (ingestTokenInput.trim()) target.searchParams.set("token", ingestTokenInput.trim());
    window.open(target.toString(), "_blank", "noopener");
  };

  const buildUserscript = () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8788";
    const tok = ingestTokenInput.trim() || "replace with your INGEST_TOKEN";
    return `// ==UserScript==
// @name         Freebie Radar 零 Cookie 上传采集助手
// @namespace    https://github.com/ZiChuanLan/freebie-radar
// @version      0.1.0
// @description  Reads only public post titles and links from the current search page and sends them to your own Freebie Radar; cookies never leave the browser
// @match        https://www.xiaohongshu.com/search_result*
// @match        https://www.zhihu.com/search*
// @match        https://www.xiaoheihe.cn/app/bbs/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==
(function () {
  const SERVER = ${JSON.stringify(origin)};
  const TOKEN = ${JSON.stringify(tok)};
  function push(sourceId, items) {
    if (!items.length) return;
    GM_xmlhttpRequest({
      method: "POST",
      url: SERVER + "/api/ingest",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      data: JSON.stringify({ sourceId, items }),
      onload: (r) => console.log("[FreebieRadar]", sourceId, r.status, r.responseText),
    });
  }
  setTimeout(() => {
    const h = location.hostname;
    if (h.includes("xiaohongshu")) {
      const items = [...document.querySelectorAll("section.note-item")].map((c) => {
        const a = c.querySelector('a.cover, a[href*="/explore/"], a[href*="/search_result/"]');
        const t = c.querySelector(".title span, .footer .title, .title");
        const img = c.querySelector("img");
        return a && t ? { externalId: a.href, url: a.href, title: t.textContent.trim(), summary: "", imageUrl: img?.src || "" } : null;
      }).filter((x) => x && x.title && x.url);
      push("xhs-search", items);
    } else if (h.includes("zhihu")) {
      const items = [...document.querySelectorAll(".SearchResult-Card, .List-item")].map((c) => {
        const a = c.querySelector("h2 a, .ContentItem-title a");
        const t = c.querySelector(".RichText");
        const img = c.querySelector("img");
        return a ? { externalId: a.href, url: a.href, title: a.textContent.trim(), summary: (t?.textContent || "").trim().slice(0, 300), imageUrl: img?.getAttribute("data-original") || img?.src || "" } : null;
      }).filter((x) => x && x.title && x.url);
      push("zhihu-search", items);
    }
  }, 3500);
})();`;
  };

  const visibleSources = sources.filter((s) => {
    if (filterText && !(s.name + " " + s.id + " " + s.kind).toLowerCase().includes(filterText.toLowerCase())) {
      return false;
    }
    if (statusFilter === "disabled") return !s.enabled;
    if (statusFilter === "error") return s.last_status === "failed" || s.last_status === "degraded";
    if (statusFilter === "ok") return s.enabled && s.last_status === "ok";
    return true;
  });

  const enabledCount = sources.filter((s) => s.enabled).length;
  const errorCount = sources.filter((s) => s.enabled && (s.last_status === "failed" || s.last_status === "degraded")).length;

  const [retention, setRetention] = useState<RetentionSettings | null>(null);
  const [retCounts, setRetCounts] = useState<{ total: number; active: number; ignored: number; starred: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanPreview, setCleanPreview] = useState<Record<string, number> | null>(null);


  // Source quality board: see which sources waste crawling and AI quota, by AI retention rate
  const [qualityDays, setQualityDays] = useState(7);
  const [quality, setQuality] = useState<SourceQuality[] | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  useEffect(() => {
    setQualityLoading(true);
    fetch("/api/source-quality?days=" + qualityDays)
      .then((r) => r.json())
      .then((j: { sources: SourceQuality[] }) => setQuality(j.sources))
      .catch(() => setQuality(null))
      .finally(() => setQualityLoading(false));
  }, [qualityDays, sources]);
  useEffect(() => {
    fetch("/api/retention")
      .then((r) => r.json())
      .then((j: { settings: RetentionSettings; counts: typeof retCounts }) => {
        setRetention(j.settings);
        setRetCounts(j.counts);
      })
      .catch(() => undefined);
  }, []);

  const saveRetentionField = async (patch: Partial<RetentionSettings>) => {
    if (!retention) return;
    setRetention({ ...retention, ...patch });
    const r = await fetch("/api/retention", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      const j = (await r.json()) as { settings: RetentionSettings; counts: typeof retCounts };
      setRetention(j.settings);
      setRetCounts(j.counts);
      onNotify?.("Retention policy saved");
    } else {
      onNotify?.("Save failed");
    }
  };

  const previewCleanup = async () => {
    const r = await fetch("/api/retention/preview", { method: "POST" });
    if (r.ok) setCleanPreview(((await r.json()) as { deleted: Record<string, number> }).deleted);
  };

  const doCleanup = async () => {
    setCleaning(true);
    try {
      const r = await fetch("/api/retention/run", { method: "POST" });
      if (r.ok) {
        const j = (await r.json()) as { deleted: Record<string, number>; counts: typeof retCounts };
        setCleanPreview(j.deleted);
        setRetCounts(j.counts);
        onNotify?.("Cleanup complete");
      }
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top overview + sub-tabs */}
      <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { key: "sources" as OpsTab, label: `Sources (${enabledCount}/${sources.length})`, icon: Rss },
            { key: "runs" as OpsTab, label: `Fetch log (${runs.length})`, icon: Activity },
            { key: "quality" as OpsTab, label: "Source quality", icon: Gauge },
            { key: "retention" as OpsTab, label: "Retention & cleanup", icon: Database },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setSubTab(t.key)}
              className={
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors " +
                (subTab === t.key ? "bg-brand text-white" : "text-ink-600 hover:bg-ink-100")
              }
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[12px] text-ink-500">
          <span>
            Errored{" "}
            <span className={`font-mono font-semibold ${errorCount > 0 ? "text-alert" : "text-deal"}`}>{errorCount}</span>
          </span>
          {retCounts && (
            <span>
              Stored <span className="font-mono font-semibold text-ink-800">{retCounts.total}</span>
            </span>
          )}
        </div>
      </div>

      {subTab === "sources" && (
        <div className="space-y-4">
          <div className="panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Search source name / type..."
                  className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] text-ink-900 outline-none focus:border-brand"
                />
                {(["all", "ok", "error", "disabled"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setStatusFilter(k)}
                    className={
                      "rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors " +
                      (statusFilter === k ? "bg-brand-subtle text-brand" : "text-ink-600 hover:bg-ink-100")
                    }
                  >
                    {k === "all" ? `All (${sources.length})` : k === "ok" ? "OK" : k === "error" ? `Errored (${errorCount})` : "Disabled"}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowIngestGuide((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:text-brand"
                >
                  <KeyRound size={13} /> {showIngestGuide ? "Hide cookie hosting" : "Cookie hosting (Zhihu / Xiaohongshu / Xiaoheihe / NGA)"}
                </button>
              <button
                type="button"
                onClick={() => setShowAddRss((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-brand-subtle px-3 py-1.5 text-[12px] font-medium text-brand hover:bg-ink-200/70"
              >
                <Plus size={13} /> {showAddRss ? "Hide" : "Add RSS / Atom"}
              </button>
            </div>
              </div>

            {showIngestGuide && (
              <div className="space-y-3.5 border-b border-ink-100 bg-brand-subtle/50 px-4 py-3.5 text-[12.5px] text-ink-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-medium text-ink-950">
                    <KeyRound size={14} className="text-brand" />
                    VPS cookie-hosted fetching (spins up headless Chrome on demand and releases it right after; 0 MB when idle)
                  </div>
                  {runnerTest && (
                    <span
                      className={
                        "rounded px-2 py-0.5 text-[11px] font-medium " +
                        (runnerTest.ok ? "bg-deal-subtle text-deal" : "bg-alert-subtle text-alert")
                      }
                    >
                      {runnerTest.ok ? `Runner online${runnerTest.chrome ? " · Chrome ready" : ""}` : `Not connected: ${runnerTest.error ?? "offline"}`}
                    </span>
                  )}
                </div>

                {/* Runner address and Xiaohongshu proxy */}
                <div className="grid gap-2 sm:grid-cols-12">
                  <label className="space-y-1 sm:col-span-5">
                    <span className="text-[11px] text-ink-500">VPS runner address (listen on the internal network / Docker bridge only)</span>
                    <input
                      value={runnerUrlInput}
                      onChange={(e) => setRunnerUrlInput(e.target.value)}
                      placeholder="http://172.17.0.1:18790"
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                  <label className="space-y-1 sm:col-span-4">
                    <span className="text-[11px] text-ink-500">Xiaohongshu China proxy egress (required for overseas VPS, e.g. http://47.110.65.20:8888)</span>
                    <input
                      value={xhsProxyInput}
                      onChange={(e) => setXhsProxyInput(e.target.value)}
                      placeholder="http://47.110.65.20:8888"
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                  <div className="flex items-end gap-1.5 sm:col-span-3">
                    <button
                      type="button"
                      disabled={cookieBusy !== null}
                      onClick={() => void saveCookiePatch({ runnerUrl: runnerUrlInput, xhsProxy: xhsProxyInput }, "save-net")}
                      className="inline-flex h-8 flex-1 items-center justify-center rounded-lg bg-ink-950 px-2.5 text-[12px] font-medium text-white hover:bg-ink-800 disabled:opacity-40"
                    >
                      {cookieBusy === "save-net" ? <Loader2 size={12} className="animate-spin" /> : "Save route"}
                    </button>
                    <button
                      type="button"
                      disabled={cookieBusy !== null}
                      onClick={() => void testCookieRunner()}
                      className="inline-flex h-8 items-center justify-center rounded-lg border border-ink-200 bg-surface px-2.5 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:text-brand disabled:opacity-40"
                    >
                      {cookieBusy === "test-runner" ? <Loader2 size={12} className="animate-spin" /> : "Test"}
                    </button>
                  </div>
                </div>

                {/* Cookie paste cards for login-gated sites */}
                <div className="grid gap-2.5 lg:grid-cols-2">
                  {(
                    [
{ key: "zhihu" as const, sourceId: "zhihu-search", title: "Zhihu (zhihu.com)", hint: "Key fields: z_c0 / d_c0" },
                      { key: "xhs" as const, sourceId: "xhs-search", title: "Xiaohongshu (xiaohongshu.com)", hint: "Key fields: web_session / a1" },
                      { key: "xiaoheihe" as const, sourceId: "xiaoheihe-search", title: "Xiaoheihe (xiaoheihe.cn)", hint: "Key fields: user_token / x_app_id" },
                      {
                        key: "nga" as const,
                        sourceId: "nga-deals",
                        title: "NGA (bbs.nga.cn)",
                        hint: "Key fields: ngaPassportUid / ngaPassportCid (direct HTTP, no runner needed)",
                      },
                      {
                        key: "weibo" as const,
                        sourceId: "weibo-freebies",
                        title: "Weibo (weibo.com)",
                        hint: "Key fields: SUB / SUBP (direct PC ajax, no runner needed)",
                      },
                    ] as const
                  ).map((site) => {
                    const st = cookieStatus?.sites[site.key];
                    const draft = cookieInputs[site.key];
                    return (
                      <div key={site.key} className="space-y-2 rounded-lg border border-ink-200 bg-surface p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-ink-950">{site.title}</span>
                          {st?.configured ? (
                            <span
                              className={
                                "rounded px-1.5 py-0.5 text-[10.5px] font-medium " +
                                (st.hasAuthHint ? "bg-deal-subtle text-deal" : "bg-code-subtle text-amber-800")
                              }
                              title={`Saved fields: ${st.keyNames.join(", ")}`}
                            >
                              Hosted {st.count} items{st.hasAuthHint ? " · with login state" : " · needs review"}
                            </span>
                          ) : (
                            <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10.5px] text-ink-500">Not configured</span>
                          )}
                        </div>
                        <div className="text-[11px] text-ink-400">
                          {st?.configured && st.updatedAt ? `Updated ${timeAgo(st.updatedAt)} · ${st.keyNames.slice(0, 4).join(", ")}` : site.hint}
                        </div>
                        <textarea
                          rows={2}
                          value={draft}
                          onChange={(e) => setCookieInputs((prev) => ({ ...prev, [site.key]: e.target.value }))}
                          placeholder="Paste a Request Cookie string (a=1; b=2) or a JSON array exported by Cookie-Editor (plaintext is never echoed back after saving)"
                          className="w-full rounded-md border border-ink-200 bg-canvas/50 p-2 font-mono text-[11px] text-ink-900 outline-none focus:border-brand"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={!draft.trim() || cookieBusy !== null}
                              onClick={() => void saveCookiePatch({ cookies: { [site.key]: draft } }, `save-${site.key}`, site.key)}
                              className="inline-flex h-7 items-center gap-1 rounded-md bg-brand px-2.5 text-[11.5px] font-medium text-white hover:bg-brand-hover disabled:opacity-40"
                            >
                              {cookieBusy === `save-${site.key}` ? <Loader2 size={11} className="animate-spin" /> : "Save"}
                            </button>
                            <button
                              type="button"
                              disabled={(!draft.trim() && !st?.configured) || cookieBusy !== null || isRunning(site.sourceId)}
                              onClick={async () => {
                                if (draft.trim()) {
                                  const ok = await saveCookiePatch({ cookies: { [site.key]: draft } }, `run-${site.key}`, site.key);
                                  if (!ok) return;
                                }
                                await runSourceWithLock(site.sourceId);
                              }}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-200 bg-surface px-2.5 text-[11.5px] font-medium text-ink-800 hover:border-brand-border hover:text-brand disabled:opacity-40"
                            >
                              {isRunning(site.sourceId) ? <Loader2 size={11} className="animate-spin" /> : <Play size={10} />}
                              Fetch now
                            </button>
                          </div>
                          {st?.configured && (
                            <button
                              type="button"
                              disabled={cookieBusy !== null}
                              onClick={() => void saveCookiePatch({ cookies: { [site.key]: "" } }, `del-${site.key}`, site.key)}
                              className="text-[11px] text-alert hover:underline"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <details className="rounded-lg border border-ink-200/80 bg-surface/80 px-3 py-2 text-[11.5px] text-ink-600">
                  <summary className="cursor-pointer font-medium text-ink-700">
                    Alternative: local loopback helper / Tampermonkey script (use when cookies stay on your machine)
                  </summary>
                  <div className="mt-2 space-y-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[11.5px] text-ink-500">Local loopback helper address</span>
                    <input
                      value={helperUrl}
                      onChange={(e) => {
                        setHelperUrl(e.target.value);
                        try {
                          localStorage.setItem("radar_loopback_helper", e.target.value);
                        } catch { /* ignore */ }
                      }}
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11.5px] text-ink-500">Optional INGEST_TOKEN to send back (blank uses the helper's .env)</span>
                    <input
                      type="password"
                      value={ingestTokenInput}
                      onChange={(e) => setIngestTokenInput(e.target.value)}
                      placeholder="Leave blank if INGEST_TOKEN is already set in the local .env"
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-ink-500">Option A (local loopback service, no always-on browser):</span>
                  <code className="rounded bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-900">
                    SERVER_URL={typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8788"} node scripts/pw-collect.mjs serve
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        `SERVER_URL=${window.location.origin} node scripts/pw-collect.mjs serve`,
                      );
                      onNotify?.("Copied the loopback helper start command");
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[11.5px] hover:border-brand-border hover:text-brand"
                  >
                    <Copy size={11} /> Copy command
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(buildUserscript());
                      onNotify?.("Copied the Tampermonkey script (no Playwright needed)");
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-surface px-2 py-1 text-[11.5px] text-brand hover:bg-brand-subtle"
                  >
                    <Copy size={11} /> Copy Tampermonkey script (option B · no Node needed)
                  </button>
                </div>
                  </div>
                </details>
              </div>
            )}
            {showAddRss && (
              <div className="space-y-2 border-b border-ink-100 bg-surface-hover px-4 py-3">
                <div className="grid gap-2 sm:grid-cols-12">
                  <input
                    value={rssName}
                    onChange={(e) => setRssName(e.target.value)}
                    placeholder="Source name (e.g. Cailianshe wire / some blog)"
                    className="rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[12.5px] text-ink-950 outline-none focus:border-brand sm:col-span-3"
                  />
                  <input
                    value={rssUrl}
                    onChange={(e) => setRssUrl(e.target.value)}
                    placeholder="https://example.com/feed"
                    className="rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[12.5px] text-ink-950 outline-none focus:border-brand sm:col-span-4"
                  />
                  <select
                    value={rssKindHint}
                    onChange={(e) => setRssKindHint(e.target.value)}
                    className="rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800 outline-none focus:border-brand sm:col-span-3"
                  >
                    {KIND_HINT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <div className="sm:col-span-2">
                    <CategoryHintSelect
                      value={rssCategoryHint}
                      onChange={setRssCategoryHint}
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800 outline-none focus:border-brand"
                    />
                  </div>
                </div>
                <label className="flex flex-wrap items-center gap-3 text-[12px] text-ink-600">
                  <span className="font-medium">Fixed category (optional)</span>
                  <CategoryHintSelect value={rssFixedCategory} onChange={setRssFixedCategory} emptyLabel="Not fixed · classify by content" className="rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800" />
                  <span className="text-[11.5px] text-ink-500">Good for dedicated sources like cloud drives and courses; AI will not move items to other categories.</span>
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[12px] text-ink-500">
                    <span>Interval:</span>
                    <select
                      value={rssInterval}
                      onChange={(e) => setRssInterval(Number(e.target.value))}
                      className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] text-ink-800 outline-none focus:border-brand"
                    >
                      {INTERVAL_OPTIONS.map((o) => (
                        <option key={o.sec} value={o.sec}>
                          Every {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    disabled={!rssName.trim() || !/^https?:\/\//i.test(rssUrl.trim()) || addingRss}
                    onClick={async () => {
                      setAddingRss(true);
                      try {
                        await onAddRss(
                          rssName.trim(),
                          rssUrl.trim(),
                          rssInterval,
                          rssKindHint || undefined,
                          rssCategoryHint || undefined,
                          rssFixedCategory || undefined,
                        );
                        setRssName("");
                        setRssUrl("");
                        setRssKindHint("");
                        setRssCategoryHint("");
                        setRssFixedCategory("");
                        setShowAddRss(false);
                      } finally {
                        setAddingRss(false);
                      }
                    }}
                    className="inline-flex items-center justify-center gap-1 rounded-lg bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
                  >
                    {addingRss ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
                    Add and fetch
                  </button>
                </div>
              </div>
            )}

            <div className="px-4 py-4"><ClassificationPanel sources={sources} onChanged={onClassificationChanged ?? (() => {})} /></div>
            {editingSource && <div ref={editorRef} className="border-b border-ink-200 bg-surface-hover px-4 py-3">
              <SourceInlineEditor key={editingSource.id} source={editingSource}
                onSave={(patch) => onUpdateSource(editingSource.id, patch)}
                onDelete={!editingSource.builtIn ? () => onDeleteSource(editingSource.id) : undefined}
                onCancel={() => setEditingId(null)} />
            </div>}
            {/* Mobile: card-style source list (the table only shows at ≥sm to avoid horizontal squeeze) */}
            <div className="divide-y divide-ink-100 sm:hidden">
              {visibleSources.map((s) => {
                const isCustomInterval = !INTERVAL_OPTIONS.some((o) => o.sec === s.interval_sec);
                return (
                  <div key={s.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink-950">{s.name}</div>
                        <div className="truncate font-mono text-[11px] text-ink-400">
                          {s.id} · {s.kind}
                        </div>
                      </div>
                      <span
                        className={
                          "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium " +
                          (s.last_status === "ok"
                            ? "bg-deal-subtle text-deal"
                            : s.last_status === "failed"
                              ? "bg-alert-subtle text-alert"
                              : s.last_status === "degraded"
                                ? "bg-code-subtle text-amber-800"
                                : "bg-ink-100 text-ink-600")
                        }
                      >
                        {s.last_status ?? "Not run"}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-500">
                      <span className="font-mono tabular-nums text-ink-700">{s.items} items stored</span>
                      <span className="text-ink-400">
                        {(() => {
                          const hints = sourceHints(s);
                          const cat = hints.category || "Auto category";
                          const kind = hints.kind || "Auto kind";
                          return `${cat} · ${kind}`;
                        })()}
                      </span>
                      <span>Collected {timeAgo(s.last_run_at)}</span>
                      <button
                        type="button"
                        onClick={() => onToggleSource(s.id, !s.enabled)}
                        className={"h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors " + (s.enabled ? "bg-brand" : "bg-ink-300")}
                        title={s.enabled ? "Click to disable" : "Click to enable"}
                      >
                        <span
                          className={
                            "block h-4 w-4 rounded-full bg-white shadow-sm transition-transform " + (s.enabled ? "translate-x-4" : "")
                          }
                        />
                      </button>
                      {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                        <span className="text-[12px] text-ink-500">Cookie needed</span>
                      ) : (
                        <select
                          value={s.interval_sec}
                          onChange={(e) => onChangeInterval(s.id, Number(e.target.value))}
                          className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
                        >
                          {isCustomInterval && <option value={s.interval_sec}>{formatInterval(s.interval_sec)}</option>}
                          {INTERVAL_OPTIONS.map((o) => (
                            <option key={o.sec} value={o.sec}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    {s.last_error && <div className="mt-1.5 font-mono text-[11px] text-alert">{s.last_error}</div>}

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
                        className={
                          "inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-2 text-[12px] font-medium transition-colors " +
                          (editingId === s.id
                            ? "border-ink-950 bg-ink-950 text-white"
                            : "border-ink-200 bg-surface text-ink-700 hover:border-ink-300")
                        }
                      >
                        <Pencil size={11} /> Edit
                      </button>
                      {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                        <button
                          type="button"
                          onClick={() => setShowIngestGuide(true)}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-brand-border bg-brand-subtle px-2.5 py-2 text-[12px] font-medium text-brand hover:bg-ink-200/70"
                          title="Paste a cookie first, or enable local loopback fetching"
                        >
                          <KeyRound size={11} />
                          Set cookie
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isRunning(s.id)}
                          onClick={() => void runSourceWithLock(s.id)}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-2 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:bg-brand-subtle hover:text-brand disabled:opacity-50"
                        >
                          {isRunning(s.id) ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                          Fetch now
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-surface-hover text-[11px] tracking-wide text-ink-500 uppercase">
                  <tr className="border-b border-ink-200">
                    <th className="px-4 py-2.5 font-medium">Source</th>
                    <th className="px-2 py-2.5 font-medium">On</th>
                    <th className="px-2 py-2.5 font-medium">Interval</th>
                    <th className="px-2 py-2.5 font-medium">Category basis</th>
                    <th className="px-2 py-2.5 font-medium">Stored</th>
                    <th className="px-2 py-2.5 font-medium">Last fetch</th>
                    <th className="px-2 py-2.5 font-medium">Status</th>
                    <th className="px-2 py-2.5 font-medium">Error</th>
                    <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {visibleSources.map((s) => {
                    const isCustomInterval = !INTERVAL_OPTIONS.some((o) => o.sec === s.interval_sec);
                    return (
                      <Fragment key={s.id}>
                      <tr className="hover:bg-surface-hover">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-ink-950">{s.name}</div>
                          <div className="font-mono text-[11px] text-ink-400">
                            {s.id} · {s.kind}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <button
                            type="button"
                            onClick={() => onToggleSource(s.id, !s.enabled)}
                            className={
                              "h-5 w-9 rounded-full p-0.5 transition-colors " + (s.enabled ? "bg-brand" : "bg-ink-300")
                            }
                            title={s.enabled ? "Click to disable" : "Click to enable"}
                          >
                            <span
                              className={
                                "block h-4 w-4 rounded-full bg-white shadow-sm transition-transform " +
                                (s.enabled ? "translate-x-4" : "")
                              }
                            />
                          </button>
                        </td>
                        <td className="px-2 py-2.5">
                          {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                            <span className="text-[12px] text-ink-500">Cookie needed</span>
                          ) : (
                            <select
                              value={s.interval_sec}
                              onChange={(e) => onChangeInterval(s.id, Number(e.target.value))}
                              className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] text-ink-800 outline-none focus:border-brand"
                            >
                              {isCustomInterval && <option value={s.interval_sec}>{formatInterval(s.interval_sec)}</option>}
                              {INTERVAL_OPTIONS.map((o) => (
                                <option key={o.sec} value={o.sec}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {(() => {
                            const hints = sourceHints(s);
                            return (
                              <div className="flex flex-col gap-0.5 text-[11px]">
                                <span className={hints.category ? "text-ink-700" : "text-ink-400"}>
                                  {hints.category || "Auto category"}
                                </span>
                                <span className={hints.kind ? "text-ink-500" : "text-ink-400"}>
                                  {hints.kind || "Auto kind"}
                                </span>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-2 py-2.5 font-mono tabular-nums text-ink-700">{s.items}</td>
                        <td className="px-2 py-2.5 text-ink-500">{timeAgo(s.last_run_at)}</td>
                        <td className="px-2 py-2.5">
                          <span
                            className={
                              "inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium " +
                              (s.last_status === "ok"
                                ? "bg-deal-subtle text-deal"
                                : s.last_status === "failed"
                                  ? "bg-alert-subtle text-alert"
                                  : s.last_status === "degraded"
                                    ? "bg-code-subtle text-amber-800"
                                    : "bg-ink-100 text-ink-600")
                            }
                          >
                            {s.last_status ?? "Not run"}
                          </span>
                        </td>
                        <td className="max-w-[220px] truncate px-2 py-2.5 font-mono text-[11px] text-alert" title={s.last_error ?? ""}>
                          {s.last_error ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
                              className={
                                "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[12px] font-medium transition-colors " +
                                (editingId === s.id
                                  ? "border-ink-950 bg-ink-950 text-white"
                                  : "border-ink-200 bg-surface text-ink-600 hover:border-ink-300 hover:text-ink-950")
                              }
                              title="Edit name, RSS URLs, kind channels or JSON config"
                            >
                              <Pencil size={11} /> Edit
                            </button>
                            {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setShowIngestGuide(true)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-brand-subtle px-2.5 py-1 text-[12px] font-medium text-brand hover:bg-ink-200/70"
                                  title="Paste a cookie to enable full VPS pipeline fetching"
                                >
                                  <KeyRound size={11} />
                                  Set cookie
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void startLoopbackLogin(s.id)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] text-ink-600 hover:border-brand-border hover:text-brand"
                                  title="Alternative: fetch via the local loopback helper after a QR-code login"
                                >
                                  <ExternalLink size={11} />
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={isRunning(s.id)}
                                onClick={() => void runSourceWithLock(s.id)}
                                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:bg-brand-subtle hover:text-brand disabled:opacity-50"
                              >
                                {isRunning(s.id) ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                                Fetch now
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}


      {subTab === "quality" && (
        <div className="space-y-4">
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
                <Gauge size={15} className="text-brand" /> Source quality
              </div>
              <p className="mt-0.5 text-[12px] text-ink-500">
                Retention = items AI kept valid ÷ reviewed items. A source with a low retention rate and high volume is mostly burning crawling and AI quota.
              </p>
            </div>
            <div className="flex items-center gap-0.5 rounded-md border border-ink-200 bg-surface p-0.5">
              {[
                { d: 1, label: "Today" },
                { d: 7, label: "7 days" },
                { d: 30, label: "30 days" },
              ].map((w) => (
                <button
                  key={w.d}
                  type="button"
                  onClick={() => setQualityDays(w.d)}
                  className={
                    "rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors " +
                    (qualityDays === w.d ? "bg-ink-950 text-white" : "text-ink-500 hover:text-ink-950")
                  }
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div className="panel overflow-hidden">
            {qualityLoading && !quality && (
              <div className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-500">
                <Loader2 size={13} className="animate-spin" /> Computing...
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead className="bg-surface-hover text-[11px] tracking-wide text-ink-500 uppercase">
                  <tr className="border-b border-ink-200">
                    <th className="px-4 py-2 font-medium">Source</th>
                    <th className="px-2 py-2 text-right font-medium">Ingested</th>
                    <th className="px-2 py-2 text-right font-medium">Reviewed</th>
                    <th className="px-2 py-2 text-right font-medium">Kept</th>
                    <th className="px-2 py-2 font-medium">Retention</th>
                    <th className="px-2 py-2 text-right font-medium">Avg quality</th>
                    <th className="px-2 py-2 text-right font-medium">Pushed</th>
                  </tr>
                </thead>
                <tbody>
                  {(quality ?? [])
                    .filter((q) => q.total > 0)
                    .sort((a, b) => (a.keepRate ?? 2) - (b.keepRate ?? 2) || b.total - a.total)
                    .map((q) => {
                      const rate = q.keepRate;
                      const pct = rate === null ? null : Math.round(rate * 100);
                      const tone = pct === null ? "text-ink-400" : pct >= 60 ? "text-deal" : pct >= 30 ? "text-ink-700" : "text-alert";
                      return (
                        <tr key={q.id} className="border-b border-ink-100 last:border-0 hover:bg-surface-hover">
                          <td className="px-4 py-2">
                            <div className="text-[12.5px] font-medium text-ink-900">{q.name}</div>
                            <div className="font-mono text-[11px] text-ink-400">{q.id}</div>
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-700">{q.total}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-500">{q.reviewed}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-700">{q.kept}</td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-ink-100">
                                <div
                                  className={"h-full rounded-full " + (pct !== null && pct >= 60 ? "bg-deal" : pct !== null && pct >= 30 ? "bg-brand" : "bg-alert")}
                                  style={{ width: (pct ?? 0) + "%" }}
                                />
                              </div>
                              <span className={"font-mono text-[11.5px] tabular-nums " + tone}>
                                {pct === null ? "Not reviewed" : pct + "%"}
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-700">
                            {q.avgQuality === null ? "—" : q.avgQuality}
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-500">{q.pushed}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {quality && quality.filter((q) => q.total > 0).length === 0 && (
              <div className="px-4 py-10 text-center text-[12.5px] text-ink-500">No items fetched in this time range</div>
            )}
          </div>
        </div>
      )}
      {subTab === "runs" && (
        <div className="panel overflow-hidden">
          <div className="border-b border-ink-100 px-4 py-3 text-[13.5px] font-semibold text-ink-950">
            Recent fetch log ({runs.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="bg-surface-hover text-[11px] tracking-wide text-ink-500 uppercase">
                <tr className="border-b border-ink-200">
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                  <th className="px-2 py-2 font-medium">Fetched</th>
                  <th className="px-2 py-2 font-medium">Added</th>
                  <th className="px-2 py-2 font-medium">Duration</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2 font-mono text-[12px] text-ink-500">
                      {r.started_at.replace("T", " ").slice(5, 19)}
                    </td>
                    <td className="px-2 py-2 text-ink-800">{sourceName(r.source_id)}</td>
                    <td className="px-2 py-2 font-mono tabular-nums text-ink-700">{r.fetched}</td>
                    <td className="px-2 py-2 font-mono font-medium tabular-nums text-deal">{r.inserted}</td>
                    <td className="px-2 py-2 font-mono tabular-nums text-ink-500">
                      {r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "—"}
                    </td>
                    <td className="max-w-[320px] truncate px-4 py-2 font-mono text-[11px] text-ink-500">
                      {r.error ?? r.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === "retention" && (
        <div className="panel space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-[14.5px] font-semibold text-ink-950">
                <Trash2 size={15} className="text-brand" /> Retention & auto-cleanup
              </div>
              <p className="mt-0.5 text-[12px] text-ink-500">
                Saves on blur after you change a day count; starred items are kept forever and never deleted.
              </p>
            </div>
            {retCounts && (
              <span className="text-[12px] text-ink-500">
                Stored <span className="font-mono font-medium text-ink-800">{retCounts.total}</span> · Starred{" "}
                <span className="font-mono font-medium text-amber-700">{retCounts.starred}</span> · Dismissed{" "}
                <span className="font-mono font-medium">{retCounts.ignored}</span>
              </span>
            )}
          </div>

          {retention && (
            <div className="grid gap-3 sm:grid-cols-5">
              {[
                { key: "itemDays" as const, label: "Non-freebie items", hint: "days" },
                { key: "keptDays" as const, label: "AI-kept freebies", hint: "days" },
                { key: "ignoredDays" as const, label: "Manually dismissed", hint: "days" },
                { key: "pushLogDays" as const, label: "Push log", hint: "days" },
                { key: "digestDays" as const, label: "Daily picks", hint: "days" },
              ].map((f) => (
                <label key={f.key} className="block rounded-lg border border-ink-200 bg-surface-hover p-3">
                  <span className="mb-1.5 block text-[12px] font-medium text-ink-700">{f.label}</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={retention[f.key]}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setRetention({ ...retention, [f.key]: Number.isFinite(v) ? v : 0 });
                      }}
                      onBlur={(e) => {
                        const raw = Number(e.target.value);
                        const clamped = Math.min(Math.max(Number.isFinite(raw) ? Math.round(raw) : 1, 1), 3650);
                        void saveRetentionField({ [f.key]: clamped } as Partial<RetentionSettings>);
                      }}
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[13px] text-ink-900 outline-none focus:border-brand"
                    />
                    <span className="text-[11.5px] text-ink-500">{f.hint}</span>
                  </div>
                </label>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label className="flex items-center gap-2 text-[12.5px] text-ink-700">
              <input
                type="checkbox"
                checked={retention?.auto ?? true}
                onChange={(e) => void saveRetentionField({ auto: e.target.checked })}
                className="h-4 w-4 accent-brand"
              />
              Auto-clean expired data every day
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={previewCleanup}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3.5 py-1.5 text-[12.5px] font-medium text-ink-700 hover:bg-ink-100"
              >
                <Search size={13} /> Preview cleanup
              </button>
              <button
                type="button"
                disabled={cleaning}
                onClick={doCleanup}
                className="inline-flex items-center gap-1.5 rounded-lg border border-alert-border bg-alert-subtle px-3.5 py-1.5 text-[12.5px] font-medium text-alert hover:bg-red-100/80 disabled:opacity-60"
              >
                {cleaning ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Clean now
              </button>
            </div>
          </div>

          {cleanPreview && (
            <div className="rounded-lg border border-ink-200 bg-surface-hover p-3 text-[12.5px] text-ink-700">
              Will clean:
              {Object.entries(cleanPreview)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${k} ${n} items`)
                .join(" · ") || "No items need cleaning"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
