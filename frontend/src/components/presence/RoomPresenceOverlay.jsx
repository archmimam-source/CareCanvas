import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { peerColor, initials } from "@/lib/usePresence";

/**
 * RoomPresenceOverlay — Miro / Figma-style live cursor overlay for the
 * whole room-editor viewport.
 *
 * What it fixes vs. the old Room2D-embedded cursor path:
 *   1. Cursor is broadcast the moment the mouse moves ANYWHERE on the page —
 *      2D canvas, 3D canvas, palette, top-bar. The previous logic only
 *      fired when the mouse was strictly INSIDE the room polygon, which
 *      made the peer arrow blink on and off.
 *   2. Coordinates are viewport-normalised (`nx`/`ny` ∈ [0, 1]) so peers
 *      with different window sizes still render the arrow in the RIGHT
 *      RELATIVE place. No metres, no PX_PER_M coupling.
 *   3. Renders the CURRENT user's own cursor too, with their name pill —
 *      the Figma UX users expect (so they can visually verify "yes, my
 *      teammate should be seeing THIS").
 *
 * Peers with a Room2D-style metre cursor `{x, y}` are ignored here —
 * they're still drawn inside Room2D's own SVG so metre-accurate hit
 * targets don't lose fidelity. Only peers publishing normalised `nx/ny`
 * coordinates are rendered as viewport-fixed overlays.
 */
export default function RoomPresenceOverlay({ peers, selfId, sendCursor, me }) {
  const [selfPos, setSelfPos] = useState(null);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onMove = (e) => {
      sizeRef.current = { w: window.innerWidth, h: window.innerHeight };
      const nx = e.clientX / sizeRef.current.w;
      const ny = e.clientY / sizeRef.current.h;
      setSelfPos({ x: e.clientX, y: e.clientY });
      if (sendCursor) sendCursor({ nx, ny, view: "room" });
    };
    const onResize = () => { sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", onResize);
    };
  }, [sendCursor]);

  // Only peers publishing normalised coordinates land in the DOM overlay.
  // Metre-cursor peers (view === "plan") are handled by Room2D's SVG.
  const renderablePeers = (peers || []).filter((p) => {
    if (!p || p.conn_id === selfId) return false;
    const c = p.cursor;
    return c && typeof c.nx === "number" && typeof c.ny === "number";
  });

  return createPortal(
    <>
      {renderablePeers.map((p) => (
        <CursorFlag key={p.conn_id}
                    testid={`peer-cursor-overlay-${p.conn_id}`}
                    x={p.cursor.nx * window.innerWidth}
                    y={p.cursor.ny * window.innerHeight}
                    color={peerColor(p.email || p.name || p.conn_id)}
                    label={p.name || p.email || "Guest"} />
      ))}
      {/* Your own cursor flag. The OS cursor still renders on top —
          the flag is the little "you are Alex" tag that trails behind
          it so you can verify what peers see of you. */}
      {selfPos && me && (
        <CursorFlag testid="self-cursor-overlay"
                    x={selfPos.x} y={selfPos.y}
                    color={peerColor(me.email || me.name || "self")}
                    label={`${me.name || me.email || "You"} (you)`}
                    isSelf />
      )}
    </>,
    document.body
  );
}

function CursorFlag({ x, y, color, label, testid, isSelf = false }) {
  return (
    <div data-testid={testid}
         className="fixed pointer-events-none z-[9990]"
         style={{
           left: x, top: y,
           transform: "translate(-2px, -2px)",
           transition: "left 60ms linear, top 60ms linear",
           opacity: isSelf ? 0.55 : 1,
         }}>
      <svg width="18" height="20" viewBox="0 0 18 20"
           style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))" }}>
        <path d="M2 2 L2 16 L6 12 L9 20 L11 19 L8 11 L14 11 Z"
              fill={color} stroke="white" strokeWidth="1.2"
              strokeLinejoin="round" />
      </svg>
      <div className="mt-1 ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-white text-[10px] font-medium whitespace-nowrap shadow-md"
           style={{ background: color }}>
        <span className="inline-flex items-center justify-center w-3 h-3 rounded-full bg-white/25 text-[8px] font-bold">
          {initials(label)}
        </span>
        {label}
      </div>
    </div>
  );
}
