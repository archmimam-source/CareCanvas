import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X, RotateCcw, Download, Check, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { exportPng, exportSvg } from "@/lib/networkExport";
import { ROLE_COLOR, BAND_COLOR, fmtSecs } from "@/lib/spatial";
import { placeLabels, nodeRadius } from "@/lib/networkLabels";
import { serialise } from "@/lib/networkExport";

// Force layout: springs on edges, repulsion between nodes, anchored to plan positions.
// `pins` hold user-dragged nodes fixed; `start` lets a drag relax from the current picture.
function layout(nodes, edges, W, H, mode, pins = {}, start = null, iters = 260) {
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const s = Math.min((W - 120) / Math.max(Math.max(...xs) - x0, 0.5), (H - 100) / Math.max(Math.max(...ys) - y0, 0.5));
  const P = nodes.map((n) => {
    const ax = 60 + (n.x - x0) * s, ay = 50 + (n.y - y0) * s, st = pins[n.id] || start?.[n.id];
    return { ...n, ax, ay, vx: 0, vy: 0, px: st ? st.px : ax, py: st ? st.py : ay, pinned: !!pins[n.id] };
  });
  if (mode === "plan") return centre(P, W, H);
  const idx = Object.fromEntries(P.map((p, i) => [p.id, i]));
  const k = Object.keys(pins).length ? 0.006 : 0.02;
  for (let t = 0; t < iters; t++) {
    const a = start ? 0.6 : 1 - t / iters;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const dx = P[j].px - P[i].px, dy = P[j].py - P[i].py, d2 = dx * dx + dy * dy + 0.01, f = 600 / d2;
      P[i].vx -= dx * f; P[i].vy -= dy * f; P[j].vx += dx * f; P[j].vy += dy * f;
    }
    edges.forEach((e) => {
      const A = P[idx[e.a]], B = P[idx[e.b]]; if (!A || !B) return;
      const rest = e.kind === "touch" ? 60 : e.kind === "rule" ? 110 : 90;
      const dx = B.px - A.px, dy = B.py - A.py, d = Math.hypot(dx, dy) || 1, f = (d - rest) * 0.02;
      A.vx += dx / d * f * d * 0.05; A.vy += dy / d * f * d * 0.05; B.vx -= dx / d * f * d * 0.05; B.vy -= dy / d * f * d * 0.05;
    });
    P.forEach((p) => {
      if (p.pinned) { p.vx = p.vy = 0; return; }
      p.vx += (p.ax - p.px) * k; p.vy += (p.ay - p.py) * k;
      p.px = Math.max(30, Math.min(W - 30, p.px + p.vx * a)); p.py = Math.max(30, Math.min(H - 30, p.py + p.vy * a));
      p.vx *= 0.5; p.vy *= 0.5;
    });
  }
  return start || Object.keys(pins).length ? P : centre(P, W, H);
}

// Shift a fresh layout so its bounding box sits in the middle of the canvas.
function centre(P, W, H) {
  if (!P.length) return P;
  const xs = P.map((p) => p.px), ys = P.map((p) => p.py);
  const dx = W / 2 - (Math.min(...xs) + Math.max(...xs)) / 2, dy = H / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
  return P.map((p) => ({ ...p, px: p.px + dx, py: p.py + dy }));
}

export default function NetworkDialog({ data, roomId, roomName = "room", onClose }) {
  const [mode, setMode] = useState("force");
  const [kinds, setKinds] = useState({ touch: false, rule: true, flow: true });
  const [hover, setHover] = useState(null);
  const [pins, setPins] = useState({});
  const [drag, setDrag] = useState(null);
  const svgRef = useRef(null);
  const downOnBackdrop = useRef(false);
  const W = 860, H = 520;
  const { nodes, edges } = data.network;
  const activeEdges = useMemo(() => edges.filter((e) => kinds[e.kind]), [edges, kinds]);
  const ns = useMemo(() => {
    const ids = new Set(activeEdges.flatMap((e) => [e.a, e.b]));
    return mode === "force" ? nodes.filter((n) => ids.has(n.id)) : nodes;
  }, [nodes, activeEdges, mode]);
  const [P, setP] = useState([]);
  // Re-layout when the visible graph changes; keep the user's moved bubbles where they put them.
  useEffect(() => { setP(layout(ns, activeEdges, W, H, mode, pins)); }, [ns, activeEdges, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared per-room arrangement: load once, save (debounced) after every change.
  const [saveInfo, setSaveInfo] = useState({ status: "idle" });
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!roomId) return;
    api.get(`/rooms/${roomId}/network-layout`).then((r) => {
      const loaded = r.data?.pins || {};
      setPins(loaded);
      setP(layout(ns, activeEdges, W, H, mode, loaded));
      if (r.data?.updated_at) setSaveInfo({ status: "saved", by: r.data.updated_by, at: r.data.updated_at });
      uploadSnapshot();
    }).catch(() => {});
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps
  const snapTimer = useRef(null);
  const uploadSnapshot = (delay = 900) => {
    if (!roomId) return;
    clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => {
      if (!svgRef.current) return;
      try {
        const { xml } = serialise(svgRef.current, `${roomName} · room network`);
        api.put(`/rooms/${roomId}/network-layout/snapshot`, { svg: xml }).catch(() => {});
      } catch { /* snapshot is best-effort */ }
    }, delay);
  };
  useEffect(() => () => { clearTimeout(snapTimer.current); }, []);
  const persist = (next) => {
    if (!roomId) return;
    clearTimeout(saveTimer.current);
    setSaveInfo({ status: "saving" });
    saveTimer.current = setTimeout(() => {
      api.put(`/rooms/${roomId}/network-layout`, { pins: next })
        .then((r) => { setSaveInfo({ status: "saved", by: r.data.updated_by, at: r.data.updated_at }); uploadSnapshot(100); })
        .catch((e) => setSaveInfo({ status: e?.response?.status === 403 ? "readonly" : "error" }));
    }, 600);
  };
  const doExport = async (fmt) => {
    const title = `${roomName} · room network · ${new Date().toLocaleDateString()}`;
    try {
      if (fmt === "svg") exportSvg(svgRef.current, title, roomName); else await exportPng(svgRef.current, title, roomName);
      toast.success(`Network saved as ${fmt.toUpperCase()}`);
    } catch { toast.error("Export failed"); }
  };

  const toSvg = (ev) => {
    const r = svgRef.current.getBoundingClientRect();
    return { px: Math.max(20, Math.min(W - 20, ev.clientX - r.left)), py: Math.max(20, Math.min(H - 20, ev.clientY - r.top)) };
  };
  const relax = (nextPins, iters) => {
    const cur = Object.fromEntries(P.map((p) => [p.id, p]));
    setP(layout(ns, activeEdges, W, H, mode, nextPins, cur, iters));
  };
  const onMove = (ev) => {
    if (!drag) return;
    const next = { ...pins, [drag]: toSvg(ev) };
    setPins(next); relax(next, 12);
  };
  const onUp = () => { if (drag) { relax(pins, 80); setDrag(null); persist(pins); } };
  const release = (id) => { const { [id]: _, ...rest } = pins; setPins(rest); relax(rest, 80); persist(rest); };
  const resetLayout = () => { setPins({}); setP(layout(ns, activeEdges, W, H, mode, {})); persist({}); };
  const pinCount = ns.filter((n) => pins[n.id]).length;

  const labelled = useMemo(() => {
    const seen = new Set(), out = new Set();
    [...P].sort((a, b) => b.degree - a.degree).forEach((p) => {
      if (!p.role || seen.has(p.label)) return;
      seen.add(p.label); out.add(p.id);
    });
    return out;
  }, [P]);
  const at = Object.fromEntries(P.map((p) => [p.id, p]));
  const flowCol = (id) => data.flow_types.find((f) => f.id === id)?.color;
  const vis = activeEdges.filter((e) => at[e.a] && at[e.b]);
  const mid = (e) => {
    const a = at[e.a], b = at[e.b], f = e.kind === "flow" ? 0.15 : 0;
    return [(a.px + b.px) / 2 + (b.py - a.py) * f, (a.py + b.py) / 2 - (b.px - a.px) * f];
  };
  const { spots, flowSpots, hidden } = useMemo(() => {
    const flows = vis.map((e, i) => [e, i]).filter(([e]) => e.kind === "flow").map(([e, i]) => {
      const [mx, my] = mid(e);
      return { key: i, mx, my, text: `${e.length_m} m · ${fmtSecs(e.seconds)}` };
    });
    return placeLabels(P, labelled, W, H, flows);
  }, [P, labelled, kinds]); // eslint-disable-line react-hooks/exhaustive-deps
  const near = hover ? new Set(vis.filter((e) => e.a === hover || e.b === hover).flatMap((e) => [e.a, e.b])) : null;
  const hovered = hover && at[hover];
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onPointerUp={(e) => { if (e.target !== e.currentTarget) downOnBackdrop.current = false; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); }} data-testid="network-dialog">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-5 max-w-[920px] w-full">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Room network</div>
            <div className="text-base font-semibold">Who touches whom, which rules link them, how people move</div>
          </div>
          <div className="flex items-center gap-2">

            {[["touch", "Touching"], ["rule", "Rules"], ["flow", "Travel"]].map(([k, l]) => (
              <button key={k} onClick={() => setKinds({ ...kinds, [k]: !kinds[k] })} data-testid={`network-kind-${k}`}
                className={`h-7 px-2.5 rounded-full text-[11px] border ${kinds[k] ? "bg-slate-900 text-white border-slate-900" : "border-slate-300"}`}>{l}</button>
            ))}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-full bg-slate-100">
              {[["force", "Network"], ["plan", "Plan"]].map(([k, l]) => (
                <button key={k} onClick={() => setMode(k)} data-testid={`network-mode-${k}`}
                  className={`h-6 px-2.5 rounded-full text-[10.5px] ${mode === k ? "bg-white shadow-sm" : "text-slate-500"}`}>{l}</button>
              ))}
            </div>
            <button onClick={onClose} data-testid="network-close" className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <svg ref={svgRef} width={W} height={H} className="rounded-xl bg-[#FAFAFA] border border-slate-100 select-none touch-none" data-testid="network-svg"
          onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <g data-content="">
          {vis.map((e, i) => {
            const a = at[e.a], b = at[e.b], dim = near && !(near.has(e.a) && near.has(e.b));
            const col = e.kind === "touch" ? "#CBD5E1" : e.kind === "rule" ? (e.status === "pass" ? "#2E9E46" : "#C0504D") : flowCol(e.flow);
            const [mx, my] = mid(e);
            return (
              <g key={i} opacity={dim ? 0.12 : 1}>
                <path d={`M${a.px} ${a.py} Q${mx} ${my} ${b.px} ${b.py}`} fill="none" stroke={col}
                  strokeWidth={e.kind === "flow" ? 2.4 : e.kind === "rule" ? 1.6 : 1} strokeDasharray={e.kind === "rule" && e.status === "fail" ? "5 4" : ""}>
                  <title>{e.kind === "rule" ? `${e.rule_id} · ${e.relation} ${e.threshold_mm} mm · actual ${e.distance_mm} mm · ${e.status}` : e.kind === "flow" ? `${e.task} · ${e.length_m} m · ${fmtSecs(e.seconds)}` : "touching"}</title>
                </path>
                {e.kind === "flow" && (flowSpots[i] || (hover && (e.a === hover || e.b === hover))) && <text x={flowSpots[i]?.x ?? mx} y={flowSpots[i]?.y ?? my} fontSize="10" textAnchor="middle" fill="#1D1D1F" stroke="#FAFAFA" strokeWidth={3} paintOrder="stroke" data-testid={`network-flow-label-${i}`} style={{ fontFamily: "Helvetica, Arial, sans-serif", pointerEvents: "none" }}>{`${e.length_m} m · ${fmtSecs(e.seconds)}`}</text>}
              </g>
            );
          })}
          {P.map((p) => {
            const r = nodeRadius(p), dim = near && !near.has(p.id), pinned = !!pins[p.id];
            return (
              <g key={p.id} transform={`translate(${p.px},${p.py})`} opacity={dim ? 0.2 : 1}
                 onMouseEnter={() => !drag && setHover(p.id)} onMouseLeave={() => !drag && setHover(null)}
                 onPointerDown={(ev) => { ev.preventDefault(); ev.currentTarget.setPointerCapture(ev.pointerId); setDrag(p.id); setHover(p.id); }}
                 onDoubleClick={() => release(p.id)}
                 data-testid={`network-node-${p.id}`} data-pinned={pinned ? "true" : "false"}
                 style={{ cursor: drag === p.id ? "grabbing" : "grab" }}>
                <circle r={r} fill={ROLE_COLOR[p.role] || "#94A3B8"} fillOpacity={0.9}
                  stroke={pinned ? "#1D1D1F" : "#fff"} strokeWidth={pinned ? 2 : 1.5} />
                {(spots[p.id] || hover === p.id) && (
                  <text x={spots[p.id]?.dx || 0} y={spots[p.id]?.dy ?? r + 11} fontSize="9.5" textAnchor={spots[p.id]?.anchor || "middle"}
                    fill="#1D1D1F" stroke="#FAFAFA" strokeWidth={3} paintOrder="stroke" data-testid={`network-label-${p.id}`}
                    style={{ pointerEvents: "none", fontFamily: "Helvetica, Arial, sans-serif" }}>{p.label}</text>
                )}
              </g>
            );
          })}
          </g>
        </svg>
        <div className="mt-3 flex items-center justify-between text-[10.5px] text-slate-500 flex-wrap gap-2">
          <div className="flex gap-3 flex-wrap">
            {Object.entries(ROLE_COLOR).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: c }} />{k.replace("_", " ").toLowerCase()}</span>)}
          </div>
          <div data-testid="network-hover-info">
            {hovered ? <span><b className="text-slate-900">{hovered.label}</b> · {hovered.degree} links · {hovered.zone || "—"} zone{pins[hovered.id] ? " · moved (double-click to release)" : ""}</span> : `Drag any bubble to rearrange — links follow · double-click to release · hover to isolate${hidden ? ` · ${hidden} crowded label${hidden > 1 ? "s" : ""} hidden` : ""}`}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-4 text-[10px] font-mono uppercase tracking-widest text-slate-500">
          <span><span style={{ color: BAND_COLOR.Excellent }}>━</span> rule met</span><span><span style={{ color: BAND_COLOR.Poor }}>╍</span> rule gap</span><span>━ touching</span>
          <div className="ml-auto flex items-center gap-2 normal-case tracking-normal font-sans text-[11px]">
            <span data-testid="network-save-status" className="text-slate-500 inline-flex items-center gap-1">
              {saveInfo.status === "saving" && <><Loader2 className="w-3 h-3 animate-spin" /> Saving layout…</>}
              {saveInfo.status === "saved" && <><Check className="w-3 h-3 text-emerald-600" /> Layout saved{saveInfo.by ? ` · ${saveInfo.by}` : ""}</>}
              {saveInfo.status === "readonly" && "View only · layout not saved"}
              {saveInfo.status === "error" && <span className="text-rose-600">Could not save layout</span>}
            </span>
            <button onClick={() => doExport("png")} data-testid="network-export-png" title="Download as PNG image"
              className="h-6 px-2.5 rounded-full border border-slate-300 hover:border-slate-900 inline-flex items-center gap-1 text-slate-700">
              <Download className="w-3 h-3" /> PNG
            </button>
            <button onClick={() => doExport("svg")} data-testid="network-export-svg" title="Download as SVG (sharp at any size)"
              className="h-6 px-2.5 rounded-full border border-slate-300 hover:border-slate-900 inline-flex items-center gap-1 text-slate-700">
              <Download className="w-3 h-3" /> SVG
            </button>
            <button onClick={resetLayout} data-testid="network-reset-layout" title="Release all moved bubbles"
              className={`h-6 px-2.5 rounded-full border border-slate-300 hover:border-slate-900 inline-flex items-center gap-1 text-slate-700 ${pinCount ? "" : "invisible"}`}>
              <RotateCcw className="w-3 h-3" /> Reset layout · {pinCount}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
