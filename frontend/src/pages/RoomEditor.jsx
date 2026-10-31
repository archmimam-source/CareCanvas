import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { api, BACKEND_URL } from "@/lib/apiClient";
import { downloadExport, brandedName, saveBlob } from "@/lib/download";
import { TopBar } from "@/pages/Dashboard";
import { useAuth } from "@/context/AuthContext";
import Room2D from "@/components/room/Room2D";
import Room3D from "@/components/room/Room3D";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Play, Sparkles, X, BookOpen, Inbox, Layers, RotateCcw, AlertOctagon, AlertTriangle, HelpCircle, ClipboardList, Trash2, Bot, RotateCw, Ruler, Undo2, Redo2, Wand2, FileText, ChevronLeft, ChevronRight, ChevronDown, Grid3x3, History, SlidersHorizontal, Star, Lock, Unlock, UserPlus, Copy, Check, Share2, Columns2, Network } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import RenderModal from "@/components/render/RenderModal";
import AiFab from "@/components/ai/AiFab";
import { usePresence, peerColor, initials } from "@/lib/usePresence";
import SharingPanel from "@/components/sharing/SharingPanel";
import { ReadOnlyBanner, IfcSourceButton } from "@/components/room/RoomSourceBits";
import ReimportDialog from "@/components/room/ReimportDialog";
import CompareDialog from "@/components/room/CompareDialog";
import { GenericLinkPanel } from "@/components/room/GenericLinkPanel";
import AnalysisPanel from "@/components/room/AnalysisPanel";

const TIER = {
  baseline:  { label: "Baseline",       cls: "bg-[#FBEDE9] text-[#B15A4F] border-[#C97567]/30" },
  enhanced:  { label: "Best practice",  cls: "bg-[#FFF6E5] text-[#B87A2B] border-[#DBA362]/40" },
  v2:        { label: "V.2.0",          cls: "bg-[#E9F1FB] text-[#3B6BB1] border-[#7DA3D6]/40" },
  context:   { label: "Context",        cls: "bg-[#F1F1F3] text-[#4A4A50] border-[#C7C7CC]" },
  review:    { label: "Review",         cls: "bg-[#F1F1F3] text-[#4A4A50] border-[#C7C7CC]" },
  // v3 evidence tiers — role-based adjacency spec.
  stated:    { label: "v3 · Stated",    cls: "bg-[#FBEDE9] text-[#B15A4F] border-[#C97567]/30" },
  invariant: { label: "v3 · Invariant", cls: "bg-[#E9F1FB] text-[#3B6BB1] border-[#7DA3D6]/40" },
  inferred:  { label: "v3 · Inferred",  cls: "bg-[#FFF6E5] text-[#B87A2B] border-[#DBA362]/40" },
};

const KIND_ICON = {
  FAIL: AlertOctagon,
  ADVISORY: AlertTriangle,
  CONTEXT: HelpCircle,
  REVIEW: ClipboardList,
};

export default function RoomEditor() {
  const { user, logout } = useAuth();
  const { roomId } = useParams();
  const nav = useNavigate();

  const [scene, setScene] = useState(null);
  const [components, setComponents] = useState([]);
  const [rules, setRules] = useState([]);
  const [node, setNode] = useState(null);
  const [showReimport, setShowReimport] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [analysisOverlay, setAnalysisOverlay] = useState(null);
  const focusDone = React.useRef(false);
  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get("focus");
    if (f && scene?.items?.some((i) => i.id === f) && !focusDone.current) { focusDone.current = true; setSelected(f); }
  }, [scene]);
  const [selected, setSelected] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);   // marquee multi-select
  const [derogateFor, setDerogateFor] = useState(null); // active flag pending justification
  // Room2D interaction mode. "select" = default drag/marquee; "partition" =
  // click-click to draw an interior wall segment.
  const [editorMode, setEditorMode] = useState("select");
  // Auto-Fix All modal state — orient-sweep diff preview.
  const [autoFixOpen, setAutoFixOpen] = useState(false);
  const [validation, setValidation] = useState(null);
  const [renders, setRenders] = useState([]);
  const [changelog, setChangelog] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState("palette");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [rightTab, setRightTab] = useState("properties");
  const [revitOnly, setRevitOnly] = useState(false); // Palette filter: only show Revit-overridden
  const [paletteGroup, setPaletteGroup] = useState(() => localStorage.getItem("his:paletteGroup") || "none"); // none | zone | mount
  const [paletteSearch, setPaletteSearch] = useState("");
  const [rendered, setRendered] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem("his:viewMode") || "split"); // split | plan | iso
  const [followId, setFollowId] = useState(null); // conn_id of the peer we're mirroring
  const [lockStatus, setLockStatus] = useState({ locked: false });
  const [lockPromptOpen, setLockPromptOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [lockManageOpen, setLockManageOpen] = useState(false);
  const [lockPassed, setLockPassed] = useState(() => {
    try { return !!sessionStorage.getItem("his:lockpass:" + roomId); } catch { return false; }
  });
  const [inviteOpen, setInviteOpen] = useState(false);

  // Real-time multi-user presence via WebSockets — shows avatar chips + peer cursors.
  // Also carries live scene ops so every edit propagates to every peer in the room.
  //
  // `remoteApplyRef` is set to `true` for exactly the duration of applying an
  // incoming peer snapshot, so `updateScene` knows to skip both the outbound
  // rebroadcast and the local undo/history push. This prevents infinite
  // op-echo loops between peers.
  const remoteApplyRef = React.useRef(false);
  const [lastRemoteEdit, setLastRemoteEdit] = useState(null); // { author, ts }
  const { peers, selfId: presenceSelfId, connected: presenceConnected, sendView, sendCursor, sendSceneOp } = usePresence(roomId, {
    onSceneOp: ({ scene: remoteScene, author, ts }) => {
      if (!remoteScene) return;
      remoteApplyRef.current = true;
      // De-dupe item ids before committing — a malformed / racy remote
      // snapshot could carry the same id twice which would trip React's
      // duplicate-key warning inside Room2D / Room3D lists. Keep the last
      // occurrence (matches the natural "last-write-wins" semantics of the
      // rest of the sync path).
      const dedup = (arr) => {
        if (!Array.isArray(arr)) return arr;
        const seen = new Map();
        for (const el of arr) {
          const k = el?.id ?? Symbol();
          seen.set(k, el);
        }
        return Array.from(seen.values());
      };
      const safe = {
        ...remoteScene,
        items: dedup(remoteScene.items),
        partitions: dedup(remoteScene.partitions || []),
      };
      setScene(safe);
      setValidation(null);
      setLastRemoteEdit({ author, ts });
      setTimeout(() => { remoteApplyRef.current = false; }, 0);
    },
  });
  // Undo/Redo history
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const isAnimatingRef = React.useRef(false);
  const [autofixBusy, setAutofixBusy] = useState(false);

  useEffect(() => { localStorage.setItem("his:viewMode", viewMode); sendView(viewMode); }, [viewMode, sendView]);

  // Cursor Follow — when a peer is being followed, mirror their view mode.
  // Also stop following if the peer disconnects.
  useEffect(() => {
    if (!followId) return;
    const peer = peers.find((p) => p.conn_id === followId);
    if (!peer) { setFollowId(null); return; }
    if (peer.view && peer.view !== viewMode) setViewMode(peer.view);
  }, [followId, peers, viewMode]);

  // Deselect / delete via keyboard.
  //  · Esc  → clear selection
  //  · Delete/Backspace → remove all selected items
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      if (e.key === "Escape") { setSelected(null); setSelectedIds([]); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && (selectedIds.length > 0 || selected)) {
        e.preventDefault();
        const kill = selectedIds.length ? selectedIds : (selected ? [selected] : []);
        if (kill.length && scene) {
          updateScene({ ...scene, items: scene.items.filter((it) => !kill.includes(it.id)) });
          setSelected(null); setSelectedIds([]);
          toast.success(kill.length === 1 ? "Item removed" : `${kill.length} items removed`);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedIds, scene]);

  // Overlay controls (persisted per-user in localStorage)
  const [overlays, setOverlays] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("his:overlays") || "null");
      if (saved) return saved;
    } catch {}
    return { zones: true, dirtyFlow: true, personFlow: false, cleanFlow: false,
             wall: true, ceiling: false, animate: true };
  });
  const [zoom2D, setZoom2D] = useState(() => Number(localStorage.getItem("his:zoom2D")) || 1);
  const [leftW, setLeftW] = useState(() => Number(localStorage.getItem("his:leftW")) || 300);
  const [rightW, setRightW] = useState(() => Number(localStorage.getItem("his:rightW")) || 340);
  const closeAnalysis = () => { setAnalysisOpen(false); setRightTab("properties"); };
  const toggleAnalysis = () => {
    if (analysisOpen && rightTab === "analysis" && !rightCollapsed) { closeAnalysis(); return; }
    setAnalysisOpen(true); setRightTab("analysis"); setRightCollapsed(false);
    setRightW((w) => Math.max(w, 380));
  };
  const [leftCollapsed, setLeftCollapsed]   = useState(() => localStorage.getItem("his:leftCollapsed")  === "1");
  const [rightCollapsed, setRightCollapsed] = useState(() => localStorage.getItem("his:rightCollapsed") === "1");
  const [splitRatio, setSplitRatio] = useState(() => {
    const v = Number(localStorage.getItem("his:splitRatio"));
    return v > 0.05 && v < 0.95 ? v : 0.5;
  });
  const [favourites, setFavourites] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("his:favouriteComponents") || "[]")); }
    catch { return new Set(); }
  });
  const toggleFavourite = (key) => {
    setFavourites((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      localStorage.setItem("his:favouriteComponents", JSON.stringify(Array.from(next)));
      return next;
    });
  };
  // Recently used components — most-recent first, dedup, capped at 6.
  const [recentKeys, setRecentKeys] = useState(() => {
    try { return JSON.parse(localStorage.getItem("his:recentComponents") || "[]"); }
    catch { return []; }
  });
  const pushRecent = React.useCallback((key) => {
    setRecentKeys((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)].slice(0, 6);
      try { localStorage.setItem("his:recentComponents", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  useEffect(() => { localStorage.setItem("his:overlays", JSON.stringify(overlays)); }, [overlays]);
  useEffect(() => { localStorage.setItem("his:zoom2D", String(zoom2D)); }, [zoom2D]);
  useEffect(() => { localStorage.setItem("his:leftW", String(leftW)); }, [leftW]);
  useEffect(() => { localStorage.setItem("his:rightW", String(rightW)); }, [rightW]);
  useEffect(() => { localStorage.setItem("his:leftCollapsed",  leftCollapsed  ? "1" : "0"); }, [leftCollapsed]);
  useEffect(() => { localStorage.setItem("his:rightCollapsed", rightCollapsed ? "1" : "0"); }, [rightCollapsed]);
  useEffect(() => { localStorage.setItem("his:splitRatio", String(splitRatio)); }, [splitRatio]);

  // Draggable resize
  const workspaceRef = useRef(null);
  const startResize = (side) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = side === "left" ? leftW : rightW;
    const onMove = (m) => {
      const dx = m.clientX - startX;
      const newW = side === "left"
        ? Math.max(220, Math.min(600, start + dx))
        : Math.max(240, Math.min(640, start - dx));
      if (side === "left") setLeftW(newW); else setRightW(newW);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "default";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "ew-resize";
  };

  const startSplitDrag = (e) => {
    e.preventDefault();
    const el = workspaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const lw = leftCollapsed ? 44 : leftW;
    const rw = rightCollapsed ? 44 : rightW;
    const middleW = rect.width - lw - rw - 6;
    const onMove = (m) => {
      const local = m.clientX - rect.left - lw;
      const r = Math.max(0.1, Math.min(0.9, local / middleW));
      setSplitRatio(r);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "default";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "ew-resize";
  };

  const refresh = React.useCallback(async () => {
    const r = await api.get(`/rooms/${roomId}/scene`);
    setScene(r.data); setDirty(false); setValidation(null);
  }, [roomId]);

  useEffect(() => {
    api.get(`/rooms/${roomId}/scene`).then((r) => setScene(r.data))
      .catch((err) => {
        // No access → route the user to the Request-Access page instead
        // of leaving them staring at a broken editor.
        if (err?.response?.status === 403) {
          nav(`/room/${roomId}/request-access`, { replace: true });
        }
      });
    // Use the merged components/library so palette shows Revit-backed items
    // with their thumbnails + REVIT badge. Fallback to /components if the
    // merged endpoint isn't available for any reason.
    api.get("/components/library")
      .then((r) => setComponents(r.data?.components || []))
      .catch(() => api.get("/components").then((r) => setComponents(r.data)));
    api.get("/rules").then((r) => setRules(r.data));
    api.get(`/rooms/${roomId}/renders`).then((r) => setRenders(r.data));
    api.get(`/rooms/${roomId}/changelog`).then((r) => setChangelog(r.data));
    api.get(`/hierarchy/${roomId}`).then((r) => setNode(r.data)).catch(()=>{});
    // Room lock — if the room is password-protected AND we haven't already
    // passed the gate in this session, show the prompt.
    api.get(`/rooms/${roomId}/lock`).then((r) => {
      setLockStatus(r.data || { locked: false });
      if (r.data?.locked && !lockPassed) setLockPromptOpen(true);
    }).catch(() => {});
  }, [roomId, lockPassed]);

  const save = async () => {
    if (!scene) return;
    const body = { room_id: roomId, width: scene.width, depth: scene.depth,
                   ceiling_h: scene.ceiling_h, shape: scene.shape,
                   zones: scene.zones, items: scene.items };
    const r = await api.put(`/rooms/${roomId}/scene`, body);
    setScene(r.data); setDirty(false);
    const cl = await api.get(`/rooms/${roomId}/changelog`);
    setChangelog(cl.data);
    toast.success(`Scene saved · v${r.data.version}`);
  };

  const runValidation = async ({ silent = false } = {}) => {
    if (dirty) await save();
    const r = await api.post(`/rooms/${roomId}/validate`);
    setValidation(r.data);
    if (!silent) setTab("validation");
    const c = r.data.counts;
    if (silent) {
      // Compliance Auto-Run: tiny non-modal toast so architects notice
      // the flag deltas without losing focus on the canvas.
      const total = (c.baseline_fail || 0) + (c.v2_fail || 0);
      if (total > 0) {
        toast(`Auto-check: ${c.baseline_fail || 0} baseline · ${c.v2_fail || 0} V.2.0`, {
          description: "Open the Checks tab to review",
          action: { label: "Open", onClick: () => setTab("validation") },
          duration: 4000,
        });
      } else if (r.data.passed) {
        toast.success("Auto-check: baseline compliant", { duration: 2500 });
      }
    } else {
      if (r.data.passed) toast.success("Baseline compliant — render unlocked");
      else toast.error(`${c.baseline_fail} baseline · ${c.v2_fail} V.2.0 fail`);
    }
  };

  const publishRender = async () => {
    if (dirty) await save();
    let val = validation;
    if (!val) { const r = await api.post(`/rooms/${roomId}/validate`); val = r.data; setValidation(val); }
    try {
      const r = await api.post(`/rooms/${roomId}/renders`);
      setRenders([r.data, ...renders]); setRendered(r.data);
      const bf = val.counts?.baseline_fail || 0;
      const v2 = val.counts?.v2_fail || 0;
      if (bf > 0) {
        toast.warning(`Draft render published — ${bf} baseline flag${bf === 1 ? "" : "s"} still open. Review the Validation tab.`);
        setTab("validation");
      } else if (v2 > 0) {
        toast.success(`Render published (${v2} V.2.0 advisory item${v2 === 1 ? "" : "s"})`);
      } else {
        toast.success("High-fidelity render published");
      }
    } catch (e) { toast.error(e.response?.data?.detail || "Render failed"); }
  };

  const resetToStandard = async () => {
    const r = await api.post(`/rooms/${roomId}/reset`);
    setPast((p) => [...p.slice(-49), scene]); setFuture([]);
    setScene(r.data); setDirty(false); setValidation(null);
    const cl = await api.get(`/rooms/${roomId}/changelog`);
    setChangelog(cl.data);
    toast.success("Room emptied — pick a standard from the toolbar to populate");
  };

  // ─── Apply a standards-compliant layout ──────────────────────────────
  // Called from the "Standard" dropdown in the room top bar. `std` is one
  // of "hbn_f74", "hbn_f79" or "nhp_v2". The backend replaces the current
  // scene with the appropriate layout scaled to the user's room width /
  // depth (never reshapes the room).
  const applyStandard = async (std) => {
    const labels = { hbn_f74: "HBN F74 (bedpan)", hbn_f79: "HBN F79 (general)", nhp_v2: "NHP V2 (RDS 6222)", revit_ex01: "Revit Example 01" };
    if (scene?.items?.length && !window.confirm(
      `This will replace the current ${scene.items.length} item(s) with the ${labels[std] || std} layout. Continue?`
    )) return;
    try {
      const r = await api.post(`/rooms/${roomId}/apply-standard`, { standard: std });
      setPast((p) => [...p.slice(-49), scene]); setFuture([]);
      setScene(r.data); setDirty(false); setValidation(null);
      try {
        const cl = await api.get(`/rooms/${roomId}/changelog`);
        setChangelog(cl.data);
      } catch {}
      toast.success(`Applied ${labels[std] || std} — ${r.data.items?.length || 0} items placed`);
      if (r.data.fit_warning) toast.warning(r.data.fit_warning);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not apply standard");
    }
  };

  const clearChangelog = async () => {
    try {
      await api.delete(`/rooms/${roomId}/changelog`);
      setChangelog([]);
      toast.success("Change log cleared");
    } catch { toast.error("Failed to clear log"); }
  };

  const clearRenders = async () => {
    try {
      await api.delete(`/rooms/${roomId}/renders`);
      setRenders([]);
      toast.success("Renders cleared");
    } catch { toast.error("Failed to clear renders"); }
  };

  const addAiComponent = (componentKey, suggestedZone) => {
    const comp = components.find((c) => c.key === componentKey);
    if (!comp) { toast.error(`Unknown component: ${componentKey}`); return; }
    const zone = suggestedZone || comp.zone_affinity || "transition";
    const zoneRect = scene.zones?.[zone];
    // Center of the target zone (or room center)
    const cx = zoneRect ? zoneRect.x + zoneRect.w / 2 : scene.width / 2;
    const cy = zoneRect ? zoneRect.y + zoneRect.d / 2 : scene.depth / 2;
    const w = comp.default_footprint?.w || 0.5;
    const d = comp.default_footprint?.d || 0.5;
    const newItem = {
      id: crypto.randomUUID(),
      component_key: comp.key,
      x: Math.max(0, cx - w / 2),
      y: Math.max(0, cy - d / 2),
      w, d, rotation: 0, zone,
      mount_type: comp.mount_type || "floor",
      elevation_m: comp.mount_type === "wall" ? 1.35 : comp.mount_type === "ceiling" ? 2.55 : 0,
      height_m: 0.9,
      kind: comp.kind, material: comp.material, code: comp.code,
    };
    updateScene({ ...scene, items: [...scene.items, newItem] });
    toast.success(`Added ${comp.name} to ${zone}`);
  };

  const updateItem = (itemId, patch) => {
    updateScene({
      ...scene,
      items: scene.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
    });
  };

  // w/d are the on-plan footprint, so a quarter-turn swaps them around the centre.
  const rotateItem = (it, deg) => {
    const patch = { rotation: deg };
    if ((deg % 180) !== ((it.rotation || 0) % 180)) {
      const W = scene.width, D = scene.depth;
      const nx = it.x + (it.w - it.d) / 2, ny = it.y + (it.d - it.w) / 2;
      Object.assign(patch, { w: it.d, d: it.w,
        x: Math.max(0, Math.min(W - it.d, nx)), y: Math.max(0, Math.min(D - it.w, ny)) });
    }
    updateItem(it.id, patch);
  };

  const removeItem = (itemId) => {
    updateScene({ ...scene, items: scene.items.filter((it) => it.id !== itemId) });
    setSelected(null);
    toast.success("Item removed");
  };

  const updateRoom = (patch) => {
    // Rescale zone rects proportionally when W/D change so the split stays visually consistent.
    let zones = scene.zones;
    if (patch.width || patch.depth) {
      const sx = patch.width ? patch.width / scene.width : 1;
      const sy = patch.depth ? patch.depth / scene.depth : 1;
      zones = Object.fromEntries(Object.entries(scene.zones || {}).map(([k, z]) => (
        [k, { x: z.x * sx, y: z.y * sy, w: z.w * sx, d: z.d * sy }]
      )));
    }
    updateScene({ ...scene, zones, ...patch });
  };

  const complianceTimer = React.useRef(null);
  const autosaveTimer = React.useRef(null);
  const latestSceneRef = React.useRef(null);
  latestSceneRef.current = scene;
  // Save the latest scene 2.5s after the last change (read from a ref, never inside a state updater).
  const scheduleAutosave = () => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const cur = latestSceneRef.current;
      if (!cur) return;
      const body = { room_id: roomId, width: cur.width, depth: cur.depth,
                     ceiling_h: cur.ceiling_h, shape: cur.shape,
                     zones: cur.zones, items: cur.items, partitions: cur.partitions };
      api.put(`/rooms/${roomId}/scene`, body).then((r) => {
        if (latestSceneRef.current === cur) { setScene(r.data); setDirty(false); }
      }).catch(() => {});
    }, 2500);
  };
  const updateScene = (s, { history = true } = {}) => {
    latestSceneRef.current = s;
    const isRemote = remoteApplyRef.current;
    if (history && !isAnimatingRef.current && !isRemote) {
      setPast((p) => [...p.slice(-49), scene]); // cap at 50
      setFuture([]);
    }
    // Detect newly added items so we can (a) push them onto the Recent
    // strip in the palette and (b) debounce an auto compliance run.
    const prevIds = new Set((scene?.items || []).map((it) => it.id));
    const newlyAdded = (s?.items || []).filter((it) => !prevIds.has(it.id));
    for (const it of newlyAdded) {
      if (it?.component_key) pushRecent(it.component_key);
    }
    setScene(s);
    setDirty(true);
    setValidation(null); // Any edit invalidates the last validation

    // Broadcast to peers + debounce auto-save — but only for LOCAL edits.
    // (Remote edits are being applied *from* a peer, so re-broadcasting
    //  would create an echo, and saving is the originator's job.)
    if (!isRemote) {
      // Strip transient client-only fields before broadcasting (nothing yet,
      // but keeps room for spawn-animation intermediates).
      const snapshot = {
        room_id: roomId,
        width: s.width, depth: s.depth,
        ceiling_h: s.ceiling_h, shape: s.shape,
        zones: s.zones, items: s.items,
        partitions: s.partitions || [],
        version: s.version,
      };
      try { sendSceneOp && sendSceneOp("snapshot", snapshot); } catch {}
      // Auto-save the persisted scene 2.5s after the last edit so returning
      // users always land on the freshest state.
      scheduleAutosave();
    }

    // Compliance Auto-Run — schedule a debounced validation after an
    // item is added or removed. We deliberately do NOT auto-run on
    // every drag / rotation to avoid noisy popups; only when the
    // item COUNT changes.
    const countChanged = (scene?.items?.length || 0) !== (s?.items?.length || 0);
    if (countChanged) {
      if (complianceTimer.current) clearTimeout(complianceTimer.current);
      complianceTimer.current = setTimeout(() => { runValidation({ silent: true }); }, 900);
    }
  };

  const undo = () => {
    if (isAnimatingRef.current) return;
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [scene, ...f].slice(0, 50));
      setScene(prev);
      latestSceneRef.current = prev;
      setDirty(true);
      setValidation(null);
      scheduleAutosave();
      return p.slice(0, -1);
    });
  };

  const redo = () => {
    if (isAnimatingRef.current) return;
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p, scene].slice(-50));
      setScene(next);
      latestSceneRef.current = next;
      setDirty(true);
      setValidation(null);
      scheduleAutosave();
      return f.slice(1);
    });
  };

  // Snap-to-wall auto-fix. Called from the "Snap to wall" button on any
  // ORIENT-* flag card. Hits the backend, reloads the scene, then re-runs
  // validation so the user sees the flag disappear immediately.
  const snapItemToWall = async (itemId, ruleId = "ORIENT") => {
    if (!itemId) return;
    try {
      const r = await api.post(`/rooms/${roomId}/items/${itemId}/snap-to-wall`);
      // Merge the updated item back into the scene locally so the UI
      // doesn't wait for a full scene refetch.
      setScene((s) => s ? { ...s, items: s.items.map((it) => it.id === itemId ? { ...it, ...r.data.item } : it) } : s);
      setDirty(false);
      toast.success(`Snapped: ${r.data.before.x.toFixed(2)},${r.data.before.y.toFixed(2)}@${r.data.before.rotation}° → ${r.data.item.x.toFixed(2)},${r.data.item.y.toFixed(2)}@${r.data.item.rotation}°`);
      runValidation({ silent: true });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Snap failed");
    }
  };

  // Add a user-drawn interior partition to the scene. `p = {x1,y1,x2,y2}`.
  const addPartition = (p) => {
    if (!scene) return;
    const nextP = [ ...(scene.partitions || []),
                    { id: crypto.randomUUID(), kind: "ips",
                      x1: Number(p.x1.toFixed(3)), y1: Number(p.y1.toFixed(3)),
                      x2: Number(p.x2.toFixed(3)), y2: Number(p.y2.toFixed(3)) }];
    updateScene({ ...scene, partitions: nextP });
    setEditorMode("select");
    toast.success("Partition added — wall-mount items can now hang on it");
  };
  // Drop a full IPS preset (T / U / L / Cross) — several segments in one
  // click. Positions are computed from the current room dimensions so the
  // preset scales with the room.
  const addPartitionPreset = (preset) => {
    if (!scene) return;
    const W = scene.width, D = scene.depth;
    const trans = scene.zones?.transition;
    const midY = trans ? trans.y : D * 0.42;               // partition sits on the transition line
    const midX = W / 2;
    const g = (x1, y1, x2, y2) => ({
      id: crypto.randomUUID(), kind: "ips",
      x1: +x1.toFixed(3), y1: +y1.toFixed(3), x2: +x2.toFixed(3), y2: +y2.toFixed(3),
    });
    let segs = [];
    if (preset === "T") {
      // A horizontal spine on the transition line + a vertical drop reaching
      // toward the clean zone (creates a T-shaped IPS wall).
      segs = [ g(0, midY, W, midY), g(midX, midY, midX, D * 0.85) ];
    } else if (preset === "U") {
      // Two vertical "wings" + one horizontal spine — a U facing the door.
      segs = [ g(0, midY, W, midY),
               g(W * 0.20, midY, W * 0.20, D * 0.85),
               g(W * 0.80, midY, W * 0.80, D * 0.85) ];
    } else if (preset === "L") {
      // A horizontal spine + a single vertical wing on the left.
      segs = [ g(0, midY, W, midY),
               g(W * 0.25, midY, W * 0.25, D * 0.85) ];
    } else if (preset === "cross") {
      // Long horizontal + long vertical (splits the room into 4 quadrants).
      segs = [ g(0, midY, W, midY),
               g(midX, 0, midX, D) ];
    } else if (preset === "horizontal") {
      // A single spine across the transition line (the standard scene default).
      segs = [ g(0, midY, W, midY) ];
    } else return;
    updateScene({ ...scene, partitions: [ ...(scene.partitions || []), ...segs ] });
    toast.success(`Dropped a ${preset.toUpperCase()} partition preset (${segs.length} segments)`);
  };
  const removePartition = (id) => {
    if (!scene) return;
    updateScene({ ...scene, partitions: (scene.partitions || []).filter((p) => p.id !== id) });
  };


  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scene, past, future]); // capture latest state

  // Build a per-item flag map so Room2D can show hover explanations.
  // A flag may reference a primary item (location.item_id) and optionally a
  // secondary item (location.item_id_other) — both surfaces get the tooltip.
  const flagsByItem = React.useMemo(() => {
    const map = {};
    (validation?.flags || []).forEach((f) => {
      const primary = f.location?.item_id;
      const secondary = f.location?.item_id_other;
      if (primary)   { (map[primary]   ??= []).push(f); }
      if (secondary) { (map[secondary] ??= []).push(f); }
    });
    return map;
  }, [validation]);

  // Component library keyed by component_key — used for materials hover callouts.
  const componentsByKey = React.useMemo(() => {
    const map = {};
    components.forEach((c) => { map[c.key] = c; });
    return map;
  }, [components]);

  // Smoothly animate items from current positions to a target list of moves + adds
  const animateMoves = (moves, adds = []) => {
    if ((!moves || moves.length === 0) && (!adds || adds.length === 0)) return;
    const startItems = scene.items;
    // New items start at a "drop-in" position: 20cm above their target with 0 opacity → 1
    const newItems = (adds || []).map((a) => ({
      ...a,
      id: crypto.randomUUID(),
      _spawn_progress: 0, // used to animate opacity/scale in
    }));
    const start = [...startItems, ...newItems.map((n) => ({ ...n, _spawn_progress: 0 }))];
    const target = [
      ...startItems.map((it) => {
        const m = (moves || []).find((mm) => mm.id === it.id);
        if (!m) return it;
        return {
          ...it,
          x: m.x !== undefined ? m.x : it.x,
          y: m.y !== undefined ? m.y : it.y,
          rotation: m.rotation !== undefined ? m.rotation : (it.rotation || 0),
          zone: m.zone || it.zone,
        };
      }),
      ...newItems.map((n) => ({ ...n, _spawn_progress: 1 })),
    ];
    setPast((p) => [...p.slice(-49), scene]);
    setFuture([]);

    const duration = 1400;
    const t0 = performance.now();
    isAnimatingRef.current = true;

    const step = (t) => {
      const raw = Math.min(1, (t - t0) / duration);
      const p = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      const interp = start.map((s, i) => {
        const tg = target[i];
        const sRot = ((s.rotation || 0) % 360 + 360) % 360;
        const tRot = ((tg.rotation || 0) % 360 + 360) % 360;
        let dRot = tRot - sRot;
        if (dRot > 180) dRot -= 360;
        if (dRot < -180) dRot += 360;
        return {
          ...s,
          x: s.x + (tg.x - s.x) * p,
          y: s.y + (tg.y - s.y) * p,
          rotation: sRot + dRot * p,
          zone: p > 0.5 ? tg.zone : s.zone,
          _spawn_progress: s._spawn_progress !== undefined ? p : undefined,
        };
      });
      setScene((cur) => ({ ...cur, items: interp }));
      if (raw < 1) requestAnimationFrame(step);
      else {
        isAnimatingRef.current = false;
        // Strip the _spawn_progress helper before persisting
        setScene((cur) => ({ ...cur, items: target.map(({ _spawn_progress, ...rest }) => rest) }));
        setDirty(true);
        setValidation(null);
      }
    };
    requestAnimationFrame(step);
  };

  const runAutofix = async ({ deep = false } = {}) => {
    setAutofixBusy(true);
    try {
      const start = await api.post(`/rooms/${roomId}/ai/autofix/jobs${deep ? "?deep=true" : ""}`);
      let job = start.data;
      for (let i = 0; i < 120 && job.status === "running"; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        job = (await api.get(`/ai/jobs/${start.data.job_id}`)).data;
      }
      if (job.status !== "done") throw { response: { data: { detail: job.detail || "Compliance Assistant timed out — try again" } } };
      const { moves = [], adds = [], notes } = job.result;
      if (moves.length === 0 && adds.length === 0) {
        toast.info("Compliance Assistant: no suggestions right now.");
        return;
      }
      const parts = [];
      if (moves.length) parts.push(`${moves.length} move${moves.length === 1 ? "" : "s"}`);
      if (adds.length) parts.push(`${adds.length} add${adds.length === 1 ? "" : "s"}`);
      toast.success(`Suggested: ${parts.join(" + ")} · human review required. ${notes || ""}`);
      animateMoves(moves, adds);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Compliance Assistant failed");
    } finally {
      setAutofixBusy(false);
    }
  };

  if (!scene) return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading room…</div>;

  const title = node?.name || "Inpatient Dirty Utility Room";

  return (
    <TooltipProvider delayDuration={100}>
    <div className="min-h-screen flex flex-col bg-[#F5F5F7]">
      <TopBar user={user} onLogout={logout} />
      <ReadOnlyBanner node={node} user={user} onCopied={(id) => nav(`/room/${id}`)} />
      <AnimatePresence>
        {showReimport && (
          <ReimportDialog roomId={roomId} onClose={() => setShowReimport(false)}
            onApplied={(s) => {
              setPast((p) => [...p.slice(-49), scene]); setFuture([]);
              setScene(s); setDirty(false); setValidation(null); setShowReimport(false);
              api.get(`/hierarchy/${roomId}`).then((r) => setNode(r.data)).catch(() => {});
            }} />
        )}
        {showCompare && <CompareDialog roomId={roomId} onClose={() => setShowCompare(false)} />}
      </AnimatePresence>

      {/* Sub-header */}
      <div className="hb-glass border-b border-black/5">
        <div className="px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.24em] text-[#86868B] font-medium">
                Dirty Utility · Medium
              </div>
              <div className="font-display text-base font-semibold tracking-tight text-[#1D1D1F]">{title}</div>
            </div>
            <div className="ml-2 px-2.5 h-6 rounded-full bg-[#F5F5F7] text-[10px] uppercase tracking-[0.22em] text-[#86868B] flex items-center">
              v{scene.version}{dirty && " · unsaved"}
            </div>
            {lastRemoteEdit?.author && (
              <div className="ml-2 h-6 px-2 rounded-full bg-sky-50 border border-sky-200 text-sky-800 text-[10px] font-medium flex items-center gap-1"
                   title="Live edit received from a peer"
                   data-testid="last-remote-edit">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                Live edit · {lastRemoteEdit.author.name || lastRemoteEdit.author.email}
              </div>
            )}
            <PresenceChips peers={peers} connected={presenceConnected}
                           followId={followId} onFollowToggle={setFollowId} />
            <button
              onClick={() => setLockManageOpen(true)}
              title={lockStatus.locked ? `Locked · click to manage${lockStatus.set_by ? ` (set by ${lockStatus.set_by})` : ""}` : "Set a room password to keep this session private"}
              data-testid="lock-btn"
              className={`ml-2 h-6 px-2 rounded-full inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest transition-colors ${
                lockStatus.locked
                  ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200"
              }`}>
              {lockStatus.locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
              {lockStatus.locked ? "Locked" : "Open"}
            </button>
            <button
              onClick={() => setInviteOpen(true)}
              title="Invite collaborators to this Room / Building / Estate"
              data-testid="invite-btn"
              className="ml-1 h-6 px-2 rounded-full inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest bg-sky-100 text-sky-900 hover:bg-sky-200 transition-colors">
              <UserPlus className="w-3 h-3" /> Invite
            </button>
            <IfcSourceButton node={node} onReimport={() => setShowReimport(true)} />
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden md:inline-flex items-center bg-[#F5F5F7] rounded-full p-0.5 mr-1" data-testid="view-switcher">
              <button
                onClick={() => setViewMode("plan")}
                className={`px-3 h-8 rounded-full text-[11px] tracking-tight transition-colors ${viewMode === "plan" ? "bg-white text-[#1D1D1F] shadow-sm font-medium" : "text-[#86868B] hover:text-[#1D1D1F]"}`}
                title="Expand 2D plan to full width"
                data-testid="view-plan"
              >2D</button>
              <button
                onClick={() => setViewMode("split")}
                className={`px-3 h-8 rounded-full text-[11px] tracking-tight transition-colors ${viewMode === "split" ? "bg-white text-[#1D1D1F] shadow-sm font-medium" : "text-[#86868B] hover:text-[#1D1D1F]"}`}
                title="Split view"
                data-testid="view-split"
              >Split</button>
              <button
                onClick={() => setViewMode("iso")}
                className={`px-3 h-8 rounded-full text-[11px] tracking-tight transition-colors ${viewMode === "iso" ? "bg-white text-[#1D1D1F] shadow-sm font-medium" : "text-[#86868B] hover:text-[#1D1D1F]"}`}
                title="Expand 3D to full width"
                data-testid="view-iso"
              >3D</button>
            </div>
            <div className="w-px h-5 bg-slate-200 mx-1" />
            <Button variant="outline" size="sm" onClick={undo} disabled={past.length === 0 || autofixBusy}
              className="h-9 w-9 rounded-full p-0" title="Undo (Ctrl+Z)" data-testid="undo-btn">
              <Undo2 className="w-3.5 h-3.5" />
            </Button>
            <Button variant="outline" size="sm" onClick={redo} disabled={future.length === 0 || autofixBusy}
              className="h-9 w-9 rounded-full p-0" title="Redo (Ctrl+Shift+Z)" data-testid="redo-btn">
              <Redo2 className="w-3.5 h-3.5" />
            </Button>
            <Button variant="outline" size="sm" onClick={dirty ? save : undefined} data-testid="save-scene" aria-disabled={!dirty}
              className={`h-9 rounded-full ${dirty ? "" : "cursor-default text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-50"}`}
              title={dirty ? "Save now (auto-saves 2.5s after each edit)" : `All changes saved${scene?.version ? ` · v${scene.version}` : ""}`}>
              {dirty ? "Save" : <><CheckCircle2 className="w-3 h-3 mr-1.5 text-emerald-600" />Saved{scene?.version ? ` · v${scene.version}` : ""}</>}
            </Button>
            <div className="w-px h-5 bg-slate-200 mx-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 rounded-full" data-testid="standard-menu-btn">
                  <Layers className="w-3 h-3 mr-1.5" /> Standard <ChevronDown className="w-3 h-3 ml-1 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.24em] text-[#86868B]">
                  Apply a reference layout
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={() => applyStandard("hbn_f74")}
                                  data-testid="apply-hbn-f74"
                                  className="flex-col items-start gap-0.5 py-2.5">
                  <div className="text-sm font-medium">HBN F74 · Bedpan Dirty Utility</div>
                  <div className="text-[11px] text-[#86868B] leading-snug">
                    HBN 00-10 Fig 74. Macerator + basin adjacent on the west wall,
                    bedpan washer on the east.
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => applyStandard("hbn_f79")}
                                  data-testid="apply-hbn-f79"
                                  className="flex-col items-start gap-0.5 py-2.5">
                  <div className="text-sm font-medium">HBN F79 · General Dirty Utility</div>
                  <div className="text-[11px] text-[#86868B] leading-snug">
                    HBN 00-10 Fig 79. Long narrow room, no macerator — sink + hopper
                    disposal, worktop next to the basin.
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => applyStandard("nhp_v2")}
                                  data-testid="apply-nhp-v2"
                                  className="flex-col items-start gap-0.5 py-2.5">
                  <div className="text-sm font-medium">
                    NHP V2 · RDS 6222 <span className="text-[10px] font-medium text-amber-700 ml-1">(preliminary)</span>
                  </div>
                  <div className="text-[11px] text-[#86868B] leading-snug">
                    NHP RDS 6222 medium inpatient. Basin ≥ 2 m from macerator,
                    sliding staff-card door, no in-room disposal sink.
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => applyStandard("revit_ex01")}
                                  data-testid="apply-revit-ex01"
                                  className="flex-col items-start gap-0.5 py-2.5">
                  <div className="text-sm font-medium">
                    Revit Example 01 · RDS 6222 <span className="text-[10px] font-medium text-emerald-700 ml-1">(from IFC)</span>
                  </div>
                  <div className="text-[11px] text-[#86868B] leading-snug">
                    Real Revit model, 44 fittings at true size. Workbench north, macerator at
                    east IPS, basin + trolleys south, sliding door west.
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={resetToStandard} data-testid="reset-scene"
                                  className="text-[#86868B]">
                  <RotateCcw className="w-3 h-3 mr-2" /> Reset to empty room
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ValidateMenu busy={autofixBusy} onValidate={runValidation}
              onCompliance={() => runAutofix({ deep: true })} onCompare={() => setShowCompare(true)} />
            <Button variant="outline" size="sm" onClick={toggleAnalysis} data-testid="analysis-ribbon-btn"
              aria-pressed={analysisOpen} title={analysisOpen ? "Hide analysis" : "Open travel, visibility & network analysis"}
              className={`h-9 rounded-full ${analysisOpen ? "bg-slate-900 text-white border-slate-900 hover:bg-slate-800 hover:text-white" : ""}`}>
              <Network className="w-3 h-3 mr-1.5" /> Analysis
            </Button>
            <ExportMenu roomId={roomId} onRender={publishRender} onShare={() => setSharingOpen(true)} />
          </div>
        </div>
      </div>

      {/* Main workspace */}
      <div ref={workspaceRef} className="grid" style={{
        gridTemplateColumns: (() => {
          const lw = leftCollapsed  ? 44 : leftW;
          const rw = rightCollapsed ? 44 : rightW;
          if (viewMode === "plan") return `${lw}px 1fr 0px 0px ${rw}px`;
          if (viewMode === "iso")  return `${lw}px 0px 0px 1fr ${rw}px`;
          const l = Math.max(0.05, Math.min(0.95, splitRatio));
          return `${lw}px minmax(0,${(l * 100).toFixed(2)}fr) 6px minmax(0,${((1-l) * 100).toFixed(2)}fr) ${rw}px`;
        })(),
        height: "calc(100vh - 112px)"
      }}>
        {/* Left panel */}
        <aside className={`border-r border-slate-200 bg-white/60 overflow-hidden flex flex-col relative ${leftCollapsed ? "" : ""}`}>
          {leftCollapsed ? (
            <div className="flex flex-col items-center py-3 gap-1" data-testid="left-strip">
              <button onClick={() => setLeftCollapsed(false)}
                      title="Expand panel"
                      data-testid="left-expand"
                      className="w-8 h-8 rounded-full bg-white border border-slate-300 shadow-sm text-slate-500 hover:text-slate-900 flex items-center justify-center mb-2">
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              {[
                { k: "palette",    label: "Palette",   Icon: Grid3x3 },
                { k: "validation", label: "Checks",    Icon: CheckCircle2, badge: validation?.flags?.length },
                { k: "history",    label: "Decisions", Icon: History },
              ].map(({ k, label, Icon, badge }) => (
                <button key={k}
                        onClick={() => { setTab(k); setLeftCollapsed(false); }}
                        title={label}
                        data-testid={`left-strip-${k}`}
                        className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                          tab === k ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100 border border-transparent"
                        }`}>
                  <Icon className="w-4 h-4" />
                  {badge > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-rose-500 text-white text-[9px] font-medium flex items-center justify-center">{badge}</span>
                  )}
                </button>
              ))}
            </div>
          ) : (<>
          <div
            onMouseDown={startResize("left")}
            className="absolute right-0 top-0 bottom-0 w-1.5 z-30 hover:bg-slate-900/10 active:bg-slate-900/20 cursor-ew-resize transition-colors"
            data-testid="resize-left"
          />
          <button onClick={() => setLeftCollapsed(true)}
                  title="Collapse panel"
                  className="absolute -right-3 top-4 z-40 w-6 h-6 rounded-full bg-white border border-slate-300 shadow-sm text-slate-500 hover:text-slate-900 text-xs flex items-center justify-center"
                  data-testid="left-collapse">
            «
          </button>
          <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
            <TabsList className="grid grid-cols-3 mx-3 mt-3 bg-slate-100 rounded-lg h-9 p-1">
              <TabsTrigger value="palette" className="text-[11px] rounded-md" data-testid="tab-palette">Palette</TabsTrigger>
              <TabsTrigger value="validation" className="text-[11px] rounded-md" data-testid="tab-validation">
                Checks{validation ? ` · ${validation.flags.length}` : ""}
              </TabsTrigger>
              <TabsTrigger value="history" className="text-[11px] rounded-md" data-testid="tab-history">Decisions</TabsTrigger>
            </TabsList>

            <TabsContent value="palette" className="flex-1 overflow-hidden mt-3 min-h-0">
              <ScrollArea className="h-full px-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500 px-1 mb-2">Overlays</div>
                <div className="space-y-2 p-2 rounded-xl bg-white border border-slate-200 mb-4">
                  {[
                    ["zones","Zones"],
                    ["dirtyFlow","Soiled → clean"],
                    ["personFlow","Person flow"],
                    ["cleanFlow","Clean supply"],
                    ["animate","Animate flows"],
                    ["wall","Wall-mounted"],
                    ["ceiling","Ceiling"],
                  ].map(([k, label]) => (
                    <label key={k} className="flex items-center justify-between cursor-pointer">
                      <span className="text-xs text-slate-700">{label}</span>
                      <Switch checked={!!overlays[k]}
                              onCheckedChange={(v) => setOverlays({ ...overlays, [k]: v })}
                              data-testid={`ov-${k}`} />
                    </label>
                  ))}
                </div>

                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500 px-1 mb-2 flex items-center justify-between">
                  <span>Components</span>
                  <label className="flex items-center gap-1.5 normal-case tracking-normal text-[10px] text-slate-600 cursor-pointer"
                         title="Show only components with an uploaded Revit family">
                    <Switch checked={revitOnly} onCheckedChange={setRevitOnly}
                            data-testid="palette-filter-revit-only" className="scale-75" />
                    <span className="font-mono uppercase tracking-wider">Revit only</span>
                  </label>
                </div>
                {/* Palette Search — filter by name or code as you type. */}
                <div className="mb-2 px-1">
                  <input
                    type="text"
                    placeholder="Search components…"
                    value={paletteSearch}
                    onChange={(e) => setPaletteSearch(e.target.value)}
                    data-testid="palette-search-input"
                    className="w-full h-8 px-2.5 rounded-md bg-white border border-slate-200 text-xs placeholder:text-slate-400 focus:outline-none focus:border-slate-400 transition-colors"
                  />
                </div>
                {/* Grouping selector — group palette by zone or mount type. */}
                <div className="flex items-center gap-1 mb-2 px-1" data-testid="palette-group-selector">
                  <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-400 mr-1">Group</span>
                  {[["none","Flat"],["zone","Zone"],["mount","Mount"]].map(([v, lbl]) => (
                    <button key={v}
                            onClick={() => { setPaletteGroup(v); localStorage.setItem("his:paletteGroup", v); }}
                            data-testid={`palette-group-${v}`}
                            className={`px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider transition-colors ${
                              paletteGroup === v ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200 hover:border-slate-400"
                            }`}>
                      {lbl}
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5 pr-2">
                  {(() => {
                    const q = paletteSearch.trim().toLowerCase();
                    const items = components.filter(c => {
                      if (revitOnly && !c.has_override) return false;
                      if (!q) return true;
                      const hay = `${c.key} ${c.name || ""} ${c.code || ""} ${c.override?.revit_title || ""}`.toLowerCase();
                      return hay.includes(q);
                    });
                    const renderTile = (c) => {
                      const thumb = c.override?.thumbnail_url
                        ? `${process.env.REACT_APP_BACKEND_URL}${c.override.thumbnail_url}` : null;
                      const fav = favourites.has(c.key);
                      return (
                        <div
                          key={c.key + (c.code || "")}
                          draggable
                          onDragStart={(e) => {
                            if (e.dataTransfer) {
                              e.dataTransfer.setData("application/json", JSON.stringify(c));
                            }
                            // Fire a global event so Room2D can render a live footprint ghost.
                            window.dispatchEvent(new CustomEvent("his:paletteDragStart", { detail: c }));
                          }}
                          onDragEnd={() => window.dispatchEvent(new CustomEvent("his:paletteDragEnd"))}
                          className="group p-2.5 rounded-lg bg-white border border-slate-200 hover:border-slate-400 cursor-grab active:cursor-grabbing transition-colors relative"
                          data-testid={`palette-${c.key}`}
                        >
                          <button
                            type="button"
                            draggable={false}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); toggleFavourite(c.key); }}
                            title={fav ? "Unstar" : "Star this component (float to top)"}
                            data-testid={`palette-star-${c.key}`}
                            className={`absolute top-1.5 right-1.5 w-5 h-5 rounded flex items-center justify-center transition-opacity ${
                              fav ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            <Star className={`w-3.5 h-3.5 ${fav ? "text-amber-400 fill-amber-400" : "text-slate-400 hover:text-amber-500"}`} />
                          </button>
                          <div className="flex items-center gap-2">
                            {thumb ? (
                              <img src={thumb} alt="" className="w-10 h-10 object-contain rounded bg-[#F5F5F7] flex-shrink-0"
                                   data-testid={`palette-thumb-${c.key}`} />
                            ) : (
                              <div className="w-10 h-10 rounded bg-[#F5F5F7] flex-shrink-0 flex items-center justify-center">
                                <div className="w-2 h-2 rounded-full" style={{
                                  background: c.zone_affinity === "clean" ? "#7CBF8B" :
                                              c.zone_affinity === "transition" ? "#DBA362" : "#C97567"
                                }} />
                              </div>
                            )}
                            <div className="min-w-0 flex-1 pr-5">
                              <div className="flex items-center gap-1.5">
                                <div className="font-display text-xs font-medium text-slate-900 truncate">{c.name}</div>
                                {c.has_override && (
                                  <span className="text-[8px] leading-none font-mono uppercase tracking-wider bg-violet-50 text-violet-700 px-1 py-[1.5px] rounded"
                                        title={`Revit: ${c.override?.revit_title}`}
                                        data-testid={`palette-badge-${c.key}`}>R</span>
                                )}
                              </div>
                              <div className="font-mono text-[10px] uppercase tracking-widest text-slate-400 mt-0.5 truncate">
                                {c.mount_type} · {c.default_footprint.w}×{c.default_footprint.d}m
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    };
                    // Favourites always float to the top.
                    const favList = items.filter(c => favourites.has(c.key));
                    const restList = items.filter(c => !favourites.has(c.key));
                    const favouritesSection = favList.length > 0 && (
                      <div className="mb-3" data-testid="palette-favourites-section">
                        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-amber-600 px-1 mt-1 mb-1.5 flex items-center gap-1">
                          <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                          Favourites · {favList.length}
                        </div>
                        <div className="space-y-1.5">{favList.map(renderTile)}</div>
                      </div>
                    );
                    // Recently used horizontal strip — one-click re-drop for the
                    // last components an architect actually placed. Resolved
                    // against the currently filtered items so it respects the
                    // Revit-only toggle and the search query.
                    const recentList = recentKeys
                      .map((k) => items.find((c) => c.key === k))
                      .filter(Boolean)
                      .slice(0, 6);
                    const recentStrip = recentList.length > 0 && (
                      <div className="mb-3" data-testid="palette-recent-section">
                        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500 px-1 mt-1 mb-1.5">
                          Recently used · {recentList.length}
                        </div>
                        <div className="flex flex-wrap gap-1.5 px-1">
                          {recentList.map((c) => {
                            const thumb = c.override?.thumbnail_url
                              ? `${process.env.REACT_APP_BACKEND_URL}${c.override.thumbnail_url}` : null;
                            return (
                              <div
                                key={"recent-" + c.key}
                                draggable
                                onDragStart={(e) => {
                                  if (e.dataTransfer) e.dataTransfer.setData("application/json", JSON.stringify(c));
                                  window.dispatchEvent(new CustomEvent("his:paletteDragStart", { detail: c }));
                                }}
                                onDragEnd={() => window.dispatchEvent(new CustomEvent("his:paletteDragEnd"))}
                                title={c.name}
                                className="w-10 h-10 rounded-md bg-white border border-slate-200 hover:border-slate-500 flex items-center justify-center cursor-grab active:cursor-grabbing transition-colors relative"
                                data-testid={`palette-recent-${c.key}`}
                              >
                                {thumb
                                  ? <img src={thumb} alt="" className="w-9 h-9 object-contain rounded" />
                                  : (
                                    <div className="w-2.5 h-2.5 rounded-full" style={{
                                      background: c.zone_affinity === "clean" ? "#7CBF8B" :
                                                  c.zone_affinity === "transition" ? "#DBA362" : "#C97567"
                                    }} />
                                  )}
                                {c.has_override && (
                                  <span className="absolute -top-1 -right-1 text-[7px] leading-none font-mono uppercase tracking-wider bg-violet-600 text-white px-1 py-[1px] rounded">R</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                    if (paletteGroup === "none") {
                      return (
                        <>
                          {recentStrip}
                          {favouritesSection}
                          {restList.map(renderTile)}
                        </>
                      );
                    }
                    // Group by zone or mount, in a stable order
                    const groupKey = (c) =>
                      paletteGroup === "zone"
                        ? (c.zone_affinity || "unassigned")
                        : (c.mount_type   || "unassigned");
                    const order = paletteGroup === "zone"
                      ? ["dirty","transition","clean","unassigned"]
                      : ["floor","wall","ceiling","unassigned"];
                    const labels = paletteGroup === "zone"
                      ? { dirty:"Dirty zone", transition:"Transition zone", clean:"Clean zone", unassigned:"Unassigned" }
                      : { floor:"Floor-mounted", wall:"Wall-mounted", ceiling:"Ceiling-mounted", unassigned:"Unassigned" };
                    const buckets = {};
                    for (const c of restList) {
                      const k = groupKey(c);
                      (buckets[k] = buckets[k] || []).push(c);
                    }
                    const keys = Object.keys(buckets);
                    keys.sort((a,b) => {
                      const ia = order.indexOf(a), ib = order.indexOf(b);
                      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
                    });
                    return (
                      <>
                        {recentStrip}
                        {favouritesSection}
                        {keys.map((k) => (
                          <div key={k} className="mb-3" data-testid={`palette-group-section-${k}`}>
                            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-400 px-1 mt-2 mb-1.5">
                              {labels[k] || k} · {buckets[k].length}
                            </div>
                            <div className="space-y-1.5">
                              {buckets[k].map(renderTile)}
                            </div>
                          </div>
                        ))}
                      </>
                    );
                  })()}
                  {(() => {
                    const q = paletteSearch.trim().toLowerCase();
                    const filtered = components.filter(c => {
                      if (revitOnly && !c.has_override) return false;
                      if (!q) return true;
                      const hay = `${c.key} ${c.name || ""} ${c.code || ""} ${c.override?.revit_title || ""}`.toLowerCase();
                      return hay.includes(q);
                    });
                    if (filtered.length) return null;
                    return (
                      <div className="text-[11px] font-mono text-slate-500 italic p-2"
                           data-testid="palette-filter-empty">
                        {q
                          ? `No components match "${paletteSearch}".`
                          : "No Revit-overridden components yet. Upload .rfa files in the Components library."}
                      </div>
                    );
                  })()}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="validation" className="flex-1 overflow-hidden mt-3 min-h-0">
              <ScrollArea className="h-full px-3">
                {!validation && <div className="text-xs text-slate-500 font-mono p-2">Run validation to see checks by tier.</div>}
                {validation && (
                  <div className="space-y-3">
                    {/* Summary */}
                    <div className={`p-3 rounded-xl border ${validation.passed
                        ? "bg-[#EEF6EF] border-[#7CBF8B]/40"
                        : "bg-[#FBEDE9] border-[#C97567]/40"}`}>
                      <div className="flex items-center gap-2 justify-between">
                        <div className="flex items-center gap-2">
                          {validation.passed
                            ? <CheckCircle2 className="w-4 h-4 text-[#4A9C5F]" />
                            : <AlertOctagon className="w-4 h-4 text-[#B15A4F]" />}
                          <div className="font-display text-sm font-semibold">
                            {validation.passed ? "Baseline compliant" : "Non-compliant"}
                          </div>
                        </div>
                        {/* Auto-fix all: only appears if there's at least one ORIENT flag. */}
                        {validation.flags.some((f) => f.rule_id?.startsWith("ORIENT-")) && (
                          <button
                            onClick={() => setAutoFixOpen(true)}
                            data-testid="auto-fix-all"
                            className="text-[10px] uppercase tracking-widest text-[#0071E3] hover:text-[#0077ED] font-medium inline-flex items-center gap-1">
                            <Wand2 className="w-3 h-3" /> Auto-fix all
                          </button>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <TierChip label="Baseline fail" count={validation.counts.baseline_fail} tier="baseline" />
                        <TierChip label="V.2.0 fail" count={validation.counts.v2_fail} tier="v2" />
                        <TierChip label="Best practice" count={validation.counts.enhanced_advisory} tier="enhanced" />
                        <TierChip label="v3 · Stated"    count={validation.counts.stated_fail}         tier="stated" />
                        <TierChip label="v3 · Invariant" count={validation.counts.invariant_advisory}  tier="invariant" />
                        <TierChip label="v3 · Inferred"  count={validation.counts.inferred_advisory}   tier="inferred" />
                        <TierChip label="Context" count={validation.counts.context} tier="context" />
                        <TierChip label="Review" count={validation.counts.review} tier="review" />
                      </div>
                    </div>

                    {/* Grouped flags */}
                    {["baseline","stated","v2","invariant","enhanced","inferred","context","review"].map((tKey) => {
                      const groupFlags = validation.flags.filter((f) => f.tier === tKey);
                      if (groupFlags.length === 0) return null;
                      return (
                        <div key={tKey}>
                          <div className={`font-mono text-[10px] uppercase tracking-[0.3em] px-2 py-1 rounded-full inline-block ${TIER[tKey].cls} border mb-2`}>
                            {TIER[tKey].label} · {groupFlags.length}
                          </div>
                          <div className="space-y-2">
                            {groupFlags.map((f, i) => {
                              const Icon = KIND_ICON[f.kind] || AlertTriangle;
                              const hasPdf = !!f.source_url;
                              const itemId = f.location?.item_id;
                              const openPdf = (e) => {
                                e.stopPropagation();
                                if (!hasPdf) return;
                                const href = f.source_page ? `${f.source_url}#page=${f.source_page}` : f.source_url;
                                window.open(href, "_blank", "noopener,noreferrer");
                              };
                              const focusItem = () => {
                                if (itemId) { setSelected(itemId); setSelectedIds([itemId]); }
                              };
                              return (
                                <motion.div key={`${tKey}-${i}`}
                                  initial={{opacity:0,y:4}} animate={{opacity:1,y:0}}
                                  transition={{delay:i*0.03}}
                                  onClick={focusItem}
                                  className={`p-3 rounded-lg bg-white border border-slate-200 ${itemId ? "cursor-pointer hover:border-slate-400" : ""}`}
                                  data-testid={`flag-${f.rule_id}`}>
                                  <div className="flex items-start gap-2">
                                    <Icon className="w-3.5 h-3.5 mt-0.5 text-slate-500 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                      <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                                        {f.rule_id} · {f.kind}
                                      </div>
                                      <div className="text-xs text-slate-800 mt-1 leading-relaxed">
                                        {f.message}
                                        {f.derogated && (
                                          <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FFF4E5] text-[#B87A2B] text-[9px] font-medium uppercase tracking-[0.18em]">
                                            derogated
                                          </span>
                                        )}
                                      </div>
                                      {f.fix && !f.derogated && (
                                        <div className="mt-1.5 text-xs text-[#0071E3] leading-relaxed">
                                          → {f.fix}
                                        </div>
                                      )}
                                      {f.derogated && f.derogation && (
                                        <div className="mt-1.5 text-xs text-[#B87A2B] leading-relaxed">
                                          Derogation approved by {f.derogation.approved_by} · "{f.derogation.justification}"
                                        </div>
                                      )}
                                      <div className="mt-2 flex items-center justify-between gap-2">
                                        <button
                                          type="button"
                                          onClick={openPdf}
                                          disabled={!hasPdf}
                                          className={`inline-flex items-center gap-1 font-mono text-[10px] ${hasPdf ? "text-[#0071E3] hover:text-[#0077ED] cursor-pointer" : "text-slate-400 cursor-default"}`}
                                          title={hasPdf ? "Open source PDF at extraction page" : "Source PDF not available"}>
                                          ↳ {f.source}{hasPdf && f.source_page ? ` · p. ${f.source_page}` : ""}{hasPdf ? " ↗" : ""}
                                        </button>
                                        {!f.derogated && f.kind === "FAIL" && (
                                          <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); setDerogateFor(f); }}
                                            className="text-[10px] uppercase tracking-widest text-[#B87A2B] hover:text-[#8A5A20] font-medium"
                                            data-testid={`derogate-${f.rule_id}`}>
                                            Request derogation
                                          </button>
                                        )}
                                        {!f.derogated && f.rule_id?.startsWith("ORIENT-") && f.location?.item_id && (
                                          <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); snapItemToWall(f.location.item_id, f.rule_id); }}
                                            className="text-[10px] uppercase tracking-widest text-[#0071E3] hover:text-[#0077ED] font-medium"
                                            data-testid={`snap-${f.location.item_id}`}>
                                            Snap to wall
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </motion.div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="history" className="flex-1 overflow-hidden mt-3 min-h-0">
              <DecisionLog roomId={roomId} user={user} changelog={changelog} onClearChangelog={clearChangelog} />
            </TabsContent>
          </Tabs>
          </>)}
        </aside>

        {/* Center: 2D */}
        <div className="border-r border-slate-200 relative overflow-hidden" style={{ background: "#FAFAFB" }}>
          <div className="absolute top-3 left-3 z-10 font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">
            2D Plan · {scene.width}m × {scene.depth}m · drag empty area to marquee-select
          </div>
          {selectedIds.length > 1 && (
            <div className="absolute top-3 right-3 z-10 hb-glass rounded-full px-3 py-1 flex items-center gap-2 text-[11px] tracking-tight text-[#1D1D1F]"
                 data-testid="multiselect-chip">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0071E3]" />
              <span className="font-medium">{selectedIds.length} selected</span>
              <span className="text-[#86868B]">· press Delete</span>
            </div>
          )}
          <Room2D scene={scene} onSceneChange={updateScene}
                  selected={selected} setSelected={setSelected}
                  selectedIds={selectedIds} setSelectedIds={setSelectedIds}
                  flags={validation?.flags || []} flagsByItem={flagsByItem}
                  flowPaths={validation?.flow_paths || null}
                  analysisOverlay={analysisOpen && rightTab === "analysis" ? analysisOverlay : null}
                  componentsByKey={componentsByKey}
                  editorMode={editorMode} onEditorModeChange={setEditorMode}
                  onPartitionAdd={addPartition} onPartitionRemove={removePartition}
                  overlays={overlays} zoom={zoom2D} onZoomChange={setZoom2D} />
        </div>

        {/* Split divider — drag to resize 2D/3D. Only interactive in split mode. */}
        <div
          onMouseDown={viewMode === "split" ? startSplitDrag : undefined}
          data-testid="split-divider"
          className={`relative ${viewMode === "split" ? "cursor-ew-resize group" : "pointer-events-none"}`}
          style={{ background: viewMode === "split" ? "rgba(226,232,240,0.6)" : "transparent" }}
        >
          {viewMode === "split" && (
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity">
              <div className="w-1 h-8 rounded-full bg-slate-500/40" />
            </div>
          )}
        </div>

        {/* Right-center: 3D */}
        <div className="relative overflow-hidden">
          <div className="absolute top-3 left-3 z-10 font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">
            3D Isometric · {(scene.ceiling_h || 2.7)}m ceiling · shift-click for multi-select
          </div>
          <div className="absolute top-3 right-3 z-10 font-mono text-[9px] text-slate-500 hb-glass rounded-full px-3 py-1" data-testid="hint-3d">
            drag rotate · wheel zoom · right-drag pan
          </div>
          <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest">
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{background:"#6FBE83"}}/>Clean</div>
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{background:"#C9A76E"}}/>Transition</div>
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{background:"#D07268"}}/>Dirty</div>
          </div>
          <Room3D scene={scene} highlightItemId={selected} highlightIds={selectedIds} overlays={overlays}
                  flowPaths={validation?.flow_paths || null}
                  componentsByKey={componentsByKey}
                  peers={peers}
                  onSelect={(id, { shift } = {}) => {
                    if (shift) {
                      // Toggle in the multi-selection
                      setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
                      setSelected(id);
                    } else {
                      setSelected(id);
                      setSelectedIds([id]);
                    }
                  }} />
        </div>

        {/* Right: properties + renders */}
        <aside className="border-l border-slate-200 bg-white/60 overflow-hidden flex flex-col relative">
          {rightCollapsed ? (
            <div className="flex flex-col items-center py-3 gap-1" data-testid="right-strip">
              <button onClick={() => setRightCollapsed(false)}
                      title="Expand properties panel"
                      data-testid="right-expand"
                      className="w-8 h-8 rounded-full bg-white border border-slate-300 shadow-sm text-slate-500 hover:text-slate-900 flex items-center justify-center mb-2">
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-500"
                   title={selected ? "Properties" : "No selection"}>
                <SlidersHorizontal className="w-4 h-4" />
              </div>
              {analysisOpen && (
                <button onClick={() => { setRightTab("analysis"); setRightCollapsed(false); }} title="Analysis"
                  data-testid="right-strip-analysis"
                  className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center">
                  <Network className="w-4 h-4" />
                </button>
              )}
              {selected && (
                <div className="mt-1 px-1 text-[9px] font-mono uppercase tracking-widest text-slate-400 text-center leading-tight">
                  1<br />item
                </div>
              )}
            </div>
          ) : (<>
          <div
            onMouseDown={startResize("right")}
            className="absolute left-0 top-0 bottom-0 w-1.5 z-30 hover:bg-slate-900/10 active:bg-slate-900/20 cursor-ew-resize transition-colors"
            data-testid="resize-right"
          />
          <button onClick={() => setRightCollapsed(true)}
                  title="Collapse properties panel"
                  className="absolute -left-3 top-4 z-40 w-6 h-6 rounded-full bg-white border border-slate-300 shadow-sm text-slate-500 hover:text-slate-900 text-xs flex items-center justify-center"
                  data-testid="right-collapse">
            »
          </button>
          {analysisOpen && (
            <div className="flex items-center gap-1 px-3 pt-3 pb-2 border-b border-slate-100" data-testid="right-tabs">
              <button onClick={() => setRightTab("properties")} data-testid="right-tab-properties"
                className={`h-7 px-3 rounded-full text-[11px] font-medium transition-colors ${
                  rightTab === "properties" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>Properties</button>
              <div className={`h-7 pl-3 pr-1 rounded-full text-[11px] font-medium inline-flex items-center gap-1 transition-colors ${
                  rightTab === "analysis" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                <button onClick={() => setRightTab("analysis")} data-testid="right-tab-analysis">Analysis</button>
                <button onClick={closeAnalysis} title="Close analysis" aria-label="Close analysis" data-testid="right-tab-analysis-close"
                  className={`w-5 h-5 rounded-full inline-flex items-center justify-center ${rightTab === "analysis" ? "hover:bg-white/20" : "hover:bg-slate-200"}`}>
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          )}
          {analysisOpen && rightTab === "analysis" ? (
            <ScrollArea className="flex-1" data-testid="right-analysis-panel">
              <div className="p-3">
                <AnalysisPanel roomId={roomId} roomName={node?.name} sceneVersion={scene?.version} items={scene?.items || []}
                               onOverlay={setAnalysisOverlay} />
              </div>
            </ScrollArea>
          ) : (<>
          <div className="p-4 border-b border-slate-100">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500 mb-1">Properties</div>
            {selected ? (() => {
              const it = scene.items.find((i) => i.id === selected);
              const comp = components.find((c) => c.key === it?.component_key);
              if (!it || !comp) return null;
              const rot = ((it.rotation || 0) % 360 + 360) % 360;
              const cycleRot = (dir) => {
                const next = ((rot + dir * 90) % 360 + 360) % 360;
                rotateItem(it, next);
              };
              return (
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-display text-base font-semibold text-slate-900 leading-tight" data-testid="item-title">{it.component_key === "generic_ifc" ? (it.label || comp.name) : comp.name}</div>
                    <button onClick={() => removeItem(it.id)}
                      className="text-slate-400 hover:text-red-600 transition-colors shrink-0"
                      title="Remove from scene"
                      data-testid="item-remove">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="font-mono text-[9px] uppercase tracking-widest capitalize">{it.mount_type}</Badge>
                    <Badge variant="outline" className="font-mono text-[9px] uppercase tracking-widest capitalize">{it.zone}</Badge>
                    {comp.code && comp.code !== "—" && (
                      <Badge variant="outline" className="font-mono text-[9px] tracking-widest">{comp.code}</Badge>
                    )}
                  </div>
                  {it.revit_family && (
                    <div className="mt-2 rounded-md bg-violet-50 border border-violet-200 px-2.5 py-1.5" data-testid="item-revit-family">
                      <div className="font-mono text-[9px] uppercase tracking-widest text-violet-700">Revit family</div>
                      <div className="text-[11px] text-violet-950 leading-snug break-words">{it.revit_family}</div>
                    </div>
                  )}
                  {it.component_key === "generic_ifc" && it.revit_family && (
                    <GenericLinkPanel item={it} components={components}
                      onLinked={(key) => {
                        const c = components.find((x) => x.key === key);
                        updateScene({ ...scene, items: scene.items.map((x) =>
                          x.component_key === "generic_ifc" && x.revit_family === it.revit_family
                            ? { ...x, component_key: key, kind: c?.kind, material: c?.material, code: c?.code } : x) });
                      }} />
                  )}

                  {/* Position (read-only from 2D drag) */}
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <Prop label="X" value={`${it.x.toFixed(2)}m`} />
                    <Prop label="Y" value={`${it.y.toFixed(2)}m`} />
                    <Prop label="W" value={`${it.w.toFixed(2)}m`} />
                    <Prop label="D" value={`${it.d.toFixed(2)}m`} />
                  </div>

                  {/* Rotation */}
                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Rotation</div>
                      <div className="font-mono text-[11px] text-slate-800 tabular-nums" data-testid="item-rotation-value">{rot}°</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => cycleRot(-1)}
                        className="h-8 w-8 rounded-md bg-white border border-slate-200 hover:border-slate-400 flex items-center justify-center text-slate-700"
                        title="Rotate 90° counter-clockwise"
                        data-testid="item-rotate-ccw">
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                      <div className="flex-1 grid grid-cols-4 gap-1">
                        {[0, 90, 180, 270].map((deg) => (
                          <button key={deg} onClick={() => rotateItem(it, deg)}
                            className={`h-8 rounded-md text-[10px] font-mono uppercase tracking-widest transition-colors ${
                              rot === deg ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-700 hover:border-slate-400"
                            }`}
                            data-testid={`item-rot-${deg}`}>
                            {deg}°
                          </button>
                        ))}
                      </div>
                      <button onClick={() => cycleRot(1)}
                        className="h-8 w-8 rounded-md bg-white border border-slate-200 hover:border-slate-400 flex items-center justify-center text-slate-700"
                        title="Rotate 90° clockwise"
                        data-testid="item-rotate-cw">
                        <RotateCw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Elevation + Height */}
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <NumberField
                      label="Elevation (m)" hint="Height above floor"
                      value={it.elevation_m ?? 0} min={0} max={scene.ceiling_h || 2.7} step={0.05}
                      onChange={(v) => updateItem(it.id, { elevation_m: v })}
                      testId="item-elevation"
                    />
                    <NumberField
                      label="Height (m)" hint="Vertical extent"
                      value={it.height_m ?? 0.9} min={0.05} max={scene.ceiling_h || 2.7} step={0.05}
                      onChange={(v) => updateItem(it.id, { height_m: v })}
                      testId="item-height"
                    />
                  </div>

                  <p className="mt-3 text-xs text-slate-600 leading-relaxed">{comp.description}</p>
                </div>
              );
            })() : (
              <RoomBoundary scene={scene} onChange={updateRoom}
                            editorMode={editorMode} onEditorModeChange={setEditorMode}
                            onAddPreset={addPartitionPreset}
                            onRemovePartition={removePartition} />
            )}
          </div>

          <ScrollArea className="flex-1">
            <div className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Latest renders</div>
                {renders.length > 0 && (
                  <button onClick={clearRenders}
                    className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500 hover:text-red-600"
                    data-testid="clear-renders">
                    <Trash2 className="w-3 h-3" /> Clear
                  </button>
                )}
              </div>
              {renders.length === 0 && <div className="text-xs text-slate-400 font-mono">Not yet rendered.</div>}
              <div className="space-y-2">
                {renders.map((r) => (
                  <button key={r.id} onClick={() => setRendered(r)}
                          className="w-full text-left p-2.5 rounded-lg bg-white border border-slate-200 hover:border-slate-400 transition-colors"
                          data-testid={`render-${r.id}`}>
                    <div className="text-xs text-slate-800">v{r.scene_version}</div>
                    <div className="font-mono text-[10px] text-slate-500 mt-0.5">
                      {new Date(r.published_at).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </ScrollArea>
          </>)}
          </>)}
        </aside>
      </div>

      <AnimatePresence>
        {rendered && <RenderModal render={rendered} components={components} onClose={() => setRendered(null)} roomId={roomId} roomName={node?.name} />}
      </AnimatePresence>

      <RoomLockPrompt
        open={lockPromptOpen && !lockPassed}
        roomId={roomId}
        onCancel={() => nav("/dashboard")}
        onSuccess={() => {
          try { sessionStorage.setItem("his:lockpass:" + roomId, "1"); } catch {}
          setLockPassed(true);
          setLockPromptOpen(false);
        }}
      />
      <RoomLockManage
        open={lockManageOpen}
        roomId={roomId}
        locked={lockStatus.locked}
        onClose={() => setLockManageOpen(false)}
        onChanged={(next) => {
          setLockStatus(next);
          if (next.locked) {
            // Whoever just set the lock has implicitly passed.
            try { sessionStorage.setItem("his:lockpass:" + roomId, "1"); } catch {}
            setLockPassed(true);
          } else {
            try { sessionStorage.removeItem("his:lockpass:" + roomId); } catch {}
          }
        }}
      />
      <InviteModal
        open={inviteOpen}
        roomId={roomId}
        node={node}
        onClose={() => setInviteOpen(false)}
      />

      {/* AI Compliance Chat — floating bottom-right widget */}
      <AiFab open={aiOpen} setOpen={setAiOpen} roomId={roomId} sceneVersion={scene.version}
             flagsCount={validation?.flags?.length || 0} onAddComponent={addAiComponent} />

      {/* Derogation request dialog */}
      <DerogationDialog roomId={roomId} flag={derogateFor} onClose={() => setDerogateFor(null)}
                        onDone={() => { setDerogateFor(null); toast.success("Derogation submitted for reviewer/admin approval."); runValidation && runValidation(); }} />
      {/* Auto-Fix All (orient sweep) preview */}
      <AutoFixDialog roomId={roomId} open={autoFixOpen} onClose={() => setAutoFixOpen(false)}
                     onApplied={() => {
                       setAutoFixOpen(false);
                       api.get(`/rooms/${roomId}/scene`).then((r) => { setScene(r.data); setDirty(false); });
                       runValidation && runValidation({ silent: true });
                     }} />
      {/* Sharing panel — owner-only. Backend returns 403 for non-owners and
          the panel closes itself. */}
      <AnimatePresence>
        {sharingOpen && (
          <SharingPanel roomId={roomId} roomName={node?.name}
                        currentUser={user}
                        onClose={() => setSharingOpen(false)} />
        )}
      </AnimatePresence>
    </div>
    </TooltipProvider>
  );
}

function Prop({ label, value }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-400">{label}</div>
      <div className="font-mono text-xs text-slate-800">{value}</div>
    </div>
  );
}

function NumberField({ label, hint, value, min, max, step, onChange, testId }) {
  const clamp = (v) => Math.max(min, Math.min(max, v));
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className="flex items-center gap-1">
        <button type="button"
          onClick={() => onChange(clamp(Number((Number(value) - step).toFixed(2))))}
          className="w-6 h-8 rounded-md bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-sm"
          data-testid={`${testId}-dec`}
        >−</button>
        <input
          type="number"
          value={Number(value).toFixed(2)}
          min={min} max={max} step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!isNaN(v)) onChange(clamp(Number(v.toFixed(2))));
          }}
          className="flex-1 h-8 rounded-md border border-slate-200 focus:border-slate-900 focus:outline-none px-1.5 text-xs font-mono text-center tabular-nums"
          data-testid={`${testId}-input`}
        />
        <button type="button"
          onClick={() => onChange(clamp(Number((Number(value) + step).toFixed(2))))}
          className="w-6 h-8 rounded-md bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-sm"
          data-testid={`${testId}-inc`}
        >+</button>
      </div>
      {hint && <div className="font-mono text-[9px] text-slate-400 mt-1">{hint}</div>}
    </div>
  );
}

function RoomBoundary({ scene, onChange, editorMode, onEditorModeChange, onAddPreset, onRemovePartition }) {
  const shape = scene.shape?.type || "rectangle";
  const setShape = (type) => {
    // Sensible default notch = 20% of width × 30% of depth in the far corner
    const notch = type === "rectangle" ? null : {
      x: scene.width * 0.6, y: 0,
      w: scene.width * 0.4, d: scene.depth * 0.3,
    };
    onChange({ shape: { type, ...(notch ? { notch } : {}) } });
  };
  return (
    <div data-testid="room-boundary">
      <div className="flex items-center gap-2 mb-3">
        <Ruler className="w-4 h-4 text-slate-500" strokeWidth={1.75} />
        <div className="font-display text-base font-semibold text-slate-900">Room boundary</div>
      </div>
      {/* Shape presets */}
      <div className="mb-4">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500 mb-1.5">Shape</div>
        <div className="grid grid-cols-4 gap-1" data-testid="shape-presets">
          {[
            { k: "rectangle", label: "▭", name: "Rect" },
            { k: "L",         label: "⌐", name: "L" },
            { k: "T",         label: "⊤", name: "T" },
            { k: "U",         label: "∪", name: "U" },
          ].map((s) => (
            <button key={s.k} onClick={() => setShape(s.k)}
              className={`h-10 rounded-md text-xs font-mono transition-colors flex flex-col items-center justify-center ${
                shape === s.k ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-700 hover:border-slate-400"
              }`}
              data-testid={`shape-${s.k}`}
            >
              <span className="text-base leading-none">{s.label}</span>
              <span className="text-[9px] uppercase tracking-widest mt-0.5">{s.name}</span>
            </button>
          ))}
        </div>
        {shape !== "rectangle" && scene.shape?.notch && (
          <NotchEditor scene={scene} onChange={onChange} />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Width (m)" hint="X-axis"
          value={scene.width} min={1.5} max={10} step={0.1}
          onChange={(v) => onChange({ width: v })}
          testId="room-width"
        />
        <NumberField
          label="Depth (m)" hint="Y-axis"
          value={scene.depth} min={1.5} max={10} step={0.1}
          onChange={(v) => onChange({ depth: v })}
          testId="room-depth"
        />
        <NumberField
          label="Ceiling (m)" hint="Vertical clearance"
          value={scene.ceiling_h || 2.7} min={2.2} max={4.0} step={0.05}
          onChange={(v) => onChange({ ceiling_h: v })}
          testId="room-ceiling"
        />
        <div className="flex flex-col justify-end">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-400 mb-1">Floor area</div>
          <div className="font-mono text-xs text-slate-800 tabular-nums" data-testid="room-area">
            {(() => {
              const base = scene.width * scene.depth;
              const n = scene.shape?.notch;
              const cut = n ? (n.w * n.d) : 0;
              return `${(base - cut).toFixed(1)} m²`;
            })()}
          </div>
        </div>
      </div>
      <div className="mt-4 p-2.5 rounded-lg bg-slate-50 border border-slate-200">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500 mb-0.5">Tip</div>
        <div className="text-[11px] text-slate-600 leading-relaxed">
          Click any item to edit its rotation, elevation and height. Click empty space or press Esc to deselect.
        </div>
      </div>

      {/* Partition tools — draw an interior IPS wall or drop a preset.
          Every partition here counts as a valid mount surface for
          wall-mounted components. */}
      {onAddPreset && (
        <div className="mt-5">
          <div className="flex items-center gap-2 mb-2">
            <Ruler className="w-3.5 h-3.5 text-slate-500" strokeWidth={1.75} />
            <div className="font-display text-[13px] font-semibold text-slate-900">Interior partitions</div>
          </div>
          <div className="text-[11px] text-slate-500 mb-3 leading-relaxed">
            IPS / GBC sanitary walls that wall-mount components can hang on. Draw one by click-click on the 2D plan, or drop a preset.
          </div>
          <button onClick={() => onEditorModeChange(editorMode === "partition" ? "select" : "partition")}
                  data-testid="partition-tool-side"
                  className={`w-full h-9 rounded-lg text-xs font-medium border transition-colors ${
                    editorMode === "partition"
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-800 border-slate-200 hover:border-slate-400"
                  }`}>
            {editorMode === "partition" ? "Click end point on plan · Esc to cancel" : "Draw partition"}
          </button>
          <div className="mt-3 grid grid-cols-3 gap-1.5" data-testid="partition-presets-side">
            {[
              { k: "horizontal", label: "Spine",  glyph: "─" },
              { k: "T",          label: "T",      glyph: "⊤" },
              { k: "U",          label: "U",      glyph: "∪" },
              { k: "L",          label: "L",      glyph: "⌐" },
              { k: "cross",      label: "Cross",  glyph: "✚" },
            ].map((p) => (
              <button key={p.k} onClick={() => onAddPreset(p.k)}
                      data-testid={`partition-preset-side-${p.k}`}
                      className="h-11 rounded-md bg-white border border-slate-200 text-slate-700 hover:border-slate-400 hover:bg-slate-50 flex flex-col items-center justify-center transition-colors">
                <span className="text-sm leading-none">{p.glyph}</span>
                <span className="text-[9px] uppercase tracking-widest mt-1">{p.label}</span>
              </button>
            ))}
          </div>
          {/* Live list of placed partitions with a delete handle */}
          {(scene.partitions || []).length > 0 && (
            <div className="mt-3">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500 mb-1">
                Placed · {(scene.partitions || []).length}
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
                {(scene.partitions || []).map((p, i) => {
                  const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
                  const orientation = Math.abs(p.y2 - p.y1) < 0.05 ? "horizontal" : "vertical";
                  return (
                    <div key={p.id} className="flex items-center justify-between text-[11px] text-slate-700 bg-white border border-slate-100 rounded px-2 py-1.5"
                         data-testid={`partition-row-${p.id}`}>
                      <span className="font-mono">
                        #{i + 1} · {orientation} · {len.toFixed(2)} m
                      </span>
                      <button onClick={() => onRemovePartition(p.id)}
                              data-testid={`partition-delete-${p.id}`}
                              className="text-[10px] uppercase tracking-widest text-[#FF3B30] hover:text-[#D9291F]">
                        remove
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotchEditor({ scene, onChange }) {
  const n = scene.shape.notch;
  const setNotch = (patch) => onChange({ shape: { ...scene.shape, notch: { ...n, ...patch } } });
  return (
    <div className="mt-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200" data-testid="notch-editor">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500 mb-2">Cutout</div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Cutout X" value={n.x} min={0} max={scene.width - 0.1} step={0.1}
          onChange={(v) => setNotch({ x: v })} testId="notch-x" />
        <NumberField label="Cutout Y" value={n.y} min={0} max={scene.depth - 0.1} step={0.1}
          onChange={(v) => setNotch({ y: v })} testId="notch-y" />
        <NumberField label="Cutout W" value={n.w} min={0.2} max={scene.width} step={0.1}
          onChange={(v) => setNotch({ w: v })} testId="notch-w" />
        <NumberField label="Cutout D" value={n.d} min={0.2} max={scene.depth} step={0.1}
          onChange={(v) => setNotch({ d: v })} testId="notch-d" />
      </div>
    </div>
  );
}

function TierChip({ label, count, tier }) {
  const cls = TIER[tier].cls;
  return (
    <div className={`px-2 py-1 rounded-lg border ${cls}`}>
      <div className="font-mono text-[9px] uppercase tracking-widest opacity-80">{label}</div>
      <div className="font-display text-base font-semibold tabular-nums">{count}</div>
    </div>
  );
}

/* Live presence — one avatar chip per peer, plus a "live" dot when connected. */
function PresenceChips({ peers, connected, followId, onFollowToggle }) {
  const [peekId, setPeekId] = useState(null);
  const max = 5;
  const visible = peers.slice(0, max);
  const overflow = Math.max(0, peers.length - max);
  return (
    <div className="ml-3 flex items-center gap-1.5 relative" data-testid="presence-chips" title={connected ? "Live" : "Reconnecting…"}>
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[#34C759]" : "bg-[#FF9500]"}`} />
      <div className="flex -space-x-1.5">
        {visible.map((p) => {
          const isFollowed = followId === p.conn_id;
          const bgColor = peerColor(p.email || p.id);
          return (
            <div key={p.conn_id} className="relative"
                 onMouseEnter={() => setPeekId(p.conn_id)}
                 onMouseLeave={() => setPeekId(null)}>
              <button
                onClick={() => onFollowToggle && onFollowToggle(isFollowed ? null : p.conn_id)}
                title={isFollowed ? "Following — click to stop" : "Click to follow their view"}
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white shadow-sm transition-transform hover:scale-110 overflow-hidden ${
                  isFollowed ? "border-2 border-amber-400 ring-2 ring-amber-200" : "border-2 border-white"
                }`}
                style={{ background: bgColor }}
                data-testid={`peer-${p.conn_id}`}>
                {p.avatar_url
                  ? <img src={`${process.env.REACT_APP_BACKEND_URL}${p.avatar_url}`} alt="" className="w-full h-full object-cover" />
                  : initials(p.name || p.email)}
              </button>
              {peekId === p.conn_id && (
                <div className="absolute top-8 left-1/2 -translate-x-1/2 z-[9999] w-64 bg-white rounded-xl shadow-2xl border border-black/5 p-3"
                     data-testid={`peer-peek-${p.conn_id}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {p.avatar_url
                      ? <img src={`${process.env.REACT_APP_BACKEND_URL}${p.avatar_url}`} alt=""
                             className="w-10 h-10 rounded-full object-cover" />
                      : <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-xs font-semibold"
                             style={{ background: bgColor }}>{initials(p.name || p.email)}</div>}
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold truncate">{p.name || "Guest"}</div>
                      <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 truncate">
                        {p.role || "member"}{p.organization ? ` · ${p.organization}` : ""}
                      </div>
                    </div>
                  </div>
                  {p.discipline && <div className="text-[11px] text-slate-600 mb-1">{p.discipline}</div>}
                  {p.email && !p.email.startsWith("guest+") && <div className="text-[11px] text-slate-500 truncate">{p.email}</div>}
                  {p.bio && <div className="mt-2 text-[11px] text-slate-600 leading-snug italic">"{p.bio}"</div>}
                  <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between">
                    <span className={`text-[9px] font-mono uppercase tracking-widest ${isFollowed ? "text-amber-600" : "text-slate-400"}`}>
                      {isFollowed ? "Following now" : "Click chip to follow"}
                    </span>
                    {p.view && <span className="text-[9px] font-mono uppercase tracking-widest text-slate-400">view: {p.view}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {overflow > 0 && (
          <div className="w-6 h-6 rounded-full bg-[#F5F5F7] text-[#1D1D1F] text-[10px] font-semibold border-2 border-white flex items-center justify-center">
            +{overflow}
          </div>
        )}
      </div>
      {peers.length > 0 && (
        <span className="text-[10px] text-[#86868B] tracking-tight ml-1 hidden md:inline">
          {peers.length} other{peers.length === 1 ? "" : "s"} live
        </span>
      )}
      {followId && (
        <button
          onClick={() => onFollowToggle && onFollowToggle(null)}
          className="ml-2 text-[10px] font-mono uppercase tracking-widest bg-amber-100 text-amber-900 px-2 py-0.5 rounded-full hover:bg-amber-200"
          data-testid="follow-stop">
          Following · stop
        </button>
      )}
    </div>
  );
}



/* Data-sheet dropdown (PDF | Excel). Same URL prefix as REST for auth cookies. */
function IfcImportButton({ roomId, onImported }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const onPick = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (!confirm(`Import ${f.name}? This will REPLACE all items in the current scene.`)) {
      e.target.value = ""; return;
    }
    setBusy(true);
    try {
      const fd = new FormData(); fd.append("file", f);
      const r = await api.post(`/rooms/${roomId}/import.ifc`, fd,
        { headers: { "Content-Type": "multipart/form-data" } });
      alert(`Imported ${r.data.imported} items from IFC (scene v${r.data.scene_version}).`);
      onImported && await onImported();
    } catch (err) {
      alert(err?.response?.data?.detail || "Import failed.");
    } finally { setBusy(false); e.target.value = ""; }
  };
  return (
    <>
      <input ref={ref} type="file" accept=".ifc" hidden onChange={onPick}
             data-testid="import-ifc-input" />
      <Button variant="outline" size="sm" onClick={() => ref.current?.click()}
              disabled={busy} data-testid="import-ifc-btn"
              className="h-9 rounded-full">
        {busy ? "Importing…" : "Import CAD"}
      </Button>
    </>
  );
}




/*
 * Auto-Fix All preview modal. Fetches the diff from `/orient/preview`,
 * shows a side-by-side list of before → after (position + rotation) for
 * every orient-violating item, and lets the user apply the sweep in one
 * click. Individual items can be excluded via a checkbox before applying.
 */


function AutoFixDialog({ roomId, open, onClose, onApplied }) {
  const [diffs, setDiffs] = useState(null);
  const [excluded, setExcluded] = useState(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDiffs(null); setExcluded(new Set());
    api.post(`/rooms/${roomId}/orient/preview`, {})
      .then((r) => setDiffs(r.data.diffs))
      .catch((e) => toast.error(e.response?.data?.detail || "Preview failed"));
  }, [open, roomId]);

  const toggle = (id) => {
    setExcluded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const apply = async () => {
    if (!diffs) return;
    const ids = diffs.filter((d) => !excluded.has(d.item_id)).map((d) => d.item_id);
    if (!ids.length) { toast.error("Nothing selected"); return; }
    setBusy(true);
    try {
      const r = await api.post(`/rooms/${roomId}/orient/apply`, { item_ids: ids });
      toast.success(`Snapped ${r.data.snapped} component(s) to walls`);
      onApplied && onApplied();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Apply failed");
    }
    setBusy(false);
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[9998] bg-black/50 backdrop-blur-sm flex items-start justify-center px-4 py-8 overflow-y-auto"
         data-testid="auto-fix-modal">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl p-6 my-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-[#0071E3]" />
            <div className="font-display text-lg font-semibold">Auto-fix orientation</div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-1"><X className="w-4 h-4" /></button>
        </div>
        <div className="text-[13px] text-[#86868B] mb-4 leading-relaxed">
          Snap every orient-violating component to its nearest valid wall or partition and rotate its working face into the room. Review the diff, un-check anything you want to leave alone, then apply.
        </div>

        {diffs === null && <div className="py-10 text-center text-xs font-mono uppercase tracking-widest text-slate-500">Computing…</div>}
        {diffs && diffs.length === 0 && (
          <div className="py-10 text-center">
            <div className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center mb-2"><Check className="w-5 h-5" /></div>
            <div className="text-sm text-slate-800 font-medium">Nothing to fix</div>
            <div className="text-xs text-slate-500 mt-1">Every wall / against-wall component is already flush and correctly rotated.</div>
          </div>
        )}
        {diffs && diffs.length > 0 && (
          <>
            <div className="space-y-2 max-h-[52vh] overflow-y-auto pr-1">
              {diffs.map((d) => {
                const off = excluded.has(d.item_id);
                return (
                  <div key={d.item_id}
                       className={`p-3 rounded-lg border ${off ? "border-slate-100 bg-slate-50 opacity-50" : "border-slate-200 bg-white"}`}
                       data-testid={`diff-${d.item_id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-700">{d.component_name}</div>
                          <div className="font-mono text-[10px] tracking-widest text-slate-400">→ {d.wall}</div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-3 text-[11px] font-mono">
                          <div className="text-slate-500">
                            <span className="text-slate-400">before</span> ({d.before.x.toFixed(2)}, {d.before.y.toFixed(2)}) @ {d.before.rotation}°
                          </div>
                          <div className="text-emerald-700">
                            <span className="text-slate-400">after</span> ({d.after.x.toFixed(2)}, {d.after.y.toFixed(2)}) @ {d.after.rotation}°
                          </div>
                        </div>
                      </div>
                      <button onClick={() => toggle(d.item_id)}
                              className={`text-[10px] uppercase tracking-widest px-2 h-6 rounded-full border ${off ? "border-slate-300 text-slate-500" : "border-slate-900 text-slate-900"}`}
                              data-testid={`toggle-${d.item_id}`}>
                        {off ? "Skip" : "Fix"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex items-center justify-between">
              <div className="text-xs text-slate-500">
                {diffs.length - excluded.size} of {diffs.length} will be snapped
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={onClose} className="h-9 rounded-full">Cancel</Button>
                <Button size="sm" onClick={apply} disabled={busy || (diffs.length - excluded.size) === 0}
                        className="h-9 rounded-full bg-slate-900 hover:bg-slate-800 text-white"
                        data-testid="apply-autofix">
                  {busy ? "Applying…" : "Apply snap"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


function ValidateMenu({ busy, onValidate, onCompliance, onCompare }) {
  const item = (testid, Icon, title, hint, fn) => (
    <DropdownMenuItem onClick={fn} data-testid={testid} className="items-start gap-2.5 py-2.5">
      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] text-[#86868B] leading-snug">{hint}</div>
      </div>
    </DropdownMenuItem>
  );
  return (
    <div className="flex items-center">
      <Button variant="outline" size="sm" onClick={onValidate} data-testid="run-validation"
        className="h-9 rounded-l-full rounded-r-none pr-2.5" title="Run validation against the room's standard">
        {busy ? <Sparkles className="w-3 h-3 mr-1.5 animate-pulse" /> : <Play className="w-3 h-3 mr-1.5" />}
        {busy ? "Working…" : "Validate"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 rounded-r-full rounded-l-none px-2 border-l-0"
            data-testid="validate-menu-btn" title="Compliance and compare">
            <ChevronDown className="w-3.5 h-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72" data-testid="validate-menu">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.24em] text-[#86868B]">Check this room</DropdownMenuLabel>
          {item("validate-menu-run", Play, "1 · Run validation", "Checks rules, clearances and zones", onValidate)}
          {item("compliance-btn", Sparkles, "2 · Compliance suggestions", "Advisory fixes for failed checks — you review each one", busy ? undefined : onCompliance)}
          <DropdownMenuSeparator />
          {item("compare-btn", Columns2, "Compare with a standard", "Overlay HBN / NHP / Revit references and switch between them", onCompare)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ExportMenu({ roomId, onRender, onShare }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef(null);
  /* Capture the 2D plan (SVG) and the 3D isometric (WebGL canvas) as
     PNGs so they can be embedded in the exported PDF with callouts. */
  const capturePlanPng = async () => {
    // 2D is an inline <svg data-testid="room-2d-svg">. Serialise and
    // rasterise it via an Image → offscreen canvas. Colour fills survive
    // because they're inline attributes, not external CSS.
    const svg = document.querySelector('[data-testid="room-2d-svg"]') || document.querySelector("main svg");
    if (!svg) return null;
    const xml = new XMLSerializer().serializeToString(svg);
    const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cvs = document.createElement("canvas");
        // Bump the resolution 2× so the embedded PNG holds up in print.
        cvs.width = img.width * 2; cvs.height = img.height * 2;
        const ctx = cvs.getContext("2d");
        ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, cvs.width, cvs.height);
        ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
        resolve(cvs.toDataURL("image/png"));
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  };
  const captureIsoPng = () => {
    // Three.js renders on the FIRST <canvas> under the 3D pane. Screenshot
    // it directly — the renderer keeps its backbuffer around because of
    // `preserveDrawingBuffer` on the Canvas.
    const cvs = document.querySelector('[data-testid="room-3d-canvas"] canvas')
             || document.querySelectorAll("canvas")[0];
    if (!cvs) return null;
    try { return cvs.toDataURL("image/png"); } catch { return null; }
  };
  const exportPdf = async () => {
    setOpen(false);
    setBusy(true);
    const t = toast.loading("Preparing PDF (2D + 3D + callouts)…");
    try {
      const [plan, iso] = await Promise.all([capturePlanPng(), Promise.resolve(captureIsoPng())]);
      const r = await api.post(`/rooms/${roomId}/data-sheet.pdf`,
                               { plan_png_b64: plan, iso_png_b64: iso },
                               { responseType: "blob" });
      const cd = r.headers?.["content-disposition"] || "";
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
      saveBlob(r.data, m ? decodeURIComponent(m[1]) : brandedName("Room", "data-sheet", "pdf"));
      toast.success("PDF downloaded", { id: t });
    } catch (e) {
      toast.error(e.response?.data?.detail || "PDF export failed", { id: t });
    }
    setBusy(false);
  };
  const dlXlsx = () => {
    setOpen(false);
    downloadExport(`/rooms/${roomId}/data-sheet.xlsx`, { fallbackName: brandedName("Room", "data-sheet", "xlsx") })
      .catch(() => toast.error("Excel export failed"));
  };
  const openIfc = () => {
    setOpen(false);
    downloadExport(`/rooms/${roomId}/export.ifc`, { fallbackName: brandedName("Room", "", "ifc") })
      .catch(() => toast.error("IFC export failed"));
  };
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    setOpen(true);
  };
  return (
    <>
      <Button size="sm"
              ref={btnRef}
              onClick={toggle}
              disabled={busy}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              data-testid="export-btn"
              className="h-9 rounded-full bg-slate-900 hover:bg-slate-800 text-white">
        <Share2 className="w-3 h-3 mr-1.5" /> {busy ? "Exporting…" : "Share & Export"}
      </Button>
      {open && pos && createPortal(
        <div className="fixed w-60 bg-white rounded-xl border border-black/5 shadow-[0_10px_32px_rgba(0,0,0,0.14)] py-1"
             style={{ top: pos.top, right: pos.right, zIndex: 100000 }}
             data-testid="export-menu"
             onMouseDown={(e) => e.stopPropagation()}>
          <div className="px-3 py-1 text-[9px] uppercase tracking-[0.2em] text-slate-400 font-mono">Share</div>
          <button onMouseDown={() => { setOpen(false); onShare(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F] flex items-start gap-2"
                  data-testid="open-share-panel">
            <UserPlus className="w-3 h-3 mt-0.5" />
            <div>
              <div>Share with people</div>
              <div className="text-[10px] text-[#86868B]">Invite co-designers, set who can edit</div>
            </div>
          </button>
          <button onMouseDown={() => { setOpen(false); onRender(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F] flex items-start gap-2"
                  data-testid="publish-render-btn">
            <Sparkles className="w-3 h-3 mt-0.5" />
            <div>
              <div>Publish render</div>
              <div className="text-[10px] text-[#86868B]">Snapshot this version for the team · opens 3D / AI render</div>
            </div>
          </button>
          <div className="h-px bg-black/5 my-1" />
          <div className="px-3 py-1 text-[9px] uppercase tracking-[0.2em] text-slate-400 font-mono">Data sheet</div>
          <button onMouseDown={exportPdf}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F] flex items-start gap-2"
                  data-testid="export-pdf">
            <FileText className="w-3 h-3 mt-0.5" />
            <div>
              <div>PDF with plans</div>
              <div className="text-[10px] text-[#86868B]">2D + 3D + numbered callouts</div>
            </div>
          </button>
          <button onMouseDown={dlXlsx}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F] flex items-center gap-2"
                  data-testid="export-xlsx">
            <FileText className="w-3 h-3" />
            <span>Excel (.xlsx)</span>
          </button>
          <div className="h-px bg-black/5 my-1" />
          <button onMouseDown={openIfc}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F] flex items-center gap-2"
                  data-testid="export-ifc">
            <FileText className="w-3 h-3" />
            <span>CAD / Revit (.ifc)</span>
          </button>
        </div>,
        document.body
      )}
    </>
  );
}

function DataSheetDropdown({ roomId }) {
  const [open, setOpen] = useState(false);
  const download = (ext) => {
    setOpen(false);
    downloadExport(`/rooms/${roomId}/data-sheet.${ext}`, { fallbackName: brandedName("Room", "data-sheet", ext) })
      .catch(() => toast.error("Export failed"));
  };
  return (
    <div className="relative">
      <Button variant="outline" size="sm"
              onClick={() => setOpen((o) => !o)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              data-testid="export-datasheet"
              className="h-9 rounded-full"
              title="Export a Room Data Sheet">
        <FileText className="w-3 h-3 mr-1.5" /> Data sheet
      </Button>
      {open && (
        <div className="absolute right-0 top-10 w-40 bg-white rounded-xl border border-black/5 shadow-[0_10px_32px_rgba(0,0,0,0.14)] py-1 z-50"
             data-testid="datasheet-menu">
          <button onMouseDown={() => download("pdf")}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F]"
                  data-testid="dl-pdf">
            <FileText className="w-3 h-3 mr-1.5 inline" /> PDF
          </button>
          <button onMouseDown={() => download("xlsx")}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F]"
                  data-testid="dl-xlsx">
            <FileText className="w-3 h-3 mr-1.5 inline" /> Excel (.xlsx)
          </button>
          <div className="h-px bg-black/5 my-1" />
          <button onMouseDown={() => {
                    setOpen(false);
                    downloadExport(`/rooms/${roomId}/export.ifc`, { fallbackName: brandedName("Room", "", "ifc") })
                      .catch(() => toast.error("IFC export failed"));
                  }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F]"
                  data-testid="dl-ifc">
            <FileText className="w-3 h-3 mr-1.5 inline" /> CAD / Revit (.ifc)
          </button>
        </div>
      )}
    </div>
  );
}

/* Decision log with keyword + author + date-range filters and manual note entry.
   Auto-events (edits, validation runs, renders) show below in a separate track. */
function DecisionLog({ roomId, user, changelog, onClearChangelog }) {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [author, setAuthor] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", note: "" });

  const load = React.useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (author) params.set("author", author);
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    const r = await api.get(`/rooms/${roomId}/decisions?${params.toString()}`);
    setItems(r.data || []);
  }, [roomId, q, author, since, until]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.title.trim()) { toast.error("Title required"); return; }
    try {
      await api.post(`/rooms/${roomId}/decisions`, { title: form.title, note: form.note });
      setForm({ title: "", note: "" }); setAdding(false);
      toast.success("Decision logged");
      load();
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };

  const remove = async (id) => {
    try {
      await api.delete(`/rooms/${roomId}/decisions/${id}`);
      setItems((prev) => prev.filter((d) => d.id !== id));
    } catch (e) { toast.error(e.response?.data?.detail || "Delete failed"); }
  };

  const KIND_TINT = {
    decision: "bg-[#0071E3]",
    note: "bg-[#8E8E93]",
    derogation: "bg-[#FF9500]",
    render: "bg-[#AF52DE]",
    edit: "bg-slate-900",
  };

  return (
    <ScrollArea className="h-full px-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Decision log</div>
          <div className="text-[10px] text-slate-400 mt-0.5">Dated · authored · scoped to this room</div>
        </div>
        <button onClick={() => setAdding((a) => !a)}
                className="text-[10px] font-mono uppercase tracking-widest text-[#0071E3] hover:text-[#0077ED]"
                data-testid="add-decision">+ add</button>
      </div>

      {adding && (
        <div className="p-3 rounded-xl border border-black/10 bg-white mb-3 space-y-2">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                 placeholder="Decision title" className="h-9 rounded-lg" data-testid="dec-title" />
          <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
                    placeholder="Note (optional)" rows={2}
                    className="w-full text-xs rounded-lg border border-black/10 p-2 bg-white" data-testid="dec-note" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="text-[10px] uppercase tracking-widest text-slate-500">Cancel</button>
            <button onClick={create} className="text-[10px] uppercase tracking-widest text-[#0071E3] font-semibold" data-testid="dec-save">Save</button>
          </div>
        </div>
      )}

      <div className="space-y-2 mb-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="Search title or note" className="h-8 rounded-lg text-xs" data-testid="dec-q" />
        <Input value={author} onChange={(e) => setAuthor(e.target.value)}
               placeholder="Author (email)" className="h-8 rounded-lg text-xs" data-testid="dec-author" />
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" value={since?.slice(0,10)} onChange={(e) => setSince(e.target.value ? e.target.value + "T00:00:00Z" : "")}
                 className="h-8 rounded-lg text-xs" data-testid="dec-since" />
          <Input type="date" value={until?.slice(0,10)} onChange={(e) => setUntil(e.target.value ? e.target.value + "T23:59:59Z" : "")}
                 className="h-8 rounded-lg text-xs" data-testid="dec-until" />
        </div>
      </div>

      <div className="relative pl-4 border-l border-slate-200">
        {items.map((d) => (
          <div key={d.id} className="mb-4 relative" data-testid={`dec-${d.id}`}>
            <div className={`absolute -left-[21px] top-1.5 w-2 h-2 rounded-full ${KIND_TINT[d.kind] || "bg-slate-900"}`} />
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-slate-900 font-medium">{d.title}</div>
                {d.note && <div className="text-xs text-slate-700 mt-0.5 leading-relaxed">{d.note}</div>}
                <div className="font-mono text-[10px] text-slate-500 mt-1">
                  {new Date(d.created_at).toLocaleString()} · {d.author} · {d.author_role || "—"} · {d.kind}
                </div>
              </div>
              {(d.author === user?.email || ["reviewer","admin"].includes(user?.role)) && (
                <button onClick={() => remove(d.id)} className="text-slate-400 hover:text-red-600 shrink-0"
                        data-testid={`dec-del-${d.id}`}>
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="text-xs text-slate-400 font-mono">No decisions yet.</div>}
      </div>

      {changelog.length > 0 && (
        <>
          <div className="mt-6 mb-2 flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Auto-events</div>
            <button onClick={onClearChangelog} className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500 hover:text-red-600"
                    data-testid="clear-changelog">
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          </div>
          <div className="relative pl-4 border-l border-slate-200">
            {changelog.slice(0, 40).map((c) => (
              <div key={c.id} className="mb-3 relative">
                <div className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-slate-300" />
                <div className="text-xs text-slate-700">{c.delta_summary}</div>
                <div className="font-mono text-[10px] text-slate-500 mt-0.5">
                  {new Date(c.timestamp).toLocaleString()} · {c.author}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </ScrollArea>
  );
}

/* Request a derogation on a failing flag. Any user can submit; a reviewer /
   admin approves via `PATCH /rooms/{room}/derogations/{id}`. */
function DerogationDialog({ roomId, flag, onClose, onDone }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (flag) setText(""); }, [flag]);
  if (!flag) return null;
  const submit = async () => {
    if (text.trim().length < 8) { toast.error("Justification must be at least 8 characters."); return; }
    setBusy(true);
    try {
      await api.post(`/rooms/${roomId}/derogations`, {
        rule_id: flag.rule_id,
        justification: text.trim(),
        item_id: flag.location?.item_id || null,
      });
      onDone && onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to submit derogation");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onClick={onClose}
         data-testid="derog-modal">
      <div className="bg-white rounded-2xl w-[520px] max-w-[90vw] shadow-[0_20px_60px_rgba(0,0,0,0.25)] p-6"
           onClick={(e) => e.stopPropagation()}>
        <div className="text-[11px] uppercase tracking-[0.22em] text-[#B87A2B] font-medium mb-1">
          Derogation · request
        </div>
        <div className="font-display text-2xl font-semibold tracking-tight text-[#1D1D1F]">
          Bypass {flag.rule_id}?
        </div>
        <div className="mt-2 text-sm text-[#1D1D1F]/70 leading-relaxed">{flag.message}</div>
        {flag.source && (
          <div className="mt-1 text-xs text-[#86868B] font-mono">↳ {flag.source}</div>
        )}
        <div className="mt-4 p-3 rounded-xl bg-[#FFF4E5] text-xs text-[#B87A2B] leading-relaxed">
          A derogation bypasses this guideline for this room only. Reviewers or admins
          must approve before the flag is treated as resolved. Please justify why the
          guideline should not apply here.
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="Justification (e.g. HVAC upgrade planned Q4, interim 5 ACH agreed with Trust engineering)"
                  className="mt-3 w-full h-28 rounded-xl border border-black/10 p-3 text-sm bg-white focus:outline-none focus:border-[#0071E3]/40"
                  data-testid="derog-justification" />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="h-9 px-4 rounded-full text-sm text-[#1D1D1F] hover:bg-[#F5F5F7]"
                  data-testid="derog-cancel">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="h-9 px-5 rounded-full text-sm font-medium bg-[#B87A2B] hover:bg-[#8A5A20] text-white disabled:opacity-60"
                  data-testid="derog-submit">
            {busy ? "Submitting…" : "Submit for approval"}
          </button>
        </div>
      </div>
    </div>
  );
}


/* Room password gate — shown when the room is locked and the current
   browser session hasn't already verified. Cancel returns to dashboard.
*/
function RoomLockPrompt({ open, roomId, onCancel, onSuccess }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!open) return null;
  const submit = async (e) => {
    e?.preventDefault?.();
    if (!pw) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/rooms/${roomId}/lock/verify`, { password: pw });
      onSuccess && onSuccess();
    } catch (e2) {
      setErr(e2?.response?.status === 401 ? "Wrong password." : "Could not verify.");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm flex items-center justify-center px-4"
         data-testid="room-lock-prompt">
      <form onSubmit={submit}
            className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <Lock className="w-4 h-4 text-amber-600" />
          <div className="font-display text-lg font-semibold">Room is locked</div>
        </div>
        <p className="text-sm text-slate-600 mb-4">
          The person who set up this session added a password. Enter it to join.
        </p>
        <Input type="password" autoFocus value={pw}
               onChange={(e) => setPw(e.target.value)}
               placeholder="Room password"
               data-testid="lock-prompt-input"
               className="rounded-xl" />
        {err && <div className="mt-2 text-xs text-rose-600">{err}</div>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm"
                  onClick={onCancel} data-testid="lock-prompt-cancel"
                  className="h-9 rounded-full">
            Back to estate
          </Button>
          <Button type="submit" size="sm" disabled={busy || !pw}
                  data-testid="lock-prompt-submit"
                  className="h-9 rounded-full bg-slate-900 hover:bg-slate-800 text-white">
            {busy ? "Verifying…" : "Enter"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/* Lock management modal — set / clear the room password. */
function RoomLockManage({ open, roomId, locked, onClose, onChanged }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { if (!open) { setPw(""); setPw2(""); setErr(null); } }, [open]);
  if (!open) return null;

  const setLock = async (e) => {
    e?.preventDefault?.();
    if (pw.length < 4) { setErr("Password must be at least 4 characters."); return; }
    if (pw !== pw2)    { setErr("Passwords don't match.");                  return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/rooms/${roomId}/lock`, { password: pw });
      onChanged && onChanged({ locked: true, set_by: r.data?.set_by });
      onClose && onClose();
    } catch (e2) {
      setErr(e2?.response?.data?.detail || "Could not set the password.");
    } finally { setBusy(false); }
  };
  const clearLock = async () => {
    setBusy(true); setErr(null);
    try {
      await api.delete(`/rooms/${roomId}/lock`);
      onChanged && onChanged({ locked: false });
      onClose && onClose();
    } catch (e2) {
      setErr("Could not clear the password.");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[9998] bg-black/50 backdrop-blur-sm flex items-center justify-center px-4"
         data-testid="room-lock-manage">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          {locked ? <Lock className="w-4 h-4 text-amber-600" /> : <Unlock className="w-4 h-4 text-slate-500" />}
          <div className="font-display text-lg font-semibold">
            {locked ? "Room password" : "Add a room password"}
          </div>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Optional. When set, anyone joining this room is prompted once per browser session before they can see the layout.
        </p>
        {!locked ? (
          <form onSubmit={setLock} className="space-y-3">
            <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)}
                   placeholder="Choose a password (min 4 characters)"
                   className="rounded-xl" data-testid="lock-manage-pw" />
            <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)}
                   placeholder="Confirm password"
                   className="rounded-xl" data-testid="lock-manage-pw2" />
            {err && <div className="text-xs text-rose-600">{err}</div>}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}
                      className="h-9 rounded-full">Cancel</Button>
              <Button type="submit" size="sm" disabled={busy || !pw || !pw2}
                      data-testid="lock-manage-set"
                      className="h-9 rounded-full bg-slate-900 hover:bg-slate-800 text-white">
                {busy ? "Setting…" : "Lock room"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-slate-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              This room is currently locked. Peers you invite will need the password to join.
              Share it out-of-band (e.g. secure message).
            </div>
            {err && <div className="text-xs text-rose-600">{err}</div>}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}
                      className="h-9 rounded-full">Close</Button>
              <Button type="button" size="sm" disabled={busy}
                      onClick={clearLock}
                      data-testid="lock-manage-clear"
                      className="h-9 rounded-full bg-rose-600 hover:bg-rose-700 text-white">
                {busy ? "Clearing…" : "Remove lock"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


const INVITE_ROLES = [
  { v: "architect", label: "Architect" },
  { v: "ipc",       label: "IPC lead" },
  { v: "engineer",  label: "Engineer" },
  { v: "clinician", label: "Clinician" },
  { v: "viewer",    label: "Viewer (read-only)" },
];

const TTL_OPTIONS = [
  { v: 24,  label: "24 hours" },
  { v: 168, label: "7 days" },
  { v: 720, label: "30 days" },
];

/* Invite people to the current Room / its parent Building / the whole
   Estate. Generates a shareable link with a token and a chosen role. */
function InviteModal({ open, roomId, node, onClose }) {
  const [scope, setScope] = useState("room");
  const [role, setRole] = useState("viewer");
  const [ttl, setTtl] = useState(168);
  const [note, setNote] = useState("");
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [existing, setExisting] = useState([]);

  // Resolve the scope_id for the chosen scope from the current room's node.
  const scopeId =
    scope === "room"     ? roomId :
    scope === "building" ? (node?.parent_id || node?.building_id || null) :
                           null;

  const scopeLabel =
    scope === "room"     ? (node?.name || "this room") :
    scope === "building" ? (node?.parent_name || "parent building") :
                           "the whole estate";

  useEffect(() => {
    if (!open) return;
    setInvite(null); setErr(null); setCopied(false);
    // Fetch invites this user has created for the current selected scope
    api.get("/invites", { params: { scope, scope_id: scopeId || undefined } })
      .then((r) => setExisting(r.data || []))
      .catch(() => setExisting([]));
  }, [open, scope, scopeId]);

  const generate = async (e) => {
    e?.preventDefault?.();
    if (scope !== "estate" && !scopeId) {
      setErr(`Cannot resolve ${scope} id for the current room.`);
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await api.post("/invites", {
        scope, scope_id: scopeId,
        role, ttl_hours: ttl,
        note: note || undefined,
      });
      setInvite(r.data);
      setExisting((prev) => [r.data, ...prev]);
    } catch (e2) {
      setErr(e2?.response?.data?.detail || "Could not create invite.");
    } finally { setBusy(false); }
  };

  const revoke = async (id) => {
    try {
      await api.delete(`/invites/${id}`);
      setExisting((prev) => prev.filter((i) => i.id !== id));
      if (invite?.id === id) setInvite(null);
    } catch {}
  };

  const inviteUrl = invite
    ? `${window.location.origin}/accept-invite?token=${invite.token}`
    : "";

  const copyLink = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      toast.success("Invite link copied");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Copy blocked by the browser — select and copy manually");
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9998] bg-black/50 backdrop-blur-sm flex items-center justify-center px-4"
         data-testid="invite-modal">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl p-6 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center gap-2 mb-1">
          <UserPlus className="w-4 h-4 text-sky-600" />
          <div className="font-display text-lg font-semibold">Invite collaborators</div>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Generate a shareable link. Anyone who opens it can join {scopeLabel} with the role you choose.
        </p>

        {/* Scope picker */}
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {[
            { v: "room",     label: "This room",   ok: !!roomId },
            { v: "building", label: "Building",    ok: !!node?.parent_id },
            { v: "estate",   label: "Whole estate", ok: true },
          ].map((s) => (
            <button key={s.v} disabled={!s.ok}
              onClick={() => setScope(s.v)}
              data-testid={`invite-scope-${s.v}`}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                scope === s.v
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-700 border-slate-200 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
              }`}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-medium">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}
                    data-testid="invite-role"
                    className="mt-1 w-full h-9 px-2 rounded-md border border-slate-200 bg-white text-sm">
              {INVITE_ROLES.map((r) => (
                <option key={r.v} value={r.v}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-medium">Link expires in</label>
            <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}
                    data-testid="invite-ttl"
                    className="mt-1 w-full h-9 px-2 rounded-md border border-slate-200 bg-white text-sm">
              {TTL_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mb-3">
          <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-medium">Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="e.g. Draft sign-off for HDU Dirty Utility"
                 data-testid="invite-note"
                 className="mt-1 w-full h-9 px-3 rounded-md border border-slate-200 bg-white text-sm" />
        </div>

        {err && <div className="text-xs text-rose-600 mb-2">{err}</div>}

        {!invite ? (
          <Button onClick={generate} disabled={busy}
                  data-testid="invite-generate-btn"
                  className="w-full h-10 rounded-full bg-slate-900 hover:bg-slate-800 text-white">
            {busy ? "Generating…" : "Generate invite link"}
          </Button>
        ) : (
          <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3"
               data-testid="invite-generated">
            <div className="text-[10px] uppercase tracking-[0.2em] text-sky-800 font-medium mb-1.5">Invite link</div>
            <div className="flex items-center gap-2">
              <input readOnly value={inviteUrl}
                     onClick={(e) => e.target.select()}
                     data-testid="invite-url"
                     className="flex-1 h-9 px-2.5 rounded-md bg-white border border-sky-200 text-xs font-mono truncate" />
              <Button onClick={copyLink} size="sm"
                      data-testid="invite-copy-btn"
                      className={`h-9 rounded-full text-white ${copied ? "bg-emerald-600" : "bg-sky-700 hover:bg-sky-800"}`}>
                {copied ? <><Check className="w-3.5 h-3.5 mr-1.5" />Copied</>
                        : <><Copy  className="w-3.5 h-3.5 mr-1.5" />Copy</>}
              </Button>
            </div>
            <div className="mt-2 text-[11px] text-sky-900/70">
              Expires {new Date(invite.expires_at).toLocaleString()} · role: <span className="font-medium">{invite.role}</span>
            </div>
          </div>
        )}

        {existing.length > 0 && (
          <div className="mt-5">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-medium mb-2">
              Active invites for this {scope} · {existing.length}
            </div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {existing.map((i) => (
                <div key={i.id}
                     className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded-md bg-slate-50 border border-slate-200"
                     data-testid={`invite-row-${i.id}`}>
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] text-slate-700 truncate">
                      {i.token.slice(0, 8)}… · {i.role}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      exp {new Date(i.expires_at).toLocaleString()}
                      {i.accepted_by?.length ? ` · ${i.accepted_by.length} joined` : ""}
                    </div>
                  </div>
                  <button onClick={() => revoke(i.id)}
                          data-testid={`invite-revoke-${i.id}`}
                          className="text-rose-600 hover:text-rose-800 text-[11px] font-mono uppercase tracking-widest">
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={onClose}
                  className="h-9 rounded-full">Close</Button>
        </div>
      </div>
    </div>
  );
}

