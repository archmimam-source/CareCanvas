import React, { createContext, useContext, useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { usePresence, peerColor, initials } from "@/lib/usePresence";
import { Eye, EyeOff } from "lucide-react";

/**
 * EstatePresenceContext exposes a compact "who's currently inside which room"
 * map to Dashboard cards. Shape: `{ [roomId]: [{email, name, avatar_url, role}] }`.
 * Populated by the estate WebSocket (`hello` bundles the initial snapshot; every
 * `rooms_update` event refreshes it live).
 */
const EstatePresenceContext = createContext({ rooms: {} });
export const useEstateOccupants = () => useContext(EstatePresenceContext);

/**
 * Miro-style presence overlay for the Estate / Dashboard / any non-room
 * route. Broadcasts this user's cursor on `mousemove`, renders every
 * peer's cursor as a coloured arrow + name tag, AND publishes the live
 * room-occupancy map so `<NodeCard>` chips update instantly.
 */
export default function EstatePresence({ children }) {
  const [rooms, setRooms] = useState({});
  const { peers, selfId, sendCursor } = usePresence("estate", {
    onRoomsUpdate: (map) => setRooms(map || {}),
  });
  const [visible, setVisible] = useState(() => {
    try { return localStorage.getItem("cc:hide-peers") !== "1"; } catch { return true; }
  });
  const size = useRef({ w: window.innerWidth, h: window.innerHeight });

  // Broadcast our normalised cursor whenever the mouse moves on this page.
  useEffect(() => {
    const onMove = (e) => {
      size.current = { w: window.innerWidth, h: window.innerHeight };
      sendCursor({ nx: e.clientX / size.current.w, ny: e.clientY / size.current.h, view: "estate" });
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [sendCursor]);

  const toggle = () => {
    const nv = !visible;
    setVisible(nv);
    try { localStorage.setItem("cc:hide-peers", nv ? "0" : "1"); } catch {}
  };

  // Everyone currently connected to the "estate" presence channel counts as
  // "online" — regardless of whether they've moved their mouse yet. Only
  // peers that have actually moved get an on-screen arrow rendered.
  const connectedPeers = peers.filter((p) => p.conn_id !== selfId);
  const renderablePeers = connectedPeers.filter((p) => p.cursor && (p.cursor.view === "estate" || p.cursor.view == null));
  const connectedCount = connectedPeers.length;

  const overlay = createPortal(
    <>
      {/* Peer cursor markers — hidden when the user toggled them off. */}
      {visible && renderablePeers.map((p) => {
        const nx = p.cursor?.nx ?? 0, ny = p.cursor?.ny ?? 0;
        const left = nx * window.innerWidth;
        const top  = ny * window.innerHeight;
        const color = peerColor(p.email);
        const label = p.name || p.email || "peer";
        return (
          <div key={p.conn_id}
               data-testid={`peer-cursor-${p.conn_id}`}
               className="fixed pointer-events-none z-[9990] transition-transform duration-100"
               style={{ left, top, transform: "translate(-2px, -2px)" }}>
            <svg width="18" height="18" viewBox="0 0 18 18" style={{ filter: `drop-shadow(0 1px 2px rgba(0,0,0,0.25))` }}>
              <path d="M2 2 L2 14 L6 10 L9 16 L11 15 L8 9 L14 9 Z"
                    fill={color} stroke="white" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <div className="mt-1 px-2 py-0.5 rounded-full text-white text-[10px] font-medium whitespace-nowrap shadow-md"
                 style={{ background: color }}>
              {label}
            </div>
          </div>
        );
      })}
      <button onClick={toggle}
              data-testid="toggle-peer-cursors"
              title={visible ? "Hide other users' cursors" : "Show other users' cursors"}
              className="fixed bottom-6 right-6 z-[9992] h-10 rounded-full bg-white/95 backdrop-blur border border-black/10 shadow-lg text-[#1D1D1F] text-xs px-3 flex items-center gap-2 hover:bg-white">
        {visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        <span className="font-medium" data-testid="estate-online-count">{connectedCount} online</span>
        <span className="text-[10px] uppercase tracking-widest text-[#86868B]">
          {visible ? "hide" : "show"}
        </span>
      </button>
    </>,
    document.body
  );

  return (
    <EstatePresenceContext.Provider value={{ rooms }}>
      {overlay}
      {children}
    </EstatePresenceContext.Provider>
  );
}

/**
 * A tiny row of avatar chips + overflow badge, keyed off the current
 * estate-occupancy map. Renders nothing if the room is empty. Used at
 * the top-right of every utility-room card on the Dashboard so the
 * user can see who's inside before they open the room.
 */
export function RoomOccupancyChips({ roomId, max = 3 }) {
  const { rooms } = useEstateOccupants();
  const occupants = rooms?.[roomId] || [];
  if (!occupants.length) return null;
  const shown = occupants.slice(0, max);
  const extra = occupants.length - shown.length;
  return (
    <div className="flex items-center gap-1" data-testid={`room-occupancy-${roomId}`}>
      <div className="flex -space-x-1.5">
        {shown.map((u, i) => {
          const bg = peerColor(u.email);
          return u.avatar_url ? (
            <img key={u.email}
                 src={`${process.env.REACT_APP_BACKEND_URL}${u.avatar_url}`}
                 alt={u.name || u.email}
                 title={`${u.name || u.email}${u.role ? " · " + u.role : ""}`}
                 className="w-6 h-6 rounded-full border-2 border-white object-cover"
                 style={{ zIndex: max - i }}
                 data-testid={`occupancy-avatar-${roomId}-${i}`} />
          ) : (
            <div key={u.email}
                 title={`${u.name || u.email}${u.role ? " · " + u.role : ""}`}
                 style={{ background: bg, zIndex: max - i }}
                 className="w-6 h-6 rounded-full border-2 border-white text-white text-[9px] font-semibold flex items-center justify-center"
                 data-testid={`occupancy-avatar-${roomId}-${i}`}>
              {initials(u.name || u.email)}
            </div>
          );
        })}
      </div>
      {extra > 0 && (
        <span className="text-[10px] text-[#86868B] font-medium"
              data-testid={`occupancy-extra-${roomId}`}>
          +{extra}
        </span>
      )}
      <span className="ml-1 w-1.5 h-1.5 rounded-full bg-[#34C759] animate-pulse"
            title="Live in this room" />
    </div>
  );
}
