import React from "react";

// Minimal read-only plan: room outline + footprint rects + optional arrows.
export default function MiniPlan({ width, depth, rects = [], lines = [], maxW = 520, maxH = 380, testId }) {
  const s = Math.min(maxW / width, maxH / depth);
  const W = width * s, D = depth * s, pad = 10;
  return (
    <svg width={W + pad * 2} height={D + pad * 2} data-testid={testId} className="block">
      <defs>
        <marker id="mp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#B45309" />
        </marker>
      </defs>
      <g transform={`translate(${pad},${pad})`}>
        <rect x={0} y={0} width={W} height={D} fill="#FAFAFA" stroke="#1D1D1F" strokeWidth={2} />
        {rects.map((r, i) => (
          <g key={r.key || i}>
            <rect x={r.x * s} y={r.y * s} width={Math.max(2, r.w * s)} height={Math.max(2, r.d * s)}
              fill={r.dashed ? "none" : r.color} fillOpacity={r.opacity ?? 0.75}
              stroke={r.color} strokeWidth={r.highlight ? 2.5 : 1.2} strokeDasharray={r.dashed ? "4 3" : ""} rx={2}>
              {r.title && <title>{r.title}</title>}
            </rect>
          </g>
        ))}
        {lines.map((l, i) => (
          <line key={i} x1={l.x1 * s} y1={l.y1 * s} x2={l.x2 * s} y2={l.y2 * s}
            stroke="#B45309" strokeWidth={1.5} markerEnd="url(#mp-arrow)" />
        ))}
      </g>
    </svg>
  );
}
