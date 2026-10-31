import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import {
  X as XIcon, Share2, Link2, UserMinus, Users, Globe2, History,
  Copy, Check, Clock, Pencil, DoorOpen, ShieldCheck, Inbox, ThumbsUp, ThumbsDown,
} from "lucide-react";

/**
 * In-room Sharing Panel.
 * - Lists accepted collaborators + pending invites (with revoke controls).
 * - Copy-invite-link button (creates a room-scoped invite on demand).
 * - Org visibility toggle (owner's `organization` string).
 * - History tab: 30-day audit trail (opens / edits / invites / revokes / clones).
 * Owner (or admin) only — mount-guarded by `open`.
 */
export default function SharingPanel({ roomId, roomName, currentUser, onClose }) {
  const [tab, setTab]         = useState("people"); // "people" | "requests" | "history"
  const [loading, setLoading] = useState(true);
  const [data, setData]       = useState(null);   // /shares response
  const [copyBusy, setCopyBusy] = useState(false);
  const [copied, setCopied]   = useState(false);
  const [inviteRole, setInviteRole] = useState("architect");
  const [inviteNote, setInviteNote] = useState("");
  const [visToggling, setVisToggling] = useState(false);
  const [audit, setAudit]     = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [requests, setRequests]         = useState(null);
  const [requestsLoading, setRequestsLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/rooms/${roomId}/shares`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load sharing info.");
      onClose?.();
    } finally { setLoading(false); }
  };
  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const r = await api.get(`/rooms/${roomId}/audit?limit=200`);
      setAudit(r.data.events || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load history.");
    } finally { setAuditLoading(false); }
  };

  const loadRequests = async () => {
    setRequestsLoading(true);
    try {
      const r = await api.get(`/rooms/${roomId}/access-requests?status=pending`);
      setRequests(r.data.requests || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load requests.");
    } finally { setRequestsLoading(false); }
  };

  useEffect(() => { load(); }, [roomId]);
  useEffect(() => {
    if (tab === "history"  && !audit)    loadAudit();
    if (tab === "requests" && !requests) loadRequests();
  }, [tab]);

  const copyInviteLink = async () => {
    setCopyBusy(true);
    try {
      const r = await api.post("/invites",
        { scope: "room", scope_id: roomId, role: inviteRole,
          ttl_hours: 168, note: inviteNote.slice(0, 240) || undefined });
      const url = `${window.location.origin}/accept?token=${r.data.token}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Invite link copied to clipboard");
      setTimeout(() => setCopied(false), 2500);
      setInviteNote("");
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not create invite.");
    } finally { setCopyBusy(false); }
  };

  const revoke = async (grantee) => {
    const note = window.prompt(
      `Revoke access for ${grantee.email}?\n\nOptional one-line note (they will see it in their bell):`, "");
    if (note === null) return; // Cancel
    try {
      const qp = note.trim() ? `?note=${encodeURIComponent(note.trim().slice(0, 240))}` : "";
      await api.delete(`/rooms/${roomId}/shares/${grantee.user_id}${qp}`);
      toast.success(`Removed ${grantee.email}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Revoke failed.");
    }
  };

  const resolveRequest = async (req, decision) => {
    let role = "architect";
    if (decision === "approve") {
      role = window.prompt("Grant role (architect / ipc / engineer / clinician / viewer):", "architect");
      if (!role) return;
      role = role.trim().toLowerCase();
    }
    const note = window.prompt(
      decision === "approve"
        ? "Optional welcome note for the requester (max 240 chars):"
        : "Optional reason for denying (max 240 chars):",
      "");
    if (note === null) return;
    try {
      await api.post(`/rooms/${roomId}/access-requests/${req.id}/${decision}`,
        { role, note: (note || "").slice(0, 240) });
      toast.success(decision === "approve" ? `Approved ${req.requester_email}` : `Denied ${req.requester_email}`);
      await loadRequests();
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || `${decision} failed.`);
    }
  };

  const revokeInvite = async (inviteId) => {
    if (!confirm("Revoke this pending invite link?")) return;
    try {
      await api.delete(`/invites/${inviteId}`);
      toast.success("Invite revoked");
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Revoke failed.");
    }
  };

  const toggleOrgVisibility = async (next) => {
    setVisToggling(true);
    try {
      const r = await api.patch(`/rooms/${roomId}/visibility`,
        { visible_to_org: next });
      toast.success(next
        ? `Anyone at ${r.data.owner_org || "your org"} can now view this room`
        : "Room is now private to invited people only");
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Toggle failed.");
    } finally { setVisToggling(false); }
  };

  const owner = data?.owner || {};
  const noOrgWarning = !owner.organization;

  return createPortal(
    <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
      className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
      data-testid="sharing-panel">
      <motion.div initial={{y:12, opacity:0}} animate={{y:0, opacity:1}}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-slate-100 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.24em] text-slate-500 font-medium">
              <Share2 className="w-3 h-3" /> Share room
            </div>
            <div className="font-display text-xl font-semibold tracking-tight text-slate-900 mt-1"
                 data-testid="sharing-panel-room-name">
              {roomName || "Room"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Manage who can view or edit this room
            </div>
          </div>
          <button onClick={onClose}
                  className="text-slate-400 hover:text-slate-900 p-1"
                  data-testid="sharing-panel-close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6 pt-3 flex items-center gap-1 border-b border-slate-100">
          {[
            { k: "people",   label: "People",   Icon: Users },
            { k: "requests", label: `Requests${requests?.length ? ` · ${requests.length}` : ""}`, Icon: Inbox },
            { k: "history",  label: "History",  Icon: History },
          ].map(({ k, label, Icon }) => (
            <button key={k} onClick={() => setTab(k)}
              data-testid={`sharing-tab-${k}`}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-[11px] uppercase tracking-[0.2em] font-medium border-b-2 transition-colors ${
                tab === k
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}>
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="p-10 text-center text-sm text-slate-400">Loading…</div>
        )}

        {/* People tab */}
        {!loading && tab === "people" && data && (
          <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">

            {/* Invite Link */}
            <section>
              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium mb-2">
                Invite via link
              </div>
              <div className="flex items-center gap-2">
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}
                        data-testid="invite-role-select"
                        className="h-9 px-2 rounded-md border border-slate-200 bg-white text-sm">
                  <option value="architect">Architect (edit)</option>
                  <option value="ipc">IPC lead (edit)</option>
                  <option value="engineer">Engineer (edit)</option>
                  <option value="clinician">Clinician (edit)</option>
                  <option value="viewer">Viewer (read-only)</option>
                </select>
                <button
                  onClick={copyInviteLink}
                  disabled={copyBusy}
                  data-testid="copy-invite-link"
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium disabled:opacity-50">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : (copyBusy ? "Creating…" : "Copy invite link")}
                </button>
              </div>
              <div className="text-[11px] text-slate-500 mt-2">
                Anyone with the link can join this room with the selected role for 7 days.
              </div>
              <div className="mt-2">
                <label className="block">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium">Optional welcome note (max 240)</div>
                  <textarea
                    rows={2}
                    value={inviteNote}
                    maxLength={240}
                    onChange={(e) => setInviteNote(e.target.value)}
                    placeholder="Hey Ivan — please focus on the airflow zone."
                    data-testid="invite-note"
                    className="mt-1 w-full px-3 py-2 rounded-md border border-slate-200 focus:outline-none focus:border-slate-500 text-sm bg-white resize-none"
                  />
                </label>
                <div className="text-[10px] text-slate-400 mt-0.5">{inviteNote.length}/240</div>
              </div>
            </section>

            {/* Org visibility */}
            <section className="rounded-xl border border-slate-100 bg-slate-50/50 p-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center flex-shrink-0">
                  <Globe2 className="w-4 h-4 text-slate-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900">
                    Share with everyone at
                    <span className="font-mono text-[13px] ml-1.5">
                      {owner.organization || "—"}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Read-only. People at your organization see this room in their estate.
                    Invite them individually above to grant edit access.
                  </div>
                  {noOrgWarning && (
                    <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-2">
                      Set your <b>Organization</b> in your profile before turning this on.
                    </div>
                  )}
                </div>
                <label className="inline-flex items-center cursor-pointer">
                  <input type="checkbox"
                         checked={data.visible_to_org}
                         onChange={(e) => toggleOrgVisibility(e.target.checked)}
                         disabled={visToggling || noOrgWarning}
                         data-testid="visible-to-org-toggle"
                         className="peer sr-only" />
                  <div className="w-9 h-5 bg-slate-300 peer-checked:bg-emerald-500 rounded-full peer-disabled:opacity-40 relative transition-colors">
                    <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
                  </div>
                </label>
              </div>
            </section>

            {/* Accepted collaborators */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium">
                  People with access · {data.accepted.length}
                </div>
              </div>
              <div className="border border-slate-100 rounded-xl overflow-hidden divide-y divide-slate-100"
                   data-testid="shares-accepted-list">
                {/* Owner row */}
                <Row
                  name={currentUser?.name || currentUser?.email}
                  email={currentUser?.email}
                  role="Owner"
                  avatar={currentUser?.avatar_url}
                  isOwner
                />
                {data.accepted.map((a) => (
                  <Row key={a.user_id}
                       testid={`share-row-${a.user_id}`}
                       name={a.name || a.email}
                       email={a.email}
                       organization={a.organization}
                       role={a.role}
                       avatar={a.avatar_url}
                       onRevoke={() => revoke(a)} />
                ))}
                {data.accepted.length === 0 && (
                  <div className="text-xs text-slate-400 px-4 py-6 text-center">
                    No one else has access yet.
                  </div>
                )}
              </div>
            </section>

            {/* Pending invites */}
            {data.pending.length > 0 && (
              <section>
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium mb-2">
                  Pending invite links · {data.pending.length}
                </div>
                <div className="border border-slate-100 rounded-xl overflow-hidden divide-y divide-slate-100"
                     data-testid="shares-pending-list">
                  {data.pending.map((inv) => (
                    <div key={inv.invite_id} className="flex items-center gap-3 px-4 py-3">
                      <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                        <Link2 className="w-3.5 h-3.5 text-slate-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-900">
                          {inv.role} · {inv.accepted_by?.length || 0} joined
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          Expires {new Date(inv.expires_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          const url = `${window.location.origin}/accept?token=${inv.token}`;
                          navigator.clipboard.writeText(url);
                          toast.success("Link copied");
                        }}
                        className="text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded"
                        data-testid={`copy-pending-${inv.invite_id}`}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => revokeInvite(inv.invite_id)}
                        className="text-[11px] font-medium text-red-600 hover:text-red-700 px-2 py-1 rounded"
                        data-testid={`revoke-invite-${inv.invite_id}`}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* Requests tab */}
        {!loading && tab === "requests" && (
          <div className="p-6 space-y-3 max-h-[70vh] overflow-y-auto"
               data-testid="sharing-requests">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium">
              Pending access requests
            </div>
            {requestsLoading && (
              <div className="text-sm text-slate-400 text-center py-10">Loading…</div>
            )}
            {!requestsLoading && requests && requests.length === 0 && (
              <div className="text-sm text-slate-400 text-center py-10">
                No pending requests. When someone with a room link asks for access, they'll appear here.
              </div>
            )}
            {!requestsLoading && requests && requests.length > 0 && (
              <div className="border border-slate-100 rounded-xl overflow-hidden divide-y divide-slate-100">
                {requests.map((req) => (
                  <div key={req.id} className="p-4 flex items-start gap-3"
                       data-testid={`request-row-${req.id}`}>
                    <div className="w-8 h-8 rounded-full bg-slate-900 text-white text-[10px] font-semibold flex items-center justify-center flex-shrink-0">
                      {initials(req.requester_name || req.requester_email)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-900 truncate">
                        {req.requester_name || req.requester_email}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {req.requester_email}{req.requester_org ? ` · ${req.requester_org}` : ""}
                      </div>
                      {req.note && (
                        <div className="mt-2 text-[13px] text-slate-800 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                          "{req.note}"
                        </div>
                      )}
                      <div className="text-[10px] text-slate-400 mt-1">
                        <Clock className="w-3 h-3 inline mr-1" />{new Date(req.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => resolveRequest(req, "approve")}
                        data-testid={`approve-request-${req.id}`}
                        className="inline-flex items-center gap-1 h-8 px-3 rounded-md text-[11px] text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200"
                      >
                        <ThumbsUp className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button
                        onClick={() => resolveRequest(req, "deny")}
                        data-testid={`deny-request-${req.id}`}
                        className="inline-flex items-center gap-1 h-8 px-3 rounded-md text-[11px] text-red-700 bg-red-50 hover:bg-red-100 border border-red-200"
                      >
                        <ThumbsDown className="w-3.5 h-3.5" /> Deny
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* History tab */}
        {!loading && tab === "history" && (
          <div className="p-6 space-y-3 max-h-[70vh] overflow-y-auto"
               data-testid="sharing-history">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-medium">
              Activity · last 30 days
            </div>
            {auditLoading && (
              <div className="text-sm text-slate-400 text-center py-10">Loading history…</div>
            )}
            {!auditLoading && audit && audit.length === 0 && (
              <div className="text-sm text-slate-400 text-center py-10">
                No activity in the last 30 days.
              </div>
            )}
            {!auditLoading && audit && audit.length > 0 && (
              <div className="border border-slate-100 rounded-xl overflow-hidden divide-y divide-slate-100">
                {audit.map((e) => (
                  <AuditRow key={e.id} event={e} />
                ))}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function initials(nameOrEmail) {
  const s = nameOrEmail || "?";
  return s.split(/[.@\s_-]/).filter(Boolean).slice(0, 2)
          .map((p) => p[0].toUpperCase()).join("");
}

function Row({ name, email, organization, role, avatar, isOwner, onRevoke, testid }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid={testid}>
      {avatar ? (
        <img src={avatar.startsWith('http') ? avatar : `${process.env.REACT_APP_BACKEND_URL}${avatar}`}
             alt="" className="w-8 h-8 rounded-full object-cover border border-slate-100" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-slate-900 text-white text-[10px] font-semibold flex items-center justify-center">
          {initials(name || email)}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-900 truncate">
          {name || email}
          {isOwner && (
            <span className="ml-2 text-[10px] uppercase tracking-widest text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">
              Owner
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500 truncate">
          {email}{organization ? ` · ${organization}` : ""}
        </div>
      </div>
      <div className="text-[11px] text-slate-500 mr-1 capitalize">{role}</div>
      {!isOwner && onRevoke && (
        <button onClick={onRevoke}
                className="inline-flex items-center gap-1 h-8 px-2 rounded-md text-[11px] text-red-600 hover:bg-red-50"
                data-testid="revoke-share-btn">
          <UserMinus className="w-3.5 h-3.5" /> Revoke
        </button>
      )}
    </div>
  );
}

const ACTION_META = {
  opened:     { Icon: DoorOpen,     label: "opened",       tint: "text-slate-500" },
  edited:     { Icon: Pencil,       label: "edited",       tint: "text-slate-900" },
  invited:    { Icon: Link2,        label: "invited",      tint: "text-blue-700" },
  revoked:    { Icon: UserMinus,    label: "revoked",      tint: "text-red-700" },
  cloned:     { Icon: Share2,       label: "cloned",       tint: "text-emerald-700" },
  visibility: { Icon: Globe2,       label: "changed sharing", tint: "text-amber-700" },
  approved:   { Icon: ThumbsUp,     label: "approved request", tint: "text-emerald-700" },
  denied:     { Icon: ThumbsDown,   label: "denied request",   tint: "text-red-700" },
};

function AuditRow({ event }) {
  const meta = ACTION_META[event.action] || { Icon: ShieldCheck, label: event.action, tint: "text-slate-500" };
  const { Icon, label, tint } = meta;
  let extra = "";
  if (event.action === "edited" && event.meta?.items != null) extra = `v${event.meta.version} · ${event.meta.items} items`;
  else if (event.action === "invited") extra = `${event.meta?.role || "collaborator"}`;
  else if (event.action === "visibility") extra = event.meta?.visible_to_org ? "org visibility on" : "org visibility off";
  else if (event.action === "cloned") extra = "created from template";
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className={`w-7 h-7 rounded-full bg-slate-50 flex items-center justify-center flex-shrink-0 ${tint}`}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-slate-900 truncate">
          <span className="font-medium">{event.actor_name || event.actor_email}</span>
          <span className={`ml-1 ${tint}`}>{label}</span>
          {extra && <span className="text-slate-500 ml-1">— {extra}</span>}
        </div>
        <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
          <Clock className="w-3 h-3" /> {new Date(event.ts).toLocaleString()}
        </div>
      </div>
    </div>
  );
}
