import React, { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { X, Columns2, Layers } from "lucide-react";
import MiniPlan from "@/components/room/MiniPlan";

const REFS = [
  ["nhp_v2", "NHP V2 · RDS 6222"], ["hbn_f74", "HBN F74 · Bedpan"],
  ["hbn_f79", "HBN F79 · General"], ["revit_ex01", "Revit Example 01"],
];
const C = { same: "#059669", moved: "#D97706", current: "#2563EB", reference: "#DC2626" };

function Legend() {
  const rows = [["same", "Same place"], ["moved", "Moved / turned"], ["current", "Only in this room"], ["reference", "Missing vs reference"]];
  return (
    <div className="flex gap-4 flex-wrap text-[10px] font-mono uppercase tracking-widest text-slate-500">
      {rows.map(([k, l]) => <span key={k} className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: C[k] }} />{l}</span>)}
    </div>
  );
}

function ViewChooser({ onPick }) {
  return (
    <div className="py-6" data-testid="compare-view-chooser">
      <div className="text-sm text-slate-700 mb-4">How would you like to compare?</div>
      <div className="grid sm:grid-cols-2 gap-3">
        {[["side", Columns2, "Side by side", "Two plans next to each other, differences coloured"],
          ["overlay", Layers, "Overlay", "One plan, reference as a ghost with arrows for moves"]].map(([k, I, t, d]) => (
          <button key={k} onClick={() => onPick(k)} data-testid={`compare-pick-${k}`}
            className="text-left rounded-2xl border border-slate-200 hover:border-slate-900 p-5 transition-colors">
            <I className="w-5 h-5 text-slate-900" />
            <div className="mt-3 text-sm font-semibold text-slate-900">{t}</div>
            <div className="text-xs text-slate-500 mt-1">{d}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function buildRects(data) {
  const status = {}, cur = {}, ref = {};
  data.pairs.forEach((p) => { status[p.current_id] = p.status; status[p.reference_id] = p.status; });
  const name = (it) => it.label || it.component_key.replace(/_/g, " ");
  const floorFirst = (a, b) => (a.mount_type === "ceiling") - (b.mount_type === "ceiling");
  cur.list = [...data.current.items].sort(floorFirst).map((it) => ({ key: "c" + it.id, ...it, title: name(it),
    color: C[status[it.id] || "current"], opacity: it.mount_type === "ceiling" ? 0.15 : 0.7 }));
  ref.list = [...data.reference.items].sort(floorFirst).map((it) => ({ key: "r" + it.id, ...it, title: name(it),
    color: C[status[it.id] || "reference"], opacity: it.mount_type === "ceiling" ? 0.15 : 0.7 }));
  const byId = Object.fromEntries([...data.current.items, ...data.reference.items].map((i) => [i.id, i]));
  const lines = data.pairs.filter((p) => p.status === "moved" && byId[p.current_id].mount_type !== "ceiling").map((p) => {
    const a = byId[p.reference_id], b = byId[p.current_id];
    return { x1: a.x + a.w / 2, y1: a.y + a.d / 2, x2: b.x + b.w / 2, y2: b.y + b.d / 2 };
  });
  return { cur: cur.list, ref: ref.list, lines, byId, name };
}

export default function CompareDialog({ roomId, onClose }) {
  const [view, setView] = useState(null);
  const [std, setStd] = useState("nhp_v2");
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
    api.get(`/rooms/${roomId}/compare`, { params: { standard: std } })
      .then((r) => setData(r.data)).catch((e) => toast.error(e.response?.data?.detail || "Compare failed"));
  }, [roomId, std]);
  const R = data && buildRects(data);
  const refLabel = REFS.find((r) => r[0] === std)?.[1];
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose} data-testid="compare-dialog">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-6xl bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Layout comparison</div>
            <div className="font-display text-lg font-semibold tracking-tight">This room vs {refLabel}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={std} onChange={(e) => setStd(e.target.value)} data-testid="compare-ref-select"
              className="h-9 rounded-full border border-slate-300 px-3 text-xs bg-white">
              {REFS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {view && (
              <div className="grid grid-cols-2 gap-1 p-1 rounded-full bg-slate-100" data-testid="compare-view-toggle">
                {[["side", "Side by side"], ["overlay", "Overlay"]].map(([k, l]) => (
                  <button key={k} onClick={() => setView(k)} data-testid={`compare-view-${k}`}
                    className={`h-7 px-3 rounded-full text-[11px] font-medium transition-colors ${view === k ? "bg-white shadow-sm" : "text-slate-500"}`}>{l}</button>
                ))}
              </div>
            )}
            <button onClick={onClose} data-testid="compare-close" className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center"><X className="w-4 h-4" /></button>
          </div>
        </div>
        {!view ? <ViewChooser onPick={setView} /> : !data ? <div className="py-16 text-center text-sm text-slate-500">Comparing…</div> : (
          <>
            <div className="flex gap-6 mb-4 text-sm" data-testid="compare-summary">
              <span><b>{data.summary.same}</b> same</span><span className="text-amber-700"><b>{data.summary.moved}</b> moved</span>
              <span className="text-blue-700"><b>{data.summary.only_current}</b> only here</span>
              <span className="text-red-700"><b>{data.summary.only_reference}</b> missing vs reference</span>
            </div>
            {view === "side" ? (
              <div className="grid md:grid-cols-2 gap-6" data-testid="compare-side">
                <div><div className="text-xs font-medium mb-2">This room</div><MiniPlan width={data.current.width} depth={data.current.depth} rects={R.cur} maxW={500} testId="compare-plan-current" /></div>
                <div><div className="text-xs font-medium mb-2">{refLabel}</div><MiniPlan width={data.reference.width} depth={data.reference.depth} rects={R.ref} maxW={500} testId="compare-plan-reference" /></div>
              </div>
            ) : (
              <div data-testid="compare-overlay">
                <MiniPlan width={data.current.width} depth={data.current.depth} maxW={900} maxH={520} testId="compare-plan-overlay"
                  rects={[...R.ref.map((r) => ({ ...r, dashed: true })), ...R.cur]} lines={R.lines} />
              </div>
            )}
            <div className="mt-3"><Legend /></div>
            <DiffList data={data} R={R} />
          </>
        )}
      </div>
    </motion.div>
  );
}

function DiffList({ data, R }) {
  const moved = data.pairs.filter((p) => p.status === "moved");
  const col = (title, color, list) => (
    <div>
      <div className="text-[10px] uppercase tracking-[0.2em] font-medium mb-1" style={{ color }}>{title} · {list.length}</div>
      <ul className="text-xs text-slate-700 space-y-0.5 max-h-40 overflow-y-auto">{list.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
  return (
    <div className="mt-6 grid sm:grid-cols-3 gap-6" data-testid="compare-diff-list">
      {col("Moved", C.moved, moved.map((p) => `${R.name(R.byId[p.current_id])} · ${p.distance.toFixed(2)} m`))}
      {col("Only in this room", C.current, data.only_current.map((id) => R.name(R.byId[id])))}
      {col("Missing vs reference", C.reference, data.only_reference.map((id) => R.name(R.byId[id])))}
    </div>
  );
}
