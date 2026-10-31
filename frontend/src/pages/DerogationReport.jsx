import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/apiClient";
import { downloadExport, brandedName } from "@/lib/download";
import { toast } from "sonner";
import { TopBar } from "./Dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Search, FileText, FileSpreadsheet, ChevronDown, ShieldAlert, ShieldCheck, PenLine, X } from "lucide-react";
import { Link } from "react-router-dom";

const STATUS_TINT = {
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending:  "bg-amber-50   text-amber-700   border-amber-200",
  rejected: "bg-rose-50    text-rose-700    border-rose-200",
};
const TIER_TINT = {
  baseline: "bg-rose-50    text-rose-700",
  v2:       "bg-amber-50   text-amber-800",
  best:     "bg-sky-50     text-sky-700",
  context:  "bg-slate-50   text-slate-700",
  review:   "bg-violet-50  text-violet-700",
};

export default function DerogationReport({ embedded = false }) {
  const { user, logout } = useAuth();
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ total: 0, approved: 0, pending: 0, rejected: 0 });
  const [facets, setFacets] = useState({ hospitals: [], wards: [] });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [hospital, setHospital] = useState("all");
  const [ward, setWard] = useState("all");
  const [exportOpen, setExportOpen] = useState(false);
  const [latestSig, setLatestSig] = useState(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyToken, setVerifyToken] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);
  const [signing, setSigning] = useState(false);

  // Load latest signature applicable to the current filter (so the UI can
  // show "last signed …" and pre-select it for exports).
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get("/estate/derogation-report/signatures");
        const sigs = r.data || [];
        const match = sigs.find((s) => (
          (s.filter?.hospital || "") === (hospital === "all" ? "" : hospital) &&
          (s.filter?.ward     || "") === (ward     === "all" ? "" : ward) &&
          (s.filter?.status   || "") === (status   === "all" ? "" : status)
        )) || null;
        setLatestSig(match);
      } catch { /* ignore */ }
    })();
  }, [hospital, ward, status, rows.length]);

  const signReport = async () => {
    setSigning(true);
    try {
      const params = new URLSearchParams();
      if (status !== "all")   params.set("status",   status);
      if (hospital !== "all") params.set("hospital", hospital);
      if (ward !== "all")     params.set("ward",     ward);
      const r = await api.post(`/estate/derogation-report/sign?${params.toString()}`);
      setLatestSig(r.data);
    } finally { setSigning(false); }
  };

  const verify = async () => {
    if (!verifyToken.trim()) return;
    try {
      const r = await api.post("/estate/derogation-report/verify",
        { token: verifyToken.trim() });
      setVerifyResult(r.data);
    } catch (e) {
      setVerifyResult({ valid: false, reason: "Verification failed" });
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      const params = new URLSearchParams();
      if (status !== "all")   params.set("status",   status);
      if (hospital !== "all") params.set("hospital", hospital);
      if (ward !== "all")     params.set("ward",     ward);
      const r = await api.get(`/estate/derogation-report?${params.toString()}`);
      const d = r.data;
      setRows(d.rows || []); setCounts(d.counts || { total: 0, approved: 0, pending: 0, rejected: 0 });
      setFacets(d.facets || { hospitals: [], wards: [] });
      setLoading(false);
    })();
  }, [status, hospital, ward]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) =>
      (r.room || "").toLowerCase().includes(s) ||
      (r.rule_id || "").toLowerCase().includes(s) ||
      (r.rule_statement || "").toLowerCase().includes(s) ||
      (r.justification || "").toLowerCase().includes(s) ||
      (r.requested_by || "").toLowerCase().includes(s)
    );
  }, [rows, q]);

  const grouped = useMemo(() => {
    const g = {};
    for (const r of filtered) {
      const h = r.hospital || "—";
      const w = r.ward     || "—";
      g[h] = g[h] || {};
      g[h][w] = g[h][w] || [];
      g[h][w].push(r);
    }
    return g;
  }, [filtered]);

  const download = async (ext, opts = {}) => {
    const p = new URLSearchParams();
    if (status !== "all")   p.set("status",   status);
    if (hospital !== "all") p.set("hospital", hospital);
    if (ward !== "all")     p.set("ward",     ward);
    if (opts.signed && latestSig) p.set("signature_id", latestSig.id);
    setExportOpen(false);
    try {
      await downloadExport(`/estate/derogation-report.${ext}?${p.toString()}`,
        { fallbackName: brandedName("Estate", "derogation-report", ext) });
    } catch { toast.error("Export failed"); }
  };

  return (
    <div className={embedded ? "" : "min-h-screen bg-[#FAFAFB] text-[#1D1D1F]"}>
      {!embedded && <TopBar user={user} onLogout={logout} />}
      <div className={embedded ? "" : "max-w-7xl mx-auto px-8 pt-10 pb-24"}>
        {/* Header — hidden when embedded because KnowledgeBase already has one. */}
        <div className={`flex items-end justify-between ${embedded ? "mb-4" : "mb-8"}`}>
          {!embedded ? (
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-2">
                Estate-wide compliance record
              </div>
              <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-none">
                Derogation Report
              </h1>
              <p className="mt-3 text-sm text-[#6E6E73] max-w-2xl">
                Every rule waiver requested across the estate, grouped by hospital and ward.
                Filter, search, or export the record as a signed PDF or XLSX for auditors.
              </p>
            </div>
          ) : <div />}
          <div className="flex items-center gap-2">
            {latestSig && (
              <div className="hidden md:flex items-center gap-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5"
                   data-testid="latest-signature-chip">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Signed {fmt(latestSig.signed_at)} · {latestSig.signed_by}</span>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => setVerifyOpen(true)}
                    data-testid="open-verify" className="h-10 rounded-full">
              Verify
            </Button>
            <Button size="sm" onClick={signReport} disabled={signing}
                    data-testid="sign-report" className="h-10 rounded-full bg-[#1D1D1F] hover:bg-black text-white">
              <PenLine className="w-3.5 h-3.5 mr-1.5" />
              {signing ? "Signing…" : latestSig ? "Re-sign" : "Sign report"}
            </Button>
            <ExportDropdown open={exportOpen} setOpen={setExportOpen}
                            onExport={download} hasSignature={!!latestSig} />
          </div>
        </div>

        {/* Metric strip */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <MetricChip label="Total records" value={counts.total} testId="metric-total" />
          <MetricChip label="Approved"      value={counts.approved} testId="metric-approved" accent="emerald" />
          <MetricChip label="Pending"       value={counts.pending}  testId="metric-pending"  accent="amber" />
          <MetricChip label="Rejected"      value={counts.rejected} testId="metric-rejected" accent="rose" />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Search room, rule, justification…"
                   data-testid="derog-search"
                   className="pl-9 h-10 w-80 rounded-full bg-white border-black/10 text-sm" />
          </div>
          <FacetSelect label="Hospital" value={hospital} onChange={setHospital}
                       options={facets.hospitals} testId="filter-hospital" />
          <FacetSelect label="Ward" value={ward} onChange={setWard}
                       options={facets.wards} testId="filter-ward" />
          <FacetSelect label="Status" value={status} onChange={setStatus}
                       options={["approved", "pending", "rejected"]} testId="filter-status" />
          {(q || status !== "all" || hospital !== "all" || ward !== "all") && (
            <button onClick={() => { setQ(""); setStatus("all"); setHospital("all"); setWard("all"); }}
                    className="text-[11px] uppercase tracking-[0.2em] text-[#6E6E73] hover:text-[#1D1D1F] px-3"
                    data-testid="clear-filters">Clear</button>
          )}
        </div>

        {/* Rows grouped by hospital → ward */}
        {loading ? (
          <div className="font-mono text-xs uppercase tracking-[0.3em] text-slate-400 py-16 text-center">
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-8" data-testid="derog-groups">
            {Object.keys(grouped).sort().map((hosp) => (
              <div key={hosp}>
                <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-3">
                  {hosp} · {Object.values(grouped[hosp]).reduce((a, b) => a + b.length, 0)}
                </div>
                {Object.keys(grouped[hosp]).sort().map((w) => (
                  <div key={w} className="mb-6">
                    <div className="text-sm font-medium text-[#1D1D1F] mb-2">{w}</div>
                    <div className="rounded-2xl border border-black/5 bg-white overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FAFAFB] text-[10px] uppercase tracking-[0.18em] text-[#86868B]">
                          <tr>
                            <th className="text-left px-4 py-2 font-medium">Room</th>
                            <th className="text-left px-4 py-2 font-medium">Rule</th>
                            <th className="text-left px-4 py-2 font-medium">Tier</th>
                            <th className="text-left px-4 py-2 font-medium">Status</th>
                            <th className="text-left px-4 py-2 font-medium">Justification</th>
                            <th className="text-left px-4 py-2 font-medium">Requested by</th>
                            <th className="text-left px-4 py-2 font-medium">Approver</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-black/5">
                          {grouped[hosp][w].map((r) => (
                            <tr key={r.id} className="hover:bg-[#FAFAFB]" data-testid={`derog-row-${r.id}`}>
                              <td className="px-4 py-3">
                                <Link to={`/room/${r.room_id}`}
                                      className="font-medium hover:underline">{r.room}</Link>
                              </td>
                              <td className="px-4 py-3">
                                <div className="font-mono text-[11px]">{r.rule_id}</div>
                                <div className="text-[11px] text-[#6E6E73] max-w-md line-clamp-2 mt-0.5">
                                  {r.rule_statement}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span className={`text-[10px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-full ${TIER_TINT[r.rule_tier] || "bg-slate-50 text-slate-700"}`}>
                                  {r.rule_tier || "—"}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <span className={`text-[10px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-full border ${STATUS_TINT[r.status] || "bg-slate-50 text-slate-700 border-slate-200"}`}>
                                  {r.status}
                                </span>
                              </td>
                              <td className="px-4 py-3 max-w-md">
                                <div className="text-[13px] text-[#1D1D1F] line-clamp-3">{r.justification}</div>
                                {r.reviewer_note && (
                                  <div className="mt-1 text-[11px] text-[#6E6E73] italic">
                                    Reviewer: {r.reviewer_note}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-[12px] text-[#6E6E73]">
                                {r.requested_by}
                                <div className="text-[10px] mt-0.5">{fmt(r.created_at)}</div>
                              </td>
                              <td className="px-4 py-3 text-[12px] text-[#6E6E73]">
                                {r.approved_by || "—"}
                                {r.approved_at && <div className="text-[10px] mt-0.5">{fmt(r.approved_at)}</div>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Verify signature modal */}
      {verifyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
             data-testid="verify-modal"
             onClick={(e) => { if (e.target === e.currentTarget) { setVerifyOpen(false); setVerifyResult(null); } }}>
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-black/5">
              <div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-[#86868B] font-medium">HMAC-SHA256</div>
                <div className="text-lg font-semibold tracking-tight">Verify signature</div>
              </div>
              <button onClick={() => { setVerifyOpen(false); setVerifyResult(null); }}
                      className="text-[#86868B] hover:text-[#1D1D1F]"
                      data-testid="close-verify"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="text-[11px] uppercase tracking-[0.2em] text-[#86868B]">Paste signature token</label>
                <Input value={verifyToken} onChange={(e) => setVerifyToken(e.target.value)}
                       placeholder="e.g. tGfyqwh7q8UwWmxvCbkEut1041ujQWLIklMsFYYobn8"
                       data-testid="verify-token-input"
                       className="mt-1.5 font-mono text-xs" />
              </div>
              <Button onClick={verify} data-testid="verify-submit"
                      className="rounded-full bg-[#1D1D1F] hover:bg-black text-white">
                Verify
              </Button>
              {verifyResult && (
                <div className={`rounded-xl p-4 border ${verifyResult.valid
                  ? (verifyResult.tampered ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200")
                  : "bg-rose-50 border-rose-200"}`}
                  data-testid="verify-result">
                  <div className="flex items-center gap-2 mb-2">
                    {verifyResult.valid && !verifyResult.tampered && <ShieldCheck className="w-4 h-4 text-emerald-700" />}
                    {verifyResult.valid && verifyResult.tampered && <ShieldAlert className="w-4 h-4 text-amber-700" />}
                    {!verifyResult.valid && <ShieldAlert className="w-4 h-4 text-rose-700" />}
                    <span className={`text-sm font-medium ${
                      !verifyResult.valid ? "text-rose-800"
                      : verifyResult.tampered ? "text-amber-800" : "text-emerald-800"}`}>
                      {!verifyResult.valid ? "Signature invalid"
                        : verifyResult.tampered ? "Signature valid but data has changed" : "Signature valid"}
                    </span>
                  </div>
                  {verifyResult.valid && (
                    <div className="text-[12px] text-[#1D1D1F] space-y-0.5">
                      <div><span className="text-[#6E6E73]">Signed by:</span> {verifyResult.signed_by}</div>
                      <div><span className="text-[#6E6E73]">Signed at:</span> {fmt(verifyResult.signed_at)}</div>
                      <div><span className="text-[#6E6E73]">Records signed:</span> {verifyResult.row_count_signed}</div>
                      <div className="font-mono text-[10px] mt-1 text-[#6E6E73]">
                        signed hash: {verifyResult.body_hash_signed} · current hash: {verifyResult.body_hash_now}
                      </div>
                    </div>
                  )}
                  {!verifyResult.valid && (
                    <div className="text-[12px] text-rose-700">{verifyResult.reason || "Token not recognised."}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fmt(iso) {
  if (!iso) return "";
  try { return new Date(iso).toISOString().slice(0, 16).replace("T", " "); }
  catch { return iso.slice(0, 16); }
}

function MetricChip({ label, value, accent, testId }) {
  const c = accent === "emerald" ? "text-emerald-700"
          : accent === "amber"   ? "text-amber-700"
          : accent === "rose"    ? "text-rose-700"
          : "text-[#1D1D1F]";
  return (
    <div className="rounded-2xl bg-white border border-black/5 p-4" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tracking-tight tabular-nums ${c}`}>{value}</div>
    </div>
  );
}

function FacetSelect({ label, value, onChange, options, testId }) {
  const plural = label === "Status" ? "statuses"
             : label === "Ward"   ? "wards"
             : label === "Hospital" ? "hospitals"
             : `${label.toLowerCase()}s`;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-10 w-52 rounded-full bg-white border-black/10 text-sm"
                     data-testid={testId}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {plural}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>{o}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ExportDropdown({ open, setOpen, onExport, hasSignature }) {
  return (
    <div className="relative">
      <Button variant="outline" size="sm"
              onClick={() => setOpen(!open)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              data-testid="export-derog-report"
              className="h-10 rounded-full px-4">
        Export <ChevronDown className="w-3 h-3 ml-1.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-12 w-64 bg-white rounded-xl border border-black/5 shadow-[0_10px_32px_rgba(0,0,0,0.14)] py-1 z-50"
             data-testid="export-derog-menu">
          <button onMouseDown={() => onExport("pdf")}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F]"
                  data-testid="dl-derog-pdf">
            <FileText className="w-3 h-3 mr-1.5 inline" /> PDF
          </button>
          <button onMouseDown={() => onExport("xlsx")}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F]"
                  data-testid="dl-derog-xlsx">
            <FileSpreadsheet className="w-3 h-3 mr-1.5 inline" /> Excel (.xlsx)
          </button>
          <div className="h-px bg-black/5 my-1" />
          <button onMouseDown={() => onExport("pdf", { signed: true })}
                  disabled={!hasSignature}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F] disabled:opacity-40 disabled:cursor-not-allowed flex items-center"
                  data-testid="dl-derog-pdf-signed">
            <ShieldCheck className="w-3 h-3 mr-1.5 inline text-emerald-600" />
            Signed PDF {!hasSignature && <span className="ml-auto text-[10px] text-[#86868B]">Sign first</span>}
          </button>
          <button onMouseDown={() => onExport("xlsx", { signed: true })}
                  disabled={!hasSignature}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#F5F5F7] text-[#1D1D1F] disabled:opacity-40 disabled:cursor-not-allowed flex items-center"
                  data-testid="dl-derog-xlsx-signed">
            <ShieldCheck className="w-3 h-3 mr-1.5 inline text-emerald-600" />
            Signed Excel {!hasSignature && <span className="ml-auto text-[10px] text-[#86868B]">Sign first</span>}
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-black/10 bg-white/40 p-16 text-center"
         data-testid="derog-empty">
      <ShieldAlert className="w-8 h-8 mx-auto text-[#86868B] mb-3" />
      <div className="text-sm font-medium text-[#1D1D1F]">No derogation records</div>
      <div className="text-[12px] text-[#6E6E73] mt-1 max-w-md mx-auto">
        Waivers are logged whenever a reviewer bypasses a rule flag from a room's Checks tab.
        Submit or approve one to see it here.
      </div>
    </div>
  );
}
