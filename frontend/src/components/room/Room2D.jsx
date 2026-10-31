import React, { useEffect, useMemo, useRef, useState } from "react";
import { ramp, gridRange } from "@/lib/spatial";

const ZONE_STROKE = { clean: "#6FBE83", transition: "#C9A76E", dirty: "#D07268" };
const ZONE_FILL   = { clean: "#DBEEDE", transition: "#F0E7D2", dirty: "#F7DCD4" };
const ITEM_COLOR  = { clean: "#6FBE83", transition: "#C9A76E", dirty: "#D07268" };

// Stable pastel color per peer, keyed by their email / name.
const _PEER_PALETTE = ["#0071E3","#34C759","#FF9500","#AF52DE","#FF2D55","#5AC8FA","#EF476F","#5856D6","#22D3EE","#F97316"];
function _peerColor(key = "") {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return _PEER_PALETTE[h % _PEER_PALETTE.length];
}
function _titleCase(s) {
  if (!s) return "";
  return String(s).replace(/\b\w/g, (c) => c.toUpperCase());
}
// Approximate text width for the peer name pill (11px font).
function _measureText(s) {
  return Math.max(24, Math.round(String(s).length * 6.5));
}

export default function Room2D({
  scene, onSceneChange, selected, setSelected,
  selectedIds = [], setSelectedIds,
  flags = [], flagsByItem = {},
  flowPaths = null,
  analysisOverlay = null,
  componentsByKey = {},
  peers = [], sendCursor,
  editorMode = "select", onEditorModeChange,
  onPartitionAdd, onPartitionRemove,
  overlays, zoom = 1, onZoomChange,
}) {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [marquee, setMarquee] = useState(null); // {x0,y0,x1,y1} in metres
  const [hoveredItem, setHoveredItem] = useState(null); // for flag / materials tooltip
  const [containerSize, setContainerSize] = useState({ w: 800, h: 500 });
  const [dragPreview, setDragPreview] = useState(null); // { comp, x, y } while dragging from palette
  // Partition draw state — when editorMode === "partition", the SVG accepts
  // two clicks to define a segment. `partitionStart` holds the first click
  // in metres; `partitionHover` mirrors the mouse for the live preview.
  const [partitionStart, setPartitionStart] = useState(null);
  const [partitionHover, setPartitionHover] = useState(null);

  const idsSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const emitSelectedIds = (arr) => {
    if (setSelectedIds) setSelectedIds(arr);
    if (setSelected) setSelected(arr.length === 1 ? arr[0] : (arr[arr.length - 1] || null));
  };

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ w: width, h: height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Track drag-over from the palette so we can render a live footprint ghost.
  // The palette emits `his:paletteDragStart` with the component on dragstart.
  useEffect(() => {
    const onStart = (e) => setDragPreview({ comp: e.detail, x: null, y: null });
    const onEnd   = () => setDragPreview(null);
    window.addEventListener("his:paletteDragStart", onStart);
    window.addEventListener("his:paletteDragEnd",   onEnd);
    return () => {
      window.removeEventListener("his:paletteDragStart", onStart);
      window.removeEventListener("his:paletteDragEnd",   onEnd);
    };
  }, []);

  // Fit-to-container scale in px/m, then user zoom multiplies it
  const fitPx = Math.min(
    (containerSize.w - 40) / scene.width,
    (containerSize.h - 40) / scene.depth
  );
  const PX_PER_M = Math.max(40, fitPx * zoom);
  const heatRects = useMemo(() => {
    if (!analysisOverlay?.values) return null;
    const { res } = analysisOverlay.grid, vals = analysisOverlay.values;
    const [mn, mx] = gridRange(vals);
    return vals.flatMap((row, j) => row.map((v, i) => v == null ? null : (
      <rect key={`h${i}-${j}`} x={i * res * PX_PER_M} y={j * res * PX_PER_M}
        width={res * PX_PER_M + 0.5} height={res * PX_PER_M + 0.5}
        fill={ramp(analysisOverlay.layer === "step_depth" ? 1 - (v - mn) / (mx - mn || 1) : (v - mn) / (mx - mn || 1))}
        fillOpacity={0.55} />
    )));
  }, [analysisOverlay?.values, analysisOverlay?.layer, analysisOverlay?.grid, PX_PER_M]);
  const W = scene.width * PX_PER_M;
  const H = scene.depth * PX_PER_M;

  // Attach non-passive wheel listener so preventDefault actually blocks page scroll
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !onZoomChange) return;
    const handler = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      onZoomChange(Math.max(0.4, Math.min(3.5, zoom * factor)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoom, onZoomChange]);


  const toM = (px) => px / PX_PER_M;
  const zoneAt = (x, y) => {
    for (const [k, z] of Object.entries(scene.zones || {})) {
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.d) return k;
    }
    return "transition";
  };

  const startDrag = (e, item) => {
    e.stopPropagation();
    // Shift-click toggles multi-select without starting a drag
    if (e.shiftKey) {
      const has = idsSet.has(item.id);
      emitSelectedIds(has ? selectedIds.filter((x) => x !== item.id) : [...selectedIds, item.id]);
      return;
    }
    // If item is already in the multi-selection, keep the group and drag it as one
    if (!idsSet.has(item.id)) emitSelectedIds([item.id]);
    const rect = svgRef.current.getBoundingClientRect();
    setDragging({
      id: item.id,
      offsetX: toM(e.clientX - rect.left) - item.x,
      offsetY: toM(e.clientY - rect.top) - item.y,
    });
  };

  // Marquee: mousedown on empty background (not on an item)
  const onBgMouseDown = (e) => {
    if (!svgRef.current) return;
    if (e.target !== e.currentTarget) return; // only when the bg rect is the direct target
    const rect = svgRef.current.getBoundingClientRect();
    const mx = toM(e.clientX - rect.left);
    const my = toM(e.clientY - rect.top);
    // Partition draw mode swallows all bg clicks. First click sets the
    // start point; second click emits the partition and exits the mode.
    if (editorMode === "partition") {
      const snapped = snapPartitionPoint(mx, my);
      if (!partitionStart) {
        setPartitionStart(snapped);
      } else {
        // Force the segment to be axis-aligned by locking the axis with
        // the smaller delta to the start point.
        const seg = axisLock(partitionStart, snapped);
        onPartitionAdd && onPartitionAdd(seg);
        setPartitionStart(null);
        setPartitionHover(null);
      }
      return;
    }
    if (!e.shiftKey) emitSelectedIds([]);
    setMarquee({ x0: mx, y0: my, x1: mx, y1: my });
  };

  // Snap a raw metre-space point to the closest room wall or 5 cm grid.
  const snapPartitionPoint = (x, y) => {
    const W = scene.width, D = scene.depth, T = 0.25;
    let sx = x, sy = y;
    if (Math.abs(x) < T)       sx = 0;
    if (Math.abs(x - W) < T)   sx = W;
    if (Math.abs(y) < T)       sy = 0;
    if (Math.abs(y - D) < T)   sy = D;
    return { x: Math.round(sx * 20) / 20, y: Math.round(sy * 20) / 20 };
  };
  const axisLock = (a, b) => {
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    return dx >= dy ? { x1: a.x, y1: a.y, x2: b.x, y2: a.y }
                    : { x1: a.x, y1: a.y, x2: a.x, y2: b.y };
  };

  const onMove = (e) => {
    // NOTE: Cursor broadcast lives at the page-level `RoomPresenceOverlay`
    // now (see /app/frontend/src/components/presence/RoomPresenceOverlay.jsx).
    // The old Room2D-scoped `sendCursor` only fired when the mouse was
    // strictly INSIDE the room polygon, which caused peer cursors to
    // blink on and off. Handled globally via viewport-normalised
    // coordinates instead.
    // Live partition preview.
    if (editorMode === "partition" && partitionStart && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const p = snapPartitionPoint(toM(e.clientX - rect.left), toM(e.clientY - rect.top));
      setPartitionHover(p);
    }
    if (marquee) {
      const rect = svgRef.current.getBoundingClientRect();
      setMarquee((m) => m ? { ...m, x1: toM(e.clientX - rect.left), y1: toM(e.clientY - rect.top) } : null);
      return;
    }
    if (!dragging) return;
    const rect = svgRef.current.getBoundingClientRect();
    const newX = Math.max(0, toM(e.clientX - rect.left) - dragging.offsetX);
    const newY = Math.max(0, toM(e.clientY - rect.top) - dragging.offsetY);
    // Move the dragged item; if it's part of a multi-selection, move the group by the same delta
    const dragged = scene.items.find((i) => i.id === dragging.id);
    if (!dragged) return;
    const clampedX = Math.min(newX, scene.width - dragged.w);
    const clampedY = Math.min(newY, scene.depth - dragged.d);
    const dx = clampedX - dragged.x;
    const dy = clampedY - dragged.y;
    const movingIds = idsSet.has(dragging.id) && idsSet.size > 1 ? idsSet : new Set([dragging.id]);
    const items = scene.items.map((it) => {
      if (!movingIds.has(it.id)) return it;
      const nx = Math.min(Math.max(0, it.x + dx), scene.width - it.w);
      const ny = Math.min(Math.max(0, it.y + dy), scene.depth - it.d);
      return { ...it, x: nx, y: ny, zone: zoneAt(nx + it.w/2, ny + it.d/2) };
    });
    onSceneChange({ ...scene, items });
  };

  const endDrag = () => {
    if (marquee) {
      // Collect items whose footprints intersect the marquee
      const mx0 = Math.min(marquee.x0, marquee.x1);
      const my0 = Math.min(marquee.y0, marquee.y1);
      const mx1 = Math.max(marquee.x0, marquee.x1);
      const my1 = Math.max(marquee.y0, marquee.y1);
      if ((mx1 - mx0) > 0.05 || (my1 - my0) > 0.05) {
        const picked = scene.items.filter((it) => visible(it)
          && it.x + it.w >= mx0 && it.x <= mx1
          && it.y + it.d >= my0 && it.y <= my1).map((it) => it.id);
        emitSelectedIds(picked);
      }
      setMarquee(null);
    }
    setDragging(null);
  };

  // Corner-snap helper. If an incoming `against_wall`/`wall_mounted` drop
  // lands within 30 cm of a room wall, adjust position + rotation so the
  // component ends up flush and facing into the room. Room walls only —
  // partitions are honoured separately by the backend snap endpoint.
  const applyCornerSnap = (raw, comp) => {
    const placement = comp.placement || (comp.mount_type === "wall" ? "wall_mounted" :
                                          comp.mount_type === "ceiling" ? "ceiling_mounted" : "free_floor");
    if (placement !== "against_wall" && placement !== "wall_mounted") return raw;
    const RADIUS = 0.30;
    const W = scene.width, D = scene.depth;
    const dN = raw.y, dS = D - (raw.y + raw.d), dW = raw.x, dE = W - (raw.x + raw.w);
    const walls = [["top", dN, 0], ["bottom", dS, 180], ["left", dW, 270], ["right", dE, 90]]
                    .sort((a, b) => a[1] - b[1]);
    // Only snap if the nearest wall is within RADIUS.
    if (walls[0][1] > RADIUS) return raw;
    // Corner detection — two walls within RADIUS.
    const inCorner = walls[1][1] < RADIUS;
    let chosen = walls[0];
    if (inCorner) {
      // Prefer the wall aligned with the component's longer footprint side.
      const longAxisIsX = raw.w >= raw.d;
      const pref = walls.slice(0, 2).find(([n]) => (n === "top" || n === "bottom") === longAxisIsX);
      chosen = pref || walls[0];
    }
    const [name, , rot] = chosen;
    const snapped = { ...raw, rotation: rot };
    // w/d are the on-plan footprint: swap when the item turns to face a side wall.
    if ((rot % 180) !== ((raw.rotation || 0) % 180)) { snapped.w = raw.d; snapped.d = raw.w; }
    if      (name === "top")    snapped.y = 0;
    else if (name === "bottom") snapped.y = D - snapped.d;
    else if (name === "left")   snapped.x = 0;
    else if (name === "right")  snapped.x = W - snapped.w;
    return snapped;
  };

  const onDropFromPalette = (e) => {
    e.preventDefault();
    setDragPreview(null);
    const payload = e.dataTransfer.getData("application/json");
    if (!payload) return;
    const comp = JSON.parse(payload);
    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.max(0, toM(e.clientX - rect.left) - comp.default_footprint.w/2);
    const y = Math.max(0, toM(e.clientY - rect.top) - comp.default_footprint.d/2);
    let item = {
      id: crypto.randomUUID(),
      component_key: comp.key,
      x, y,
      w: comp.default_footprint.w, d: comp.default_footprint.d,
      rotation: 0,
      zone: zoneAt(x + comp.default_footprint.w/2, y + comp.default_footprint.d/2),
      mount_type: comp.mount_type || "floor",
      elevation_m: comp.elevation_m || 0,
      height_m: comp.height_m || comp.default_footprint.h || 0.9,
    };
    item = applyCornerSnap(item, comp);
    onSceneChange({ ...scene, items: [...scene.items, item] });
    setSelected(item.id);
  };

  const removeItem = (id) => {
    onSceneChange({ ...scene, items: scene.items.filter((i) => i.id !== id) });
    if (selected === id) setSelected(null);
  };

  const showZones = overlays?.zones ?? true;
  const showDirtyFlow = overlays?.dirtyFlow ?? true;
  const showPersonFlow = overlays?.personFlow ?? false;
  const showCleanFlow = overlays?.cleanFlow ?? false;
  const showWallItems = overlays?.wall ?? true;
  const showCeilingItems = overlays?.ceiling ?? false;

  const visible = (it) => {
    if (it.mount_type === "wall" && !showWallItems) return false;
    if (it.mount_type === "ceiling" && !showCeilingItems) return false;
    return true;
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && editorMode === "partition") {
        setPartitionStart(null);
        setPartitionHover(null);
        onEditorModeChange && onEditorModeChange("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorMode, onEditorModeChange]);

  return (
    <div ref={wrapRef} className="w-full h-full flex items-center justify-center overflow-hidden hb-scroll p-4"
         onDragOver={(e) => {
           e.preventDefault();
           if (!dragPreview?.comp || !svgRef.current) return;
           const rect = svgRef.current.getBoundingClientRect();
           const w = dragPreview.comp.default_footprint.w;
           const d = dragPreview.comp.default_footprint.d;
           const x = Math.max(0, toM(e.clientX - rect.left) - w/2);
           const y = Math.max(0, toM(e.clientY - rect.top)  - d/2);
           setDragPreview({ comp: dragPreview.comp, x, y });
         }}
         onDragLeave={() => setDragPreview((p) => p ? { ...p, x: null, y: null } : null)}
         onDrop={onDropFromPalette}
         data-testid="room-2d">
      <svg
        ref={svgRef}
        width={W} height={H}
        onMouseMove={onMove} onMouseUp={endDrag} onMouseLeave={endDrag}
        className="rounded-3xl"
        data-testid="room-2d-svg"
        style={{
          background: "#FBFBFD",
          border: "1px solid #E5E5EA",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.05)",
          userSelect: "none",
        }}
      >
        {/* Grid — Apple-neutral, layered fine + coarse */}
        <defs>
          <pattern id="p2d-grid-fine" width={PX_PER_M/4} height={PX_PER_M/4} patternUnits="userSpaceOnUse">
            <path d={`M ${PX_PER_M/4} 0 L 0 0 0 ${PX_PER_M/4}`} fill="none" stroke="rgba(29,29,31,0.05)" strokeWidth="1"/>
          </pattern>
          <pattern id="p2d-grid-1m" width={PX_PER_M} height={PX_PER_M} patternUnits="userSpaceOnUse">
            <path d={`M ${PX_PER_M} 0 L 0 0 0 ${PX_PER_M}`} fill="none" stroke="rgba(29,29,31,0.10)" strokeWidth="1"/>
          </pattern>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#8E8E93"/>
          </marker>
          {[
            ["arr-soiled",       "#B0655A"],
            ["arr-clean_supply", "#5EA773"],
            ["arr-person",       "#B29666"],
            ["arr-waste",        "#7C6DA5"],
          ].map(([id, colour]) => (
            <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={colour} />
            </marker>
          ))}
        </defs>
        <rect width={W} height={H} fill="url(#p2d-grid-fine)"
              onMouseDown={onBgMouseDown}
              data-testid="room-2d-bg"/>
        <rect width={W} height={H} fill="url(#p2d-grid-1m)" pointerEvents="none"/>

        {/* Zones */}
        {showZones && Object.entries(scene.zones || {}).map(([k, z]) => (
          <g key={k}>
            <rect
              x={z.x * PX_PER_M} y={z.y * PX_PER_M}
              width={z.w * PX_PER_M} height={z.d * PX_PER_M}
              fill={ZONE_FILL[k]} fillOpacity={0.85}
              stroke={ZONE_STROKE[k]} strokeOpacity="0.55"
              strokeDasharray="6 4" strokeWidth="1"
              rx="8"
            />
            <text
              x={z.x * PX_PER_M + 14}
              y={z.y * PX_PER_M + 22}
              style={{ fontSize: 10, fill: ZONE_STROKE[k], letterSpacing: "0.28em", textTransform: "uppercase", fontWeight: 600, fontFamily: "'SF Mono','JetBrains Mono',monospace" }}
            >{k}</text>
          </g>
        ))}

        {/* Flow overlays are now rendered AFTER the items so the arrows
            are never hidden behind furniture — see block below. */}

        {/* Interior partitions — user-drawn IPS-style walls that count as
            valid mount surfaces for wall-mounted components. Rendered as
            thick charcoal segments with a subtle drop shadow. */}
        {(scene.partitions || []).map((p) => (
          <g key={p.id} data-testid={`partition-${p.id}`}>
            <line x1={p.x1 * PX_PER_M} y1={p.y1 * PX_PER_M}
                  x2={p.x2 * PX_PER_M} y2={p.y2 * PX_PER_M}
                  stroke="#1D1D1F" strokeWidth="7" strokeLinecap="round"
                  opacity="0.85" />
            <line x1={p.x1 * PX_PER_M} y1={p.y1 * PX_PER_M}
                  x2={p.x2 * PX_PER_M} y2={p.y2 * PX_PER_M}
                  stroke="#F5F5F7" strokeWidth="1.5" strokeLinecap="round"
                  opacity="0.7" />
            {/* Delete handle at the midpoint (visible only in select mode) */}
            {editorMode === "select" && onPartitionRemove && (
              <g style={{ cursor: "pointer" }}
                 onClick={(e) => { e.stopPropagation(); onPartitionRemove(p.id); }}>
                <circle cx={(p.x1 + p.x2) / 2 * PX_PER_M} cy={(p.y1 + p.y2) / 2 * PX_PER_M}
                        r="8" fill="#FFF" stroke="#FF3B30" strokeWidth="1.5" />
                <text x={(p.x1 + p.x2) / 2 * PX_PER_M} y={(p.y1 + p.y2) / 2 * PX_PER_M + 3}
                      textAnchor="middle" style={{ fontSize: 9, fill: "#FF3B30", fontWeight: 700 }}>×</text>
              </g>
            )}
          </g>
        ))}

        {/* Partition draw preview */}
        {editorMode === "partition" && partitionStart && partitionHover && (() => {
          const seg = axisLock(partitionStart, partitionHover);
          return (
            <g pointerEvents="none">
              <line x1={seg.x1 * PX_PER_M} y1={seg.y1 * PX_PER_M}
                    x2={seg.x2 * PX_PER_M} y2={seg.y2 * PX_PER_M}
                    stroke="#0071E3" strokeWidth="6" strokeDasharray="10 6"
                    strokeLinecap="round" opacity="0.75" />
              <circle cx={seg.x1 * PX_PER_M} cy={seg.y1 * PX_PER_M} r="5" fill="#0071E3" />
              <circle cx={seg.x2 * PX_PER_M} cy={seg.y2 * PX_PER_M} r="5" fill="#0071E3" />
            </g>
          );
        })()}
        {editorMode === "partition" && !partitionStart && (
          <text x={16} y={H - 16}
                style={{ fontSize: 11, fill: "#0071E3", letterSpacing: "0.24em", textTransform: "uppercase", fontWeight: 600, fontFamily: "'SF Mono','JetBrains Mono',monospace" }}
                pointerEvents="none">
            Partition mode — click to start
          </text>
        )}
        {editorMode === "partition" && partitionStart && (
          <text x={16} y={H - 16}
                style={{ fontSize: 11, fill: "#0071E3", letterSpacing: "0.24em", textTransform: "uppercase", fontWeight: 600, fontFamily: "'SF Mono','JetBrains Mono',monospace" }}
                pointerEvents="none">
            Click end point, or press Esc
          </text>
        )}

        {/* Items */}
        {scene.items.filter(visible).map((it) => {
          const itemFlags = flagsByItem[it.id] || (flags.find((f) => f.location?.item_id === it.id) ? [flags.find((f) => f.location?.item_id === it.id)] : []);
          const flag = itemFlags[0];
          const isWall = it.mount_type === "wall";
          const isCeil = it.mount_type === "ceiling";
          const fill = ITEM_COLOR[it.zone] || "#8E8E93";
          const cx = (it.x + it.w/2) * PX_PER_M;
          const cy = (it.y + it.d/2) * PX_PER_M;
          const rot = it.rotation || 0;
          const isSelected = selected === it.id || idsSet.has(it.id);
          return (
            <g key={it.id} onMouseDown={(e) => startDrag(e, it)} style={{ cursor: "grab" }}
               onMouseEnter={() => setHoveredItem(it.id)}
               onMouseLeave={() => setHoveredItem((h) => h === it.id ? null : h)}
               data-testid={`item-${it.id}`}>
              <rect
                x={it.x * PX_PER_M} y={it.y * PX_PER_M}
                width={it.w * PX_PER_M} height={it.d * PX_PER_M}
                fill={fill}
                fillOpacity={isCeil ? 0.18 : isWall ? 0.55 : 0.9}
                stroke={isSelected ? "#1D1D1F" : (isWall || isCeil ? fill : "white")}
                strokeWidth={isSelected ? 2 : 1.5}
                strokeDasharray={isCeil ? "3 3" : isWall ? "4 2" : ""}
                rx="6"
                style={{ filter: isSelected ? "drop-shadow(0 2px 6px rgba(0,0,0,0.14))" : "none" }}
              />
              {/* Selection halo — pulsing amber ring so clicking a validation
                  flag or item stands out unmistakably in the 2D plan. */}
              {isSelected && (
                <rect
                  x={it.x * PX_PER_M - 4} y={it.y * PX_PER_M - 4}
                  width={it.w * PX_PER_M + 8} height={it.d * PX_PER_M + 8}
                  fill="none" stroke="#F59E0B" strokeWidth={2.5}
                  strokeDasharray="6 4"
                  rx="9"
                  pointerEvents="none"
                  data-testid={`item-halo-${it.id}`}
                  style={{ animation: "his-pulse-ring 1.4s ease-in-out infinite" }}
                />
              )}
              {Math.max(it.w, it.d) * PX_PER_M > 40 && Math.min(it.w, it.d) * PX_PER_M > 14 && (
                <text
                  x={it.x * PX_PER_M + it.w * PX_PER_M/2}
                  y={it.y * PX_PER_M + it.d * PX_PER_M/2 + 3}
                  transform={it.d > it.w ? `rotate(${rot === 90 ? 90 : 270} ${cx} ${cy})` : undefined}
                  textAnchor="middle" className="font-mono"
                  style={{ fontSize: 9, fill: isCeil ? fill : "white", pointerEvents: "none", fontWeight: 500 }}
                >{it.component_key === "generic_ifc" ? (it.label || "ifc element") : it.component_key.replace(/_/g," ")}</text>
              )}
              {/* 'R' badge — item's component_key has an uploaded Revit family override. */}
              {(componentsByKey[it.component_key]?.has_override) && (
                <g data-testid={`item-revit-badge-${it.id}`} style={{ pointerEvents: "none" }}>
                  <rect
                    x={it.x * PX_PER_M + 3} y={it.y * PX_PER_M + it.d * PX_PER_M - 13}
                    width="16" height="10" rx="2"
                    fill="#7C3AED" fillOpacity="0.92" />
                  <text
                    x={it.x * PX_PER_M + 11} y={it.y * PX_PER_M + it.d * PX_PER_M - 5}
                    textAnchor="middle" className="font-mono"
                    style={{ fontSize: 8, fill: "white", fontWeight: 700, letterSpacing: "0.12em" }}>
                    R
                  </text>
                </g>
              )}
              {(isWall || isCeil) && (
                <text
                  x={it.x * PX_PER_M + 3} y={it.y * PX_PER_M + 10}
                  className="font-mono"
                  style={{ fontSize: 7, fill: fill, letterSpacing: "0.15em", pointerEvents: "none" }}
                >{isCeil ? "▲ CLG" : "▲ WALL"}</text>
              )}
              {flag && (
                <circle
                  cx={it.x * PX_PER_M + it.w * PX_PER_M - 5}
                  cy={it.y * PX_PER_M + 5} r="5"
                  fill="#C97567" stroke="white" strokeWidth="1.5">
                  <animate attributeName="r" values="5;7;5" dur="1.6s" repeatCount="indefinite"/>
                </circle>
              )}
              {selected === it.id && idsSet.size <= 1 && (
                <g onMouseDown={(e) => { e.stopPropagation(); removeItem(it.id); }} style={{ cursor: "pointer" }}>
                  <circle cx={it.x * PX_PER_M + it.w * PX_PER_M} cy={it.y * PX_PER_M} r="9" fill="#1D1D1F"/>
                  <text x={it.x * PX_PER_M + it.w * PX_PER_M} y={it.y * PX_PER_M + 3}
                        textAnchor="middle" style={{ fontSize: 12, fill: "white", pointerEvents: "none" }}>×</text>
                </g>
              )}
            </g>
          );
        })}

        {/* Marquee selection rectangle */}
        {marquee && (() => {
          const x = Math.min(marquee.x0, marquee.x1) * PX_PER_M;
          const y = Math.min(marquee.y0, marquee.y1) * PX_PER_M;
          const w = Math.abs(marquee.x1 - marquee.x0) * PX_PER_M;
          const h = Math.abs(marquee.y1 - marquee.y0) * PX_PER_M;
          return (
            <rect x={x} y={y} width={w} height={h}
                  fill="#0071E3" fillOpacity="0.08"
                  stroke="#0071E3" strokeOpacity="0.55"
                  strokeDasharray="4 4" strokeWidth="1"
                  pointerEvents="none"
                  data-testid="room-2d-marquee" />
          );
        })()}

        {/* Flow overlays — rendered AFTER items so arrows sit on top of
            furniture and the doorway anchor is legible. Backend routes
            (A*, aware of every floor obstacle) supply the polylines. */}
        <style>{`
          @keyframes dashmove2d { to { stroke-dashoffset: -20; } }
          .flow-line { animation: dashmove2d 1.6s linear infinite; }
        `}</style>
        {analysisOverlay && (
          <g pointerEvents="none" data-testid="analysis-overlay">
            {heatRects}
            {analysisOverlay.routes.map((r) => (
              <g key={r.id}>
                <polyline points={r.path.map(([x, y]) => `${x * PX_PER_M},${y * PX_PER_M}`).join(" ")}
                  fill="none" stroke="#fff" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" opacity={0.8} />
                <polyline points={r.path.map(([x, y]) => `${x * PX_PER_M},${y * PX_PER_M}`).join(" ")}
                  fill="none" stroke={r.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
                  strokeDasharray={r.dashed ? "6 4" : ""} data-testid={`analysis-route-line-${r.id}`} />
                <circle cx={r.path[r.path.length - 1][0] * PX_PER_M} cy={r.path[r.path.length - 1][1] * PX_PER_M} r={4} fill={r.color} />
              </g>
            ))}
            {(analysisOverlay.clashes || []).map((c) => (
              <g key={c.id} transform={`translate(${c.x * PX_PER_M},${c.y * PX_PER_M})`} data-testid={`analysis-clash-${c.id}`}>
                <circle r={11} fill={c.soiled ? "#C0504D" : "#D97706"} fillOpacity={0.18} />
                <circle r={6} fill={c.soiled ? "#C0504D" : "#D97706"} stroke="#fff" strokeWidth={2} />
                <title>{c.pairs.join("\n")}</title>
              </g>
            ))}
          </g>
        )}
        {(() => {
          const toPath = (pts) => pts && pts.length
            ? "M " + pts.map((p) => `${p.x * PX_PER_M} ${p.y * PX_PER_M}`).join(" L ")
            : null;
          const rows = [];
          const push = (key, colour, label, enabled) => {
            if (!enabled) return;
            const pts = flowPaths?.[key];
            const dPath = toPath(pts);
            if (!dPath) return;
            rows.push({ key, colour, label, dPath, pts });
          };
          push("soiled",       "#B0655A", "soiled → clean", showDirtyFlow);
          push("clean_supply", "#5EA773", "clean supply",   showCleanFlow);
          push("person",       "#B29666", "person",         showPersonFlow);
          push("waste",        "#7C6DA5", "waste out",      showDirtyFlow);
          return rows.map((r) => {
            const start = r.pts[0], end = r.pts[r.pts.length - 1];
            return (
              <g key={r.key} data-testid={`flow-path-${r.key}`} pointerEvents="none">
                {/* White halo underneath for legibility over dark items */}
                <path d={r.dPath} stroke="white" strokeWidth="6"
                      strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.85" />
                {/* Dashed animated line */}
                <path d={r.dPath} stroke={r.colour} strokeWidth="2.6"
                      strokeDasharray="8 5" strokeLinecap="round"
                      strokeLinejoin="round" fill="none"
                      markerEnd={`url(#arr-${r.key})`} className="flow-line"/>
                {/* Start anchor circle */}
                <circle cx={start.x * PX_PER_M} cy={start.y * PX_PER_M} r={5}
                        fill="white" stroke={r.colour} strokeWidth="2" />
                <circle cx={start.x * PX_PER_M} cy={start.y * PX_PER_M} r={2}
                        fill={r.colour} />
                {/* Label pill anchored to the start point */}
                <g transform={`translate(${start.x * PX_PER_M + 10}, ${start.y * PX_PER_M - 14})`}>
                  <rect x={0} y={0} width={r.label.length * 6.2 + 14} height={16} rx={8} ry={8}
                        fill={r.colour} opacity="0.95" />
                  <text x={7} y={11}
                        style={{ fontSize: 10, fill: "white", letterSpacing: "0.15em",
                                 textTransform: "uppercase", fontWeight: 600, fontFamily: "'SF Mono','JetBrains Mono',monospace" }}>
                    {r.label}
                  </text>
                </g>
              </g>
            );
          });
        })()}

        {/* Compliance + materials hover tooltip.
            Shows compliance flags first (if any), otherwise the component's
            materials list. Both use the same Apple-style card. */}
        {hoveredItem && (() => {
          const it = scene.items.find((i) => i.id === hoveredItem);
          if (!it) return null;
          const itemFlags = flagsByItem[it.id] || flags.filter((f) => f.location?.item_id === it.id);
          const comp = componentsByKey[it.component_key] || {};
          const materials = (comp.materials || []).slice(0, 6);
          if (itemFlags.length === 0 && materials.length === 0) return null;
          const mode = itemFlags.length > 0 ? "flags" : "materials";
          const rows = mode === "flags" ? itemFlags.length : 1;
          const tw = 320, th = 70 + rows * (mode === "flags" ? 78 : Math.max(24, materials.length * 22));
          let tx = it.x * PX_PER_M + it.w * PX_PER_M / 2 - tw / 2;
          let ty = it.y * PX_PER_M - th - 8;
          tx = Math.max(6, Math.min(tx, W - tw - 6));
          if (ty < 6) ty = it.y * PX_PER_M + it.d * PX_PER_M + 8;
          return (
            <foreignObject x={tx} y={ty} width={tw} height={th} pointerEvents="none"
                           data-testid={`hover-tooltip-${it.id}`}>
              <div xmlns="http://www.w3.org/1999/xhtml"
                   style={{
                     background: "white",
                     border: "1px solid rgba(0,0,0,0.08)",
                     borderRadius: 14,
                     boxShadow: "0 10px 32px rgba(0,0,0,0.16)",
                     padding: "12px 14px",
                     fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif",
                   }}>
                <div style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "#86868B", fontWeight: 600, marginBottom: 6 }}>
                  {mode === "flags"
                    ? `Compliance · ${itemFlags.length} flag${itemFlags.length === 1 ? "" : "s"}`
                    : "Materials · specification"}
                </div>
                {mode === "flags" && itemFlags.map((f, i) => (
                  <div key={i} style={{ marginTop: i === 0 ? 0 : 10, paddingTop: i === 0 ? 0 : 10, borderTop: i === 0 ? "none" : "1px solid #F2F2F5" }}>
                    <div style={{ fontSize: 11, color: "#1D1D1F", fontWeight: 600, marginBottom: 2 }}>
                      {f.rule_id} · <span style={{ color: f.kind === "FAIL" ? "#B15A4F" : "#B87A2B" }}>{f.kind}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#1D1D1F", lineHeight: 1.4 }}>{f.message}</div>
                    {f.fix && (
                      <div style={{ fontSize: 11, color: "#0071E3", marginTop: 4, lineHeight: 1.4 }}>→ {f.fix}</div>
                    )}
                    <div style={{ fontSize: 10, color: "#86868B", marginTop: 4 }}>{f.source}</div>
                  </div>
                ))}
                {mode === "materials" && (
                  <>
                    <div style={{ fontSize: 13, color: "#1D1D1F", fontWeight: 600, marginBottom: 6 }}>
                      {comp.name || it.component_key}
                    </div>
                    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                      {materials.map((m, i) => (
                        <li key={i} style={{ fontSize: 12, color: "#1D1D1F", lineHeight: 1.5, display: "flex", gap: 6 }}>
                          <span style={{ color: "#86868B" }}>·</span><span>{m}</span>
                        </li>
                      ))}
                    </ul>
                    <div style={{ fontSize: 10, color: "#86868B", marginTop: 6 }}>
                      Zone · {it.zone} &nbsp;·&nbsp; Mount · {it.mount_type || "floor"}
                    </div>
                  </>
                )}
              </div>
            </foreignObject>
          );
        })()}

        {/* Room shape cutout (L/T/U) — drawn last so it obscures items in the notch */}
        {scene.shape?.notch && (
          <g data-testid="shape-notch" style={{ pointerEvents: "none" }}>
            <rect
              x={scene.shape.notch.x * PX_PER_M} y={scene.shape.notch.y * PX_PER_M}
              width={scene.shape.notch.w * PX_PER_M} height={scene.shape.notch.d * PX_PER_M}
              fill="#F5F5F7" fillOpacity="0.92"
              stroke="#8E8E93" strokeDasharray="6 4" strokeWidth="1.5"
            />
            <text
              x={(scene.shape.notch.x + scene.shape.notch.w / 2) * PX_PER_M}
              y={(scene.shape.notch.y + scene.shape.notch.d / 2) * PX_PER_M + 3}
              textAnchor="middle" className="font-mono"
              style={{ fontSize: 10, fill: "#8E8E93", letterSpacing: "0.2em", textTransform: "uppercase" }}
            >outside</text>
          </g>
        )}

        {/* Live footprint ghost while dragging from the palette. Shows an
            outlined rectangle at the actual component footprint so users
            immediately see the target size (esp. for Revit-backed items
            whose thumbnail is the drag image). */}
        {dragPreview?.comp && dragPreview.x !== null && dragPreview.y !== null && (() => {
          const c = dragPreview.comp;
          const w = c.default_footprint.w * PX_PER_M;
          const d = c.default_footprint.d * PX_PER_M;
          const px = dragPreview.x * PX_PER_M;
          const py = dragPreview.y * PX_PER_M;
          const zoneFill = ZONE_FILL[c.zone_affinity] || "#F2F2F5";
          const zoneStroke = ZONE_STROKE[c.zone_affinity] || "#7A7A80";
          return (
            <g data-testid="drop-ghost" pointerEvents="none">
              <rect x={px} y={py} width={w} height={d}
                    rx={4} ry={4}
                    fill={zoneFill} fillOpacity={0.45}
                    stroke={zoneStroke} strokeWidth={2}
                    strokeDasharray="6 4" />
              {/* Corner tick marks */}
              {[[0,0],[w,0],[0,d],[w,d]].map(([cx, cy], i) => (
                <circle key={i} cx={px+cx} cy={py+cy} r={2.5}
                        fill="white" stroke={zoneStroke} strokeWidth={1.5} />
              ))}
              {w > 60 && d > 24 && (
                <text x={px + w/2} y={py + d/2}
                      textAnchor="middle" dominantBaseline="middle"
                      className="font-mono"
                      style={{ fontSize: 10, fill: zoneStroke,
                               letterSpacing: "0.08em", textTransform: "uppercase",
                               fontWeight: 600 }}>
                  drop here
                </text>
              )}
              {w > 80 && d > 40 && (
                <text x={px + w/2} y={py + d/2 + 12}
                      textAnchor="middle"
                      style={{ fontSize: 9, fill: "#4B5563" }}>
                  {c.default_footprint.w}m × {c.default_footprint.d}m
                </text>
              )}
            </g>
          );
        })()}
        {/* Peer cursors — Miro-style. Renders each peer's live cursor with
            a coloured arrow + name pill. `peers` may include peers on other
            views (3D-only) whose cursor is null — those are silently skipped. */}
        {peers && peers.length > 0 && peers.map((p) => {
          if (!p?.cursor || typeof p.cursor.x !== "number" || typeof p.cursor.y !== "number") return null;
          const cx = p.cursor.x * PX_PER_M;
          const cy = p.cursor.y * PX_PER_M;
          const c = _peerColor(p.email || p.name || p.conn_id);
          const label = `${p.name || "Guest"}${p.role ? ` (${_titleCase(p.role)})` : ""}`;
          return (
            <g key={p.conn_id} pointerEvents="none" data-testid={`peer-cursor-${p.conn_id}`}>
              {/* Arrow — path styled like a native pointer */}
              <path
                d="M0 0 L0 16 L4 12 L7 20 L10 19 L7 11 L14 11 Z"
                transform={`translate(${cx}, ${cy})`}
                fill={c}
                stroke="white" strokeWidth="1.3"
                style={{
                  filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))",
                  transition: "transform 60ms linear",
                }}
              />
              {/* Name pill */}
              <g transform={`translate(${cx + 12}, ${cy + 18})`}>
                <rect x={0} y={0}
                      width={_measureText(label) + 14} height={18}
                      rx={9} ry={9}
                      fill={c} />
                <text x={7} y={12}
                      fill="white"
                      style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.1 }}
                >{label}</text>
              </g>
            </g>
          );
        })}
        {editorMode === "partition" && (
          <rect width={W} height={H} fill="transparent" onMouseDown={onBgMouseDown}
                style={{ cursor: "crosshair" }} data-testid="partition-capture" />
        )}
      </svg>
    </div>
  );
}
