import React, { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import EstatePresence, { RoomOccupancyChips } from "@/components/presence/EstatePresence";
import { useAuth } from "@/context/AuthContext";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { api } from "@/lib/apiClient";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { LogOut, Building2, DoorOpen, Layers, Boxes, BookOpen, Inbox, Plus, Search, ArrowRight, Trash2, Bell, User2, X as XIcon, Compass, ScrollText, CheckCircle2, AlertTriangle, Copy, FileUp, Pencil } from "lucide-react";
import { openTour } from "@/components/tour/TourController";
import { TERMS_VERSION, TERMS_DATE } from "@/components/legal/TermsModal";
import NewRoomDialog from "@/components/room/NewRoomDialog";
import IfcImportDialog from "@/components/room/IfcImportDialog";
import RoomNameDialog, { buildPlaces } from "@/components/room/RoomNameDialog";
import { PublishControl, PublishRequestsPanel } from "@/components/room/PublishControls";
import { Input } from "@/components/ui/input";
import { Wordmark } from "@/components/brand/Logo";

const NODE_ICON = {
  estate: Layers, building: Building2, zone: Boxes,
  ward: Boxes, room: DoorOpen, utility: DoorOpen, component: Boxes,
};

const RISK_TINT = { high: "text-[#FF3B30]", medium: "text-[#FF9500]", low: "text-[#34C759]" };
const TYPE_ORDER = ["utility", "room", "ward", "zone", "building", "estate"];
const TYPE_LABEL = {
  estate: "Estates", building: "Buildings", zone: "Zones",
  ward: "Wards", room: "Rooms", utility: "Utility rooms",
};

export default function Dashboard() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [nodes, setNodes] = useState([]);
  const [lastEdits, setLastEdits] = useState({});
  const [query, setQuery] = useState("");
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [showIfcImport, setShowIfcImport] = useState(false);

  const [naming, setNaming] = useState(null);
  const loadNodes = () => api.get("/hierarchy").then((r) => setNodes(r.data));
  const submitName = async (name, parentId) => {
    const { mode, node } = naming;
    try {
      if (mode === "rename") {
        await api.patch(`/rooms/${node.id}/name`, { name });
        toast.success("Room renamed");
        setNaming(null); await loadNodes();
        return;
      }
      const r = await api.post(`/rooms/${node.id}/clone`, { name, parent_id: parentId });
      toast.success(mode === "clone" ? "Template cloned into your estate" : "Room duplicated");
      setNaming(null); await loadNodes();
      if (mode === "clone") nav(`/room/${r.data.room.id}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Something went wrong");
    }
  };
  const loadLastEdits = () => api.get("/rooms/last-edits").then((r) => setLastEdits(r.data || {})).catch(() => {});
  useEffect(() => {
    loadNodes();
    loadLastEdits();
    // Refresh the "Last edited by" pills every 20s so returning users
    // see recent collaborator activity without a manual reload.
    const t = setInterval(loadLastEdits, 20000);
    return () => clearInterval(t);
  }, []);

  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);
  const places = useMemo(() => buildPlaces(nodes), [nodes]);
  const pathOf = (n) => {
    const p = []; let cur = n;
    while (cur) { p.unshift(cur); cur = cur.parent_id ? byId[cur.parent_id] : null; }
    return p;
  };
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (n) => !q || n.name.toLowerCase().includes(q) || (n.metadata?.code || "").toLowerCase().includes(q);
    const g = {};
    for (const t of TYPE_ORDER) g[t] = [];
    for (const n of nodes) if (g[n.type] && match(n)) g[n.type].push(n);
    return g;
  }, [nodes, query]);

  const totalMatches = Object.values(grouped).reduce((a, b) => a + b.length, 0);

  const [pendingDelete, setPendingDelete] = useState(null); // node or null
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.delete(`/rooms/${pendingDelete.id}`);
      setNodes((prev) => prev.filter((n) => n.id !== pendingDelete.id));
      toast.success(`Deleted ${pendingDelete.name}`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Delete failed");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <TopBar user={user} onLogout={logout} />
      <EstatePresence>
      <div className="max-w-7xl mx-auto px-8 pt-16 pb-24">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-12">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium">Estate</div>
            <h1 className="font-display text-5xl md:text-6xl font-semibold tracking-tighter text-[#1D1D1F] mt-2 leading-[1.05]">
              Your rooms.
            </h1>
            <div className="mt-3 text-base text-[#86868B]">
              {totalMatches} of {nodes.length} · tap any utility room to open the co-design canvas
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#86868B]" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder="Search"
                     className="pl-9 h-10 w-64 rounded-full bg-white border-black/10 text-sm"
                     data-testid="estate-search"/>
            </div>
            <button onClick={() => setShowNewRoom(true)}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-full hb-btn-primary text-xs font-medium"
              data-testid="new-room-btn">
              <Plus className="w-3.5 h-3.5" /> New room
            </button>
            <button onClick={() => setShowIfcImport(true)}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-full border border-slate-300 hover:border-slate-500 bg-white text-xs font-medium transition-colors"
              data-testid="import-ifc-room-btn">
              <FileUp className="w-3.5 h-3.5" /> Import IFC
            </button>
          </div>
        </div>

        {/* Shortcuts */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-16">
          <ShortcutCard testId="nav-knowledge" onClick={() => nav("/knowledge")}
            icon={BookOpen} label="Knowledge Base" sub="Rules · Components · Standards" />
          <ShortcutCard testId="nav-ingestion" onClick={() => nav("/knowledge?tab=ingest")}
            icon={Inbox} label="Add to Knowledge" sub="Extract · Submit · Review" />
          <ShortcutCard testId="nav-account" onClick={() => {}}
            icon={Layers} label={`${user?.role || "member"}`} sub={user?.email} />
        </div>

        {/* Card grid grouped by type */}
        <PublishRequestsPanel onChanged={loadNodes} />
        <div className="space-y-12">
          {TYPE_ORDER.map((t) => {
            const items = grouped[t] || [];
            if (items.length === 0) return null;
            return (
              <div key={t}>
                <div className="mb-5">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium">
                    {TYPE_LABEL[t]} · {items.length}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-5">
                  {items.map((n, i) => (
                    <NodeCard key={n.id} node={n} path={pathOf(n)} index={i}
                              lastEdit={lastEdits[n.id]}
                              onChanged={loadNodes}
                              onOpen={() => n.type === "utility" && !n.is_representation && !n.is_legacy ? nav(`/room/${n.id}`) : null}
                              onDelete={n.type === "utility" && !n.is_representation && !n.is_legacy && !n.published_view ? () => setPendingDelete(n) : null}
                              onClone={n.is_representation ? () => setNaming({ mode: "clone", node: n, name: `${n.name} — my copy` }) : null}
                              onDuplicate={n.type === "utility" && !n.is_representation && !n.is_legacy ? () => setNaming({ mode: "duplicate", node: n, name: `${n.name} (copy)` }) : null}
                              onRename={n.type === "utility" && !n.is_representation && !n.is_legacy && (n.owner_id === user?.id || user?.role === "admin") ? () => setNaming({ mode: "rename", node: n, name: n.name }) : null} />
                  ))}
                </div>
              </div>
            );
          })}
          {totalMatches === 0 && (
            <div className="text-base text-[#86868B] py-24 text-center">
              No matches. Try clearing the search.
            </div>
          )}
        </div>
      </div>
      <RoomNameDialog state={naming} places={places} onClose={() => setNaming(null)} onSubmit={submitName} />
      <AnimatePresence>
        {showNewRoom && (
          <NewRoomDialog
            onClose={() => setShowNewRoom(false)}
            onCreated={async (room) => {
              setShowNewRoom(false);
              await loadNodes();
              nav(`/room/${room.id}`);
            }}
          />
        )}
        {showIfcImport && (
          <IfcImportDialog
            onClose={() => setShowIfcImport(false)}
            onCreated={async (room) => {
              setShowIfcImport(false);
              await loadNodes();
              if (room) nav(`/room/${room.id}`);
            }}
          />
        )}
        {pendingDelete && (
          <ConfirmDelete
            node={pendingDelete}
            onCancel={() => setPendingDelete(null)}
            onConfirm={confirmDelete}
          />
        )}
      </AnimatePresence>
      </EstatePresence>
    </div>
  );
}

function ConfirmDelete({ node, onCancel, onConfirm }) {
  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onCancel}
      data-testid="confirm-delete">
      <motion.div initial={{y: 8, opacity: 0}} animate={{y: 0, opacity: 1}}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center">
            <Trash2 className="w-4 h-4" strokeWidth={1.75}/>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Delete room</div>
            <div className="font-display text-lg font-semibold tracking-tight">{node.name}</div>
          </div>
        </div>
        <p className="text-sm text-slate-600 leading-relaxed">
          This will permanently remove the room, its scene, validations, change log, and every published or AI-generated render. This action can not be undone.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="h-9 px-4 rounded-full border border-slate-300 bg-white hover:bg-slate-50 text-sm text-slate-700"
            data-testid="confirm-delete-cancel">Cancel</button>
          <button onClick={onConfirm}
            className="h-9 px-4 rounded-full bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
            data-testid="confirm-delete-yes">Delete room</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function NodeCard({ node, path, index, lastEdit, onOpen, onDelete, onClone, onDuplicate, onRename, onChanged }) {
  const Icon = NODE_ICON[node.type] || Boxes;
  const clickable = node.type === "utility" && !node.is_representation && !node.is_legacy;
  const trail = path.slice(0, -1).map((p) => p.name).join(" › ") || "—";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.2), type: "spring", stiffness: 300, damping: 30 }}
      whileHover={clickable ? { y: -3 } : undefined}
      className={`relative text-left bg-white rounded-3xl p-6 border border-black/5 shadow-[0_4px_24px_rgba(0,0,0,0.04)] hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)] transition-shadow group ${clickable ? "" : "opacity-90"}`}
      data-testid={`node-card-${node.id}`}
    >
      {/* Live occupancy chips — top-right, above the delete button. Only
          renders when at least one peer is currently inside this room. */}
      {clickable && (
        <div className="absolute top-4 right-4 z-10 pointer-events-none">
          <RoomOccupancyChips roomId={node.id} />
        </div>
      )}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute top-14 right-4 w-9 h-9 rounded-full bg-white border border-black/5 hover:bg-[#FFEBEE] hover:border-[#FF3B30]/30 hover:text-[#FF3B30] text-[#86868B] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
          title={`Delete ${node.name}`}
          data-testid={`delete-node-${node.id}`}
        >
          <Trash2 className="w-4 h-4" strokeWidth={1.75} />
        </button>
      )}
      <button
        type="button"
        onClick={onOpen || (() => {})}
        disabled={!clickable}
        className={`w-full text-left ${clickable ? "cursor-pointer" : "cursor-default"}`}
      >
        <div className="w-10 h-10 rounded-2xl bg-[#F5F5F7] flex items-center justify-center">
          <Icon className="w-5 h-5 text-[#1D1D1F]" strokeWidth={1.5} />
        </div>
        <div className="mt-5 text-[10px] uppercase tracking-[0.22em] text-[#86868B] font-medium">{node.type}</div>
        <div className="mt-1 font-display text-xl font-semibold tracking-tight text-[#1D1D1F] line-clamp-2 leading-tight">{node.name}</div>
        <div className="mt-2 text-xs text-[#86868B] truncate">{trail}</div>
        <div className="mt-4 flex items-center gap-3 text-[11px]">
          {node.risk_rating && (
            <span className={`${RISK_TINT[node.risk_rating] || ""} font-medium`}>{node.risk_rating} risk</span>
          )}
          {node.is_representation && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-[#F5F5F7] border border-black/5 text-[10px] uppercase tracking-[0.18em] text-[#86868B] font-medium"
              data-testid={`representation-pill-${node.id}`}
              title="Read-only demo room · shared with everyone"
            >
              Representation
            </span>
          )}
          {node.is_legacy && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[10px] uppercase tracking-[0.18em] text-amber-700 font-medium"
              data-testid={`legacy-pill-${node.id}`}
              title="Legacy room · unassigned · admin-only"
            >
              Legacy
            </span>
          )}
          {!clickable && !node.is_representation && !node.is_legacy && !node.is_mine && (
            <span className="text-[10px] uppercase tracking-[0.22em] text-[#86868B]/70 font-medium">read-only</span>
          )}
        </div>
        {/* Last-edited-by pill — shows the returning-user story:
            "you can pick right back up where <name> left off". */}
        {clickable && lastEdit?.by && (
          <div className="mt-3 text-[10px] text-[#86868B] font-medium flex items-center gap-1"
               data-testid={`last-edit-${node.id}`}>
            <span>Last edit</span>
            <span className="text-[#1D1D1F]">
              {lastEdit.by.name || lastEdit.by.email}
            </span>
            <span>· {relativeTime(lastEdit.at)}</span>
          </div>
        )}
        {clickable && (
          <div className="mt-4 inline-flex items-center gap-1 text-xs text-[#0071E3] opacity-0 group-hover:opacity-100 transition-opacity">
            Open <ArrowRight className="w-3.5 h-3.5" />
          </div>
        )}
      </button>
      {onClone && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClone(); }}
          className="relative z-10 mt-4 inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[#1D1D1F] text-white text-[11px] font-medium hover:bg-[#333]"
          data-testid={`clone-template-${node.id}`}
          title="Create a private editable copy in your estate"
        >
          <Copy className="w-3 h-3" /> Use as template
        </button>
      )}
      {(onDuplicate || onRename) && (
        <div className="relative z-10 mt-4 flex items-center gap-2">
          {onDuplicate && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
              data-testid={`duplicate-room-${node.id}`} title="Make a full copy of this room"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-black/10 text-[11px] font-medium text-[#1D1D1F] hover:border-[#1D1D1F] transition-colors">
              <Copy className="w-3 h-3" /> Duplicate
            </button>
          )}
          {onRename && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onRename(); }}
              data-testid={`rename-room-${node.id}`} title="Rename this room"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-black/10 text-[11px] font-medium text-[#1D1D1F] hover:border-[#1D1D1F] transition-colors">
              <Pencil className="w-3 h-3" /> Rename
            </button>
          )}
        </div>
      )}
      <PublishControl node={node} onChanged={onChanged} />
      {node.type === "zone" && node.metadata?.import_id && (
        <Link to={`/floor/${node.id}`} data-testid={`floor-analysis-link-${node.id}`}
           className="mt-3 inline-flex items-center gap-1 h-7 px-3 rounded-full border border-slate-300 hover:border-slate-900 text-[11px] font-medium transition-colors">
          Floor analysis →
        </Link>
      )}
    </motion.div>
  );
}

// Tiny "2m ago"-style formatter for last-edit pills. No dep on date-fns.
function relativeTime(iso) {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const diff = Math.max(0, Date.now() - then);
  const s = Math.round(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24)   return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30)   return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function ShortcutCard({ icon: Icon, label, sub, onClick, testId }) {
  return (
    <button
      onClick={onClick}
      className="text-left bg-white rounded-3xl p-5 border border-black/5 shadow-[0_2px_16px_rgba(0,0,0,0.03)] hover:shadow-[0_6px_24px_rgba(0,0,0,0.06)] transition-shadow group"
      data-testid={testId}
    >
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-2xl bg-[#1D1D1F] text-white flex items-center justify-center">
          <Icon className="w-4.5 h-4.5" strokeWidth={1.75} />
        </div>
        <div>
          <div className="font-display text-sm font-medium tracking-tight text-[#1D1D1F]">{label}</div>
          <div className="text-xs text-[#86868B] mt-0.5">{sub}</div>
        </div>
        <ArrowRight className="w-4 h-4 text-[#86868B] ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </button>
  );
}

export function TopBar({ user, onLogout }) {
  const loc = useLocation();
  const NAV = [
    { to: "/dashboard",   label: "Estate",     match: (p) => p.startsWith("/dashboard") || p.startsWith("/room") },
    { to: "/templates",   label: "Templates",  match: (p) => p.startsWith("/templates") },
    { to: "/components",  label: "Components", match: (p) => p.startsWith("/components") || p.startsWith("/families") },
    { to: "/knowledge",   label: "Knowledge",  match: (p) => p.startsWith("/knowledge") || p.startsWith("/ingestion") || p.startsWith("/derogations") },
    { to: "/rules-map",   label: "Rules map",  match: (p) => p.startsWith("/rules-map") },
  ];
  return (
    <div className="sticky top-0 z-30 hb-glass">
      <div className="max-w-7xl mx-auto px-8 h-12 flex items-center justify-between gap-6">
        <Link to="/dashboard" className="focus:outline-none shrink-0" data-testid="topbar-brand">
          <Wordmark size="base" solid />
        </Link>

        <nav className="flex-1 flex items-center justify-center">
          <div className="inline-flex items-center gap-1 rounded-full border border-black/5 bg-white/50 p-1"
               data-testid="topbar-nav">
            {NAV.map((n) => {
              const active = n.match(loc.pathname);
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  data-testid={`nav-${n.label.toLowerCase()}`}
                  className={`text-[11px] uppercase tracking-[0.22em] font-medium px-3.5 py-1.5 rounded-full transition-colors
                    ${active
                      ? "bg-[#1D1D1F] text-white"
                      : "text-[#1D1D1F]/70 hover:text-[#1D1D1F]"}`}>
                  {n.label}
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="flex items-center gap-4 shrink-0">
          <TourLauncher />
          <NotificationsBell />
          <ProfileButton user={user} />
          <button onClick={onLogout} className="text-[#86868B] hover:text-[#1D1D1F] transition-colors" data-testid="logout">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}


/* ── Notifications bell — three sources:
   1. Rule submissions pending review (existing)
   2. Personal notes attached to invite / revoke / approve / deny
   3. Access requests on rooms this user owns
   Users can toggle notifications on/off (localStorage-scoped). ────────────── */
function NotificationsBell() {
  const nav = useNavigate();
  const [reviewCount, setReviewCount] = useState(0);
  const [noteCount, setNoteCount]     = useState(0);
  const [reqCount, setReqCount]       = useState(0);
  const [open, setOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState([]);
  const [notes, setNotes]             = useState([]);
  const [requests, setRequests]       = useState([]);
  const [notifOn, setNotifOn] = useState(() => {
    try { return localStorage.getItem("his_notifs_on") !== "false"; } catch { return true; }
  });
  const prev = useRef({ review: 0, notes: 0, reqs: 0 });

  useEffect(() => {
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const [rev, nts, rqs] = await Promise.allSettled([
          api.get("/notifications/pending-review-count"),
          api.get("/user-notes?unseen=true"),
          api.get("/my/access-requests-count"),
        ]);
        if (!alive) return;
        const nextReview = rev.status === "fulfilled" ? (rev.value.data.count || 0) : 0;
        const nextNotes  = nts.status === "fulfilled" ? (nts.value.data.unseen_count || 0) : 0;
        const nextReqs   = rqs.status === "fulfilled" ? (rqs.value.data.count || 0) : 0;
        if (notifOn) {
          if (nextNotes > prev.current.notes && prev.current.notes !== 0) {
            toast.info(`${nextNotes - prev.current.notes} new message${nextNotes - prev.current.notes === 1 ? "" : "s"}`);
          }
          if (nextReqs > prev.current.reqs && prev.current.reqs !== 0) {
            toast.info(`${nextReqs - prev.current.reqs} new access request${nextReqs - prev.current.reqs === 1 ? "" : "s"}`);
          }
        }
        prev.current = { review: nextReview, notes: nextNotes, reqs: nextReqs };
        setReviewCount(nextReview);
        setNoteCount(nextNotes);
        setReqCount(nextReqs);
      } catch {}
      timer = setTimeout(poll, 30000);
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [notifOn]);

  const totalCount = reviewCount + noteCount + reqCount;

  const openDropdown = async () => {
    setOpen((o) => !o);
    if (open) return;
    try {
      const [rev, nts] = await Promise.allSettled([
        api.get("/ingestion?state=pending_review"),
        api.get("/user-notes?unseen=false&limit=20"),
      ]);
      setReviewItems(rev.status === "fulfilled" ? (rev.value.data || []).slice(0, 5) : []);
      setNotes(nts.status === "fulfilled" ? (nts.value.data.notes || []).slice(0, 10) : []);
      // Access requests are per-room; we fetch a rolled-up list from all rooms
      // the user owns by walking their hierarchy. Cheaper: rely on the bell
      // count and let owners open the specific room's Sharing Panel → Requests.
      // For dropdown UX we surface just the count with a link to My Rooms.
      setRequests([{ id: "sentinel", count: reqCount }]);
      // Mark notes seen so the badge clears on open
      if (noteCount > 0) {
        api.post("/user-notes/ack", {}).catch(() => {});
        setNoteCount(0);
        prev.current.notes = 0;
      }
    } catch {}
  };

  const toggle = (e) => {
    e.stopPropagation();
    const next = !notifOn;
    setNotifOn(next);
    try { localStorage.setItem("his_notifs_on", next ? "true" : "false"); } catch {}
  };

  return (
    <div className="relative">
      <button onClick={openDropdown}
        className="relative text-[#86868B] hover:text-[#1D1D1F] transition-colors"
        title="Notifications" data-testid="notif-bell">
        <Bell className="w-4 h-4" strokeWidth={1.75} />
        {totalCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-[#FF3B30] text-white text-[9px] font-medium flex items-center justify-center"
                data-testid="notif-count">
            {totalCount > 99 ? "99+" : totalCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-[360px] bg-white rounded-2xl border border-black/5 shadow-[0_10px_32px_rgba(0,0,0,0.14)] py-2 z-50"
             onMouseLeave={() => setOpen(false)}
             data-testid="notif-dropdown">
          <div className="px-4 py-2 flex items-center justify-between border-b border-black/5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-[#86868B] font-medium">Notifications</div>
            <button onClick={toggle}
                    className={`text-[10px] uppercase tracking-[0.18em] font-medium ${notifOn ? "text-[#0071E3]" : "text-[#86868B]"}`}
                    title="Toggle notifications" data-testid="notif-toggle">
              {notifOn ? "on" : "off"}
            </button>
          </div>
          <div className="max-h-[380px] overflow-auto divide-y divide-black/5">
            {/* Personal notes */}
            {notes.length > 0 && (
              <div className="py-1">
                <div className="px-4 py-1 text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">
                  Messages · {notes.length}
                </div>
                {notes.map((n) => (
                  <button key={n.id}
                          onClick={() => { setOpen(false); if (n.room_id) nav(`/room/${n.room_id}`); }}
                          data-testid={`notif-note-${n.id}`}
                          className="w-full text-left px-4 py-2 hover:bg-[#F5F5F7] transition-colors">
                    <div className="text-xs">
                      <span className="font-medium text-[#1D1D1F]">{n.from_name || n.from_email}</span>
                      <span className="text-[#86868B]"> · {n.action}</span>
                      {n.room_name && <span className="text-[#86868B]"> · {n.room_name}</span>}
                    </div>
                    <div className="text-[11px] text-[#3a3a3f] mt-0.5 line-clamp-2">"{n.note}"</div>
                    <div className="text-[10px] text-[#86868B] mt-0.5">{new Date(n.ts).toLocaleString()}</div>
                  </button>
                ))}
              </div>
            )}
            {/* Access requests */}
            {reqCount > 0 && (
              <div className="py-1">
                <div className="px-4 py-1 text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">
                  Access requests · {reqCount}
                </div>
                <div className="px-4 py-2 text-xs text-[#3a3a3f]" data-testid="notif-requests-hint">
                  Open a room and use <b>Share → Requests</b> to Approve or Deny.
                </div>
              </div>
            )}
            {/* Review queue */}
            {reviewItems.length > 0 && (
              <div className="py-1">
                <div className="px-4 py-1 text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">
                  Pending review · {reviewCount}
                </div>
                {reviewItems.map((it) => (
                  <button key={it.id} onClick={() => { setOpen(false); nav("/knowledge?tab=review"); }}
                          className="w-full text-left px-4 py-2 hover:bg-[#F5F5F7] transition-colors"
                          data-testid={`notif-item-${it.id}`}>
                    <div className="text-xs font-medium text-[#1D1D1F] truncate">
                      {it.payload?.rule_id || it.payload?.name || "Untitled"} · <span className="text-[#86868B]">{it.target}</span>
                    </div>
                    <div className="text-[10px] text-[#86868B] mt-0.5 truncate">
                      by {it.submitted_by} · {new Date(it.submitted_at).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {totalCount === 0 && notes.length === 0 && reviewItems.length === 0 && (
              <div className="px-4 py-6 text-xs text-[#86868B] text-center">Nothing new.</div>
            )}
          </div>
          <div className="px-4 pt-2 border-t border-black/5 flex items-center justify-between">
            <button onClick={() => { setOpen(false); nav("/knowledge?tab=review"); }}
                    className="text-xs text-[#0071E3] hover:text-[#0077ED]"
                    data-testid="notif-open-queue">
              Review queue →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* Profile chip in the top bar. Shows initials + name/email; click opens the
   My Profile modal to edit role / organization / discipline / etc. */
function ProfileButton({ user }) {
  const [open, setOpen] = useState(false);
  const initials = (user?.name || user?.email || "?")
    .split(/[.@\s_-]/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join("");
  return (
    <>
      <button onClick={() => setOpen(true)}
              data-testid="profile-btn"
              title={`${user?.name || user?.email}\nClick to edit profile`}
              className="hidden md:flex items-center gap-2 h-8 pl-1 pr-3 rounded-full border border-black/5 bg-white hover:bg-[#F5F5F7] transition-colors">
        {user?.avatar_url ? (
          <img src={`${process.env.REACT_APP_BACKEND_URL}${user.avatar_url}`}
               alt=""
               className="w-6 h-6 rounded-full object-cover"
               data-testid="profile-avatar-img" />
        ) : (
          <div className="w-6 h-6 rounded-full bg-slate-900 text-white text-[10px] font-semibold flex items-center justify-center">
            {initials}
          </div>
        )}
        <div className="text-left leading-tight">
          <div className="text-[11px] font-medium tracking-tight max-w-[160px] truncate">
            {user?.name || (user?.email || "").split("@")[0]}
          </div>
          <div className="text-[9px] font-mono uppercase tracking-widest text-[#86868B] max-w-[160px] truncate">
            {user?.role || "member"}{user?.organization ? ` · ${user.organization}` : ""}
          </div>
        </div>
      </button>
      {open && <ProfileModal user={user} onClose={() => setOpen(false)} />}
    </>
  );
}

const PROFILE_ROLES = [
  { v: "architect", label: "Architect" },
  { v: "ipc",       label: "IPC lead" },
  { v: "engineer",  label: "Engineer" },
  { v: "clinician", label: "Clinician" },
  { v: "viewer",    label: "Viewer (read-only)" },
];

function ProfileModal({ user, onClose }) {
  const { refresh } = useAuth();
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    setBusy(true);
    api.get("/auth/me").then((r) => setMe(r.data)).finally(() => setBusy(false));
  }, []);

  const set = (patch) => setMe((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    if (!me) return;
    setSaving(true); setMsg(null);
    try {
      await api.patch("/auth/me", {
        name: me.name, role: me.role,
        organization: me.organization, discipline: me.discipline,
        location: me.location, phone: me.phone, bio: me.bio,
      });
      setMsg("Profile updated");
      // Nudge the auth context to pick up the new fields
      await refresh?.();
      setTimeout(onClose, 700);
    } catch (e) {
      setMsg(e?.response?.data?.detail || "Could not save profile.");
    } finally { setSaving(false); }
  };

  const Field = ({ label, testId, ...rest }) => (
    <div>
      <label className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium">{label}</label>
      <input {...rest} data-testid={testId}
             className="mt-1 w-full h-9 px-3 rounded-md border border-slate-200 focus:outline-none focus:border-slate-500 text-sm bg-white" />
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[9998] bg-black/50 backdrop-blur-sm overflow-y-auto"
         data-testid="profile-modal">
      <div className="min-h-full flex items-start justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <User2 className="w-4 h-4 text-slate-600" />
            <div className="font-display text-lg font-semibold">My profile</div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-1"
                  data-testid="profile-close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        {busy || !me ? (
          <div className="text-sm text-slate-500 py-8 text-center">Loading…</div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 border border-slate-100">
              {me.avatar_url ? (
                <img src={`${process.env.REACT_APP_BACKEND_URL}${me.avatar_url}?t=${Date.now()}`}
                     alt="" className="w-14 h-14 rounded-full object-cover border border-slate-200"
                     data-testid="profile-avatar-preview" />
              ) : (
                <div className="w-14 h-14 rounded-full bg-slate-900 text-white text-lg font-semibold flex items-center justify-center">
                  {(me.name || me.email || "?").split(/[.@\s_-]/).filter(Boolean).slice(0,2).map(p => p[0].toUpperCase()).join("")}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-slate-500">{me.email}</div>
                <div className="text-[10px] text-slate-400 mb-1">{me.auth === "guest" ? "guest session" : "signed-in user"}</div>
                <label className="inline-block cursor-pointer text-[11px] font-mono uppercase tracking-widest text-[#0071E3] hover:text-[#0077ED]">
                  {me.avatar_url ? "Replace picture" : "Upload picture"}
                  <input type="file" accept="image/*" className="hidden"
                         data-testid="profile-avatar-input"
                         onChange={async (e) => {
                           const f = e.target.files?.[0];
                           if (!f) return;
                           const fd = new FormData();
                           fd.append("file", f);
                           try {
                             const r = await api.post("/auth/me/avatar", fd,
                               { headers: { "Content-Type": "multipart/form-data" } });
                             set({ avatar_url: r.data.avatar_url });
                             refresh?.();
                           } catch (err) {
                             setMsg(err?.response?.data?.detail || "Upload failed");
                           }
                         }} />
                </label>
              </div>
            </div>
            <Field label="Full name"    testId="profile-name" value={me.name || ""}         onChange={(e) => set({ name: e.target.value })} />
            <div>
              <label className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium">Role</label>
              <select value={me.role || "architect"} onChange={(e) => set({ role: e.target.value })}
                      data-testid="profile-role"
                      className="mt-1 w-full h-9 px-2 rounded-md border border-slate-200 bg-white text-sm">
                {PROFILE_ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Organization" testId="profile-org"        value={me.organization || ""} onChange={(e) => set({ organization: e.target.value })} placeholder="Perkins&Will" />
              <Field label="Discipline"   testId="profile-discipline" value={me.discipline || ""}   onChange={(e) => set({ discipline: e.target.value })}   placeholder="Health · London" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Location"     testId="profile-location"   value={me.location || ""}     onChange={(e) => set({ location: e.target.value })}     placeholder="London, UK" />
              <Field label="Phone"        testId="profile-phone"      value={me.phone || ""}        onChange={(e) => set({ phone: e.target.value })}        placeholder="+44 20 …" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium">Bio</label>
              <textarea rows={2} value={me.bio || ""} onChange={(e) => set({ bio: e.target.value })}
                        data-testid="profile-bio"
                        placeholder="Healthcare-facility infection-prevention architect · 12y"
                        className="mt-1 w-full px-3 py-2 rounded-md border border-slate-200 focus:outline-none focus:border-slate-500 text-sm bg-white resize-none" />
            </div>
            {msg && <div className="text-xs text-slate-600">{msg}</div>}
            {/* Terms of Service status card — surfaces the last-accepted
                version so users know when they need to re-accept after
                an update. */}
            <TermsStatusCard me={me} />
            <div className="pt-2 flex items-center justify-end gap-2">
              <button onClick={onClose}
                      className="h-9 px-4 rounded-full text-sm border border-slate-200 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={save} disabled={saving}
                      data-testid="profile-save"
                      className="h-9 px-5 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-sm">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>,
    document.body
  );
}


/* Compass button in the top bar that opens the global QuickTour overlay.
   The tour itself is mounted at the app root so it survives navigation. */
function TourLauncher() {
  return (
    <button onClick={() => openTour()}
            title="Take the tour"
            data-testid="tour-launcher"
            className="text-[#86868B] hover:text-[#1D1D1F] transition-colors">
      <Compass className="w-4 h-4" />
    </button>
  );
}


/* Card inside the Profile modal that shows which Terms version the user
   accepted, when, and whether it matches the current published Terms.
   If a newer version exists, calls this out clearly and reveals a Re-read
   link that clears the local acceptance so the ToS gate re-opens. */
function TermsStatusCard({ me }) {
  const accepted   = me?.tos_accepted_version || null;
  const acceptedAt = me?.tos_accepted_at ? new Date(me.tos_accepted_at) : null;
  const current    = accepted === TERMS_VERSION;

  const rereadTerms = () => {
    try { localStorage.removeItem("his:tos_accepted_version"); } catch {}
    // A hard reload sends the user back through the ToS gate cleanly.
    window.location.reload();
  };

  return (
    <div className={`mt-1 rounded-xl border p-3 ${
      current ? "border-emerald-200 bg-emerald-50/60" :
      accepted ? "border-amber-200 bg-amber-50/60" :
                 "border-slate-200 bg-slate-50/60"
    }`} data-testid="tos-status-card">
      <div className="flex items-start gap-2">
        {current
          ? <CheckCircle2 className="w-4 h-4 text-emerald-700 mt-0.5 flex-shrink-0" />
          : accepted
            ? <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 flex-shrink-0" />
            : <ScrollText className="w-4 h-4 text-slate-600 mt-0.5 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.2em] font-medium text-slate-500">
            Beta Terms of Service
          </div>
          <div className={`text-[13px] leading-snug mt-0.5 ${
            current ? "text-emerald-900" : accepted ? "text-amber-900" : "text-slate-700"
          }`}>
            {accepted
              ? <>You accepted <span className="font-mono">{accepted}</span>
                  {acceptedAt ? <> on {acceptedAt.toLocaleDateString(undefined, {
                    year: "numeric", month: "short", day: "numeric" })}</> : null}.</>
              : <>No acceptance on record yet.</>}
          </div>
          <div className="text-[11px] text-slate-600 mt-1">
            Current: <span className="font-mono">{TERMS_VERSION}</span> · {TERMS_DATE}
          </div>
          {!current && (
            <div className={`text-[11px] mt-2 ${accepted ? "text-amber-800" : "text-slate-600"}`}>
              {accepted
                ? "A newer version has been published. You'll be asked to re-accept next time you sign in."
                : "You'll be asked to accept when you next continue."}
            </div>
          )}
          <button onClick={rereadTerms}
                  data-testid="tos-reread-btn"
                  className="mt-2 text-[10px] font-mono uppercase tracking-widest text-[#0071E3] hover:text-[#0077ED]">
            Read the Terms again →
          </button>
        </div>
      </div>
    </div>
  );
}

