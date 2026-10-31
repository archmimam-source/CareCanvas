import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { TopBar } from "@/pages/Dashboard";
import { Input } from "@/components/ui/input";
import RoomNameDialog, { buildPlaces } from "@/components/room/RoomNameDialog";
import { Search, Copy, Layers, ArrowRight, DoorOpen } from "lucide-react";

const RISK_TINT = { high: "text-[#FF3B30]", medium: "text-[#FF9500]", low: "text-[#34C759]" };

export default function Templates() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [templates, setTemplates] = useState([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get("/templates").then((r) => setTemplates(r.data.templates || []))
      .catch((e) => toast.error(e?.response?.data?.detail || "Could not load templates"))
      .finally(() => setLoading(false));
  }, []);

  const kinds = useMemo(() => {
    const s = new Set();
    templates.forEach((t) => t.kind && s.add(t.kind));
    return Array.from(s).sort();
  }, [templates]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return templates.filter((t) => {
      if (kind && t.kind !== kind) return false;
      if (!qq) return true;
      return (t.name || "").toLowerCase().includes(qq)
          || (t.code || "").toLowerCase().includes(qq)
          || (t.kind || "").toLowerCase().includes(qq);
    });
  }, [templates, q, kind]);

  const [naming, setNaming] = useState(null);
  const [places, setPlaces] = useState([]);
  useEffect(() => { api.get("/hierarchy").then((r) => setPlaces(buildPlaces(r.data || []))).catch(() => {}); }, []);
  const clone = (tpl) => setNaming({ mode: "clone", node: tpl, name: `${tpl.name} — my copy` });
  const doClone = async (name, parentId) => {
    try {
      const r = await api.post(`/rooms/${naming.node.id}/clone`, { name, parent_id: parentId });
      toast.success("Template cloned into your estate");
      setNaming(null);
      nav(`/room/${r.data.room.id}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Clone failed");
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <TopBar user={user} onLogout={logout} />
      <RoomNameDialog state={naming} places={places} onClose={() => setNaming(null)} onSubmit={doClone} />
      <div className="max-w-7xl mx-auto px-8 pt-16 pb-24">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-12">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium">Gallery</div>
            <h1 className="font-display text-5xl md:text-6xl font-semibold tracking-tighter text-[#1D1D1F] mt-2 leading-[1.05]">
              Templates.
            </h1>
            <div className="mt-3 text-base text-[#86868B]" data-testid="templates-summary">
              {loading ? "Loading…" : `${filtered.length} of ${templates.length} representation rooms · tap to clone into your estate`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#86868B]" />
              <Input value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Search templates"
                     className="pl-9 h-10 w-64 rounded-full bg-white border-black/10 text-sm"
                     data-testid="templates-search" />
            </div>
            <select value={kind} onChange={(e) => setKind(e.target.value)}
                    className="h-10 px-3 rounded-full bg-white border border-black/10 text-sm"
                    data-testid="templates-kind-filter">
              <option value="">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>{k.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
        </div>

        {!loading && filtered.length === 0 && (
          <div className="text-base text-[#86868B] py-24 text-center">
            No templates match your search.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-5">
          {filtered.map((t, i) => (
            <TemplateCard key={t.id} template={t} index={i} onClone={() => clone(t)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ template, index, onClone }) {
  const t = template;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.2), type: "spring", stiffness: 300, damping: 30 }}
      whileHover={{ y: -3 }}
      className="relative bg-white rounded-3xl p-6 border border-black/5 shadow-[0_4px_24px_rgba(0,0,0,0.04)] hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)] transition-shadow group"
      data-testid={`template-card-${t.id}`}
    >
      <div className="w-10 h-10 rounded-2xl bg-[#F5F5F7] flex items-center justify-center">
        <DoorOpen className="w-5 h-5 text-[#1D1D1F]" strokeWidth={1.5} />
      </div>
      <div className="mt-5 text-[10px] uppercase tracking-[0.22em] text-[#86868B] font-medium flex items-center gap-1">
        <Layers className="w-3 h-3" /> Representation
      </div>
      <div className="mt-1 font-display text-xl font-semibold tracking-tight text-[#1D1D1F] line-clamp-2 leading-tight">
        {t.name}
      </div>
      <div className="mt-2 text-xs text-[#86868B]">
        {t.kind ? t.kind.replace(/_/g, " ") : "utility"}{t.code ? ` · ${t.code}` : ""}
      </div>
      {/* Zone strip — visual placeholder */}
      <div className="mt-4 flex h-1.5 rounded-full overflow-hidden bg-[#F5F5F7]">
        <div className="flex-1 bg-[#FBEDE9]" title="Dirty" />
        <div className="flex-1 bg-[#FFF6E5]" title="Transition" />
        <div className="flex-1 bg-[#E9F1FB]" title="Clean" />
      </div>
      <div className="mt-4 flex items-center gap-3 text-[11px]">
        {t.risk_rating && (
          <span className={`${RISK_TINT[t.risk_rating] || ""} font-medium`}>{t.risk_rating} risk</span>
        )}
        {t.area_m2 && <span className="text-[#86868B]">{t.area_m2} m²</span>}
        {t.items_count != null && <span className="text-[#86868B]">{t.items_count} items</span>}
      </div>
      <button
        onClick={onClone}
        className="mt-5 inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[#1D1D1F] text-white text-[11px] font-medium hover:bg-[#333]"
        data-testid={`template-clone-${t.id}`}
      >
        <Copy className="w-3 h-3" /> Use as template <ArrowRight className="w-3 h-3" />
      </button>
    </motion.div>
  );
}
