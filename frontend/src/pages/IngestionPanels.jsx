/*
 * IngestionPanels.jsx — reusable pieces of the ingestion pipeline surfaced
 * inside the Knowledge Base page. Previously lived on their own /ingestion
 * route; consolidated here so the entire "add / review new knowledge" flow
 * lives next to the rules & components it feeds. The three panels are:
 *
 *   <PDFExtractPanel />    Upload a standards PDF and let Gemini pull out
 *                          candidate rules; each is submitted individually.
 *   <SubmitFormPanel />    Manually author a new rule or component.
 *   <ReviewQueuePanel />   List of pending / published / rejected submissions
 *                          with approve/reject controls (reviewer-gated).
 */

import React, { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Clock, Upload, FileText, Loader2 } from "lucide-react";

const STATE_TINT = {
  pending_review: { label: "Pending",   cls: "text-[#FF9500] bg-[#FFF4E5] border-[#FF9500]/30", icon: Clock },
  published:      { label: "Published", cls: "text-[#34C759] bg-[#E8F8EE] border-[#34C759]/30", icon: CheckCircle2 },
  rejected:       { label: "Rejected",  cls: "text-[#FF3B30] bg-[#FFEBEE] border-[#FF3B30]/30", icon: XCircle },
};

/* ---------- PDF extractor ---------- */
export function PDFExtractPanel({ onSubmitted }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState({});

  const upload = async (e) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api.post("/ingestion/pdf-extract", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setResult(r.data);
      toast.success(`Extracted ${r.data.candidates.length} candidate rule(s)`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Extraction failed");
    }
    setBusy(false);
  };

  const submitCandidate = async (c) => {
    setSubmitting((s) => ({ ...s, [c._preview_id]: true }));
    try {
      const { _preview_id, ...payload } = c;
      payload.source = payload.source || `Extracted from ${result.source_file}`;
      await api.post("/ingestion/submit", {
        target: "rule", payload, note: `Extracted from PDF ${result.source_file}`,
      });
      toast.success(`Submitted "${c.rule_id}" for review`);
      setResult((r) => ({ ...r, candidates: r.candidates.filter((x) => x._preview_id !== c._preview_id) }));
      onSubmitted && onSubmitted();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Submit failed");
    }
    setSubmitting((s) => ({ ...s, [c._preview_id]: false }));
  };

  return (
    <form onSubmit={upload} className="bg-white rounded-3xl border border-black/5 shadow-[0_2px_16px_rgba(0,0,0,0.03)] p-8" data-testid="pdf-form">
      <div className="flex items-center gap-2 mb-1">
        <FileText className="w-4 h-4 text-[#86868B]" />
        <div className="font-display text-xl font-semibold tracking-tight text-[#1D1D1F]">Extract rules from PDF</div>
      </div>
      <p className="text-sm text-[#86868B] mb-5 leading-relaxed">
        Upload NHS HBN/HTM, ASHRAE, FGI or WHO documents. Gemini extracts candidate rules — you approve each individually. Never auto-published.
      </p>

      <label htmlFor="pdf-input"
        className={`block w-full h-24 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
          file ? "border-slate-900 bg-slate-50" : "border-slate-300 hover:border-slate-500 bg-white"
        } flex flex-col items-center justify-center text-center px-4`}
        data-testid="pdf-drop">
        <Upload className="w-5 h-5 text-slate-500 mb-1" />
        <div className="text-xs font-mono text-slate-600 truncate max-w-full">
          {file ? file.name : "Click to select a PDF"}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-slate-400 mt-0.5">Max 25 MB</div>
      </label>
      <input id="pdf-input" type="file" accept="application/pdf" className="hidden"
             onChange={(e) => setFile(e.target.files?.[0] || null)}
             data-testid="pdf-input" />

      <Button type="submit" disabled={busy || !file}
              className="mt-5 w-full h-11 rounded-full hb-btn-primary" data-testid="pdf-extract-submit">
        {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Extracting with Gemini…</> : "Extract candidate rules"}
      </Button>

      {result && (
        <div className="mt-6">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500 mb-2">Candidates · {result.candidates.length}</div>
          <div className="space-y-2 max-h-[520px] overflow-auto pr-1 hb-scroll">
            {result.candidates.map((c) => (
              <div key={c._preview_id} className="p-3 rounded-lg bg-white border border-slate-200" data-testid={`cand-${c.rule_id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-slate-700">{c.rule_id}</div>
                      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-400">{c.category}</div>
                      {c.numeric_value != null && (
                        <div className="font-mono text-[10px] text-slate-700">
                          {c.numeric_value}{c.numeric_unit ? ` ${c.numeric_unit}` : ""}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-slate-800 mt-1 leading-snug">{c.statement}</div>
                    <div className="font-mono text-[10px] text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                      <span>↳ {c.source}</span>
                      {c.source_page != null && c.source_url && (
                        <a href={`${c.source_url}#page=${c.source_page}`}
                           target="_blank" rel="noopener noreferrer"
                           className="text-[#0071E3] hover:text-[#0077ED]"
                           onClick={(e) => e.stopPropagation()}
                           data-testid={`cand-pdf-${c.rule_id}`}>
                          p. {c.source_page} ↗
                        </a>
                      )}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => submitCandidate(c)}
                          disabled={submitting[c._preview_id]}
                          className="h-8 rounded-full bg-slate-900 hover:bg-slate-800 shrink-0"
                          data-testid={`cand-submit-${c.rule_id}`}>
                    {submitting[c._preview_id] ? "…" : "Submit"}
                  </Button>
                </div>
              </div>
            ))}
            {result.candidates.length === 0 && (
              <div className="text-xs text-slate-400 font-mono text-center py-4">All candidates submitted.</div>
            )}
          </div>
        </div>
      )}
    </form>
  );
}

/* ---------- Manual rule / component submit ---------- */
export function SubmitFormPanel({ onDone }) {
  const [target, setTarget] = useState("rule");
  const [busy, setBusy] = useState(false);
  const [rf, setRf] = useState({
    rule_id: "", category: "Ventilation", statement: "", source: "", region: "UK",
    status: "current_nhs_baseline", severity_if_violated: "medium",
    numeric_value: "", numeric_unit: "",
  });
  const [cf, setCf] = useState({
    key: "", name: "", zone_affinity: "clean", w: 0.6, d: 0.6, h: 0.9,
    description: "", source: "",
  });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = target === "rule"
        ? { ...rf, numeric_value: rf.numeric_value ? Number(rf.numeric_value) : null,
             applies_to_zone: [], applies_to_components: [], comparator_standards: [] }
        : { key: cf.key, name: cf.name, zone_affinity: cf.zone_affinity,
             default_footprint: { w: Number(cf.w), d: Number(cf.d), h: Number(cf.h) },
             description: cf.description, source: cf.source, rule_ids: [] };
      await api.post("/ingestion/submit", { target, payload });
      toast.success("Submitted for review");
      onDone && onDone();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed");
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="bg-white rounded-3xl border border-black/5 shadow-[0_2px_16px_rgba(0,0,0,0.03)] p-8" data-testid="ingest-form">
      <div className="font-display text-xl font-semibold tracking-tight text-[#1D1D1F] mb-5">New submission</div>
      <div className="mb-4">
        <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B] font-medium">Target</Label>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger className="mt-2 rounded-xl bg-white" data-testid="ingest-target"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="rule">Rule</SelectItem>
            <SelectItem value="component">Component</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {target === "rule" ? (
        <>
          <Row label="Rule ID"><Input value={rf.rule_id} onChange={(e)=>setRf({...rf, rule_id: e.target.value})} placeholder="VENT-003" className="rounded-xl bg-white" data-testid="rf-id" /></Row>
          <Row label="Category">
            <Select value={rf.category} onValueChange={(v) => setRf({...rf, category: v})}>
              <SelectTrigger className="rounded-xl bg-white" data-testid="rf-cat"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["Spatial workflow","Ventilation","Materiality & finishes","Plumbing & bioburden","Acoustics & vibration","Lighting & electrical safety"].map((c)=>
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </Row>
          <Row label="Statement"><Textarea rows={2} value={rf.statement} onChange={(e)=>setRf({...rf, statement: e.target.value})} className="rounded-xl bg-white" data-testid="rf-statement" /></Row>
          <Row label="Source (required)"><Input required value={rf.source} onChange={(e)=>setRf({...rf, source: e.target.value})} placeholder="NHS HBN 00-09" className="rounded-xl bg-white" data-testid="rf-source" /></Row>
          <div className="grid grid-cols-2 gap-3">
            <Row label="Value"><Input value={rf.numeric_value} onChange={(e)=>setRf({...rf, numeric_value: e.target.value})} placeholder="6" className="rounded-xl bg-white" data-testid="rf-val" /></Row>
            <Row label="Unit"><Input value={rf.numeric_unit} onChange={(e)=>setRf({...rf, numeric_unit: e.target.value})} placeholder="ACH" className="rounded-xl bg-white" data-testid="rf-unit" /></Row>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Row label="Status">
              <Select value={rf.status} onValueChange={(v)=>setRf({...rf, status: v})}>
                <SelectTrigger className="rounded-xl bg-white" data-testid="rf-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="current_nhs_baseline">Current NHS baseline</SelectItem>
                  <SelectItem value="under_review">Under review</SelectItem>
                  <SelectItem value="international_comparator">International comparator</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Severity">
              <Select value={rf.severity_if_violated} onValueChange={(v)=>setRf({...rf, severity_if_violated: v})}>
                <SelectTrigger className="rounded-xl bg-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </div>
        </>
      ) : (
        <>
          <Row label="Key"><Input value={cf.key} onChange={(e)=>setCf({...cf, key: e.target.value})} placeholder="uv_sterilizer" className="rounded-xl bg-white" data-testid="cf-key" /></Row>
          <Row label="Name"><Input value={cf.name} onChange={(e)=>setCf({...cf, name: e.target.value})} className="rounded-xl bg-white" data-testid="cf-name" /></Row>
          <Row label="Zone affinity">
            <Select value={cf.zone_affinity} onValueChange={(v)=>setCf({...cf, zone_affinity: v})}>
              <SelectTrigger className="rounded-xl bg-white" data-testid="cf-zone"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="clean">Clean</SelectItem>
                <SelectItem value="transition">Transition</SelectItem>
                <SelectItem value="dirty">Dirty</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <div className="grid grid-cols-3 gap-3">
            <Row label="W (m)"><Input value={cf.w} onChange={(e)=>setCf({...cf, w: e.target.value})} className="rounded-xl bg-white" /></Row>
            <Row label="D (m)"><Input value={cf.d} onChange={(e)=>setCf({...cf, d: e.target.value})} className="rounded-xl bg-white" /></Row>
            <Row label="H (m)"><Input value={cf.h} onChange={(e)=>setCf({...cf, h: e.target.value})} className="rounded-xl bg-white" /></Row>
          </div>
          <Row label="Description"><Textarea rows={2} value={cf.description} onChange={(e)=>setCf({...cf, description: e.target.value})} className="rounded-xl bg-white" /></Row>
          <Row label="Source (required)"><Input required value={cf.source} onChange={(e)=>setCf({...cf, source: e.target.value})} className="rounded-xl bg-white" data-testid="cf-source" /></Row>
        </>
      )}

      <Button type="submit" disabled={busy} className="mt-6 w-full h-11 rounded-full hb-btn-primary" data-testid="ingest-submit">
        {busy ? "…" : "Submit for review"}
      </Button>
      <div className="mt-3 text-xs text-[#86868B]">No source, no publish — this is a hard constraint.</div>
    </form>
  );
}

function Row({ label, children }) {
  return (
    <div className="mb-3">
      <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B] font-medium">{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/* ---------- Review queue ---------- */
export function ReviewQueuePanel({ canReview, refreshKey = 0, query = "" }) {
  const [items, setItems] = useState([]);
  const refresh = () => api.get("/ingestion").then((r) => setItems(r.data));
  useEffect(() => { refresh(); }, [refreshKey]);
  const q = (query || "").toLowerCase();
  const matches = (it) => {
    if (!q) return true;
    const hay = [it.target, it.payload?.name, it.payload?.statement, it.payload?.rule_id,
                 it.payload?.source, it.payload?.key, it.submitted_by]
                 .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  };

  const decide = async (id, decision) => {
    try {
      await api.post(`/ingestion/${id}/review`, { decision });
      toast.success(decision === "approve" ? "Published to knowledge base" : "Rejected");
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed");
    }
  };

  return (
    <div className="bg-white rounded-3xl border border-black/5 shadow-[0_2px_16px_rgba(0,0,0,0.03)] p-8">
      <div className="font-display text-xl font-semibold tracking-tight text-[#1D1D1F] mb-5">Review queue</div>
      <Tabs defaultValue="pending_review">
        <TabsList className="bg-[#F5F5F7] rounded-full p-1 h-9 border border-black/5">
          <TabsTrigger value="pending_review" className="text-xs rounded-full px-3" data-testid="tab-pending">Pending</TabsTrigger>
          <TabsTrigger value="published"      className="text-xs rounded-full px-3">Published</TabsTrigger>
          <TabsTrigger value="rejected"       className="text-xs rounded-full px-3">Rejected</TabsTrigger>
        </TabsList>
        {["pending_review", "published", "rejected"].map((state) => (
          <TabsContent key={state} value={state} className="mt-4 space-y-2">
            {items.filter(i => i.state === state && matches(i)).length === 0 && (
              <div className="text-sm text-[#86868B] py-8 text-center">{q ? "No matches." : "Nothing here yet."}</div>
            )}
            {items.filter(i => i.state === state && matches(i)).map((it) => {
              const s = STATE_TINT[it.state];
              const Icon = s.icon;
              return (
                <div key={it.id} className="p-5 rounded-2xl border border-black/5 bg-[#FBFBFD]" data-testid={`sub-${it.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-[0.22em] text-[#1D1D1F] font-medium">{it.target}</span>
                        <span className={`inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.22em] px-2 py-0.5 rounded-full border ${s.cls}`}>
                          <Icon className="w-3 h-3" /> {s.label}
                        </span>
                      </div>
                      <div className="font-display text-base font-semibold tracking-tight mt-2 text-[#1D1D1F] truncate">
                        {it.payload.name || it.payload.statement || it.payload.rule_id || "Untitled"}
                      </div>
                      <div className="text-xs text-[#86868B] mt-1">↳ {it.payload.source || "no source"}</div>
                      <div className="text-[10px] text-[#86868B]/70 mt-0.5">
                        by {it.submitted_by} · {new Date(it.submitted_at).toLocaleString()}
                      </div>
                    </div>
                    {state === "pending_review" && canReview && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => decide(it.id, "reject")}
                                className="h-8 rounded-full border-black/10" data-testid={`reject-${it.id}`}>Reject</Button>
                        <Button size="sm" onClick={() => decide(it.id, "approve")}
                                className="h-8 rounded-full hb-btn-primary" data-testid={`approve-${it.id}`}>Approve</Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
