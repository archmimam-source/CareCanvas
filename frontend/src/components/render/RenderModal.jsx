import React from "react";
import { motion } from "framer-motion";
import { X, CheckCircle2 } from "lucide-react";
import { api, BACKEND_URL } from "@/lib/apiClient";
import { saveBlob, brandedName } from "@/lib/download";
import ArchRender3D from "@/components/room/ArchRender3D";

function RenderModal({ render, components, onClose, roomId, roomName }) {
  const [view, setView] = React.useState("iso3d");
  const [aiUrl, setAiUrl] = React.useState(null);
  const [aiLoading, setAiLoading] = React.useState(false);
  const [aiError, setAiError] = React.useState(null);

  React.useEffect(() => {
    if (view !== "ai" || aiUrl || aiLoading || !roomId) return;
    setAiLoading(true); setAiError(null);
    // Reuse only if latest AI render matches current scene_version
    api.get(`/rooms/${roomId}/ai-renders`).then((r) => {
      const match = (r.data || []).find((x) => x.scene_version === render.scene_version);
      if (match) {
        setAiUrl(`${BACKEND_URL}${match.url}`);
        setAiLoading(false);
      } else {
        api.post(`/rooms/${roomId}/render-ai`, {}, { timeout: 120000 })
          .then((res) => { setAiUrl(`${BACKEND_URL}${res.data.url}`); setAiLoading(false); })
          .catch((e) => { setAiError(e.response?.data?.detail || "Generation failed"); setAiLoading(false); });
      }
    }).catch(() => {
      api.post(`/rooms/${roomId}/render-ai`, {}, { timeout: 120000 })
        .then((res) => { setAiUrl(`${BACKEND_URL}${res.data.url}`); setAiLoading(false); })
        .catch((e) => { setAiError(e.response?.data?.detail || "Generation failed"); setAiLoading(false); });
    });
  }, [view, aiUrl, aiLoading, roomId, render.scene_version]);

  const regenerate = () => {
    setAiUrl(null); setAiLoading(true); setAiError(null);
    api.post(`/rooms/${roomId}/render-ai`, {}, { timeout: 120000 })
      .then((res) => { setAiUrl(`${BACKEND_URL}${res.data.url}`); setAiLoading(false); })
      .catch((e) => { setAiError(e.response?.data?.detail || "Generation failed"); setAiLoading(false); });
  };

  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <motion.div initial={{scale:0.96, y:8}} animate={{scale:1, y:0}} exit={{scale:0.96}}
        transition={{type:"spring", stiffness: 260, damping: 26}}
        className="bg-white rounded-2xl shadow-2xl max-w-[1400px] w-full max-h-[92vh] overflow-hidden flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">
              High-Fidelity Architectural Render
            </div>
            <div className="font-display text-xl font-semibold tracking-tight">
              Inpatient Dirty Utility (Medium) · scene v{render.scene_version}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-full bg-slate-100 p-1" data-testid="render-view-toggle">
              <button onClick={() => setView("iso3d")}
                      className={`px-3 h-7 text-xs rounded-full transition-colors ${view === "iso3d" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                      data-testid="render-tab-3d">3D isometric</button>
              <button onClick={() => setView("plan")}
                      className={`px-3 h-7 text-xs rounded-full transition-colors ${view === "plan" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                      data-testid="render-tab-plan">Plan drawing</button>
              <button onClick={() => setView("ai")}
                      className={`px-3 h-7 text-xs rounded-full transition-colors ${view === "ai" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                      data-testid="render-tab-ai">Enhanced render</button>
            </div>
            <button onClick={onClose} data-testid="render-close" className="text-slate-500 hover:text-slate-900">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 flex-1 overflow-hidden" style={{ minHeight: "70vh" }}>
          <div className="col-span-3 relative bg-[#F7F8FA]" data-testid="render-canvas">
            {view === "iso3d" && <ArchRender3D scene={render.scene_snapshot} components={components} />}
            {view === "plan" && <ArchPlanDrawing render={render} components={components} />}
            {view === "ai" && (
              <div className="w-full h-full flex flex-col items-center justify-center p-8">
                {aiLoading && (
                  <div className="text-center">
                    <div className="inline-block w-8 h-8 border-2 border-slate-300 border-t-slate-900 rounded-full animate-spin mb-4"/>
                    <div className="font-display text-sm text-slate-700">Generating enhanced render…</div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mt-1">
                      15–30 seconds
                    </div>
                  </div>
                )}
                {aiError && (
                  <div className="text-center max-w-md">
                    <div className="text-sm text-[#B15A4F]">{aiError}</div>
                    <button onClick={regenerate} className="mt-3 px-3 h-8 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs" data-testid="ai-retry">Retry</button>
                  </div>
                )}
                {aiUrl && !aiLoading && (
                  <>
                    <img src={aiUrl} alt="AI render"
                         className="max-w-full max-h-[85%] rounded-xl shadow-lg"
                         style={{ background: "#FFFFFF" }}
                         data-testid="ai-render-img"/>
                    <div className="mt-4 flex gap-2">
                      <button onClick={() => fetch(aiUrl).then((r) => r.blob()).then((b) => saveBlob(b,
                          brandedName(roomName || "Room", "render", b.type === "image/jpeg" ? "jpg" : "png")))}
                        className="px-3 h-8 inline-flex items-center rounded-full bg-slate-100 hover:bg-slate-200 text-xs" data-testid="ai-download">Download image</button>
                      <button onClick={regenerate} className="px-3 h-8 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs" data-testid="ai-regen">Regenerate</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="p-6 border-l border-slate-200 overflow-auto">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500 mb-3">Checked against</div>
            <div className="space-y-2">
              {render.validation_snapshot?.checked?.map((c, i) => (
                <div key={i} className="text-xs">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{c.rule}</div>
                  <div className="text-slate-700">{c.label}</div>
                </div>
              ))}
            </div>
            <div className="mt-6 p-3 rounded-lg bg-[#D4EDDA] border border-[#6FBE83]/50">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#4A9C5F]" />
                <div className="font-display text-sm font-semibold">Baseline compliant</div>
              </div>
              <div className="font-mono text-[10px] text-slate-500 mt-1">
                Published {new Date(render.published_at).toLocaleString()} · {render.published_by}
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ============================================================================
// ARCHITECTURAL PLAN DRAWING (2D)
// ============================================================================
function ArchPlanDrawing({ render, components }) {
  const scene = render.scene_snapshot;
  const compMap = Object.fromEntries(components.map((c) => [c.key, c]));
  const PAD = 90;
  const S = 260; // px per meter
  const roomW = scene.width * S;
  const roomH = scene.depth * S;
  const svgW = roomW + PAD * 2;
  const svgH = roomH + PAD * 2 + 140;

  const ZONE_FILL = { clean: "#DFF0E3", transition: "#F3ECDD", dirty: "#F6DDD5" };
  const ZONE_STROKE = { clean: "#8DBF97", transition: "#C9B58F", dirty: "#D08578" };
  const FLOW = { soiled: "#B0655A", person: "#B29666", clean: "#5EA773", waste: "#C97F1F" };

  const items = scene.items || [];
  const zones = scene.zones || {};

  // Build callouts (right-side label leaders for prominent components)
  const highlightKeys = new Set([
    "macerator","clinical_wash_basin","commode_store","exhaust_vent",
    "entry_door","ppe_station","cabinet_coshh","biohazard_bin","prep_counter"
  ]);
  const callouts = items.filter((it) => highlightKeys.has(it.component_key) && it.mount_type !== "ceiling")
    .map((it, i) => {
      const cx = PAD + (it.x + it.w/2) * S;
      const cy = PAD + (it.y + it.d/2) * S;
      const comp = compMap[it.component_key];
      return {
        id: it.id, cx, cy,
        name: comp?.name || it.component_key,
        code: comp?.code || "",
      };
    });

  // Left/right column split for callouts
  const leftCall = callouts.filter((c) => c.cx < PAD + roomW/2);
  const rightCall = callouts.filter((c) => c.cx >= PAD + roomW/2);
  leftCall.sort((a,b)=>a.cy-b.cy);
  rightCall.sort((a,b)=>a.cy-b.cy);
  leftCall.forEach((c, i) => { c.labelX = 8; c.labelY = PAD - 20 + (i+1) * ((roomH+40) / (leftCall.length+1)); });
  rightCall.forEach((c, i) => { c.labelX = svgW - 8; c.labelY = PAD - 20 + (i+1) * ((roomH+40) / (rightCall.length+1)); });

  return (
    <div className="overflow-auto bg-[#FAFAFB] p-6 w-full h-full" data-testid="render-drawing">
            <svg width={svgW} height={svgH} className="mx-auto" style={{background:"#FFFFFF", borderRadius: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.05)"}}>
              <defs>
                <marker id="ra1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill="#1D1D1F"/>
                </marker>
                {Object.entries(FLOW).map(([k, c]) => (
                  <marker key={k} id={`arr-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L10,5 L0,10 z" fill={c}/>
                  </marker>
                ))}
                <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" stroke="#B3B7BD" strokeWidth="1"/>
                </pattern>
              </defs>

              <style>{`
                @keyframes marchArch { to { stroke-dashoffset: -18; } }
                .arch-flow { animation: marchArch 1.8s linear infinite; }
              `}</style>

              {/* Title block */}
              <g>
                <text x={PAD} y={38} className="font-display" style={{fontSize: 16, fill:"#1D1D1F", fontWeight: 600}}>
                  DIRTY UTILITY — MEDIUM · CODE 6222
                </text>
                <text x={PAD} y={58} className="font-mono" style={{fontSize: 10, fill: "#6B6B70", letterSpacing:"0.2em"}}>
                  SCALE 1:{Math.round(1000 / S)} · SCENE v{render.scene_version} · BASELINE COMPLIANT
                </text>
              </g>

              {/* Wall thickness (double-line) */}
              <rect x={PAD - 8} y={PAD - 8} width={roomW + 16} height={roomH + 16}
                    fill="none" stroke="#1D1D1F" strokeWidth="1.5"/>
              <rect x={PAD} y={PAD} width={roomW} height={roomH}
                    fill="#FFFFFF" stroke="#1D1D1F" strokeWidth="1"/>
              {/* Wall fill (hatch between double lines) */}
              <rect x={PAD - 8} y={PAD - 8} width={roomW + 16} height={roomH + 16}
                    fill="url(#hatch)" fillOpacity="0.5" stroke="none"
                    style={{clipPath: `path('M ${PAD - 8} ${PAD - 8} h ${roomW+16} v ${roomH+16} h ${-(roomW+16)} z M ${PAD} ${PAD} h ${roomW} v ${roomH} h ${-roomW} z')`}}/>

              {/* Zones */}
              {Object.entries(zones).map(([k, z]) => (
                <g key={k}>
                  <rect x={PAD + z.x*S} y={PAD + z.y*S} width={z.w*S} height={z.d*S}
                        fill={ZONE_FILL[k]} fillOpacity="0.85"/>
                  <text x={PAD + z.x*S + 12} y={PAD + z.y*S + 22} className="font-mono"
                        style={{fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase",
                                fill: ZONE_STROKE[k], fontWeight: 700}}>
                    ZONE · {k}
                  </text>
                </g>
              ))}

              {/* Grid (subtle) */}
              {Array.from({length: Math.ceil(scene.width * 4)+1}).map((_, i) => (
                <line key={"gx"+i} x1={PAD + i * S/4} y1={PAD} x2={PAD + i * S/4} y2={PAD + roomH}
                      stroke="rgba(0,0,0,0.04)" strokeWidth={i%4===0?0.8:0.4}/>
              ))}
              {Array.from({length: Math.ceil(scene.depth * 4)+1}).map((_, i) => (
                <line key={"gy"+i} x1={PAD} y1={PAD + i * S/4} x2={PAD + roomW} y2={PAD + i * S/4}
                      stroke="rgba(0,0,0,0.04)" strokeWidth={i%4===0?0.8:0.4}/>
              ))}

              {/* Items (icon-detailed) */}
              {items.filter(it => it.mount_type !== "ceiling").map((it) => {
                const comp = compMap[it.component_key] || {};
                return <ItemIcon key={it.id} it={it} comp={comp} PAD={PAD} S={S}/>;
              })}
              {/* Ceiling items shown as hollow squares */}
              {items.filter(it => it.mount_type === "ceiling").map((it) => (
                <g key={"c"+it.id}>
                  <rect x={PAD + it.x*S} y={PAD + it.y*S} width={it.w*S} height={it.d*S}
                        fill="none" stroke="#8E9198" strokeDasharray="3 3" strokeWidth="1"/>
                  <text x={PAD + it.x*S + it.w*S/2} y={PAD + it.y*S + it.d*S/2 + 3}
                        textAnchor="middle" className="font-mono"
                        style={{fontSize: 9, fill: "#8E9198", letterSpacing: "0.1em"}}>
                    {compMap[it.component_key]?.code || "CLG"}
                  </text>
                </g>
              ))}

              {/* Door swing arc */}
              {items.find(it => it.component_key === "entry_door") && (() => {
                const d = items.find(it => it.component_key === "entry_door");
                const dx = PAD + d.x*S, dy = PAD + d.y*S;
                const r = d.w * S * 0.85;
                return (
                  <path d={`M ${dx} ${dy} L ${dx} ${dy - r} A ${r} ${r} 0 0 0 ${dx - r} ${dy}`}
                        fill="none" stroke="#1D1D1F" strokeWidth="0.75" strokeDasharray="3 3"/>
                );
              })()}

              {/* Flow lines (animated) */}
              {zones.dirty && zones.clean && (
                <g>
                  <path
                    d={`M ${PAD + zones.dirty.x*S + 20}
                          ${PAD + (zones.dirty.y + zones.dirty.d/2)*S}
                        L ${PAD + zones.dirty.x*S + 20}
                          ${PAD + (zones.clean.y + zones.clean.d/2)*S}`}
                    stroke={FLOW.soiled} strokeWidth="2" fill="none"
                    strokeDasharray="8 4" markerEnd="url(#arr-soiled)"
                    className="arch-flow"/>
                </g>
              )}
              {zones.clean && (
                <>
                  <path
                    d={`M ${PAD + roomW - 30} ${PAD + roomH - 30}
                        L ${PAD + roomW - 30} ${PAD + (zones.clean.y + zones.clean.d*0.5)*S}
                        L ${PAD + zones.clean.x*S + zones.clean.w*S*0.5} ${PAD + (zones.clean.y + zones.clean.d*0.5)*S}`}
                    stroke={FLOW.person} strokeWidth="2" fill="none"
                    strokeDasharray="4 5" markerEnd="url(#arr-person)"
                    className="arch-flow"/>
                  <path
                    d={`M ${PAD + roomW - 70} ${PAD + roomH - 6}
                        L ${PAD + roomW - 70} ${PAD + (zones.clean.y)*S + 20}`}
                    stroke={FLOW.clean} strokeWidth="2" fill="none"
                    strokeDasharray="2 5" markerEnd="url(#arr-clean)"
                    className="arch-flow"/>
                </>
              )}
              {zones.dirty && (
                <path
                  d={`M ${PAD + zones.dirty.x*S + zones.dirty.w*S - 30}
                        ${PAD + (zones.dirty.y + zones.dirty.d*0.5)*S}
                      L ${PAD + roomW - 6}
                        ${PAD + (zones.dirty.y + zones.dirty.d*0.5)*S}`}
                  stroke={FLOW.waste} strokeWidth="2" fill="none"
                  strokeDasharray="2 3" markerEnd="url(#arr-waste)"
                  className="arch-flow"/>
              )}

              {/* Dimensions — overall */}
              <g>
                <line x1={PAD} y1={PAD + roomH + 40} x2={PAD + roomW} y2={PAD + roomH + 40}
                      stroke="#1D1D1F" strokeWidth="0.75" markerStart="url(#ra1)" markerEnd="url(#ra1)"/>
                <text x={PAD + roomW/2} y={PAD + roomH + 34} textAnchor="middle" className="font-mono"
                      style={{fontSize: 11, fill: "#1D1D1F"}}>{(scene.width*1000).toFixed(0)} mm</text>
                <line x1={PAD - 40} y1={PAD} x2={PAD - 40} y2={PAD + roomH}
                      stroke="#1D1D1F" strokeWidth="0.75" markerStart="url(#ra1)" markerEnd="url(#ra1)"/>
                <text x={PAD - 46} y={PAD + roomH/2} textAnchor="middle" className="font-mono"
                      style={{fontSize: 11, fill: "#1D1D1F"}}
                      transform={`rotate(-90, ${PAD - 46}, ${PAD + roomH/2})`}>
                  {(scene.depth*1000).toFixed(0)} mm
                </text>
              </g>

              {/* Callout leaders */}
              {leftCall.map((c) => (
                <g key={"l"+c.id}>
                  <line x1={c.labelX + 220} y1={c.labelY} x2={c.labelX + 260} y2={c.labelY}
                        stroke="#1D1D1F" strokeWidth="0.5"/>
                  <line x1={c.labelX + 260} y1={c.labelY} x2={c.cx - 4} y2={c.cy}
                        stroke="#1D1D1F" strokeWidth="0.5"/>
                  <circle cx={c.cx} cy={c.cy} r="3" fill="#1D1D1F"/>
                  <text x={c.labelX + 4} y={c.labelY - 4} className="font-display"
                        style={{fontSize: 11, fill: "#1D1D1F", fontWeight: 600}}>{c.name}</text>
                  <text x={c.labelX + 4} y={c.labelY + 10} className="font-mono"
                        style={{fontSize: 9, fill: "#6B6B70", letterSpacing: "0.2em"}}>{c.code}</text>
                </g>
              ))}
              {rightCall.map((c) => (
                <g key={"r"+c.id}>
                  <line x1={c.labelX - 260} y1={c.labelY} x2={c.labelX - 220} y2={c.labelY}
                        stroke="#1D1D1F" strokeWidth="0.5"/>
                  <line x1={c.labelX - 260} y1={c.labelY} x2={c.cx + 4} y2={c.cy}
                        stroke="#1D1D1F" strokeWidth="0.5"/>
                  <circle cx={c.cx} cy={c.cy} r="3" fill="#1D1D1F"/>
                  <text x={c.labelX - 4} y={c.labelY - 4} textAnchor="end" className="font-display"
                        style={{fontSize: 11, fill: "#1D1D1F", fontWeight: 600}}>{c.name}</text>
                  <text x={c.labelX - 4} y={c.labelY + 10} textAnchor="end" className="font-mono"
                        style={{fontSize: 9, fill: "#6B6B70", letterSpacing: "0.2em"}}>{c.code}</text>
                </g>
              ))}

              {/* Flow legend */}
              <g transform={`translate(${PAD}, ${PAD + roomH + 70})`}>
                <text x="0" y="0" className="font-mono"
                      style={{fontSize: 10, fill: "#1D1D1F", letterSpacing: "0.25em", textTransform: "uppercase", fontWeight: 600}}>
                  Flow legend
                </text>
                {[
                  ["Soiled flow", FLOW.soiled, "8 4"],
                  ["Person flow", FLOW.person, "4 5"],
                  ["Clean supply", FLOW.clean, "2 5"],
                  ["Waste flow", FLOW.waste, "2 3"],
                ].map(([label, color, dash], i) => (
                  <g key={label} transform={`translate(${i * 180}, 24)`}>
                    <line x1="0" y1="0" x2="42" y2="0" stroke={color} strokeWidth="2" strokeDasharray={dash}/>
                    <text x="52" y="4" className="font-mono"
                          style={{fontSize: 10, fill: "#1D1D1F"}}>{label}</text>
                  </g>
                ))}
              </g>
            </svg>
          </div>
  );
}

// Render individual item as a small icon inside SVG (mini top-down representation)
function ItemIcon({ it, comp, PAD, S }) {
  const x = PAD + it.x * S, y = PAD + it.y * S, w = it.w * S, h = it.d * S;
  const wall = it.mount_type === "wall";
  const kind = comp?.kind || "cabinet";
  const zone = it.zone;
  const ZONE_TINT = { clean: "#7FB58A", transition: "#C9A76E", dirty: "#CE8175" };
  const tint = ZONE_TINT[zone] || "#8E9198";

  // For each kind, draw a tiny plan-view schematic
  const label = (comp?.code && comp.code !== "—") ? comp.code : (comp?.name?.split(" ")[0] || "");
  const showLabel = w > 40;

  const box = (
    <rect x={x} y={y} width={w} height={h}
          fill={wall ? "#F5F5F7" : "#FFFFFF"}
          stroke={tint} strokeWidth={wall ? 1.2 : 1.4}
          strokeDasharray={wall ? "3 2" : ""}
          rx={kind === "bin" ? Math.min(w,h)/2 : 3}/>
  );

  let detail = null;
  if (kind === "basin") {
    // Inner sink bowl
    detail = (
      <>
        <rect x={x+w*0.15} y={y+h*0.2} width={w*0.7} height={h*0.55}
              fill="#EAF3F6" stroke={tint} strokeWidth="0.8" rx="3"/>
        <circle cx={x+w*0.5} cy={y+h*0.55} r={Math.min(w,h)*0.08} fill="#B4CBD3"/>
      </>
    );
  } else if (kind === "macerator") {
    detail = (
      <>
        <rect x={x+w*0.15} y={y+h*0.15} width={w*0.7} height={h*0.7}
              fill="#EAF3F6" stroke={tint} strokeWidth="0.8" rx="2"/>
        <line x1={x+w*0.15} y1={y+h*0.4} x2={x+w*0.85} y2={y+h*0.4} stroke={tint} strokeWidth="0.6"/>
      </>
    );
  } else if (kind === "counter") {
    detail = (
      <line x1={x+w*0.05} y1={y+h*0.5} x2={x+w*0.95} y2={y+h*0.5} stroke={tint} strokeWidth="0.6" strokeDasharray="2 2"/>
    );
  } else if (kind === "bin") {
    detail = <circle cx={x+w/2} cy={y+h/2} r={Math.min(w,h)*0.28} fill="none" stroke={tint} strokeWidth="0.8"/>;
  } else if (kind === "trolley") {
    detail = (
      <>
        <circle cx={x+w/2} cy={y+h/2} r={Math.min(w,h)*0.32} fill="none" stroke={tint} strokeWidth="0.8"/>
        {[[0.15,0.15],[0.85,0.15],[0.15,0.85],[0.85,0.85]].map(([u,v],i)=>(
          <circle key={i} cx={x+w*u} cy={y+h*v} r="1.5" fill={tint}/>
        ))}
      </>
    );
  } else if (kind === "cabinet" || kind === "cabinet_tall") {
    detail = (
      <>
        <line x1={x+w/2} y1={y+2} x2={x+w/2} y2={y+h-2} stroke={tint} strokeWidth="0.5"/>
        <circle cx={x+w*0.7} cy={y+h/2} r="1.5" fill={tint}/>
      </>
    );
  } else if (kind === "dispenser") {
    detail = (
      <rect x={x+w*0.25} y={y+h*0.35} width={w*0.5} height={h*0.4}
            fill="#EAF3F6" stroke={tint} strokeWidth="0.6"/>
    );
  } else if (kind === "door") {
    detail = null; // handled by swing arc
  } else if (kind === "ppe") {
    detail = (
      <>
        {[0.25, 0.5, 0.75].map((v,i)=>(
          <line key={i} x1={x+w*0.15} y1={y+h*v} x2={x+w*0.85} y2={y+h*v} stroke={tint} strokeWidth="0.6"/>
        ))}
      </>
    );
  } else if (kind === "shelf" || kind === "panel" || kind === "tray") {
    detail = null;
  }

  return (
    <g>
      {box}
      {detail}
      {showLabel && (
        <text x={x + w/2} y={y + h/2 + 4} textAnchor="middle" className="font-mono"
              style={{fontSize: 10, fill: "#1D1D1F", fontWeight: 500, pointerEvents: "none"}}>
          {label}
        </text>
      )}
    </g>
  );
}
export default RenderModal;
