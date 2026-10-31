import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { api } from "@/lib/apiClient";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { TopBar } from "@/pages/Dashboard";
import { Lock, Send, CheckCircle2, ArrowLeft } from "lucide-react";

export default function RequestAccess() {
  const { user, logout } = useAuth();
  const { roomId } = useParams();
  const nav = useNavigate();
  const [preview, setPreview] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/rooms/${roomId}/access-preview`)
      .then((r) => {
        setPreview(r.data);
        if (r.data.has_access) {
          // We already have access — jump into the editor
          nav(`/room/${roomId}`, { replace: true });
        }
        if (r.data.pending_request) setSent(true);
      })
      .catch((e) => {
        setError(e?.response?.data?.detail || "Room not found");
      });
  }, [roomId]);

  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/rooms/${roomId}/access-request`, { note: note.slice(0, 240) });
      toast.success("Request sent to the room owner");
      setSent(true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not send request");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <TopBar user={user} onLogout={logout} />
      <div className="max-w-2xl mx-auto px-8 pt-24 pb-24">
        <button onClick={() => nav("/dashboard")}
                className="text-[11px] uppercase tracking-[0.22em] text-[#86868B] hover:text-[#1D1D1F] mb-6 inline-flex items-center gap-1"
                data-testid="request-access-back">
          <ArrowLeft className="w-3 h-3" /> Back to estate
        </button>
        {error && (
          <div className="bg-white rounded-3xl border border-black/5 p-8 shadow">
            <div className="text-[10px] uppercase tracking-[0.24em] text-red-600 font-medium">Not accessible</div>
            <div className="mt-2 font-display text-2xl font-semibold text-[#1D1D1F]">{error}</div>
          </div>
        )}
        {!error && preview && (
          <motion.div initial={{opacity:0, y:8}} animate={{opacity:1, y:0}}
            className="bg-white rounded-3xl border border-black/5 p-8 shadow" data-testid="request-access-card">
            <div className="w-12 h-12 rounded-2xl bg-[#FEF3F2] flex items-center justify-center">
              <Lock className="w-5 h-5 text-[#B15A4F]" />
            </div>
            <div className="mt-6 text-[10px] uppercase tracking-[0.24em] text-[#86868B] font-medium">
              Private room
            </div>
            <h1 className="font-display text-3xl md:text-4xl font-semibold tracking-tight text-[#1D1D1F] mt-1"
                data-testid="request-access-room-name">
              {preview.name}
            </h1>
            <div className="mt-2 text-sm text-[#86868B]">
              Owned by <span className="text-[#1D1D1F]">{preview.owner_email}</span>
              {preview.owner_org && <> · {preview.owner_org}</>}
            </div>

            {sent ? (
              <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-5" data-testid="request-access-sent">
                <div className="flex items-center gap-2 text-emerald-800">
                  <CheckCircle2 className="w-5 h-5" />
                  <div className="font-medium">Request sent</div>
                </div>
                <div className="text-sm text-emerald-800 mt-1">
                  The owner will review your request. You'll receive a message when they approve or deny it.
                </div>
                <button onClick={() => nav("/dashboard")}
                        className="mt-4 inline-flex items-center gap-1 h-9 px-4 rounded-full bg-emerald-700 hover:bg-emerald-800 text-white text-xs"
                        data-testid="request-access-back-to-estate">
                  Back to estate
                </button>
              </div>
            ) : (
              <div className="mt-8 space-y-3">
                <label className="block">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-[#86868B] font-medium">
                    Optional note (max 240 chars)
                  </div>
                  <textarea
                    rows={3}
                    value={note}
                    maxLength={240}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Tell the owner why you'd like access."
                    data-testid="request-access-note"
                    className="mt-1 w-full px-3 py-2 rounded-xl border border-black/10 focus:outline-none focus:border-slate-500 text-sm bg-white resize-none"
                  />
                  <div className="text-[10px] text-[#86868B] mt-1">{note.length}/240</div>
                </label>
                <button onClick={send} disabled={busy}
                        data-testid="request-access-submit"
                        className="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-[#1D1D1F] hover:bg-[#333] text-white text-sm font-medium disabled:opacity-50">
                  <Send className="w-3.5 h-3.5" /> {busy ? "Sending…" : "Send request"}
                </button>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}
