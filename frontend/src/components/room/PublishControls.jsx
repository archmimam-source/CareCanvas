import React, { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { Globe, Lock, Clock, Check, X } from "lucide-react";

const STATUS = {
  private: { label: "Private", icon: Lock, cls: "bg-slate-100 text-slate-600" },
  pending: { label: "Awaiting approval", icon: Clock, cls: "bg-amber-50 text-amber-800 border border-amber-200" },
  public:  { label: "Public", icon: Globe, cls: "bg-emerald-50 text-emerald-800 border border-emerald-200" },
};

export function PublishControl({ node, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (node.type !== "building" || !node.is_mine) return null;
  const status = node.publish_status || "private";
  const S = STATUS[status] || STATUS.private;
  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); toast.success(ok); onChanged?.(); }
    catch (e) { toast.error(e.response?.data?.detail || "Action failed"); }
    finally { setBusy(false); }
  };
  const request = () => {
    const note = window.prompt("Optional note for the approver:", "") ?? null;
    if (note === null) return;
    run(() => api.post(`/hierarchy/${node.id}/publish-request`, { note }), "Sent for admin approval");
  };
  const makePrivate = () => run(() => api.post(`/hierarchy/${node.id}/unpublish`), "Building is private again");
  return (
    <div className="mt-4 flex items-center gap-2 flex-wrap" data-testid={`publish-control-${node.id}`}>
      <span className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[10px] uppercase tracking-[0.16em] font-medium ${S.cls}`}
            data-testid={`publish-status-${node.id}`}>
        <S.icon className="w-3 h-3" /> {S.label}
      </span>
      {status === "private" && (
        <button onClick={request} disabled={busy} data-testid={`publish-request-${node.id}`}
          className="h-7 px-3 rounded-full bg-[#1D1D1F] hover:bg-[#333] text-white text-[11px] font-medium transition-colors">
          Make public
        </button>
      )}
      {status !== "private" && (
        <button onClick={makePrivate} disabled={busy} data-testid={`publish-withdraw-${node.id}`}
          className="h-7 px-3 rounded-full border border-slate-300 hover:border-slate-500 text-[11px] font-medium transition-colors">
          {status === "pending" ? "Withdraw" : "Make private"}
        </button>
      )}
    </div>
  );
}

export function PublishRequestsPanel({ onChanged }) {
  const [data, setData] = useState({ is_approver: false, requests: [] });
  const load = () => api.get("/publish-requests").then((r) => setData(r.data)).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!data.is_approver || data.requests.length === 0) return null;
  const decide = async (id, decision) => {
    const note = window.prompt(decision === "approve" ? "Optional note to the requester:" : "Reason for declining (optional):", "");
    if (note === null) return;
    try {
      await api.post(`/publish-requests/${id}/${decision}`, { note });
      toast.success(decision === "approve" ? "Building is now public" : "Request declined");
      load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.detail || "Action failed"); }
  };
  return (
    <div className="mb-12 rounded-3xl bg-white border border-amber-200 p-6" data-testid="publish-requests-panel">
      <div className="text-[11px] uppercase tracking-[0.24em] text-amber-700 font-medium">
        Publish requests · {data.requests.length}
      </div>
      <div className="mt-4 divide-y divide-slate-100">
        {data.requests.map((r) => (
          <div key={r.id} className="py-3 flex items-center justify-between gap-4" data-testid={`publish-req-${r.id}`}>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 truncate">{r.node_name}</div>
              <div className="text-xs text-slate-500 truncate">
                {r.requested_by_name || r.requested_by_email} · {new Date(r.created_at).toLocaleString()}
                {r.note ? ` · “${r.note}”` : ""}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => decide(r.id, "deny")} data-testid={`publish-deny-${r.id}`}
                className="h-8 px-3 rounded-full border border-slate-300 hover:border-slate-500 text-xs inline-flex items-center gap-1">
                <X className="w-3.5 h-3.5" /> Decline
              </button>
              <button onClick={() => decide(r.id, "approve")} data-testid={`publish-approve-${r.id}`}
                className="h-8 px-3 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs inline-flex items-center gap-1">
                <Check className="w-3.5 h-3.5" /> Approve
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
