import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { Loader2, Network, Eye, Route, RefreshCw, Flame, Zap } from "lucide-react";
import { BAND_COLOR, LAYERS, fmtSecs, ramp } from "@/lib/spatial";
import { travelHeat, flowClashes } from "@/lib/quickViews";
import NetworkDialog from "@/components/room/NetworkDialog";

const QUICK = [
  ["heat", "Travel heatmap", Flame, "Where staff walk most — warmer = busier"],
  ["sight", "Sightlines", Eye, "How much of the room each spot can see"],
  ["clash", "Flow clashes", Zap, "Where staff routes cross each other"],
];

function QuickViews({ quick, setQuick, clashes, maxHeat }) {
  const hint = {
    heat: `Busiest spot is used by ${maxHeat} route${maxHeat === 1 ? "" : "s"} · cool → warm = quiet → busy`,
    sight: "Blue = hidden corners · red = sees most of the room",
    clash: clashes.length
      ? `${clashes.length} crossing point${clashes.length > 1 ? "s" : ""}${clashes.some((c) => c.soiled) ? ` · ${clashes.filter((c) => c.soiled).length} involve a soiled route through clean zone` : ""}`
      : "No routes cross — flows are well separated",
  }[quick];
  return (
    <div data-testid="analysis-quick-views">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-1.5">Quick views</div>
      <div className="grid grid-cols-3 gap-1.5">
        {QUICK.map(([k, l, Icon, d]) => (
          <button key={k} title={d} onClick={() => setQuick(quick === k ? null : k)} data-testid={`analysis-quick-${k}`}
            aria-pressed={quick === k}
            className={`rounded-xl border px-2 py-2.5 text-[10.5px] font-medium flex flex-col items-center gap-1 transition-colors ${
              quick === k ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 hover:border-slate-400 text-slate-700"}`}>
            <Icon className="w-4 h-4" />{l}
            {k === "clash" && clashes.length > 0 && (
              <span className={`text-[9px] font-mono px-1.5 rounded-full ${quick === k ? "bg-white/20" : "bg-rose-50 text-rose-700"}`}>{clashes.length}</span>
            )}
          </button>
        ))}
      </div>
      {quick && <div className="mt-1.5 text-[10.5px] text-slate-600" data-testid="analysis-quick-hint">{hint} · tap again to clear</div>}
    </div>
  );
}

function TaskRow({ t, on, toggle, flowColor }) {
  const ok = t.status === "ok";
  return (
    <button onClick={ok ? toggle : undefined} data-testid={`analysis-task-${t.id}`}
      className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors ${on && ok ? "border-slate-900 bg-white" : "border-slate-200 bg-white/60"} ${ok ? "hover:border-slate-400" : "opacity-70 cursor-default"}`}>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: flowColor }} />
        <span className="text-[11px] font-medium text-slate-900 flex-1 truncate">{t.label}</span>
        {ok ? (
          <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded text-white"
                style={{ background: BAND_COLOR[t.band] }} data-testid={`analysis-task-band-${t.id}`}>{t.score}</span>
        ) : <span className="text-[9px] font-mono uppercase text-slate-400">{t.status === "missing" ? "no " + (t.missing || "").toLowerCase() : "blocked"}</span>}
      </div>
      {ok && (
        <div className="mt-0.5 pl-4 font-mono text-[9.5px] text-slate-500">
          {t.length_m} m · {fmtSecs(t.seconds)} · detour ×{t.detour} · clear {t.min_clearance_m} m
          {t.crosses_clean && <span className="text-rose-600"> · crosses clean zone</span>}
        </div>
      )}
    </button>
  );
}

export default function AnalysisPanel({ roomId, roomName, sceneVersion, items, onOverlay }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [layer, setLayer] = useState("integration");
  const [shown, setShown] = useState(new Set());
  const [custom, setCustom] = useState(null);
  const [cfg, setCfg] = useState({ a: "", b: "", flow: "staff" });
  const [net, setNet] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/rooms/${roomId}/spatial`);
      setData(r.data);
      setShown(new Set(r.data.tasks.filter((t) => t.status === "ok").map((t) => t.id)));
    } catch (e) { toast.error(e.response?.data?.detail || "Analysis failed"); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [roomId, sceneVersion]);

  const flowColor = (id) => data?.flow_types.find((f) => f.id === id)?.color || "#2E9E46";
  const [quick, setQuick] = useState(null);
  const heat = useMemo(() => (data ? travelHeat(data.tasks, data.grid) : null), [data]);
  const clashes = useMemo(() => (data ? flowClashes(data.tasks) : []), [data]);
  const allRoutes = () => data.tasks.filter((t) => t.status === "ok" && t.path).map((t) => ({ id: t.id, path: t.path, color: flowColor(t.flow) }));
  useEffect(() => {
    if (!data) { onOverlay(null); return; }
    if (quick === "heat") { onOverlay({ grid: data.grid, values: heat, layer: "travel", routes: [], view: "heat" }); return; }
    if (quick === "sight") { onOverlay({ grid: data.grid, values: data.vga?.connectivity, layer: "connectivity", routes: [], view: "sight" }); return; }
    if (quick === "clash") { onOverlay({ grid: data.grid, values: null, layer: "none", routes: allRoutes(), clashes, view: "clash" }); return; }
    const routes = data.tasks.filter((t) => shown.has(t.id) && t.path).map((t) => ({ id: t.id, path: t.path, color: flowColor(t.flow) }));
    if (custom) routes.push({ id: "custom", path: custom.path, color: flowColor(custom.flow), dashed: true });
    onOverlay({ grid: data.grid, values: layer === "none" ? null : data.vga?.[layer], layer, routes });
    // eslint-disable-next-line
  }, [data, layer, shown, custom, quick]);
  useEffect(() => () => onOverlay(null), []); // eslint-disable-line

  const runCustom = async () => {
    const A = items.find((i) => i.id === cfg.a), B = items.find((i) => i.id === cfg.b);
    if (!A || !B) return;
    const c = (i) => [i.x + i.w / 2, i.y + i.d / 2];
    try {
      const r = await api.get(`/rooms/${roomId}/spatial/route`, { params: { ax: c(A)[0], ay: c(A)[1], bx: c(B)[0], by: c(B)[1], flow: cfg.flow } });
      setCustom(r.data);
    } catch (e) { toast.error(e.response?.data?.detail || "No route"); }
  };

  if (!data) return <div className="py-10 flex justify-center text-slate-400" data-testid="analysis-loading"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  const s = data.summary;
  const named = items.filter((i) => i.mount_type === "floor" || ["entry_door", "staff_door"].includes(i.component_key));
  return (
    <div className="space-y-4 pb-6" data-testid="analysis-panel">
      <QuickViews quick={quick} setQuick={setQuick} clashes={clashes}
        maxHeat={Math.round(Math.max(0, ...(heat || []).flat().filter(Boolean)))} />
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-white border border-slate-200 p-3" data-testid="analysis-task-score">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Travel score</div>
          <div className="text-xl font-semibold" style={{ color: BAND_COLOR[s.task_band] }}>{s.task_score ?? "—"}</div>
          <div className="text-[10px] text-slate-500">{s.task_band}</div>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-3" data-testid="analysis-door-view">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Seen from door</div>
          <div className="text-xl font-semibold text-slate-900">{s.door_isovist_share != null ? Math.round(s.door_isovist_share * 100) + "%" : "—"}</div>
          <div className={`text-[10px] ${s.soiled_visible_from_door?.length ? "text-amber-700" : "text-slate-500"}`}>
            {s.soiled_visible_from_door?.length ? "Soil source in view of door" : "Soil source screened"}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500 flex items-center gap-1"><Eye className="w-3 h-3" /> Sightlines</div>
          <button onClick={load} disabled={busy} data-testid="analysis-refresh" className="text-slate-400 hover:text-slate-900"><RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} /></button>
        </div>
        <div className="flex flex-wrap gap-1">
          {[...LAYERS, ["none", "Off", ""]].map(([k, l, d]) => (
            <button key={k} title={d} onClick={() => { setQuick(null); setLayer(k); }} data-testid={`analysis-layer-${k}`}
              className={`h-7 px-2.5 rounded-full text-[10.5px] border transition-colors ${layer === k && !quick ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 hover:border-slate-400"}`}>{l}</button>
          ))}
        </div>
        {layer !== "none" && (
          <div className="mt-2 flex items-center gap-2 text-[9px] font-mono text-slate-500">
            low <div className="flex-1 h-1.5 rounded-full" style={{ background: `linear-gradient(90deg, ${[0, .25, .5, .75, 1].map(ramp).join(",")})` }} /> high
          </div>
        )}
      </div>

      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-1.5 flex items-center gap-1"><Route className="w-3 h-3" /> Staff tasks</div>
        <div className="space-y-1.5">
          {data.tasks.map((t) => (
            <TaskRow key={t.id} t={t} on={shown.has(t.id)} flowColor={flowColor(t.flow)}
              toggle={() => { setQuick(null); setShown((p) => { const n = new Set(p); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; }); }} />
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white border border-slate-200 p-3 space-y-2" data-testid="analysis-custom-route">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Test any route</div>
        {["a", "b"].map((k) => (
          <select key={k} value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} data-testid={`analysis-route-${k}`}
            className="w-full h-8 rounded-md border border-slate-200 px-2 text-[11px] bg-white">
            <option value="">{k === "a" ? "From…" : "To…"}</option>
            {named.map((i) => <option key={i.id} value={i.id}>{i.label || i.component_key.replace(/_/g, " ")}</option>)}
          </select>
        ))}
        <div className="flex gap-1.5">
          <select value={cfg.flow} onChange={(e) => setCfg({ ...cfg, flow: e.target.value })} data-testid="analysis-route-flow"
            className="flex-1 h-8 rounded-md border border-slate-200 px-2 text-[11px] bg-white">
            {data.flow_types.map((f) => <option key={f.id} value={f.id}>{f.label} · {f.speed} m/s</option>)}
          </select>
          <button onClick={runCustom} data-testid="analysis-route-run" className="h-8 px-3 rounded-md bg-slate-900 text-white text-[11px]">Route</button>
        </div>
        {custom && (
          <div className="text-[10.5px] text-slate-700" data-testid="analysis-route-result">
            <b style={{ color: BAND_COLOR[custom.band] }}>{custom.score} · {custom.band}</b> · {custom.length_m} m · {fmtSecs(custom.seconds)} · clear {custom.min_clearance_m} m
          </div>
        )}
      </div>

      <button onClick={() => setNet(true)} data-testid="analysis-network-btn"
        className="w-full h-9 rounded-full border border-slate-300 hover:border-slate-900 text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors">
        <Network className="w-3.5 h-3.5" /> Network view · {data.network.nodes.length} items · {s.rule_fails} rule gaps
      </button>
      {net && <NetworkDialog data={data} roomId={roomId} roomName={roomName || "room"} onClose={() => setNet(false)} />}
    </div>
  );
}
