import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/Logo";
import { Users, ArrowRight, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

/**
 * Accept-invite landing page. Reads `?token=` from the URL, previews the
 * invitation (public endpoint), and once the user is signed in / a guest,
 * calls `/api/invites/accept` and routes them to the right place.
 *
 * Behaviour by scope:
 *   - room-scope invites: **one-click** join. As soon as the invite is
 *     validated, we auto-generate a guest handle and jump the user
 *     straight into the room. This is what "signed invite URL" means for
 *     the user — no form, no delay, they land in the co-design canvas.
 *     Users can rename themselves later from the profile menu.
 *   - estate/organisation-scope invites: still show a name field, because
 *     workspace membership is longer-lived and identity matters more.
 *
 * Users can force the manual-name flow by adding `?named=1` to the URL.
 */
const FRIENDLY_HANDLES = [
  "Rowan", "Marlow", "Sage", "Wren", "Emery", "Blair", "Hollis",
  "Reese", "Quinn", "Sloane", "Frankie", "Nico", "Robin",
];
function randomHandle() {
  const base = FRIENDLY_HANDLES[Math.floor(Math.random() * FRIENDLY_HANDLES.length)];
  const suffix = Math.floor(100 + Math.random() * 899);
  return `Guest ${base}·${suffix}`;
}

export default function AcceptInvite() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const token = sp.get("token") || "";
  const forceNamed = sp.get("named") === "1";
  const { user, checked, guestLogin } = useAuth();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  // Guard so the one-click auto-join useEffect fires exactly once per mount.
  const autoJoinRef = useRef(false);

  useEffect(() => {
    if (!token) { setError("This link is missing a token."); return; }
    api.post("/invites/preview", { token })
      .then((r) => setPreview(r.data))
      .catch((e) => setError(e?.response?.data?.detail || "Invite invalid or expired."));
  }, [token]);

  // Shared accept-and-route helper. Kept inline so all three code paths
  // (already-signed-in, manual-name guest, one-click room-scope join) can
  // share the same POST + navigate without extra React commit cycles.
  const acceptAndRoute = async () => {
    try {
      const r = await api.post("/invites/accept", { token });
      toast.success(`Access granted · ${r.data.role} on this ${r.data.scope}`);
      if (r.data.scope === "room" && r.data.scope_id) {
        nav(`/room/${r.data.scope_id}`, { replace: true });
      } else {
        nav("/dashboard", { replace: true });
      }
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not accept invite.");
      setBusy(false);
    }
  };

  useEffect(() => {
    // Auto-accept for the ALREADY-signed-in path only.
    if (!user || !preview || busy) return;
    setBusy(true);
    acceptAndRoute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, preview]);

  // ─── One-click join for room-scope invites ─────────────────────────────
  // Runs once the invite preview arrives and the visitor is NOT signed in.
  // Fires guestLogin with an auto-generated friendly handle and jumps
  // straight into the room — no form, no click, no refresh loop.
  useEffect(() => {
    if (autoJoinRef.current) return;
    if (!preview || user || forceNamed) return;
    if (preview.scope !== "room") return;
    autoJoinRef.current = true;
    (async () => {
      setBusy(true);
      try {
        await guestLogin({ name: randomHandle(), role: preview.role || "viewer" });
        await acceptAndRoute();
      } catch (e) {
        setError(e?.response?.data?.detail || "Could not start guest session.");
        setBusy(false);
        autoJoinRef.current = false; // allow retry via the fallback form
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, user, forceNamed]);

  const enterAsGuest = async () => {
    const t = name.trim();
    if (!t) { toast.error("Please enter your name to continue"); return; }
    setBusy(true);
    try {
      await guestLogin({ name: t, role: preview?.role || "viewer" });
      await acceptAndRoute();
    } catch (e) {
      toast.error("Could not start guest session");
      setBusy(false);
    }
  };

  if (!checked) return <FullScreen><Loader2 className="w-4 h-4 animate-spin text-slate-400" /></FullScreen>;

  // The manual-name form is only shown for estate/org-scope invites, OR
  // when the visitor explicitly asked for it via `?named=1`.
  const showManualForm = !!(preview && !user && (preview.scope !== "room" || forceNamed));

  return (
    <div className="min-h-screen bg-[#FBFBFD] text-[#1D1D1F] antialiased flex flex-col">
      <header className="sticky top-0 z-40 hb-glass">
        <div className="max-w-6xl mx-auto px-6 md:px-8 h-12 flex items-center">
          <Wordmark size="base" solid />
        </div>
      </header>
      <div className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-3xl border border-black/5 shadow-[0_10px_40px_rgba(0,0,0,0.08)] p-8"
               data-testid="accept-invite-card">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-4">
              <Users className="w-3.5 h-3.5" /> Invitation
            </div>
            {error ? (
              <div className="text-sm">
                <div className="flex items-center gap-2 text-rose-600 mb-3">
                  <AlertTriangle className="w-4 h-4" />
                  <span className="font-medium">Can't join this session</span>
                </div>
                <p className="text-slate-600">{error}</p>
                <Button onClick={() => nav("/")} className="mt-5 h-9 rounded-full">Back home</Button>
              </div>
            ) : !preview ? (
              <div className="flex items-center gap-2 text-slate-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking your invitation…
              </div>
            ) : (
              <>
                <h1 className="font-display text-2xl font-semibold tracking-tight mb-1">
                  You're invited to a <span className="capitalize">{preview.scope}</span>
                  {preview.scope_name ? <> · {preview.scope_name}</> : null}
                </h1>
                <p className="text-sm text-slate-600 mb-5">
                  <span className="font-medium">{preview.invited_by || "A colleague"}</span> gave
                  you the role of <span className="font-medium capitalize">{preview.role}</span>.
                  {preview.note ? <> They added: <em>"{preview.note}"</em>.</> : null}
                </p>
                {(user || (preview.scope === "room" && !forceNamed)) ? (
                  <div className="text-sm text-slate-500 flex items-center gap-2"
                       data-testid="accept-as-user">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Joining {preview.scope_name || `this ${preview.scope}`}…
                  </div>
                ) : null}
                {showManualForm && (
                  <>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 font-medium mb-1">
                      Your name
                    </div>
                    <input
                      value={name} onChange={(e) => setName(e.target.value)}
                      placeholder=""
                      data-testid="accept-name-input"
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 focus:outline-none focus:border-slate-500 text-sm"
                    />
                    <Button onClick={enterAsGuest} disabled={busy}
                            data-testid="accept-continue-btn"
                            className="mt-4 w-full h-11 rounded-full hb-btn-primary text-sm">
                      {busy ? "Starting session…"
                            : <>Continue as {preview.role} <ArrowRight className="w-3.5 h-3.5 ml-1.5" /></>}
                    </Button>
                    <div className="mt-3 text-center text-[11px] text-slate-500 flex items-center justify-center gap-1">
                      <ShieldCheck className="w-3 h-3" />
                      Your name is only used for the live presence badge.
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FullScreen({ children }) {
  return <div className="min-h-screen flex items-center justify-center bg-[#FBFBFD]">{children}</div>;
}
