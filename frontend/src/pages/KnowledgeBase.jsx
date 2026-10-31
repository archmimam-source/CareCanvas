import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/apiClient";
import { saveBlob, brandedName } from "@/lib/download";
import { TopBar } from "@/pages/Dashboard";
import { useAuth } from "@/context/AuthContext";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  ExternalLink, FileText, Plus, Pin, PinOff, BookOpen,
  Recycle, Square, LayoutGrid, Boxes, Trash2, Package, Minus,
  Droplets, Sparkles, Shield, DoorOpen, Fan, Lightbulb, Plug,
  Power, Network, Droplet, Eye, Wifi, Bell, Wind, Scale, Box,
} from "lucide-react";
import { PDFExtractPanel, SubmitFormPanel, ReviewQueuePanel } from "@/pages/IngestionPanels";
import DerogationReport from "@/pages/DerogationReport";

// Short one-liners shown under each active tab. Sets expectation for what
// a user will find and, more importantly, WHY they'd land on each page.
const TAB_DESCRIPTIONS = {
  rules:       "The living rulebook. Every clause we validate against — NHS HBN/HTM, ASHRAE 170, WHO WASH FIT. Uncheck to opt out, pin to attach to a room.",
  interps:     "Notes and reasoning that turn abstract clauses into practical decisions. Written by reviewers, versioned like the rules.",
  components:  "The Revit family library. Everything you can drop onto a plan, with dimensions, materials and rule linkages.",
  derogations: "The audit trail of every rule waiver requested across the estate — who, when, why, and whether it was approved.",
  contribute:  "Bring new knowledge into HealthcareCanvas. Extract candidate rules from a PDF, or hand-author a rule / component. Nothing publishes until it's reviewed.",
  review:      "Everything waiting for reviewer approval, grouped by state. Approve to publish into Rules / Components; reject with a note.",
  adjacency:   "The v3 spatial-relations methodology. 29 role-based relations with evidence tiers (STATED / INVARIANT / INFERRED), 7 invariants that hold across every observed layout, and 9 profile deltas that show where HBN and NHP V2 diverge.",
};

const ICON_MAP = {
  "recycle": Recycle, "square": Square, "layout-grid": LayoutGrid,
  "boxes": Boxes, "trash-2": Trash2, "package": Package, "minus": Minus,
  "droplets": Droplets, "sparkles": Sparkles, "file-text": FileText,
  "shield": Shield, "door-open": DoorOpen, "fan": Fan, "lightbulb": Lightbulb,
  "plug": Plug, "power": Power, "network": Network, "droplet": Droplet,
  "eye": Eye, "wifi": Wifi, "bell": Bell, "wind": Wind, "scale": Scale,
};
const ComponentIcon = ({ name, className }) => {
  const I = ICON_MAP[name] || Box;
  return <I className={className} strokeWidth={1.5} />;
};

const STATUS_TINT = {
  current_nhs_baseline: { label: "NHS baseline", cls: "text-[#34C759] bg-[#E8F8EE] border-[#34C759]/30" },
  under_review: { label: "Under review", cls: "text-[#FF9500] bg-[#FFF4E5] border-[#FF9500]/30" },
  international_comparator: { label: "Comparator", cls: "text-slate-700 bg-slate-100 border-slate-300" },
  superseded: { label: "Superseded", cls: "text-slate-400 bg-slate-50 border-slate-200" },
};
const ZONE_DOT = { clean: "#34C759", transition: "#FF9500", dirty: "#FF3B30" };

export default function KnowledgeBase() {
  const { user, logout } = useAuth();
  const [rules, setRules] = useState([]);
  const [components, setComponents] = useState([]);
  // v3 adjacency bundle — fetched once and rendered as browsable cards
  // (invariants + profile deltas + relations) in the "Adjacency v3" tab.
  const [adjV3, setAdjV3] = useState(null);
  const [q, setQ] = useState("");
  const [params] = useSearchParams();
  const [activeTab, setActiveTab] = useState(params.get("tab") || "rules");
  // Bumped on every successful KB import so `ReviewQueuePanel` (and any
  // other list that fetches on mount) re-fetches without a page reload.
  const [ioBump, setIoBump] = useState(0);
  const roomId = params.get("room");

  const refresh = () => {
    const qs = roomId ? `?room_id=${roomId}` : "";
    api.get(`/rules${qs}`).then((r) => setRules(r.data));
    api.get("/components").then((r) => setComponents(r.data));
    api.get("/adjacency/v3").then((r) => setAdjV3(r.data)).catch(() => setAdjV3(null));
  };
  useEffect(refresh, [roomId]);

  const rulesOnly = rules.filter((r) => r.kind !== "interpretation");
  const interps   = rules.filter((r) => r.kind === "interpretation");

  const filteredRules = rulesOnly.filter((r) =>
    (r.category + r.statement + r.rule_id + r.source).toLowerCase().includes(q.toLowerCase())
  );
  const byCategory = {};
  filteredRules.forEach((r) => { (byCategory[r.category] ??= []).push(r); });

  const openSource = (r) => {
    if (!r.source_url) {
      toast.info(`Source not linkable — ${r.source}. Attach the PDF via Ingestion to enable deep-link.`);
      return;
    }
    const href = r.source_page ? `${r.source_url}#page=${r.source_page}` : r.source_url;
    window.open(href, "_blank", "noopener,noreferrer");
  };

  const toggleEnabled = async (r, e) => {
    e.stopPropagation();
    try {
      await api.patch(`/rules/${r.id}/toggle`, { enabled: !r.enabled });
      setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: !r.enabled } : x));
    } catch {
      toast.error("Failed to toggle rule");
    }
  };

  const togglePinToRoom = async (r, e) => {
    e.stopPropagation();
    if (!roomId) return;
    const nextRoom = r.scope === "room" && r.room_id === roomId ? null : roomId;
    try {
      await api.patch(`/rules/${r.id}/pin`, { room_id: nextRoom });
      setRules((prev) => prev.map((x) => x.id === r.id
        ? { ...x, scope: nextRoom ? "room" : "global", room_id: nextRoom } : x));
      toast.success(nextRoom ? "Pinned to this room" : "Detached — now global");
    } catch {
      toast.error("Failed to update pin");
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <TopBar user={user} onLogout={logout} />
      <div className="max-w-6xl mx-auto px-8 pt-14 pb-24">
        <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium">
          Knowledge Base{roomId ? " · scoped to this room" : ""}
        </div>
        <h1 className="font-display text-5xl md:text-6xl font-semibold tracking-tighter text-[#1D1D1F] mt-2 leading-[1.05]">
          One source of truth.
        </h1>
        <p className="mt-4 text-base text-[#86868B] max-w-2xl leading-relaxed">
          The knowledge base flows the way a design does. Start with the <span className="text-[#1D1D1F] font-medium">Rules</span> that
          govern a room, layer in the <span className="text-[#1D1D1F] font-medium">Interpretations</span> that turn them into decisions,
          reach for the <span className="text-[#1D1D1F] font-medium">Components</span> that satisfy them,
          log every rule waiver in the <span className="text-[#1D1D1F] font-medium">Derogations</span> record,
          then <span className="text-[#1D1D1F] font-medium">Contribute</span> new knowledge — reviewers publish it from <span className="text-[#1D1D1F] font-medium">Review</span>.
        </p>

        <div className="mt-12">
          <Tabs defaultValue={params.get("tab") || "rules"} onValueChange={setActiveTab}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <TabsList className="bg-[#F5F5F7] rounded-full p-1 h-10 border border-black/5">
                <TabsTrigger value="rules"       className="text-xs rounded-full px-4" data-testid="tab-kb-rules">Rules · {rulesOnly.length}</TabsTrigger>
                <TabsTrigger value="interps"     className="text-xs rounded-full px-4" data-testid="tab-kb-interps">Interpretations · {interps.length}</TabsTrigger>
                <TabsTrigger value="components"  className="text-xs rounded-full px-4" data-testid="tab-kb-components">Components · {components.length}</TabsTrigger>
                <TabsTrigger value="derogations" className="text-xs rounded-full px-4" data-testid="tab-kb-derogations">Derogations</TabsTrigger>
                <TabsTrigger value="contribute"  className="text-xs rounded-full px-4" data-testid="tab-kb-contribute">Contribute</TabsTrigger>
                <TabsTrigger value="review"      className="text-xs rounded-full px-4" data-testid="tab-kb-review">Review</TabsTrigger>
                <TabsTrigger value="adjacency"   className="text-xs rounded-full px-4" data-testid="tab-kb-adjacency">Adjacency v3</TabsTrigger>
              </TabsList>
              <AddRuleDialog kind="rule" onDone={refresh} />
            </div>
            {/* Sub-title copy that changes per active tab — sets context on
                why the user is looking at this list. */}
            <div className="mt-4 text-[13px] text-[#86868B] max-w-3xl leading-relaxed" data-testid="kb-tab-desc">
              {TAB_DESCRIPTIONS[activeTab] || ""}
            </div>

            <div className="mt-6 flex items-center gap-3 flex-wrap">
              <Input value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Search rules, interpretations, components, submissions"
                     className="h-11 rounded-full bg-white border-black/10 max-w-md flex-1 min-w-[240px] px-5 text-sm"
                     data-testid="kb-search" />
              <KnowledgeIO onImport={() => { refresh(); setIoBump((n) => n + 1); }} />
            </div>

            <TabsContent value="rules" className="mt-8 space-y-10">
              {Object.entries(byCategory).map(([cat, items]) => (
                <section key={cat}>
                  <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-4">{cat}</div>
                  <div className="space-y-3">
                    {items.map((r) => (
                      <RuleCard key={r.id} r={r} roomId={roomId}
                                onOpen={() => openSource(r)}
                                onToggle={(e) => toggleEnabled(r, e)}
                                onPin={(e) => togglePinToRoom(r, e)} />
                    ))}
                  </div>
                </section>
              ))}
            </TabsContent>

            <TabsContent value="interps" className="mt-8">
              <div className="mb-6 p-4 rounded-2xl bg-[#EEF3FA] border border-[#0071E3]/15">
                <div className="flex items-start gap-3">
                  <BookOpen className="w-4 h-4 text-[#0071E3] mt-0.5 shrink-0" strokeWidth={1.5} />
                  <div>
                    <div className="text-sm font-medium text-[#1D1D1F]">Interpretations run alongside validation.</div>
                    <div className="text-xs text-[#1D1D1F]/70 mt-0.5 leading-relaxed">
                      Enabled interpretations appear as low-severity advisories during validation so every reviewer sees them. They never fail a room — humans decide adoption.
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                {interps.filter((r) => (r.statement + r.rule_id + r.source).toLowerCase().includes(q.toLowerCase())).map((r) => (
                  <RuleCard key={r.id} r={r} roomId={roomId} interp
                            onOpen={() => openSource(r)}
                            onToggle={(e) => toggleEnabled(r, e)}
                            onPin={(e) => togglePinToRoom(r, e)} />
                ))}
                <div className="pt-3">
                  <AddRuleDialog kind="interpretation" onDone={refresh} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="components" className="mt-8">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {components.filter(c => (c.name+c.key).toLowerCase().includes(q.toLowerCase())).map((c) => (
                  <div key={c.id}
                       className="p-5 bg-white rounded-2xl border border-black/5 shadow-[0_2px_16px_rgba(0,0,0,0.03)] hover:shadow-[0_6px_24px_rgba(0,0,0,0.06)] transition-shadow"
                       data-testid={`comp-${c.key}`}>
                    <div className="flex items-start gap-4">
                      <div className="w-11 h-11 rounded-xl bg-[#F5F5F7] flex items-center justify-center shrink-0">
                        <ComponentIcon name={c.icon} className="w-5 h-5 text-[#1D1D1F]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-display text-base font-semibold tracking-tight text-[#1D1D1F] truncate">{c.name}</div>
                          <div className="w-2.5 h-2.5 rounded-full shrink-0"
                               style={{ background: ZONE_DOT[c.zone_affinity] || "#8E8E93" }} />
                        </div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.22em] text-[#86868B] font-medium">
                          {c.zone_affinity} · {c.default_footprint.w}m × {c.default_footprint.d}m × {c.default_footprint.h}m
                        </div>
                      </div>
                    </div>
                    {c.description && <p className="mt-3 text-sm text-[#1D1D1F]/70 leading-relaxed">{c.description}</p>}
                    {c.materials?.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {c.materials.map((m, i) => (
                          <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-[#F5F5F7] text-[#1D1D1F]/70 border border-black/5">{m}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="derogations" className="mt-8">
              <DerogationReport embedded />
            </TabsContent>

            <TabsContent value="contribute" className="mt-8">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <PDFExtractPanel onSubmitted={refresh} />
                <SubmitFormPanel onDone={refresh} />
              </div>
              <div className="mt-4 text-xs text-[#86868B]">
                Anything you contribute lands in <span className="font-mono text-[#1D1D1F]">Review</span> until a reviewer approves it — nothing is silently authoritative.
              </div>
            </TabsContent>

            <TabsContent value="review" className="mt-8">
              <ReviewQueuePanel query={q} refreshKey={ioBump} canReview={user?.role === "reviewer" || user?.role === "admin"} />
            </TabsContent>

            <TabsContent value="adjacency" className="mt-8">
              <AdjacencyV3Panel bundle={adjV3} query={q} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

/* ── Rule card with checkbox, pin-to-room, PDF deep link ─────────── */
function RuleCard({ r, roomId, interp, onOpen, onToggle, onPin }) {
  const s = STATUS_TINT[r.status] || STATUS_TINT.under_review;
  const hasPdf = !!r.source_url;
  const disabled = r.enabled === false;
  const pinned = r.scope === "room" && r.room_id === roomId;
  return (
    <div
      onClick={onOpen}
      className={`w-full text-left p-6 bg-white rounded-2xl border shadow-[0_2px_16px_rgba(0,0,0,0.03)] transition-shadow group
        ${hasPdf ? "hover:shadow-[0_6px_28px_rgba(0,0,0,0.08)] hover:border-black/10 cursor-pointer" : "cursor-help"}
        ${disabled ? "opacity-55 border-black/5" : "border-black/5"}
        ${pinned ? "ring-1 ring-[#0071E3]/40" : ""}`}
      data-testid={`rule-${r.rule_id}`}>
      <div className="flex items-start gap-4">
        {/* Enable/disable checkbox */}
        <button type="button" onClick={onToggle}
          className={`mt-1 w-4 h-4 rounded border transition-colors shrink-0 flex items-center justify-center
            ${r.enabled === false
              ? "border-black/20 bg-white hover:bg-[#F5F5F7]"
              : "border-[#1D1D1F] bg-[#1D1D1F] hover:bg-[#3A3A3C]"}`}
          title={r.enabled === false ? "Disabled — click to enable" : "Enabled — click to disable"}
          data-testid={`toggle-${r.rule_id}`}>
          {r.enabled !== false && (
            <svg viewBox="0 0 16 16" className="w-3 h-3 text-white"><path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[10px] uppercase tracking-[0.22em] text-[#1D1D1F] font-medium">{r.rule_id}</div>
            <div className={`text-[9px] uppercase tracking-[0.22em] px-2 py-0.5 rounded-full border ${s.cls}`}>
              {interp ? "Interpretation" : s.label}
            </div>
            {r.severity_if_violated && !interp && (
              <div className="text-[9px] uppercase tracking-[0.22em] text-[#86868B]">· {r.severity_if_violated}</div>
            )}
            {r.is_custom && (
              <div className="text-[9px] uppercase tracking-[0.22em] px-2 py-0.5 rounded-full text-[#0071E3] bg-[#EEF3FA]">Custom</div>
            )}
            {pinned && (
              <div className="text-[9px] uppercase tracking-[0.22em] px-2 py-0.5 rounded-full text-[#0071E3] bg-[#EEF3FA] flex items-center gap-1">
                <Pin className="w-2.5 h-2.5" /> This room
              </div>
            )}
          </div>
          <div className="mt-3 text-base text-[#1D1D1F] leading-relaxed">{r.statement}</div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-[#86868B]">
            <FileText className="w-3 h-3 shrink-0" strokeWidth={1.5} />
            <span className="truncate">{r.source}</span>
            {hasPdf && (
              <span className="ml-1 inline-flex items-center gap-1 text-[#0071E3] group-hover:text-[#0077ED]">
                <ExternalLink className="w-3 h-3" strokeWidth={1.75} />
                {r.source_page ? `p. ${r.source_page}` : "open PDF"}
              </span>
            )}
          </div>
        </div>

        {r.numeric_value != null && (
          <div className="text-right shrink-0">
            <div className="font-display text-3xl font-semibold tabular-nums tracking-tighter text-[#1D1D1F]">{r.numeric_value}</div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-[#86868B] font-medium">{r.numeric_unit}</div>
          </div>
        )}

        {roomId && (
          <button type="button" onClick={onPin}
                  className="opacity-0 group-hover:opacity-100 text-[#86868B] hover:text-[#0071E3] transition-opacity shrink-0"
                  title={pinned ? "Detach from this room" : "Pin to this room only"}
                  data-testid={`pin-${r.rule_id}`}>
            {pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Propose-rule dialog (goes to review queue via /ingestion/submit) ───── */
function AddRuleDialog({ kind = "rule", onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    rule_id: "", category: "Spatial workflow",
    statement: "", source: "", source_page: "",
    severity_if_violated: "medium", region: "UK",
    tier: kind === "interpretation" ? "context" : "enhanced",
    status: "under_review",
  });

  const submit = async () => {
    if (!form.rule_id || !form.statement || !form.source) {
      toast.error("Rule id, statement and source are required.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        ...form,
        source_page: form.source_page ? Number(form.source_page) : null,
        kind: kind,
        is_custom: true,
        enabled: true,
        scope: "global",
      };
      await api.post("/ingestion/submit", {
        target: "rule",
        payload,
        note: `Proposed via Knowledge Base · ${kind}`,
      });
      toast.success("Sent to the review queue. Reviewers will be notified.");
      setOpen(false);
      setForm((f) => ({ ...f, rule_id: "", statement: "", source: "", source_page: "" }));
      onDone && onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Submit failed");
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-10 rounded-full border-black/10 hover:bg-white text-sm"
                data-testid={`propose-${kind}`}>
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Propose {kind === "interpretation" ? "interpretation" : "rule"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-semibold tracking-tight">
            Propose {kind === "interpretation" ? "an interpretation" : "a rule"}
          </DialogTitle>
        </DialogHeader>
        <div className="text-xs text-[#86868B] leading-relaxed">
          Anyone can submit. Reviewers must approve before it's adopted. If reviewers have notifications on, they will be alerted.
        </div>
        <div className="space-y-3 mt-2">
          <F label="ID (short code, e.g. CUSTOM-01)">
            <Input value={form.rule_id} onChange={(e) => setForm({ ...form, rule_id: e.target.value })} className="rounded-lg" data-testid="rule-id" />
          </F>
          <F label="Statement">
            <Textarea value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} rows={3} className="rounded-lg" data-testid="rule-statement" />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Category">
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm">
                {["Spatial workflow","Ventilation","Plumbing & bioburden","Materiality & finishes","Lighting & electrical safety","Acoustics & vibration","Interpretation notes"].map(c => <option key={c}>{c}</option>)}
              </select>
            </F>
            <F label="Severity">
              <select value={form.severity_if_violated} onChange={(e) => setForm({ ...form, severity_if_violated: e.target.value })} className="h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm">
                {["low","medium","high"].map(c => <option key={c}>{c}</option>)}
              </select>
            </F>
          </div>
          <F label="Source citation (document name)">
            <Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="e.g. WHO WASH FIT 2022" className="rounded-lg" data-testid="rule-source" />
          </F>
          <F label="Source page (optional)">
            <Input type="number" value={form.source_page} onChange={(e) => setForm({ ...form, source_page: e.target.value })} className="rounded-lg" data-testid="rule-page" />
          </F>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} className="rounded-full">Cancel</Button>
          <Button disabled={busy} onClick={submit} className="rounded-full hb-btn-primary" data-testid="rule-submit">
            {busy ? "Submitting…" : "Send to review"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function F({ label, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.22em] text-[#86868B] font-medium mb-1">{label}</div>
      {children}
    </div>
  );
}

/**
 * KB Import/Export controls — two small buttons next to the KB search
 * bar. Exports every rule/interpretation/submission the current user
 * authored as a JSON bundle they can move to another session or share
 * with a colleague. Import replays that bundle into the current session.
 */
function KnowledgeIO({ onImport }) {
  const fileRef = useRef(null);
  const doExport = async () => {
    try {
      const r = await api.get("/knowledge/export");
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
      saveBlob(blob, brandedName("Knowledge", "export", "json"));
      const counts = { r: (r.data.rules || []).length, i: (r.data.interpretations || []).length, s: (r.data.submissions || []).length };
      toast.success(`Exported ${counts.r} rule(s), ${counts.i} interp(s), ${counts.s} submission(s)`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Export failed");
    }
  };
  const doImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const r = await api.post("/knowledge/import", bundle);
      const c = r.data.counts || {};
      toast.success(`Imported ${c.rules || 0} rule(s), ${c.interpretations || 0} interp(s), ${c.submissions || 0} submission(s)${c.skipped ? ` · ${c.skipped} skipped` : ""}`);
      onImport && onImport();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || "Import failed");
    }
  };
  return (
    <div className="flex items-center gap-2">
      <input type="file" accept="application/json" ref={fileRef} className="hidden" onChange={doImport} data-testid="kb-import-file" />
      <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}
              className="h-9 rounded-full border-black/10" data-testid="kb-import">
        Import
      </Button>
      <Button variant="outline" size="sm" onClick={doExport}
              className="h-9 rounded-full border-black/10" data-testid="kb-export">
        Export
      </Button>
    </div>
  );
}



/* ─────────────────────────── Adjacency v3 panel ───────────────────────────
 * Renders the v3 spec bundle (`/api/adjacency/v3`) as three browsable
 * sections: 29 role-based relations, 7 invariants that hold across every
 * observed layout, and 9 profile deltas showing where HBN and NHP V2
 * diverge. Every relation carries an evidence tier badge so IPC leads
 * see at a glance which findings carry NHS Baseline weight.
 * ──────────────────────────────────────────────────────────────────── */
const V3_TIER = {
  stated:    { label: "STATED",    cls: "bg-[#FBEDE9] text-[#B15A4F] border-[#C97567]/30",
               help: "Verbatim in HBN or NHP RDS — fails validation with a hard FAIL." },
  invariant: { label: "INVARIANT", cls: "bg-[#E9F1FB] text-[#3B6BB1] border-[#7DA3D6]/40",
               help: "Holds across every observed HBN + NHP layout — surfaced as an advisory." },
  inferred:  { label: "INFERRED",  cls: "bg-[#FFF6E5] text-[#B87A2B] border-[#DBA362]/40",
               help: "Methodological derivation from the spec — surfaced as an advisory for reviewer judgement." },
};
const V3_DRIVER = {
  INF:  "Infection", WF: "Workflow", ERG: "Ergonomics", MAINT: "Maintenance", MNT: "Maintenance",
  ACC: "Access", SVC: "Services", AIR: "Air", SEC: "Security", OTH: "Other",
};

function AdjacencyV3Panel({ bundle, query = "" }) {
  if (!bundle) {
    return <div className="text-sm text-[#86868B]">Loading v3 adjacency bundle…</div>;
  }
  const q = (query || "").trim().toLowerCase();
  const match = (obj, extra = "") => {
    if (!q) return true;
    return JSON.stringify(obj).toLowerCase().includes(q) || String(extra).toLowerCase().includes(q);
  };
  const relations  = (bundle.relations  || []).filter((r) => match(r, r.id));
  const invariants = (bundle.invariants || []).filter((i) => match(i, i.id));
  const deltas     = (bundle.profile_deltas || []).filter((d) => match(d, d.id));

  return (
    <div className="space-y-14" data-testid="adjacency-v3-panel">
      {/* ─── Header + tier legend ─── */}
      <div className="flex flex-wrap items-center gap-2 pb-1">
        <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mr-2">
          Evidence tiers
        </div>
        {Object.entries(V3_TIER).map(([k, t]) => (
          <span key={k}
                title={t.help}
                className={`font-mono text-[10px] uppercase tracking-[0.24em] px-2 py-1 rounded-full border ${t.cls}`}>
            {t.label}
          </span>
        ))}
        <div className="ml-auto text-[11px] text-[#86868B]">
          Source: <span className="font-medium text-[#1D1D1F]">dirty_utility_adjacency_logic_{bundle.version}</span>
        </div>
      </div>

      {/* ─── Invariants ─── */}
      <section>
        <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-4">
          Invariants · {invariants.length}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {invariants.map((inv) => (
            <div key={inv.id}
                 data-testid={`v3-invariant-${inv.id}`}
                 className="bg-white rounded-2xl p-5 border border-black/5 shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-[10px] text-[#86868B] tracking-wider">{inv.id}</span>
                <span className={`font-mono text-[10px] uppercase tracking-[0.24em] px-2 py-0.5 rounded-full border ${V3_TIER.invariant.cls}`}>
                  INVARIANT
                </span>
              </div>
              <div className="text-sm text-[#1D1D1F] leading-snug mb-3">{inv.text}</div>
              {inv.observed && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  {Object.entries(inv.observed).map(([k, v]) => (
                    <div key={k} className="bg-[#F5F5F7] rounded-lg px-2 py-1.5">
                      <div className="text-[9px] uppercase tracking-[0.2em] text-[#86868B] font-medium">{k}</div>
                      <div className="text-[12px] text-[#1D1D1F] font-mono mt-0.5">{String(v)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ─── Profile Deltas ─── */}
      <section>
        <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-4">
          Profile deltas · HBN vs NHP V2 · {deltas.length}
        </div>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full min-w-[720px] text-sm border-separate border-spacing-y-1.5 px-2">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.22em] text-[#86868B]">
                <th className="px-3 py-2 w-16">ID</th>
                <th className="px-3 py-2">Delta</th>
                <th className="px-3 py-2">HBN</th>
                <th className="px-3 py-2">NHP V2</th>
                <th className="px-3 py-2">Rationale</th>
              </tr>
            </thead>
            <tbody>
              {deltas.map((d) => (
                <tr key={d.id} data-testid={`v3-delta-${d.id}`}
                    className="bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-2xl">
                  <td className="px-3 py-3 font-mono text-[10px] text-[#86868B] rounded-l-2xl">{d.id}</td>
                  <td className="px-3 py-3 font-medium text-[#1D1D1F]">{d.delta}</td>
                  <td className="px-3 py-3 text-[#4A4A50]">{d.HBN}</td>
                  <td className="px-3 py-3 text-[#4A4A50]">{d.NHP_V2}</td>
                  <td className="px-3 py-3 text-[11px] text-[#86868B] leading-snug rounded-r-2xl">{d.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ─── Relations (grouped by tier) ─── */}
      <section>
        <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-4">
          Relations · {relations.length}
        </div>
        {["stated", "invariant", "inferred"].map((tKey) => {
          const group = relations.filter((r) => (r.tier || "inferred") === tKey);
          if (!group.length) return null;
          const t = V3_TIER[tKey];
          return (
            <div key={tKey} className="mb-8">
              <div className="flex items-baseline gap-3 mb-3">
                <span className={`font-mono text-[10px] uppercase tracking-[0.24em] px-2 py-1 rounded-full border ${t.cls}`}>
                  {t.label}
                </span>
                <span className="text-[11px] text-[#86868B]">{t.help}</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {group.map((r) => (
                  <div key={r.id}
                       data-testid={`v3-relation-${r.id}`}
                       className="bg-white rounded-2xl p-5 border border-black/5 shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="font-mono text-[10px] text-[#86868B] tracking-wider">{r.id}</span>
                      <span className="text-[11px] text-[#86868B]">·</span>
                      <span className="text-[11px] uppercase tracking-[0.22em] font-medium text-[#1D1D1F]">{r.kind}</span>
                      {r.profile && (
                        <span className="ml-auto text-[9px] uppercase tracking-[0.22em] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                          {r.profile}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-[#1D1D1F] font-medium leading-snug mb-2">
                      {(r.roles || []).join("  ↔  ")}
                      {r.threshold_mm != null && (
                        <span className="ml-2 font-mono text-[11px] text-[#86868B]">
                          {r.kind === "far" ? "≥" : r.kind === "near" || r.kind === "touching" ? "≤" : ""}
                          {" "}{r.threshold_mm} mm
                        </span>
                      )}
                    </div>
                    {r.note && (
                      <div className="text-[11px] text-[#86868B] leading-snug mb-2">{r.note}</div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap mt-2">
                      {(r.driver || []).map((d) => (
                        <span key={d} className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#4A4A50] bg-[#F5F5F7] rounded-full px-2 py-0.5">
                          {V3_DRIVER[d] || d}
                        </span>
                      ))}
                      {r.source && (
                        <span className="ml-auto text-[10px] text-[#86868B] italic truncate max-w-xs" title={r.source}>
                          {r.source}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
