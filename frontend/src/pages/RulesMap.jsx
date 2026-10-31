import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/context/AuthContext";
import { TopBar } from "@/pages/Dashboard";
import { toast } from "sonner";
import { Search, X, ExternalLink, ShieldCheck, GitPullRequest, Loader2 } from "lucide-react";
import { ROLE_COLOR } from "@/lib/spatial";

const TIER = { baseline: "#C0504D", stated: "#C0504D", enhanced: "#D97706", invariant: "#005EB8", inferred: "#64748B", v2: "#7C3AED" };

function Col({ title, count, children }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-2 px-1">{title} · {count}</div>
      <div className="space-y-1 max-h-[64vh] overflow-y-auto pr-1">{children}</div>
    </div>
  );
}

function Chip({ k, active, dim, onClick, onEnter, onLeave, children, testId }) {
  return (
    <button data-k={k} onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave} data-testid={testId}
      className={`w-full text-left rounded-lg px-2.5 py-1.5 border text-[11.5px] transition-all ${active ? "border-slate-900 bg-white shadow-sm" : "border-transparent bg-white/70 hover:border-slate-300"} ${dim ? "opacity-30" : ""}`}>
      {children}
    </button>
  );
}

function ProposeForm({ rule, onDone }) {
  const [f, setF] = useState({ statement: rule.statement || "", severity_if_violated: rule.severity || "medium", note: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post("/ingestion/submit", { target: "rule", note: f.note, payload: {
        rule_id: rule.id, supersedes_rule_id: rule.id, statement: f.statement, category: rule.category,
        severity_if_violated: f.severity_if_violated, source: rule.source, tier: rule.tier } });
      toast.success("Proposal sent — an admin will review it");
      onDone();
    } catch (e) { toast.error(e.response?.data?.detail || "Could not submit"); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2" data-testid="rules-propose-form">
      <textarea value={f.statement} onChange={(e) => setF({ ...f, statement: e.target.value })} rows={4} data-testid="rules-propose-statement"
        className="w-full rounded-lg border border-slate-300 p-2 text-xs" />
      <div className="flex gap-2">
        <select value={f.severity_if_violated} onChange={(e) => setF({ ...f, severity_if_violated: e.target.value })} data-testid="rules-propose-severity"
          className="h-8 rounded-md border border-slate-300 px-2 text-xs bg-white">
          {["low", "medium", "high"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Why? (evidence, project)" data-testid="rules-propose-note"
          className="flex-1 h-8 rounded-md border border-slate-300 px-2 text-xs" />
      </div>
      <button onClick={submit} disabled={busy || !f.statement.trim()} data-testid="rules-propose-submit"
        className="h-8 px-4 rounded-full bg-slate-900 text-white text-xs disabled:opacity-50">Send for approval</button>
    </div>
  );
}

function Drawer({ rule, comps, canApprove, onClose, onChanged }) {
  const nav = useNavigate();
  const [propose, setPropose] = useState(false);
  const fails = rule.plans.filter((p) => p.status === "fail").length;
  return (
    <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4 sticky top-6" data-testid="rules-drawer">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: TIER[rule.tier] || "#64748B" }}>{rule.code || rule.id} · {rule.tier || "—"} · {rule.category}</div>
          <div className="text-sm text-slate-900 mt-1 leading-snug" data-testid="rules-drawer-statement">{rule.statement}</div>
        </div>
        <button onClick={onClose} data-testid="rules-drawer-close" className="w-7 h-7 rounded-full hover:bg-slate-100 flex items-center justify-center shrink-0"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="text-xs text-slate-600">
        {rule.source}{rule.source_page ? ` · p.${rule.source_page}` : ""}
        {rule.source_url && <a href={rule.source_url} target="_blank" rel="noreferrer" className="ml-1 text-[#0071E3] inline-flex items-center gap-0.5">open <ExternalLink className="w-3 h-3" /></a>}
      </div>
      <div className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-600 space-y-0.5" data-testid="rules-drawer-vetting">
        <div className="flex items-center gap-1 font-medium text-slate-900"><ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Vetting</div>
        <div>Version {rule.version} · {rule.status?.replace(/_/g, " ") || "—"}</div>
        <div>Last reviewed {rule.last_reviewed ? new Date(rule.last_reviewed).toLocaleDateString() : "—"}{rule.reviewed_by ? ` by ${rule.reviewed_by}` : ""}</div>
        {rule.pending_proposals > 0 && <div className="text-amber-700">{rule.pending_proposals} proposed change(s) awaiting admin review</div>}
      </div>
      {rule.targets.length > 0 && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500 mb-1">Applies to</div>
          <div className="flex flex-wrap gap-1">{rule.targets.map((t) => <span key={t} className="px-2 py-0.5 rounded-full bg-slate-100 text-[10.5px]">{comps[t] || t.replace(/_/g, " ")}</span>)}</div>
        </div>
      )}
      <div data-testid="rules-drawer-plans">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500 mb-1">In your plans · {rule.plans.length} checked · {fails} failing</div>
        {rule.plans.length === 0 && <div className="text-[11px] text-slate-500">Not checked in any of your rooms yet — run Validate in a room.</div>}
        {rule.plans.map((p) => (
          <button key={p.room_id} onClick={() => nav(`/room/${p.room_id}${p.item_ids[0] ? `?focus=${p.item_ids[0]}` : ""}`)} data-testid={`rules-plan-${p.room_id}`}
            className="w-full flex items-center justify-between text-left py-1.5 text-xs hover:bg-slate-50 rounded px-1">
            <span className="truncate">{p.room_name}</span>
            <span className={`text-[10px] font-mono uppercase ${p.status === "fail" ? "text-rose-600" : "text-emerald-600"}`}>{p.status}</span>
          </button>
        ))}
      </div>
      {rule.kind === "rule" && (
        propose ? <ProposeForm rule={rule} onDone={() => { setPropose(false); onChanged(); }} /> : (
          <div className="flex gap-2">
            <button onClick={() => setPropose(true)} data-testid="rules-propose-btn"
              className="h-8 px-3 rounded-full border border-slate-300 hover:border-slate-900 text-xs inline-flex items-center gap-1"><GitPullRequest className="w-3.5 h-3.5" /> Propose a change</button>
            {canApprove && rule.pending_proposals > 0 && (
              <button onClick={() => nav("/knowledge?tab=review")} data-testid="rules-review-btn" className="h-8 px-3 rounded-full bg-slate-900 text-white text-xs">Review proposals</button>
            )}
          </div>
        )
      )}
    </div>
  );
}

export default function RulesMap() {
  const { user, logout } = useAuth();
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [onlyFail, setOnlyFail] = useState(false);
  const [srcSel, setSrcSel] = useState(null);
  const [sel, setSel] = useState(null);
  const [hover, setHover] = useState(null);
  const [lines, setLines] = useState([]);
  const box = useRef(null);
  const load = () => api.get("/rules-map").then((r) => setData(r.data)).catch(() => toast.error("Could not load rules"));
  useEffect(() => { load(); }, []);

  const rules = useMemo(() => (data?.rules || []).filter((r) =>
    (!srcSel || r.source === srcSel) && (!onlyFail || r.plans.some((p) => p.status === "fail")) &&
    (!q || `${r.id} ${r.statement} ${r.category}`.toLowerCase().includes(q.toLowerCase()))), [data, q, onlyFail, srcSel]);
  const focus = hover || sel;
  const focusRule = data?.rules.find((r) => r.id === focus);
  const linked = useMemo(() => {
    if (!focusRule) return null;
    const roles = new Set(focusRule.roles), comps = new Set(focusRule.targets);
    return { src: focusRule.source, roles, comps };
  }, [focusRule]);
  const targetsCol = useMemo(() => {
    if (!data) return [];
    const roleRows = data.roles.filter((r) => data.rules.some((x) => x.roles.includes(r.id)));
    return roleRows;
  }, [data]);

  useLayoutEffect(() => {
    if (!box.current || !focusRule) { setLines([]); return; }
    const B = box.current.getBoundingClientRect();
    const el = (k) => box.current.querySelector(`[data-k="${CSS.escape(k)}"]`);
    const R = el("r:" + focusRule.id); if (!R) { setLines([]); return; }
    const rb = R.getBoundingClientRect();
    const out = [];
    const S = el("s:" + focusRule.source);
    if (S) { const sb = S.getBoundingClientRect(); out.push([sb.right - B.left, sb.top + sb.height / 2 - B.top, rb.left - B.left, rb.top + rb.height / 2 - B.top, "#94A3B8"]); }
    focusRule.roles.forEach((ro) => {
      const T = el("t:" + ro); if (!T) return;
      const tb = T.getBoundingClientRect();
      out.push([rb.right - B.left, rb.top + rb.height / 2 - B.top, tb.left - B.left, tb.top + tb.height / 2 - B.top, ROLE_COLOR[ro] || "#94A3B8"]);
    });
    setLines(out);
  }, [focusRule, rules]);

  if (!data) return <div className="min-h-screen bg-[#F5F5F7]"><TopBar user={user} onLogout={logout} /><div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div></div>;
  const failing = data.rules.filter((r) => r.plans.some((p) => p.status === "fail")).length;
  const selRule = data.rules.find((r) => r.id === sel);
  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <TopBar user={user} onLogout={logout} />
      <div className="max-w-[1440px] mx-auto px-8 py-10">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Source of truth</div>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mt-1">Rules map.</h1>
        <div className="mt-3 flex gap-5 text-sm text-slate-600 flex-wrap" data-testid="rules-stats">
          <span><b className="text-slate-900">{data.rules.length}</b> rules</span>
          <span><b className="text-slate-900">{data.sources.length}</b> sources</span>
          <span><b className="text-slate-900">{data.rooms_validated}</b> of your rooms validated</span>
          <span><b className="text-rose-600">{failing}</b> rules failing somewhere</span>
        </div>
        <div className="mt-6 flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules" data-testid="rules-search"
              className="h-9 pl-8 pr-3 rounded-full border border-slate-300 bg-white text-xs w-64" />
          </div>
          <button onClick={() => setOnlyFail(!onlyFail)} data-testid="rules-only-failing"
            className={`h-9 px-3 rounded-full text-xs border ${onlyFail ? "bg-rose-600 text-white border-rose-600" : "bg-white border-slate-300"}`}>Failing in my plans</button>
          {srcSel && <button onClick={() => setSrcSel(null)} data-testid="rules-clear-source" className="h-9 px-3 rounded-full text-xs bg-slate-900 text-white inline-flex items-center gap-1">{srcSel.slice(0, 32)} <X className="w-3 h-3" /></button>}
        </div>
        <div className={`mt-6 grid gap-6 ${selRule ? "lg:grid-cols-[1fr_380px]" : ""}`}>
          <div ref={box} className="relative grid grid-cols-[1fr_1.6fr_0.9fr] gap-8" data-testid="rules-map">
            <svg className="absolute inset-0 w-full h-full pointer-events-none z-10">
              {lines.map(([x1, y1, x2, y2, c], i) => (
                <path key={i} d={`M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`} fill="none" stroke={c} strokeWidth={1.6} opacity={0.85} />
              ))}
            </svg>
            <Col title="Sources" count={data.sources.length}>
              {data.sources.map((s) => (
                <Chip key={s.id} k={"s:" + s.id} active={srcSel === s.id || linked?.src === s.id} dim={linked && linked.src !== s.id}
                  onClick={() => setSrcSel(srcSel === s.id ? null : s.id)} testId={`rules-source-${s.id}`}>
                  <div className="truncate text-slate-900">{s.id}</div><div className="text-[10px] text-slate-500">{s.count} rules</div>
                </Chip>
              ))}
            </Col>
            <Col title="Rules" count={rules.length}>
              {rules.map((r) => {
                const fails = r.plans.filter((p) => p.status === "fail").length;
                return (
                  <Chip key={r.id} k={"r:" + r.id} active={sel === r.id} dim={focus && focus !== r.id && hover}
                    onClick={() => setSel(sel === r.id ? null : r.id)} onEnter={() => setHover(r.id)} onLeave={() => setHover(null)} testId={`rules-rule-${r.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: TIER[r.tier] || "#94A3B8" }} />
                      <span className="font-mono text-[10px] text-slate-500 shrink-0">{r.code || r.id}</span>
                      <span className="truncate text-slate-900">{r.statement}</span>
                      {r.plans.length > 0 && <span className={`ml-auto shrink-0 text-[9.5px] font-mono ${fails ? "text-rose-600" : "text-emerald-600"}`}>{fails ? `${fails} fail` : "pass"}</span>}
                      {r.pending_proposals > 0 && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-amber-500" title="Proposal pending" />}
                    </div>
                  </Chip>
                );
              })}
            </Col>
            <Col title="Roles in the room" count={targetsCol.length}>
              {targetsCol.map((t) => (
                <Chip key={t.id} k={"t:" + t.id} active={linked?.roles.has(t.id)} dim={linked && !linked.roles.has(t.id)} testId={`rules-role-${t.id}`}>
                  <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: ROLE_COLOR[t.id] || "#94A3B8" }} />
                    <span className="text-slate-900">{t.id.replace(/_/g, " ").toLowerCase()}</span></div>
                  <div className="text-[10px] text-slate-500 truncate">{t.intent}</div>
                </Chip>
              ))}
            </Col>
          </div>
          {selRule && <Drawer rule={selRule} comps={data.components} canApprove={data.can_approve} onClose={() => setSel(null)} onChanged={load} />}
        </div>
      </div>
    </div>
  );
}
