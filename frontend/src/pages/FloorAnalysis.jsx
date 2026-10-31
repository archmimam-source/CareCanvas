import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/context/AuthContext";
import { TopBar } from "@/pages/Dashboard";
import { toast } from "sonner";
import { Loader2, ArrowLeft } from "lucide-react";
import { BAND_COLOR, ramp, gridRange, fmtSecs } from "@/lib/spatial";

function useFloor(floorId, source, flow) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get(`/hierarchy/${floorId}/spatial`, { params: { source: source || undefined, flow } })
      .then((r) => { setData(r.data); setErr(null); })
      .catch((e) => setErr(e.response?.data?.detail || "Could not analyse this floor"));
  }, [floorId, source, flow]);
  return [data, err];
}

function FloorSvg({ data, layer, source, setSource, showNet, routes }) {
  const W = 980, H = 560;
  const pts = data.rooms.flatMap((r) => r.poly);
  const x0 = Math.min(...pts.map((p) => p[0])) - 1, x1 = Math.max(...pts.map((p) => p[0])) + 1;
  const y0 = Math.min(...pts.map((p) => p[1])) - 1, y1 = Math.max(...pts.map((p) => p[1])) + 1;
  const s = Math.min(W / (x1 - x0), H / (y1 - y0));
  const X = (x) => (x - x0) * s, Y = (y) => (y1 - y) * s;
  const g = data.grid, vals = layer !== "none" && data.vga?.[layer];
  const [mn, mx] = vals ? gridRange(vals) : [0, 1];
  const node = Object.fromEntries(data.network.nodes.map((n) => [n.id, n]));
  return (
    <svg width={(x1 - x0) * s} height={(y1 - y0) * s} className="bg-white rounded-2xl border border-slate-200" data-testid="floor-svg">
      {vals && vals.flatMap((row, j) => row.map((v, i) => v == null ? null : (
        <rect key={`${i}-${j}`} x={X(g.origin[0] + i * g.res)} y={Y(g.origin[1] - j * g.res)} width={g.res * s + 0.5} height={g.res * s + 0.5}
          fill={ramp((v - mn) / (mx - mn || 1))} fillOpacity={0.6} pointerEvents="none" />
      )))}
      {data.rooms.map((r) => {
        const on = r.id === source, rt = routes[r.id];
        return (
          <g key={r.id} onClick={() => setSource(on ? null : r.id)} style={{ cursor: "pointer" }} data-testid={`floor-room-${r.id}`}>
            <polygon points={r.poly.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}
              fill={on ? "#1D1D1F" : rt?.band ? BAND_COLOR[rt.band] : "#F5F5F7"} fillOpacity={on ? 0.15 : rt ? 0.18 : vals ? 0 : 0.7}
              stroke={on ? "#1D1D1F" : "#64748B"} strokeWidth={on ? 2.5 : 1.2} />
            <text x={X(node[r.id]?.x ?? r.poly[0][0])} y={Y(node[r.id]?.y ?? r.poly[0][1])} fontSize="11" textAnchor="middle" fill="#1D1D1F" pointerEvents="none">
              {r.name.split(" · ").pop()}
            </text>
          </g>
        );
      })}
      {showNet && data.network.edges.map((e, i) => {
        const a = node[e.a], b = node[e.b]; if (!a?.x || !b?.x) return null;
        return <line key={i} x1={X(a.x)} y1={Y(a.y)} x2={X(b.x)} y2={Y(b.y)} stroke={e.door ? "#005EB8" : "#CBD5E1"} strokeWidth={e.door ? 2.5 : 1} strokeDasharray={e.door ? "" : "4 3"} pointerEvents="none" />;
      })}
      {Object.values(routes).filter((r) => r.path).map((r) => (
        <polyline key={r.to} points={r.path.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")} fill="none" stroke={BAND_COLOR[r.band]} strokeWidth={2} opacity={0.8} pointerEvents="none" />
      ))}
    </svg>
  );
}

export default function FloorAnalysis() {
  const { floorId } = useParams();
  const nav = useNavigate();
  const { user, logout } = useAuth();
  const [source, setSource] = useState(null);
  const [flow, setFlow] = useState("staff");
  const [layer, setLayer] = useState("integration");
  const [showNet, setShowNet] = useState(true);
  const [data, err] = useFloor(floorId, source, flow);
  useEffect(() => { if (err) toast.error(err); }, [err]);
  const routes = useMemo(() => Object.fromEntries((data?.routes || []).map((r) => [r.to, r])), [data]);
  const names = Object.fromEntries((data?.rooms || []).map((r) => [r.id, r.name]));
  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <TopBar user={user} onLogout={logout} />
      <div className="max-w-[1400px] mx-auto px-8 py-8">
        <button onClick={() => nav(-1)} className="text-xs text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 mb-3" data-testid="floor-back"><ArrowLeft className="w-3 h-3" /> Back</button>
        <div className="flex items-end justify-between gap-6 flex-wrap mb-6">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Floor analysis · network · space syntax</div>
            <h1 className="text-4xl font-semibold tracking-tight mt-1" data-testid="floor-title">{data?.floor?.name || "Floor"}</h1>
          </div>
          {data && (
            <div className="flex items-center gap-2 flex-wrap">
              {[["integration", "Integration"], ["connectivity", "Connectivity"], ["none", "Off"]].map(([k, l]) => (
                <button key={k} onClick={() => setLayer(k)} data-testid={`floor-layer-${k}`}
                  className={`h-8 px-3 rounded-full text-xs border ${layer === k ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300"}`}>{l}</button>
              ))}
              <button onClick={() => setShowNet(!showNet)} data-testid="floor-network-toggle"
                className={`h-8 px-3 rounded-full text-xs border ${showNet ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300"}`}>Network</button>
              <select value={flow} onChange={(e) => setFlow(e.target.value)} data-testid="floor-flow-select" className="h-8 rounded-full border border-slate-300 px-3 text-xs bg-white">
                {data.flow_types.map((f) => <option key={f.id} value={f.id}>{f.label} · {f.speed} m/s</option>)}
              </select>
            </div>
          )}
        </div>
        {!data && !err && <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>}
        {err && <div className="py-16 text-center text-sm text-slate-600" data-testid="floor-error">{err}</div>}
        {data && (
          <div className="grid lg:grid-cols-[1fr_320px] gap-6">
            <div className="overflow-auto"><FloorSvg data={data} layer={layer} source={source} setSource={setSource} showNet={showNet} routes={routes} /></div>
            <div className="space-y-4">
              <div className="rounded-2xl bg-white border border-slate-200 p-4 text-xs text-slate-600" data-testid="floor-help">
                {source ? <>Routes from <b className="text-slate-900">{names[source]}</b> by {flow}. Click it again to clear.</> : "Click a room to route from it to every other room on the floor."}
              </div>
              {source && (
                <div className="rounded-2xl bg-white border border-slate-200 p-4" data-testid="floor-routes">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-2">Adjacency score</div>
                  {[...data.routes].sort((a, b) => (b.score || 0) - (a.score || 0)).map((r) => (
                    <div key={r.to} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0 text-xs">
                      <span className="truncate text-slate-900">{names[r.to]}</span>
                      {r.status === "ok"
                        ? <span className="font-mono text-[10px] shrink-0 ml-2"><b style={{ color: BAND_COLOR[r.band] }}>{r.score}</b> · {r.length_m} m · {fmtSecs(r.seconds)}</span>
                        : <span className="text-rose-600 text-[10px]">no door path</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-2xl bg-white border border-slate-200 p-4" data-testid="floor-integration-rank">
                <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-2">Most integrated spaces</div>
                {[...data.network.nodes].filter((n) => n.integration != null).sort((a, b) => b.integration - a.integration).slice(0, 8).map((n) => (
                  <div key={n.id} className="flex justify-between text-xs py-1"><span className="truncate">{n.name}</span><span className="font-mono text-slate-500">{n.integration.toFixed(2)} · {n.degree} links</span></div>
                ))}
                {data.vga_note && <div className="text-[11px] text-slate-500 mt-1" data-testid="floor-vga-note">{data.vga_note}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
