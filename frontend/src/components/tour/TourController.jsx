import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/context/AuthContext";
import QuickTour, { TOUR_VERSION, buildDefaultSteps } from "./QuickTour";

/**
 * Mounted once at the app root inside <BrowserRouter>. Owns the tour's
 * open/close state, resolves the first available room for the room-editor
 * steps, and reacts to:
 *
 *   - `?tour=<step-key>` deep links
 *   - the global `healthcarecanvas:open-tour` custom event (fired from any
 *     Compass button in the app)
 *   - first-visit auto-launch (once per browser per TOUR_VERSION)
 *
 * Keeping the tour outside of any page means the overlay survives the
 * `navigate()` calls the tour makes as it walks the user across routes.
 */
export default function TourController() {
  const { user, checked } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [initialKey, setInitialKey] = useState(null);
  const [firstRoomId, setFirstRoomId] = useState(null);
  const autoFiredRef = useRef(false);

  // Fetch the first utility/room in the estate once the user is known.
  useEffect(() => {
    if (!user) { setFirstRoomId(null); return; }
    let cancelled = false;
    api.get("/hierarchy").then((r) => {
      if (cancelled) return;
      const utility = r.data.find((n) => n.type === "utility") ||
                      r.data.find((n) => n.type === "room");
      setFirstRoomId(utility?.id || null);
    }).catch(() => { if (!cancelled) setFirstRoomId(null); });
    return () => { cancelled = true; };
  }, [user]);

  // Listen for global open events so any Compass button can trigger us.
  useEffect(() => {
    const onOpen = (e) => {
      const key = e?.detail?.key || null;
      setInitialKey(key);
      setOpen(true);
    };
    window.addEventListener("healthcarecanvas:open-tour", onOpen);
    return () => window.removeEventListener("healthcarecanvas:open-tour", onOpen);
  }, []);

  // Deep-link + first-visit auto-launch — only run once the auth check
  // has settled and only for signed-in users.
  useEffect(() => {
    if (!checked || !user || autoFiredRef.current) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const key = params.get("tour");
      if (key) {
        autoFiredRef.current = true;
        setInitialKey(key);
        setOpen(true);
        params.delete("tour");
        const q = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : ""));
        return;
      }
      if (localStorage.getItem("his:tour_seen") !== TOUR_VERSION) {
        autoFiredRef.current = true;
        const t = setTimeout(() => setOpen(true), 900);
        return () => clearTimeout(t);
      }
    } catch {}
  }, [checked, user]);

  const steps = useMemo(() => buildDefaultSteps(firstRoomId), [firstRoomId]);

  // Only render the overlay on protected routes — never on /signin or invite pages.
  const isProtected = !["/signin", "/accept-invite"].includes(loc.pathname);
  if (!isProtected) return null;

  return (
    <QuickTour
      open={open}
      steps={steps}
      initialKey={initialKey}
      onClose={() => setOpen(false)}
      navigate={nav}
      currentPath={loc.pathname}
    />
  );
}

/** Fire the tour from anywhere in the app. */
export function openTour(key = null) {
  window.dispatchEvent(new CustomEvent("healthcarecanvas:open-tour", { detail: { key } }));
}
