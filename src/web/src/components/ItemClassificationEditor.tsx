import { useEffect, useState } from "react";
import { Loader2, Pencil, RotateCcw } from "lucide-react";
import { CATEGORY_LABEL, KIND_LABEL } from "../lib/sources.ts";
import { categoryOptionGroups } from "../../../shared/taxonomy.ts";
import type { Item } from "../types.ts";

export type ClassificationPatch = { category: string | null; kind: string | null; note?: string } | { clear: true };
export function ItemClassificationEditor({ item, onSave }: { item: Item; onSave: (id: number, patch: ClassificationPatch) => Promise<void> }) {
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const manual = item.manualClassification;
  useEffect(() => {
    setCategory(manual?.category ?? ""); setKind(manual?.kind ?? ""); setNote(manual?.note ?? "");
    setError(""); setNotice("");
  }, [item.id, manual?.category, manual?.kind, manual?.note]);
  const perform = async (patch: ClassificationPatch) => {
    setBusy(true); setError(""); setNotice("");
    try { await onSave(item.id, patch); setNotice("clear" in patch ? "Back to automatic classification (source fixed rules still apply)" : "Manual classification saved; later fetching and re-review will not overwrite it"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save classification"); }
    finally { setBusy(false); }
  };
  return <details className="rounded-lg border border-brand-border bg-brand-subtle/30 p-3">
    <summary className="cursor-pointer text-[12.5px] font-medium text-accent"><Pencil size={12} className="mr-1 inline" /> Adjust classification (admin){manual ? " · manual classification locked" : ""}</summary>
    <fieldset disabled={busy} className="mt-3 min-w-0 space-y-3">
      <p className="text-[11.5px] leading-relaxed text-ink-600">This is the site-wide classification. Manual settings win over source fixed rules, keywords and AI; no push is triggered, and content AI already rejected is not let back in. For "cloud-drive resource" just change the category; going from "deal" to "news" also needs the kind changed.</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[12px] text-ink-700">Manual category<select aria-label="Manual category" value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 block w-full rounded-md border border-ink-200 bg-surface px-2 py-2">
          <option value="">Keep automatic category</option>
          {categoryOptionGroups().map((group) => <optgroup key={group.label} label={group.label}>{group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}
        </select></label>
        <label className="block text-[12px] text-ink-700">Manual kind<select aria-label="Manual kind" value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block w-full rounded-md border border-ink-200 bg-surface px-2 py-2">
          <option value="">Keep automatic kind</option>
          {Object.entries(KIND_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
      </div>
      <p className="text-[11px] text-ink-500">Current: {KIND_LABEL[item.kind ?? ""] ?? "unrecognized"} / {CATEGORY_LABEL[item.category ?? "other"] ?? item.category}</p>
      <label className="block text-[12px] text-ink-700">Correction note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. a traveler story, not a promotion" className="mt-1 block w-full rounded-md border border-ink-200 bg-surface px-3 py-2" /></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!category && !kind} onClick={() => void perform({ category: category || null, kind: kind || null, note })} className="inline-flex items-center gap-1 rounded-md bg-brand px-3 py-2 text-[12px] font-medium text-white disabled:opacity-40">{busy && <Loader2 size={12} className="animate-spin" />} Save manual classification</button>
        {manual && <button type="button" onClick={() => {
          if (window.confirm("Clear the manual classification for this item and go back to the current automatic rules? Source fixed categories still apply.")) void perform({ clear: true });
        }} className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-3 py-2 text-[12px] text-ink-700"><RotateCcw size={12} /> Restore automatic classification</button>}
      </div>
      {(error || notice) && <p role={error ? "alert" : "status"} className={"text-[12px] " + (error ? "text-alert" : "text-deal")}>{error || notice}</p>}
    </fieldset>
  </details>;
}
