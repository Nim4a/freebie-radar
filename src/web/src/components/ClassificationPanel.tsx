import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { categoryLabel, KIND_LABEL } from "../lib/sources.ts";
import type { Source } from "../types.ts";

type Audit = {
  scanned: number; updated: number; rerouted: number;
  samples: { id: number; title: string; sourceId: string; fromKind: string | null; toKind: string | null; fromCategory: string | null; toCategory: string | null }[];
};
type Preview = { ruleKind: string; finalKind: string; category: string; signals: Record<string, boolean>; hints: { fixedCategory?: string }; note: string };

export function ClassificationPanel({ sources, onChanged }: { sources: Source[]; onChanged: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [title, setTitle] = useState("All US flights grounded for 4 hours: what regular travelers actually went through");
  const [summary, setSummary] = useState("");
  const [sourceId, setSourceId] = useState("rss-smzdm");
  const [aiKind, setAiKind] = useState("news");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/classification");
    if (!response.ok) throw new Error("Could not load classification settings, please retry");
    const data = await response.json() as { settings: { guardEnabled: boolean }; audit: Audit };
    setEnabled(data.settings.guardEnabled); setAudit(data.audit);
  }, []);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); } finally { setBusy(false); }
  };
  const call = async (path: string, body: unknown, method = "POST") => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? "Operation failed"));
    return data;
  };
  return <fieldset disabled={busy} className="panel space-y-4 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink-950"><ShieldCheck size={16} className="text-accent" /> Classification evidence check</h3>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-ink-500">A deal must show promotion or transaction evidence, and a freebie must have a claim target. Source bias and AI output both go through the check; fixed categories are set per source under "Edit".</p>
      </div>
      <button type="button" role="switch" aria-checked={enabled} aria-label="Classification evidence check" onClick={() => void perform(async () => {
        await call("/api/admin/classification", { guardEnabled: !enabled }, "PATCH");
        setPreview(null); await load(); setNotice(enabled ? "Evidence check off; falling back to loose classification" : "Evidence check on; you can inspect and fix past misclassifications");
      })} className={"rounded-md border px-3 py-2 text-[12px] font-medium " + (enabled ? "border-deal-border bg-deal-subtle text-deal" : "border-ink-200 text-ink-600")}>{enabled ? "Check on" : "Check off"}</button>
    </div>
    {(error || notice) && <p role={error ? "alert" : "status"} className={"text-[12px] " + (error ? "text-alert" : "text-deal")}>{error || notice}</p>}
    <details className="rounded-lg border border-ink-200 bg-surface-hover p-3">
      <summary className="cursor-pointer text-[12.5px] font-medium text-ink-700">Inspect past classifications{audit ? ` · scanned ${audit.scanned}, ${audit.rerouted} to fix` : " · loading"}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-[11.5px] text-ink-500">Checks up to 6000 recent valid resources; fixes categories and recomputes scores without calling paid AI, triggering pushes, or touching stars and hidden state. New rules cannot guarantee zero misclassification, so review the sample first.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void perform(load)} className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-3 py-1.5 text-[12px]"><RefreshCw size={12} /> Re-check</button>
          <button type="button" disabled={!audit?.rerouted} onClick={() => {
            if (!window.confirm("Apply the current classification rules to the latest 6000 resources? No AI calls or pushes will be made.")) return;
            void perform(async () => {
              const result = await call("/api/admin/classification/reclassify", {});
              onChanged(); await load(); setNotice(`Fixed ${result.rerouted ?? 0} categories, recomputed ${result.updated ?? 0} scores`);
            });
          }} className="rounded-md bg-brand px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">Fix past misclassifications (0 tokens)</button>
        </div>
        <div className="max-h-64 divide-y divide-ink-100 overflow-auto">
          {audit?.samples.map((sample) => <div key={sample.id} className="py-2 text-[12px]">
            <p className="font-medium text-ink-900">{sample.title}</p>
            <p className="mt-0.5 text-ink-500">{sources.find((s) => s.id === sample.sourceId)?.name ?? sample.sourceId} · {KIND_LABEL[sample.fromKind ?? ""] ?? sample.fromKind} / {categoryLabel(sample.fromCategory ?? "other")} → <span className="text-accent">{KIND_LABEL[sample.toKind ?? ""] ?? sample.toKind} / {categoryLabel(sample.toCategory ?? "other")}</span></p>
          </div>)}
        </div>
      </div>
    </details>
    <details className="rounded-lg border border-ink-200 p-3">
      <summary className="cursor-pointer text-[12.5px] font-medium text-ink-700">Try a title against the false-positive rules (no AI call)</summary>
      <div className="mt-3 space-y-3">
        <label className="block text-[12px] text-ink-700">Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="mt-1 block w-full rounded-md border border-ink-200 px-3 py-2" /></label>
        <label className="block text-[12px] text-ink-700">Summary (optional)<textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} rows={2} className="mt-1 block w-full rounded-md border border-ink-200 px-3 py-2" /></label>
        <div className="flex flex-wrap gap-2">
          <label className="text-[12px] text-ink-700">Source<select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="ml-2 max-w-full rounded-md border border-ink-200 px-2 py-2"><option value="">Plain, unspecified source</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="text-[12px] text-ink-700">Simulated AI verdict<select value={aiKind} onChange={(e) => setAiKind(e.target.value)} className="ml-2 rounded-md border border-ink-200 px-2 py-2"><option value="">No kind given</option>{Object.entries(KIND_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button type="button" disabled={!title.trim()} onClick={() => void perform(async () => { setPreview(await call("/api/admin/classification/preview", { title, summary, sourceId, aiKind }) as unknown as Preview); })} className="inline-flex items-center gap-1 rounded-md bg-brand px-3 py-2 text-[12px] text-white">{busy ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Run rules</button>
        </div>
        {preview && <div role="status" className="rounded-md bg-brand-subtle p-3 text-[12px] leading-relaxed text-accent">
          Rule: {KIND_LABEL[preview.ruleKind]} · After check: {KIND_LABEL[preview.finalKind]} · Category: {categoryLabel(preview.category)}
          <p className="mt-1 text-ink-600">Claim evidence {preview.signals.claim ? "yes" : "no"} / Promotion evidence {preview.signals.promotion ? "yes" : "no"} / Editorial tone {preview.signals.editorial ? "yes" : "no"} / Open-source evidence {preview.signals.repository ? "yes" : "no"}{preview.hints.fixedCategory ? ` · source fixed category ${categoryLabel(preview.hints.fixedCategory)}` : ""}</p>
          <p className="mt-1 text-[11px] text-ink-500">{preview.note}</p>
        </div>}
      </div>
    </details>
  </fieldset>;
}
