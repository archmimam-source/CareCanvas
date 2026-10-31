import React from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Html, ContactShadows } from "@react-three/drei";
import { Room3DObjects } from "./Room3D";

/**
 * ArchRender3D — high-fidelity 3D render output.
 * Fixed isometric camera, no controls by default (locked framing), with
 * annotated HTML callouts leadering to specific components, "Overall
 * Unidirectional Workflow" arrow at the top, zone chips, and flow legend.
 */
export default function ArchRender3D({ scene, components }) {
  if (!scene) return null;
  const cx = scene.width / 2;
  const cz = scene.depth / 2;
  const dist = Math.max(scene.width, scene.depth) * 2.4;
  const compMap = Object.fromEntries((components || []).map((c) => [c.key, c]));

  // Which items should have annotations
  const annotatedKeys = new Set([
    "macerator","clinical_wash_basin","commode_store","exhaust_vent",
    "entry_door","ppe_station","cabinet_coshh","biohazard_bin","prep_counter",
    "soap_dispenser","paper_towel"
  ]);
  const annotated = (scene.items || []).filter((it) =>
    annotatedKeys.has(it.component_key) && it.mount_type !== "ceiling"
  );

  // Split callouts into left/right columns to avoid pileup in the tight 3x3 footprint
  const leftItems = annotated.filter((it) => (it.x + it.w/2) < cx);
  const rightItems = annotated.filter((it) => (it.x + it.w/2) >= cx);
  leftItems.sort((a,b) => a.y - b.y);
  rightItems.sort((a,b) => a.y - b.y);

  return (
    <div className="relative w-full h-full">
      {/* Left column callout labels */}
      <div className="absolute left-2 top-24 z-30 space-y-2 pointer-events-none w-56">
        {leftItems.map((it) => {
          const comp = compMap[it.component_key] || {};
          return (
            <div key={it.id} className="bg-white/95 backdrop-blur border border-slate-300 rounded-md shadow-sm px-2 py-1"
                 data-testid={`callout-${comp.code || it.component_key}`}>
              <div className="font-display text-[11px] font-semibold text-slate-900 leading-tight">
                {comp.name || it.component_key}
              </div>
              {comp.code && comp.code !== "—" && (
                <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{comp.code}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right column callout labels */}
      <div className="absolute right-2 top-24 z-30 space-y-2 pointer-events-none w-56">
        {rightItems.map((it) => {
          const comp = compMap[it.component_key] || {};
          return (
            <div key={it.id} className="bg-white/95 backdrop-blur border border-slate-300 rounded-md shadow-sm px-2 py-1 text-right"
                 data-testid={`callout-${comp.code || it.component_key}`}>
              <div className="font-display text-[11px] font-semibold text-slate-900 leading-tight">
                {comp.name || it.component_key}
              </div>
              {comp.code && comp.code !== "—" && (
                <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{comp.code}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Header banner (workflow arrow + zone chips inline) */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 hb-glass rounded-full px-5 py-2 flex items-center gap-5 pointer-events-none">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#A2D9B0" }}/>
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-700">Clean</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#E5D5B0" }}/>
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-700">Transition</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#E89689" }}/>
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-700">Dirty</span>
        </div>
        <div className="w-px h-4 bg-slate-300"/>
        <div className="font-display text-xs font-semibold text-slate-800">
          Overall Unidirectional Workflow
        </div>
        <svg width="42" height="10" viewBox="0 0 42 10">
          <defs>
            <marker id="arh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="#1D1D1F"/>
            </marker>
          </defs>
          <line x1="0" y1="5" x2="38" y2="5" stroke="#1D1D1F" strokeWidth="1.5" markerEnd="url(#arh)"/>
        </svg>
      </div>

      {/* Flow legend */}
      <div className="absolute bottom-4 left-4 z-20 hb-glass rounded-xl p-3 pointer-events-none">
        <div className="font-mono text-[9px] uppercase tracking-[0.28em] text-slate-500 mb-1.5">
          Flow legend
        </div>
        <div className="space-y-1">
          {[
            ["Clean flow",  "#5EA773", "2 4"],
            ["Soiled flow", "#C97567", "8 3"],
            ["Person flow", "#B29666", "4 5"],
            ["Waste flow",  "#C97F1F", "2 3"],
          ].map(([label, color, dash]) => (
            <div key={label} className="flex items-center gap-2 text-xs text-slate-700">
              <svg width="34" height="6">
                <line x1="0" y1="3" x2="34" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dash}/>
              </svg>
              <span className="font-mono">{label}</span>
            </div>
          ))}
        </div>
      </div>

      <Canvas
        dpr={[1.5, 2]}
        shadows
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [cx + dist, dist * 1.15, cz + dist], fov: 26, near: 0.1, far: 200 }}
        style={{ width: "100%", height: "100%", background: "#F7F8FA" }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight
          position={[6, 14, 4]} intensity={1.05} castShadow
          shadow-mapSize-width={2048} shadow-mapSize-height={2048}
          shadow-camera-left={-8} shadow-camera-right={8}
          shadow-camera-top={8} shadow-camera-bottom={-8}
        />
        <directionalLight position={[-6, 8, -4]} intensity={0.35} />
        <hemisphereLight args={["#FFFFFF", "#E5E5EA", 0.45]} />
        <OrbitControls
          target={[cx, 0.6, cz]}
          enablePan={false} enableZoom
          minDistance={4} maxDistance={14}
          minPolarAngle={0.25} maxPolarAngle={Math.PI/2 - 0.05}
          enableDamping dampingFactor={0.08}
        />
        <ContactShadows position={[cx, 0.001, cz]} opacity={0.32}
                        scale={Math.max(scene.width, scene.depth) * 1.6} blur={2.8} far={4}/>
        <Room3DObjects scene={scene} overlays={{
          zones: true, wall: true, ceiling: true,
          animate: true, dirtyFlow: true, personFlow: true, cleanFlow: true,
        }} withFlows highDetail />

        {/* Anchor pins in world space (small dots) */}
        {annotated.map((it) => {
          const h = it.height_m || 0.9;
          const elev = it.elevation_m || 0;
          let px = it.x + it.w/2;
          let pz = it.y + it.d/2;
          if (it.mount_type === "wall") {
            const d0 = pz, d1 = scene.depth - pz, d2 = px, d3 = scene.width - px;
            const m = Math.min(d0, d1, d2, d3);
            if (m === d0)      pz = 0.04 + it.d/2;
            else if (m === d1) pz = scene.depth - 0.04 - it.d/2;
            else if (m === d2) px = 0.04 + it.w/2;
            else               px = scene.width - 0.04 - it.w/2;
          }
          const py = elev + h + 0.08;
          return (
            <mesh key={"pin-" + it.id} position={[px, py, pz]}>
              <sphereGeometry args={[0.03, 12, 12]} />
              <meshBasicMaterial color="#1D1D1F" />
            </mesh>
          );
        })}
      </Canvas>
    </div>
  );
}

function ZoneChip({ color, label, sub }) {
  return (
    <div className="hb-glass rounded-lg px-3 py-1.5 flex items-center gap-2">
      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
      <div>
        <div className="font-display text-xs font-semibold text-slate-900 leading-tight">{label}</div>
        <div className="font-mono text-[9px] text-slate-500 tracking-wider">{sub}</div>
      </div>
    </div>
  );
}
