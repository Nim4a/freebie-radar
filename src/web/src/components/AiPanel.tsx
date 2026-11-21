import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  FlaskConical,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Filter,
  Sparkles,
  Zap,
} from "lucide-react";
import { KIND_LABEL, OBTAIN_LABEL, categoryLabel, timeAgo } from "../lib/sources.ts";
import type { AiPayload, AiSettings, AiSourceMode, AiStage, AiStats, Source } from "../types.ts";

const STAGE_META: Record<AiStage, { label: string; cls: string }> = {
  sync: { label: "Pre-push sync", cls: "bg-brand-subtle text-accent border-brand-border" },
  queue: { label: "Async queue", cls: "bg-ink-100 text-ink-700 border-ink-200" },
  backfill: { label: "Backfill", cls: "bg-code-subtle text-code border-code-border" },
  test: { label: "Connectivity test", cls: "bg-deal-subtle text-deal border-deal-border" },
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type TestResult = {
  ok: boolean;
  ms: number;
  model: string;
  results: {
    title: string;
    keep: boolean;
    category: string;
    kind?: string;
    obtain?: string;
    quality?: number | null;
    reason: string;
  }[];
  error?: string;
};

type BackfillMode = "pending" | "recent" | "rejected";

function SwitchRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-ink-200 bg-surface-hover px-3.5 py-2.5 text-left transition-colors hover:border-ink-300"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink-900">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-snug break-words text-ink-500">{hint}</div>}
      </div>
      <span
        className={
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors " +
          (value ? "bg-brand" : "bg-ink-300")
        }
      >
        <span
          className={
            "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform " +
            (value ? "translate-x-4.5" : "translate-x-0.5")
          }
        />
      </span>
    </button>
  );
}

export function AiPanel({
  data,
  sources,
  reload,
  onNotify,
  sourceName = (id: string) => id,
  onOpenItem,
}: {
  data: AiPayload | null;
  sources: Source[];
  reload: () => void;
  onNotify?: (msg: string) => void;
  sourceName?: (id: string) => string;
  onOpenItem?: (id: number) => void;
}) {
  const [form, setForm] = useState<AiSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [deduping, setDeduping] = useState(false);
  const [dedupResult, setDedupResult] = useState<{ scanned: number; merged: number; clusters: number; skippedReason?: string } | null>(null);
  const [backfillMode, setBackfillMode] = useState<BackfillMode>("pending");
  const [backfillLimit, setBackfillLimit] = useState(200);
  const [backfill, setBackfill] = useState<{
    reviewed: number;
    rejected: number;
    skippedBlocked?: number;
    scanned: number;
    mode?: BackfillMode;
    error?: string;
  } | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [liveStats, setLiveStats] = useState<AiStats | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [sampleFilter, setSampleFilter] = useState<"all" | "kept" | "rejected">("all");
  const [sampleQuery, setSampleQuery] = useState("");

  useEffect(() => {
    if (data?.settings && !form) setForm({ ...data.settings });
  }, [data, form]);

  useEffect(() => {
    if (data?.stats) setLiveStats(data.stats);
  }, [data?.stats]);

  useEffect(() => {
    if (!data?.settings) return;
    setForm((prev) =>
      prev
        ? {
            ...prev,
            enabled: data.settings.enabled,
            learnFromFeedback: data.settings.learnFromFeedback,
            preFilterEnabled: data.settings.preFilterEnabled,
            aiDedupEnabled: data.settings.aiDedupEnabled,
            aiDedupWindowHours: data.settings.aiDedupWindowHours,
            skipFreebieSources: data.settings.skipFreebieSources,
            sourceMode: data.settings.sourceMode,
            sourceIds: data.settings.sourceIds,
            customNoiseKeywords: data.settings.customNoiseKeywords,
          }
        : prev,
    );
  }, [
    data?.settings?.enabled,
    data?.settings?.learnFromFeedback,
    data?.settings?.preFilterEnabled,
    data?.settings?.skipFreebieSources,
    data?.settings?.sourceMode,
    data?.settings?.sourceIds,
    data?.settings?.customNoiseKeywords,
  ]);

  const st = liveStats ?? data?.stats;
  const activeJobs = st?.telemetry?.active ?? [];
  const isLiveActive = Boolean(backfilling || testing || st?.queue?.running || activeJobs.length > 0);

  // While a job is running, refresh progress and the live verdict stream every 750 ms; when idle, silently sync background collection results every 5 s
  useEffect(() => {
    if (!data) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/ai/live");
        if (!r.ok || !alive) return;
        const j = (await r.json()) as { stats?: AiStats };
        if (j.stats && alive) setLiveStats(j.stats);
      } catch {
        /* ignore */
      }
    };
    if (isLiveActive) void poll();
    const timer = window.setInterval(() => void poll(), isLiveActive ? 750 : 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [Boolean(data), isLiveActive]);

  // Active job timer: smoothly update the elapsed seconds
  useEffect(() => {
    if (!isLiveActive) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [isLiveActive]);

  const recentFiltered = useMemo(() => {
    const list = st?.recent ?? [];
    const q = sampleQuery.trim().toLowerCase();
    return list.filter((r) => {
      if (sampleFilter === "kept" && !r.keep) return false;
      if (sampleFilter === "rejected" && r.keep !== false) return false;
      if (!q) return true;
      const src = r.sourceId ? sourceName(r.sourceId).toLowerCase() : "";
      return (
        r.title.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q) ||
        src.includes(q)
      );
    });
  }, [st?.recent, sampleFilter, sampleQuery, sourceName]);

  if (!data || !form || !st) {
    return <div className="panel p-6 text-[13px] text-ink-500">Reading AI configuration...</div>;
  }

  const s = data.settings;
  const total = st.kept + st.rejected + st.pending;
  const keptPct = total ? Math.round((st.kept / total) * 100) : 0;
  const enabledSources = sources.filter((src) => src.enabled);

  async function save(patch: Partial<AiSettings>, toastText = "AI settings saved") {
    setSaving(true);
    try {
      const r = await fetch("/api/ai", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (r.ok) {
        const j = (await r.json()) as AiPayload;
        const saved = j.settings as unknown as Record<string, unknown>;
        setForm((prev) => {
          if (!prev) return { ...j.settings };
          const next: Record<string, unknown> = { ...prev };
          // Write back only the fields submitted in this patch; other unsaved drafts (endpoint / model / key / prompt) keep the user input.
          // Writing the whole form with setForm({ ...j.settings }) used to clobber drafts with stale server values - toggling any auto-save switch lost the key.
          for (const key of Object.keys(patch)) {
            if (key in saved) next[key] = saved[key];
          }
          // The plaintext key from this submit is already stored: clear the input and let the keyHint placeholder take over
          if (typeof patch.apiKey === "string" && patch.apiKey.trim() && !patch.apiKey.startsWith("••••")) {
            next.apiKey = "";
          }
          return next as unknown as AiSettings;
        });
        reload();
        onNotify?.(toastText);
      } else {
        onNotify?.("Save failed");
      }
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const draft: Partial<AiSettings> = {
        baseUrl: form?.baseUrl ?? "",
        model: form?.model ?? "",
        apiKey: (form?.apiKey ?? "").startsWith("••••") ? "" : (form?.apiKey ?? ""),
        timeoutSec: form?.timeoutSec,
        extraPrompt: form?.extraPrompt,
        systemPrompt: form?.systemPrompt,
        learnFromFeedback: form?.learnFromFeedback,
        feedbackLimit: form?.feedbackLimit,
      };
      const r = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      setTest((await r.json()) as TestResult);
      // No reload() here: re-fetching /api/ai would only overwrite unsaved drafts with stale server values;
      // the test does not change settings, and stats refresh themselves through /api/ai/live polling (750 ms while active).
    } finally {
      setTesting(false);
    }
  }

  async function runBackfill() {
    setBackfilling(true);
    setBackfill(null);
    try {
      const r = await fetch("/api/ai/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: backfillLimit, mode: backfillMode }),
      });
      setBackfill((await r.json()) as typeof backfill);
      reload();
    } finally {
      setBackfilling(false);
    }
  }

  async function runReclassify() {
    setReclassifying(true);
    try {
      const r = await fetch("/api/ai/reclassify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "other" }),
      });
      const j = (await r.json()) as { scanned: number; updated: number; movedFromOther: number };
      reload();
      onNotify?.(`Scanned ${j.scanned} "Other" items, reclassified ${j.movedFromOther} (zero tokens)`);
    } finally {
      setReclassifying(false);
    }
  }

  async function runDedup() {
    setDeduping(true);
    setDedupResult(null);
    try {
      const r = await fetch("/api/ai/dedup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 80 }),
      });
      const j = (await r.json()) as { scanned: number; merged: number; clusters: number; skippedReason?: string };
      setDedupResult(j);
      reload();
      onNotify?.(
        j.skippedReason
          ? j.skippedReason
          : `Compared ${j.scanned} items, merged ${j.merged} duplicates (${j.clusters} clusters now)`,
      );
    } finally {
      setDeduping(false);
    }
  }

  const toggleSourceId = (id: string) => {
    const next = form.sourceIds.includes(id)
      ? form.sourceIds.filter((x) => x !== id)
      : [...form.sourceIds, id];
    setForm({ ...form, sourceIds: next });
    void save({ sourceIds: next });
  };

  const canTest = Boolean(form.baseUrl.trim() && form.model.trim());

  return (
    <div className="space-y-4">
      {/* 1. Status plus test / backfill tools */}
      <div className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-subtle text-brand">
            <Bot size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold text-ink-900">AI semantic review engine</h2>
              {s.ready ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-deal-subtle px-1.5 py-0.5 text-[11px] font-medium text-deal">
                  <CircleCheck size={11} /> Running
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                  <AlertTriangle size={11} /> Not enabled
                </span>
              )}
              {st.queue && (
                <span className="rounded-md bg-ink-100 px-2 py-0.5 font-mono text-[11px] text-ink-600">
                  Async queue: {st.queue.queued} pending{st.queue.running ? " (running)" : ""} · processed {st.queue.processed}
                  {st.queue.dropped > 0 ? ` · dropped ${st.queue.dropped}` : ""}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] text-ink-500">
              {s.baseUrl ? s.model + " @ " + s.baseUrl.replace(/^https?:\/\//, "") : "No endpoint configured yet"}
              {s.hasKey ? " · Key " + s.keyHint : " · No key set"}
              {" · Set pre-push wait and instant-claim timing under Push rules"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={testing || !canTest}
              title="Run a test with the endpoint, model and prompt drafts from the form below"
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-50"
            >
              {testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
              Test draft config
            </button>
          </div>
        </div>

        {/* Backfill / re-review toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 bg-surface-hover px-3.5 py-2.5">
          <div className="text-[12px] text-ink-700">
            <span className="font-medium text-ink-900">Backfill / re-review history:</span>
            After changing extra rules or prompts, re-review past items right away to verify them
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={backfillMode}
              onChange={(e) => setBackfillMode(e.target.value as BackfillMode)}
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[12px] text-ink-800 outline-none focus:border-brand"
            >
              <option value="pending">Unreviewed items only (pending)</option>
              <option value="recent">Re-review recent items (calibrate category / score)</option>
              <option value="rejected">Re-check items AI blocked (catch false positives)</option>
            </select>
            <select
              value={backfillLimit}
              onChange={(e) => setBackfillLimit(Number(e.target.value))}
              className="rounded-lg border border-ink-200 bg-surface px-2 py-1 font-mono text-[12px] text-ink-800 outline-none focus:border-brand"
            >
              <option value={50}>50 items</option>
              <option value={200}>200 items</option>
              <option value={500}>500 items</option>
            </select>
            <button
              type="button"
              onClick={runBackfill}
              disabled={backfilling || !s.ready}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1 text-[12px] font-medium text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {backfilling ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              Run now
            </button>

            <button
              type="button"
              onClick={runReclassify}
              disabled={reclassifying}
              title="Recompute the historical Other category with the latest keyword rules (zero tokens)"
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-50"
            >
              {reclassifying ? <Loader2 size={12} className="animate-spin" /> : null}
              Reclassify (0 tokens)
            </button>
          </div>
        </div>

        {test && (
          <div
            className={
              "rounded-lg border p-3 text-[12.5px] " +
              (test.ok ? "border-deal-border bg-deal-subtle" : "border-red-200 bg-red-50")
            }
          >
            <div className="mb-2 flex items-center gap-2 font-medium">
              {test.ok ? <CircleCheck size={13} className="text-deal" /> : <CircleX size={13} className="text-red-600" />}
              {test.ok ? "Connection OK" : "Call failed"} · {test.model} · {test.ms} ms
              {test.error && <span className="font-normal text-red-700">{test.error}</span>}
            </div>
            {test.results.map((r) => (
              <div key={r.title} className="flex flex-wrap items-center gap-2 py-1 text-[12px]">
                <span className={"shrink-0 " + (r.keep ? "text-deal" : "text-red-600")}>
                  {r.keep ? <Check size={12} /> : <CircleX size={12} />}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink-800">{r.title}</span>
                {r.kind && r.kind !== "noise" && (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] font-medium text-brand">
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                )}
                <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-ink-600">
                  {categoryLabel(r.category)}
                </span>
                {r.obtain && (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-ink-600">
                    {OBTAIN_LABEL[r.obtain] ?? r.obtain}
                  </span>
                )}
                {typeof r.quality === "number" && (
                  <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-brand">
                    ★{r.quality}
                  </span>
                )}
                <span className="shrink-0 text-ink-500">{r.reason}</span>
              </div>
            ))}
          </div>
        )}

        {backfill && (
          <div className="rounded-lg border border-ink-200 bg-surface p-3 text-[12.5px] text-ink-700">
            Done ({backfill.mode ?? "pending"}): scanned {backfill.scanned}, judged {backfill.reviewed} (kept{" "}
            {backfill.reviewed - backfill.rejected} / blocked {backfill.rejected})
            {backfill.skippedBlocked ? (
              <span className="text-ink-500">
                {" "}
                · skipped {backfill.skippedBlocked} items matching global block words (saves quota)
              </span>
            ) : null}
            {backfill.reviewed === 0 && (backfill.skippedBlocked ?? 0) > 0 && !backfill.error ? (
              <span className="ml-1 text-ink-500">- no unblocked items are waiting for review</span>
            ) : null}
            {backfill.error && <span className="text-red-700"> · {backfill.error}</span>}
          </div>
        )}
      </div>

      {/* 2. Live review console and run log */}
      <div className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {isLiveActive ? (
              <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                <span className="ai-pulse-ring absolute inline-flex h-full w-full rounded-full bg-accent" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
            ) : (
              <span className="inline-flex h-2 w-2 rounded-full bg-deal" />
            )}
            <h3 className="text-[13.5px] font-semibold text-ink-900">
              {isLiveActive ? "AI review in progress" : "AI run monitor"}
            </h3>
            <span className="text-[11.5px] text-ink-500">
              {isLiveActive
                ? "Verdicts and progress refresh after each batch"
                : st.telemetry?.history?.length
                  ? `${st.telemetry.history.length} recent runs recorded`
                  : "Waiting for the next collection or a manual backfill"}
            </span>
          </div>
          {(st.telemetry?.history?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-2 py-1 text-[11.5px] text-ink-600 hover:bg-ink-100"
            >
              {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {showHistory ? "Collapse full log" : `Recent run log (${st.telemetry?.history?.length ?? 0})`}
            </button>
          )}
        </div>

        {activeJobs.length > 0 && (
          <div className="space-y-3">
            {activeJobs.map((job) => {
              const pct = job.total > 0 ? Math.min(100, Math.round(((job.done + job.failed) / job.total) * 100)) : 0;
              const elapsed = Math.max(0, nowTick - new Date(job.startedAt).getTime());
              const meta = STAGE_META[job.stage];
              return (
                <div
                  key={job.id}
                  className="ai-enter space-y-2.5 rounded-lg border border-brand-border bg-brand-subtle/40 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={"rounded border px-1.5 py-0.5 text-[11px] font-medium " + meta.cls}>
                        {meta.label}
                      </span>
                      <span className="text-[13px] font-medium text-ink-950">
                        {job.sourceId ? `${sourceName(job.sourceId)} · ${job.label.replace(job.sourceId + " · ", "")}` : job.label}
                      </span>
                      <span className="font-mono text-[11px] text-ink-500">{job.model}</span>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[11.5px] tabular-nums text-ink-600">
                      <span>
                        Batch {Math.min(job.completedBatches + 1, job.totalBatches)}/{job.totalBatches}
                      </span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} /> {fmtDuration(elapsed)}
                      </span>
                    </div>
                  </div>

                  {/* Soft shimmer progress bar */}
                  <div className="relative h-2 overflow-hidden rounded-full bg-white/80 ring-1 ring-brand-border/60">
                    <div
                      className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-300 ease-out"
                      style={{ width: Math.max(6, pct) + "%" }}
                    >
                      <span className="ai-shimmer absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                    <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
                      <span className="text-ink-900">
                        Progress {job.done}/{job.total} ({pct}%)
                      </span>
                      <span className="text-deal">Kept {job.kept}</span>
                      <span className="text-alert">Blocked {job.rejected}</span>
                      {job.failed > 0 && <span className="text-code">Failed {job.failed}</span>}
                    </div>
                  </div>

                  {job.recentEvents.length > 0 && (
                    <div className="space-y-1 border-t border-brand-border/50 pt-2">
                      <div className="text-[11px] font-medium text-ink-500">Just stored verdicts</div>
                      {job.recentEvents.slice(0, 4).map((ev, idx) => (
                        <div
                          key={ev.title + idx}
                          className="ai-enter flex items-center gap-2 rounded bg-white/85 px-2.5 py-1 text-[12px]"
                        >
                          <span className={"shrink-0 " + (ev.keep ? "text-deal" : "text-alert")}>
                            {ev.keep ? <Check size={12} /> : <CircleX size={12} />}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium text-ink-800">{ev.title}</span>
                          {typeof ev.quality === "number" && (
                            <span className="shrink-0 rounded bg-brand-subtle px-1 py-0.5 font-mono text-[10.5px] text-accent">
                              ★{ev.quality}
                            </span>
                          )}
                          <span className="max-w-[220px] shrink-0 truncate text-[11px] text-ink-500">{ev.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {(st.telemetry?.history?.length ?? 0) > 0 && (
          <div className="space-y-1.5">
            {(st.telemetry?.history ?? []).slice(0, showHistory ? 25 : 4).map((run) => {
              const meta = STAGE_META[run.stage];
              const passRatio = run.reviewed > 0 ? Math.round((run.kept / run.reviewed) * 100) : 0;
              return (
                <div
                  key={run.id}
                  className="flex flex-wrap items-center gap-2.5 rounded-lg border border-ink-200 bg-surface-hover px-3 py-2 text-[12px]"
                >
                  <span className={"shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] font-medium " + meta.cls}>
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink-800">
                    {run.sourceId ? sourceName(run.sourceId) : run.label}
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-14 overflow-hidden rounded-full bg-ink-200" title={`Kept ${run.kept} / blocked ${run.rejected}`}>
                      <div className="h-full bg-deal" style={{ width: passRatio + "%" }} />
                    </div>
                    <span className="font-mono text-[11.5px] tabular-nums text-ink-700">
                      {run.reviewed} items (<span className="text-deal">{run.kept}</span>/<span className="text-ink-500">{run.rejected}</span>)
                    </span>
                  </div>
                  {run.skippedBlocked ? (
                    <span className="font-mono text-[11px] text-ink-400">Block-skipped {run.skippedBlocked}</span>
                  ) : null}
                  {run.error ? (
                    <span className="max-w-[180px] truncate rounded bg-alert-subtle px-1.5 py-0.5 text-[11px] text-alert">
                      {run.error}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] tabular-nums text-ink-500">
                      {fmtDuration(run.durationMs)}
                      {run.ttfbAvgMs !== null ? ` · first token ${run.ttfbAvgMs}ms` : ""}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-ink-400">{timeAgo(run.finishedAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Verdict distribution */}
      <div className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-ink-500" />
            <h3 className="text-[13.5px] font-semibold text-ink-900">Verdict distribution</h3>
            <span className="text-[11.5px] text-ink-500">{total} active items pending or reviewed</span>
          </div>
          {(st.blockedSkipped ?? 0) > 0 && (
            <span className="text-[11.5px] text-ink-500">
              <span className="font-mono text-ink-700">{st.blockedSkipped}</span> more matched global block words and skipped AI to save quota
            </span>
          )}
        </div>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-ink-100">
          <div className="h-full bg-deal transition-[width] duration-500" style={{ width: keptPct + "%" }} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <div className="font-mono text-[18px] font-semibold tabular-nums text-deal">{st.kept}</div>
            <div className="text-[11.5px] text-ink-500">Kept as valid</div>
          </div>
          <div>
            <div className="font-mono text-[18px] font-semibold tabular-nums text-ink-700">{st.rejected}</div>
            <div className="text-[11.5px] text-ink-500">Judged noise</div>
          </div>
          <div>
            <div className="font-mono text-[18px] font-semibold tabular-nums text-ink-900">{st.pending}</div>
            <div className="text-[11.5px] text-ink-500">Waiting for review</div>
          </div>
          <div>
            <div className="font-mono text-[18px] font-semibold tabular-nums text-ink-400">{st.blockedSkipped ?? 0}</div>
            <div className="text-[11.5px] text-ink-500">Block words skipped (saves quota)</div>
          </div>
        </div>
        {st.byCategory.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {st.byCategory.map((c) => (
              <span key={c.category} className="rounded-md bg-ink-100 px-2 py-0.5 text-[11.5px] text-ink-700">
                {categoryLabel(c.category)} <span className="font-mono">{c.n}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 3. First-pass rule filter and review scope */}
      <div className="panel space-y-4 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter size={15} className="text-brand" />
            <h3 className="text-[13.5px] font-semibold text-ink-900">Rule pre-filter and review scope (saves quota · faster)</h3>
          </div>
          <span className="text-[11.5px] text-ink-500">After collection, every item passes the rule pre-filter before anything is sent to AI</span>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <SwitchRow
            label="Enable entry noise pre-block (rule pre-filter)"
            hint="Automatically skips help requests, price questions, game patch notes and other obvious non-deals; they are not sent to AI and never pushed"
            value={form.preFilterEnabled}
            onChange={(v) => {
              setForm({ ...form, preFilterEnabled: v });
              void save({ preFilterEnabled: v }, v ? "Rule pre-filter enabled" : "Rule pre-filter disabled (everything goes to AI)");
            }}
          />
          <SwitchRow
            label="Freebie-only sources bypass AI"
            hint="Pure-freebie sources such as Epic/Steam/GamerPower/CheapShark/ITAD/SharewareOnSale count as real deals right away, saving quota"
            value={form.skipFreebieSources}
            onChange={(v) => {
              setForm({ ...form, skipFreebieSources: v });
              void save({ skipFreebieSources: v }, v ? "Freebie-only sources now bypass review" : "Freebie-only sources are sent to AI again");
            }}
          />
        </div>

        <div className="rounded-lg border border-ink-200 bg-surface-hover p-3.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-ink-900">AI semantic dedupe (automatic)</div>
              <div className="mt-0.5 text-[11px] leading-snug text-ink-500">
Runs fully automatically once enabled: one comparison when an item passes review, and another right before the Telegram push. Even when every source words the same event differently, only 1 item is kept and pushed once.
                {st?.dedup ? ` Merged ${st.dedup.mergedItems} items into ${st.dedup.clusterCount} clusters.` : ""}
                {st?.dedup?.degraded && st.dedup.degraded.count > 0
                  ? ` ⚠ Degraded ${st.dedup.degraded.count} times (latest: ${st.dedup.degraded.lastReason ?? "unknown"}); only rule-based dedupe ran.`
                  : ""}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="flex items-center gap-1 text-[11.5px] text-ink-600">
                Compare window
                <input
                  type="number"
                  min={6}
                  max={168}
                  value={form.aiDedupWindowHours}
                  onChange={(e) => setForm({ ...form, aiDedupWindowHours: Number(e.target.value) })}
                  onBlur={() => void save({ aiDedupWindowHours: form.aiDedupWindowHours })}
                  className="w-14 rounded border border-ink-200 bg-surface px-1.5 py-0.5 text-center font-mono text-[12px]"
                />
                hours
              </label>
              <button
                type="button"
                onClick={() => {
                  const next = !form.aiDedupEnabled;
                  setForm({ ...form, aiDedupEnabled: next });
                  void save({ aiDedupEnabled: next }, next ? "AI semantic dedupe enabled" : "AI semantic dedupe disabled");
                }}
                className={
                  "rounded-lg border px-3 py-1 text-[12px] font-medium transition-colors " +
                  (form.aiDedupEnabled
                    ? "border-deal-border bg-deal-subtle text-deal"
                    : "border-ink-200 bg-ink-100 text-ink-600")
                }
              >
                {form.aiDedupEnabled ? "On" : "Off"}
              </button>
              <button
                type="button"
                onClick={() => void runDedup()}
                disabled={deduping || !s.ready}
                title="Run semantic clustering over items stored in the last N hours; older duplicates are folded too"
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-50"
              >
                {deduping ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                Cluster and dedupe now
              </button>
            </div>
          </div>
          {dedupResult && (
            <div className="mt-1 text-[11.5px] text-ink-600">
              {dedupResult.skippedReason
                ? dedupResult.skippedReason
                : `Compared ${dedupResult.scanned} items, merged ${dedupResult.merged} duplicates, ${dedupResult.clusters} clusters now.`}
            </div>
          )}
        </div>

<div className="rounded-lg border border-ink-200 bg-surface-hover px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-600">
          Custom block words have been merged into <span className="font-medium text-ink-900">Follows and blocks</span> as one unified rule: items matching a global block word or regex are skipped before they reach AI, saving review quota.
        </div>

        <div className="rounded-lg border border-ink-200 bg-surface-hover p-3.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-ink-900">Sources sent for review</span>
            <div className="flex items-center gap-1.5">
              {[
                { key: "all" as AiSourceMode, label: "All enabled sources" },
                { key: "exclude" as AiSourceMode, label: "Exclude selected sources" },
                { key: "only" as AiSourceMode, label: "Selected sources only" },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => {
                    setForm({ ...form, sourceMode: m.key });
                    void save({ sourceMode: m.key });
                  }}
                  className={
                    "rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors " +
                    (form.sourceMode === m.key
                      ? "border-brand bg-brand text-white"
                      : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100")
                  }
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {form.sourceMode !== "all" && (
            <div className="mt-2 flex max-h-[150px] flex-wrap gap-1.5 overflow-auto rounded-lg border border-ink-200 bg-surface p-2">
              {enabledSources.map((src) => {
                const active = form.sourceIds.includes(src.id);
                return (
                  <button
                    key={src.id}
                    type="button"
                    onClick={() => toggleSourceId(src.id)}
                    className={
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition-colors " +
                      (active
                        ? "border-brand bg-brand-subtle font-medium text-brand"
                        : "border-ink-200 bg-surface-hover text-ink-700 hover:bg-ink-100")
                    }
                  >
                    {active && <Check size={11} />}
                    {src.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 4. Model connection, concurrency and prompt customization */}
      <div className="panel space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[13.5px] font-semibold text-ink-900">Model connection, concurrency performance and review policy</h3>
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-ink-800">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => {
                setForm({ ...form, enabled: e.target.checked });
                void save({ enabled: e.target.checked }, e.target.checked ? "AI semantic review enabled" : "AI semantic review disabled");
              }}
              className="h-3.5 w-3.5 accent-brand"
            />
            Enable AI semantic review
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">API endpoint (OpenAI compatible)</span>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12.5px] text-ink-900 outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">Model name</span>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="mercury-3"
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12.5px] text-ink-900 outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">
              API Key {s.hasKey && <span className="font-normal text-ink-500">(current {s.keyHint})</span>}
            </span>
            <input
              type="password"
              value={(form.apiKey ?? "").startsWith("••••") ? "" : (form.apiKey ?? "")}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={s.hasKey ? "Already configured; leave empty to keep it" : "sk-..."}
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12.5px] text-ink-900 outline-none focus:border-brand"
            />
          </label>
        </div>

        {/* Performance settings */}
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block rounded-lg border border-ink-200 bg-surface-hover p-3">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">Max items per call (20-500)</span>
            <input
              type="number"
              min={20}
              max={500}
              step={10}
              value={form.maxItems}
              onChange={(e) => setForm({ ...form, maxItems: Number(e.target.value) })}
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1 font-mono text-[12.5px] text-ink-900 outline-none focus:border-brand"
            />
          </label>
          <label className="block rounded-lg border border-ink-200 bg-surface-hover p-3">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">Items per batch (2-20)</span>
            <input
              type="number"
              min={2}
              max={20}
              value={form.batchSize}
              onChange={(e) => setForm({ ...form, batchSize: Number(e.target.value) })}
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1 font-mono text-[12.5px] text-ink-900 outline-none focus:border-brand"
            />
          </label>
          <label className="block rounded-lg border border-ink-200 bg-surface-hover p-3">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">Concurrent batches (1-8)</span>
            <input
              type="number"
              min={1}
              max={8}
              value={form.concurrency}
              onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })}
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1 font-mono text-[12.5px] text-ink-900 outline-none focus:border-brand"
            />
          </label>
          <label className="block rounded-lg border border-ink-200 bg-surface-hover p-3">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">Batch timeout in seconds (5-60)</span>
            <input
              type="number"
              min={5}
              max={60}
              value={form.timeoutSec}
              onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) })}
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1 font-mono text-[12.5px] text-ink-900 outline-none focus:border-brand"
            />
          </label>
        </div>

        <div className="rounded-lg border border-ink-200 bg-surface-hover px-3.5 py-2 text-[11.5px] leading-relaxed text-ink-600">
          Current wave rhythm: each HTTP request packs <span className="font-mono font-medium text-ink-900">{form.batchSize}</span> items ×{" "}
          <span className="font-mono font-medium text-ink-900">{form.concurrency}</span> concurrent = {" "}
          <span className="font-mono font-medium text-ink-900">{form.batchSize * form.concurrency}</span> items per wave · after collection the first{" "}
          <span className="font-mono font-medium text-ink-900">{s.syncPrePushLimit ?? 20}</span> are pushed after review (adjustable under Push rules); the rest join the async queue, at most{" "}
          <span className="font-mono font-medium text-ink-900">{Math.min(Math.max(form.batchSize * form.concurrency, 12), 48)}</span> per wave · "Max items per call" only limits direct batch calls, while "Backfill 50/200/500" is controlled separately by the dropdown on the right.
        </div>

        {/* Preference adaptation */}
        <div className="rounded-lg border border-ink-200 bg-surface-hover p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[12.5px] font-medium text-ink-900">Learn preferences automatically from stars and hides</div>
              <div className="mt-0.5 text-[11px] text-ink-500">
                Automatically uses the most recent starred items (positive samples: {data.feedback?.positive ?? 0}) and manual hides (negative samples: {data.feedback?.negative ?? 0}) as review references
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11.5px] text-ink-600">
                Most recent
                <input
                  type="number"
                  min={1}
                  max={15}
                  value={form.feedbackLimit}
                  onChange={(e) => setForm({ ...form, feedbackLimit: Number(e.target.value) })}
                  className="w-12 rounded border border-ink-200 bg-surface px-1.5 py-0.5 text-center font-mono text-[12px]"
                />
                items
              </label>
              <button
                type="button"
                onClick={() => setShowSamples((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[11.5px] text-ink-700 hover:bg-ink-100"
              >
                {showSamples ? <ChevronUp size={12} /> : <ChevronDown size={12} />} View samples
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = !form.learnFromFeedback;
                  setForm({ ...form, learnFromFeedback: next });
                  void save({ learnFromFeedback: next }, next ? "Preference adaptation enabled" : "Preference adaptation disabled");
                }}
                className={
                  "rounded-lg border px-3 py-1 text-[12px] font-medium transition-colors " +
                  (form.learnFromFeedback
                    ? "border-deal-border bg-deal-subtle text-deal"
                    : "border-ink-200 bg-ink-100 text-ink-600")
                }
              >
                {form.learnFromFeedback ? "Learning automatically" : "Off"}
              </button>
            </div>
          </div>

          {showSamples && (
            <div className="mt-3 grid gap-2.5 border-t border-ink-200 pt-2.5 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[11px] font-medium text-deal">Injected positive samples (recently starred)</div>
                <ul className="space-y-1 text-[11.5px] text-ink-700">
                  {(data.feedback?.positiveSamples ?? []).map((t, idx) => (
                    <li key={idx} className="truncate">
                      · {t}
                    </li>
                  ))}
                  {!(data.feedback?.positiveSamples?.length) && <li className="text-ink-400">No starred samples yet</li>}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-medium text-alert">Injected negative samples (recently hidden)</div>
                <ul className="space-y-1 text-[11.5px] text-ink-700">
                  {(data.feedback?.negativeSamples ?? []).map((t, idx) => (
                    <li key={idx} className="truncate">
                      · {t}
                    </li>
                  ))}
                  {!(data.feedback?.negativeSamples?.length) && <li className="text-ink-400">No hidden samples yet</li>}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Extra review rules (recommended) */}
        <label className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium text-ink-800">
              Extra review rules (recommended · appended after the system default, without breaking the JSON format)
            </span>
            <span className="text-[11px] text-ink-500">Add preferences any time, e.g. "mark false when a credit card is required", "always keep free AI model quotas"</span>
          </div>
          <textarea
            value={form.extraPrompt}
            onChange={(e) => setForm({ ...form, extraPrompt: e.target.value })}
            rows={3}
            placeholder="e.g. 1. mark keep=false for offers that require a business license or company verification; 2. give quality=5 to open-source free AI APIs and free compute credits..."
            className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-2 text-[12px] leading-relaxed text-ink-800 outline-none focus:border-brand"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              save({
                enabled: form.enabled,
                baseUrl: form.baseUrl,
                model: form.model,
                apiKey: (form.apiKey ?? "").startsWith("••••") ? "" : (form.apiKey ?? ""),
                maxItems: form.maxItems,
                batchSize: form.batchSize,
                concurrency: form.concurrency,
                timeoutSec: form.timeoutSec,
                feedbackLimit: form.feedbackLimit,
                extraPrompt: form.extraPrompt,
                systemPrompt: form.systemPrompt,
              })
            }
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:bg-brand-hover disabled:opacity-60"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save settings
          </button>
          <button
            type="button"
            onClick={() => setShowPrompt((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-700 hover:bg-ink-100"
          >
            <Zap size={13} />
            {showPrompt ? "Collapse full system prompt" : "Advanced: custom full system prompt"}
          </button>
          <button
            type="button"
            onClick={reload}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-700 hover:bg-ink-100"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {showPrompt && (
          <div className="border-t border-ink-100 pt-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-700">
                Full system prompt
                {s.promptIsDefault ? (
                  <span className="ml-1 font-normal text-ink-500">(currently the built-in default; leave empty to keep picking up version updates)</span>
                ) : (
                  <span className="ml-1 font-normal text-brand">(fully overridden by your custom prompt)</span>
                )}
              </span>
              {!s.promptIsDefault && (
                <button
                  type="button"
                  onClick={() => {
                    setForm({ ...form, systemPrompt: "" });
                    void save({ systemPrompt: "" }, "Built-in system prompt restored");
                  }}
                  className="text-[11.5px] font-medium text-brand hover:underline"
                >
                  Restore default system prompt
                </button>
              )}
            </div>
            <textarea
              value={form.systemPrompt || (s.promptIsDefault ? s.defaultPrompt : "")}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              rows={11}
              className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink-800 outline-none focus:border-brand"
            />
          </div>
        )}
      </div>

      {/* 5. Recent verdict samples */}
      <div className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-ink-900">Recent verdict samples</h3>
            <span className="text-[11.5px] text-ink-500">Newest AI verdicts first, showing the latest {st.recent.length}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-md border border-ink-200 bg-surface p-0.5 text-[11.5px]">
              {[
                { key: "all" as const, label: `All ${st.recent.length}` },
                { key: "kept" as const, label: `Kept ${st.recent.filter((r) => r.keep).length}` },
                { key: "rejected" as const, label: `Blocked ${st.recent.filter((r) => r.keep === false).length}` },
              ].map((tabItem) => (
                <button
                  key={tabItem.key}
                  type="button"
                  onClick={() => setSampleFilter(tabItem.key)}
                  className={
                    "rounded px-2 py-0.5 font-medium transition-colors " +
                    (sampleFilter === tabItem.key ? "bg-ink-950 text-white" : "text-ink-500 hover:text-ink-950")
                  }
                >
                  {tabItem.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-400" />
              <input
                value={sampleQuery}
                onChange={(e) => setSampleQuery(e.target.value)}
                placeholder="Search title / reason / source"
                className="w-40 rounded-md border border-ink-200 bg-surface py-1 pr-2 pl-6 text-[11.5px] text-ink-800 outline-none focus:border-brand"
              />
            </div>
          </div>
        </div>

        <div className="divide-y divide-ink-100">
          {recentFiltered.map((r) => (
            <div key={r.id} className="py-2.5 first:pt-1 last:pb-1">
              <div className="flex items-start gap-2">
                <span className={"mt-0.5 shrink-0 " + (r.keep ? "text-deal" : "text-alert")}>
                  {r.keep ? <Check size={13} /> : <CircleX size={13} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    {onOpenItem ? (
                      <button
                        type="button"
                        onClick={() => onOpenItem(r.id)}
                        className="group inline-flex min-w-0 flex-1 items-center gap-1 text-left text-[13px] font-medium text-ink-900 hover:text-accent hover:underline"
                      >
                        <span className="truncate">{r.title}</span>
                        <ExternalLink size={11} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-70" />
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-900">{r.title}</span>
                    )}
                    <span className="shrink-0 font-mono text-[11px] text-ink-400">
                      {r.reviewedAt ? timeAgo(r.reviewedAt) : ""}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {r.sourceId && (
                      <span className="rounded bg-ink-100 px-1.5 py-0.5 text-ink-600">{sourceName(r.sourceId)}</span>
                    )}
                    {r.kind && r.kind !== "noise" && (
                      <span className="rounded bg-brand-subtle px-1.5 py-0.5 font-medium text-accent">
                        {KIND_LABEL[r.kind] ?? r.kind}
                      </span>
                    )}
                    {r.category && (
                      <span className="rounded bg-ink-100 px-1.5 py-0.5 text-ink-600">
                        {categoryLabel(r.category)}
                      </span>
                    )}
                    {r.obtain && r.obtain !== "free" && (
                      <span className="rounded bg-code-subtle px-1.5 py-0.5 text-code">
                        {OBTAIN_LABEL[r.obtain] ?? r.obtain}
                      </span>
                    )}
                    {typeof r.quality === "number" && (
                      <span className="rounded bg-brand-subtle px-1.5 py-0.5 font-mono text-accent">★{r.quality}</span>
                    )}
                    <span className="font-mono text-ink-400">{Math.round(r.score)} pts</span>
                    {r.reason && (
                      <span className={"ml-0.5 " + (r.keep ? "text-ink-600" : "text-alert/90")}>
                        · {r.reason}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {!recentFiltered.length && (
            <div className="py-6 text-center text-[12.5px] text-ink-500">
              {st.recent.length ? "No matching samples" : "No verdicts yet"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
