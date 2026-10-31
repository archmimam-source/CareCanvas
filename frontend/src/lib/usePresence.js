import { useEffect, useRef, useState } from "react";

/**
 * Multi-user presence over WebSockets.
 * Connects to /api/ws/rooms/<roomId>/presence with the user's auth cookie
 * (falls back to a `?token=` query param for browsers that drop cookies on
 * WS handshakes). Auto-reconnects with linear backoff. Exposes:
 *   - peers[]         : other users currently connected to the room
 *   - selfId          : this connection's server-assigned conn_id
 *   - connected       : whether the WS is currently open
 *   - sendCursor      : broadcast our cursor {x,y} (or normalised nx/ny)
 *   - sendView        : broadcast our current view ("plan" | "split" | "iso")
 *   - sendSceneOp     : broadcast a live scene op / snapshot to peers
 *
 * Optional callback opts allow consumers to react to *messages* rather
 * than to state:
 *   - onSceneOp({conn_id, op, scene, author, ts})
 *   - onRoomsUpdate(estateMap)   // only fires on the "estate" pseudo-room
 * Callbacks are held in a ref so re-renders don't reconnect the socket.
 */
export function usePresence(roomId, { onSceneOp, onRoomsUpdate } = {}) {
  const [peers, setPeers] = useState([]);
  const [selfId, setSelfId] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const cursorTimer = useRef(null);
  const lastCursor = useRef(null);
  const cbs = useRef({ onSceneOp, onRoomsUpdate });
  useEffect(() => { cbs.current = { onSceneOp, onRoomsUpdate }; }, [onSceneOp, onRoomsUpdate]);

  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    let backoff = 800;
    let hbTimer = null;
    // Auth-failure circuit breaker. If the server closes the socket with
    // 4401 (invalid/missing token) THREE times in a row, we stop hammering
    // it — otherwise we'd reconnect every ~1s and the presence chips would
    // flicker between 0 and 1 in the top bar (the exact symptom users
    // describe as "name coming and going"). The counter resets on a
    // successful `open`.
    let authFailStreak = 0;

    const connect = () => {
      const httpBase = process.env.REACT_APP_BACKEND_URL || "";
      const wsBase = httpBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
      // Token fallback for the WS handshake (cookies aren't reliably
      // attached on the WS upgrade cross-origin). We try localStorage
      // FIRST — but also fall back to sessionStorage for browsers that
      // silently drop localStorage in incognito or with strict site-data
      // settings.
      let token = null;
      try { token = localStorage.getItem("token"); } catch {}
      if (!token) { try { token = sessionStorage.getItem("token"); } catch {} }
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      const url = `${wsBase}/api/ws/rooms/${roomId}/presence${qs}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => { backoff = 800; authFailStreak = 0; setConnected(true); };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "hello") {
          setSelfId(msg.conn_id);
          // Merge — preserve any pre-hello upserts (cursors that arrived
          // before hello due to WS message reordering).
          setPeers((prev) => {
            const server = msg.peers || [];
            const byId = new Map(server.map((p) => [p.conn_id, p]));
            for (const p of prev) {
              if (byId.has(p.conn_id)) {
                const s = byId.get(p.conn_id);
                byId.set(p.conn_id, { ...s, cursor: s.cursor || p.cursor });
              }
            }
            return Array.from(byId.values());
          });
          // Estate viewers receive an initial rooms snapshot bundled with hello.
          if (msg.rooms && cbs.current.onRoomsUpdate) {
            cbs.current.onRoomsUpdate(msg.rooms);
          }
        } else if (msg.type === "join" && msg.peer) {
          // Merge instead of overwrite so any cursor / view info we
          // already learned about this peer (via race-ordered `cursor`
          // messages that arrived BEFORE `join`) survives.
          setPeers((prev) => {
            const known = prev.find((p) => p.conn_id === msg.peer.conn_id);
            const merged = known ? { ...known, ...msg.peer, cursor: known.cursor || msg.peer.cursor } : msg.peer;
            return [...prev.filter((p) => p.conn_id !== msg.peer.conn_id), merged];
          });
        } else if (msg.type === "leave") {
          setPeers((prev) => prev.filter((p) => p.conn_id !== msg.conn_id));
        } else if (msg.type === "cursor") {
          // UPSERT — if the peer isn't in our roster yet (race with an
          // unreceived `join`), add a stub so the cursor overlay can
          // still render. The next `join` will fill in name/email/etc.
          setPeers((prev) => {
            const idx = prev.findIndex((p) => p.conn_id === msg.conn_id);
            if (idx >= 0) {
              const copy = prev.slice();
              copy[idx] = { ...copy[idx], cursor: msg.cursor };
              return copy;
            }
            return [...prev, { conn_id: msg.conn_id, cursor: msg.cursor, name: "Guest", email: "" }];
          });
        } else if (msg.type === "view") {
          setPeers((prev) => {
            const idx = prev.findIndex((p) => p.conn_id === msg.conn_id);
            if (idx >= 0) {
              const copy = prev.slice();
              copy[idx] = { ...copy[idx], view: msg.view };
              return copy;
            }
            return [...prev, { conn_id: msg.conn_id, view: msg.view, name: "Guest", email: "" }];
          });
        } else if (msg.type === "scene_op") {
          if (cbs.current.onSceneOp) cbs.current.onSceneOp(msg);
        } else if (msg.type === "rooms_update") {
          if (cbs.current.onRoomsUpdate) cbs.current.onRoomsUpdate(msg.rooms || {});
        }
      };
      ws.onclose = (ev) => {
        setConnected(false);
        // Preserve peers on a *transient* close so chips don't flash
        // between 0 and 1 during a quick reconnect. Only wipe if this
        // is looking like a permanent failure (auth or explicit close).
        if (ev && ev.code === 4401) {
          authFailStreak += 1;
          setPeers([]); setSelfId(null);
          // Give the caller a chance to see the "signed-out" state.
          if (authFailStreak >= 3) {
            // eslint-disable-next-line no-console
            console.warn("[usePresence] 3× WS 4401 — auth token likely invalid; giving up");
            return; // do NOT reconnect
          }
        }
        if (alive) { setTimeout(connect, backoff); backoff = Math.min(backoff * 1.6, 5000); }
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    connect();

    hbTimer = setInterval(() => {
      try { wsRef.current && wsRef.current.readyState === 1 && wsRef.current.send(JSON.stringify({ type: "ping" })); } catch {}
    }, 20000);

    return () => {
      alive = false;
      if (hbTimer) clearInterval(hbTimer);
      try { wsRef.current && wsRef.current.close(); } catch {}
    };
  }, [roomId]);

  // Throttled cursor sender — max 20 Hz, only sends if position changed.
  const sendCursor = (cursor) => {
    lastCursor.current = cursor;
    if (cursorTimer.current) return;
    cursorTimer.current = setTimeout(() => {
      cursorTimer.current = null;
      const c = lastCursor.current;
      try {
        if (wsRef.current && wsRef.current.readyState === 1) {
          wsRef.current.send(JSON.stringify({ type: "cursor", cursor: c }));
        }
      } catch {}
    }, 50);
  };

  const sendView = (view) => {
    try {
      if (wsRef.current && wsRef.current.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: "view", view }));
      }
    } catch {}
  };

  // Broadcasts a live scene op / snapshot to peers in the same room. The
  // originating client stays responsible for persisting the scene via the
  // existing HTTP PUT — peers apply the snapshot locally so their canvas
  // matches instantly (last-write-wins).
  //
  // Throttled to ~10 Hz (100 ms). During a rapid drag, only the LATEST
  // snapshot survives — the trailing send fires shortly after the user
  // stops moving so peers always end up on the same final state.
  const sceneOpTimer = useRef(null);
  const lastSceneOp = useRef(null);
  const sendSceneOp = (op, scene) => {
    lastSceneOp.current = { op, scene };
    if (sceneOpTimer.current) return;
    sceneOpTimer.current = setTimeout(() => {
      sceneOpTimer.current = null;
      const payload = lastSceneOp.current;
      if (!payload) return;
      try {
        if (wsRef.current && wsRef.current.readyState === 1) {
          wsRef.current.send(JSON.stringify({ type: "scene_op", op: payload.op, scene: payload.scene }));
        }
      } catch {}
    }, 100);
  };

  return { peers, selfId, connected, sendCursor, sendView, sendSceneOp };
}

/** Stable pastel accent for each peer, keyed by email. */
export function peerColor(email = "") {
  const palette = ["#0071E3","#34C759","#FF9500","#AF52DE","#FF2D55","#5AC8FA","#FFCC00","#5856D6"];
  let h = 0; for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function initials(nameOrEmail = "") {
  const s = String(nameOrEmail).trim();
  if (!s) return "?";
  if (s.includes("@")) return s[0].toUpperCase();
  const parts = s.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0].toUpperCase()).join("");
}
