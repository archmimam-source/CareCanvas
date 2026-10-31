import React, { useState } from "react";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { Link2 } from "lucide-react";

export function GenericLinkPanel({ item, components, onLinked }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const options = components.filter((c) => c.key !== "generic_ifc")
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const link = async () => {
    if (!key) return;
    setBusy(true);
    try {
      await api.post("/ifc-mappings", { family: item.revit_family, component_key: key });
      onLinked(key);
      toast.success("Linked — your organisation's future imports will recognise this family");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not save the link");
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2" data-testid="generic-link-panel">
      <div className="font-mono text-[9px] uppercase tracking-widest text-amber-800">Unknown fitting</div>
      <div className="text-[11px] text-amber-950 mb-1.5">Link it to a library component once — every matching box here and in future imports updates.</div>
      <div className="flex gap-1.5">
        <select value={key} onChange={(e) => setKey(e.target.value)} data-testid="generic-link-select"
          className="flex-1 min-w-0 h-8 rounded-md border border-amber-300 bg-white px-2 text-[11px]">
          <option value="">Choose component…</option>
          {options.map((c) => <option key={c.key + (c.code || "")} value={c.key}>{c.name}</option>)}
        </select>
        <button onClick={link} disabled={!key || busy} data-testid="generic-link-btn"
          className="h-8 px-2.5 rounded-md bg-slate-900 text-white text-[11px] inline-flex items-center gap-1 disabled:opacity-50">
          <Link2 className="w-3 h-3" /> Link
        </button>
      </div>
    </div>
  );
}
