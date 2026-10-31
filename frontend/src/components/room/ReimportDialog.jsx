import React, { useRef, useState } from "react";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { X, Loader2, FileUp } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import MiniPlan from "@/components/room/MiniPlan";

const TYPE = {
  moved:   { label: "Moved / resized", color: "#D97706" },
  added:   { label: "New in IFC",      color: "#059669" },
  removed: { label: "Gone from IFC",   color: "#DC2626" },
  room:    { label: "Room size",       color: "#2563EB" },
};

function ChangeRow({ ch, on, toggle }) {
  const fmt = (v) => v && `${v.x?.toFixed(2)}, ${v.y?.toFixed(2)} · ${v.w?.toFixed(2)}×${v.d?.toFixed(2)}`;
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer" data-testid={`reimport-change-${ch.id}`}>
      <Checkbox checked={on} onCheckedChange={toggle} data-testid={`reimport-check-${ch.id}`} className="mt-0.5" />
      <div className="min-w-0 text-xs">
        <div className="font-medium text-slate-900 truncate">{ch.label || ch.component_key?.replace(/_/g, " ")}</div>
        {ch.component_from && (
          <div className="text-[10px] text-violet-700">{ch.component_from.replace(/_/g, " ")} → {ch.component_key.replace(/_/g, " ")}</div>
        )}
        <div className="font-mono text-[10px] text-slate-500">
          {ch.type === "room" ? `${ch.before} → ${ch.after} m`
            : ch.type === "moved" ? `${fmt(ch.before)} → ${fmt(ch.after)}`
            : fmt(ch.after || ch.before)}
        </div>
      </div>
    </label>
  );
}

export default function ReimportDialog({ roomId, onClose, onApplied }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [imp, setImp] = useState(null);
  const [diff, setDiff] = useState(null);
  const [needPick, setNeedPick] = useState(false);
  const [accept, setAccept] = useState(new Set());

  const loadDiff = async (importId, spaceGuid) => {
    try {
      const r = await api.post(`/rooms/${roomId}/ifc-diff`, { import_id: importId, space_guid: spaceGuid });
      setDiff(r.data); setNeedPick(false);
      setAccept(new Set(r.data.changes.map((c) => c.id)));
    } catch (e) {
      if (e.response?.status === 409) setNeedPick(true);
      else toast.error(e.response?.data?.detail || "Could not compare");
    }
  };

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData(); fd.append("file", file);
    try {
      const r = await api.post("/ifc-import", fd, { headers: { "Content-Type": "multipart/form-data" } });
      setImp(r.data);
      await loadDiff(r.data.id);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not read the IFC file");
    } finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/rooms/${roomId}/ifc-diff/apply`,
        { import_id: diff.import_id, space_guid: diff.space_guid, accept: [...accept] });
      toast.success(`Applied ${accept.size} change(s) from ${diff.filename}`);
      onApplied?.(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not apply changes");
    } finally { setBusy(false); }
  };

  const toggle = (id) => setAccept((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const rects = [];
  const lines = [];
  (diff?.changes || []).filter((c) => c.type !== "room").forEach((c) => {
    const on = accept.has(c.id), col = TYPE[c.type].color;
    if (c.before) rects.push({ key: c.id + "b", ...c.before, color: c.type === "moved" ? "#94A3B8" : col, dashed: true, title: c.label });
    if (c.after) rects.push({ key: c.id + "a", ...c.after, color: col, opacity: on ? 0.75 : 0.2, highlight: on, title: c.label });
    if (c.type === "moved" && on) lines.push({ x1: c.before.x + c.before.w / 2, y1: c.before.y + c.before.d / 2,
      x2: c.after.x + c.after.w / 2, y2: c.after.y + c.after.d / 2 });
  });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose} data-testid="reimport-dialog">
      <div onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Re-import IFC</div>
            <div className="font-display text-lg font-semibold tracking-tight">Review changes from a newer IFC</div>
          </div>
          <button onClick={onClose} data-testid="reimport-close" className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".ifc" className="hidden" data-testid="reimport-input"
          onChange={(e) => upload(e.target.files?.[0])} />
        {!imp && (
          <button onClick={() => fileRef.current?.click()} disabled={busy} data-testid="reimport-drop"
            className="w-full rounded-xl border-2 border-dashed border-slate-300 hover:border-slate-500 py-10 flex flex-col items-center gap-2 transition-colors">
            {busy ? <Loader2 className="w-6 h-6 animate-spin text-slate-500" /> : <FileUp className="w-6 h-6 text-slate-500" />}
            <div className="text-sm font-medium">{busy ? "Reading IFC…" : "Choose the newer .ifc file"}</div>
            <div className="text-xs text-slate-500">Fittings are matched by their Revit/IFC id. Items you added in HealthcareCanvas are never touched.</div>
          </button>
        )}
        {needPick && imp && (
          <div className="space-y-2" data-testid="reimport-space-picker">
            <div className="text-sm text-slate-700">Which room in this IFC is this one?</div>
            {imp.spaces.map((s) => (
              <button key={s.guid} onClick={() => loadDiff(imp.id, s.guid)} data-testid={`reimport-space-${s.guid}`}
                className="w-full text-left rounded-xl border border-slate-200 hover:border-slate-500 px-4 py-2 text-sm">
                {s.name} <span className="text-slate-500 text-xs">· {s.width}×{s.depth} m</span>
              </button>
            ))}
          </div>
        )}
        {diff && (
          <div className="grid md:grid-cols-[1fr_300px] gap-6">
            <div>
              <MiniPlan width={diff.new_size.width} depth={diff.new_size.depth} rects={rects} lines={lines} testId="reimport-plan" />
              <div className="mt-2 flex gap-3 flex-wrap text-[10px] font-mono uppercase tracking-widest text-slate-500">
                {Object.entries(TYPE).map(([k, t]) => (
                  <span key={k} className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: t.color }} />{t.label}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-2" data-testid="reimport-summary">
                {diff.space_name} · {diff.changes.length} change(s) · {diff.unchanged} unchanged
                {diff.manual_items ? ` · ${diff.manual_items} of your own items kept` : ""}
              </div>
              {diff.changes.length === 0 && <div className="text-sm text-slate-700 py-6" data-testid="reimport-nochanges">Nothing changed — the room already matches this IFC.</div>}
              {["room", "moved", "added", "removed"].map((t) => {
                const list = diff.changes.filter((c) => c.type === t);
                if (!list.length) return null;
                return (
                  <div key={t} className="mb-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-medium" style={{ color: TYPE[t].color }}>{TYPE[t].label} · {list.length}</div>
                    <div className="divide-y divide-slate-100">{list.map((c) => <ChangeRow key={c.id} ch={c} on={accept.has(c.id)} toggle={() => toggle(c.id)} />)}</div>
                  </div>
                );
              })}
              <Button onClick={apply} disabled={busy} className="w-full rounded-full bg-slate-900 hover:bg-slate-800 text-white mt-2" data-testid="reimport-apply">
                {busy ? "Applying…" : `Apply ${accept.size} selected change(s)`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
