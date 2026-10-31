import React, { useEffect, useRef, useState } from "react";
import { Compass, ChevronLeft, ChevronRight, X as XIcon } from "lucide-react";

/**
 * Guided product tour.
 *
 * Each step is a stop on a walk through the app. A step may declare:
 *   - `path`        the route we need to be on before the step renders
 *   - `target`      the `data-testid` of the element to spotlight
 *   - `placement`   where the card sits relative to the target
 *   - `title/body`  the copy shown on the card
 *
 * When advancing to a step, the tour:
 *   1. navigates to `step.path` (if we're not already there)
 *   2. polls the DOM for the target element (~2s max)
 *   3. spotlights it and anchors the card next to it
 *
 * If `target` is absent, the step shows the current page underneath a
 * light dim + a bottom-centre card so the user can still see the
 * screen the copy is describing.
 */
export const TOUR_VERSION = "v2";

export default function QuickTour({
  open, onClose, steps, initialKey = null, navigate, currentPath,
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const pollTimer = useRef(null);

  // Reset / seek to initialKey whenever the tour opens.
  useEffect(() => {
    if (!open) return;
    if (initialKey) {
      const idx = steps.findIndex((s) => s.key === initialKey);
      setI(idx >= 0 ? idx : 0);
    } else {
      setI(0);
    }
  }, [open, initialKey, steps]);

  // Whenever the active step changes, route + poll for the target.
  useEffect(() => {
    if (!open) return;
    const step = steps[i];
    if (!step) return;

    // Clear any previous polling.
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }

    // 1. Navigate if the step wants a different route.
    if (step.path && step.path !== currentPath) {
      navigate(step.path);
    }

    // 2. If no target, just clear the rect and centre the card.
    if (!step.target) { setRect(null); return; }

    // 3. Poll for the target — it may only appear once the route mounts.
    let tries = 0;
    setRect(null);
    const compute = () => {
      const el = document.querySelector(`[data-testid="${step.target}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        // Some sub-nav elements may be hidden on smaller viewports; keep polling.
        if (r.width > 0 && r.height > 0) {
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
          return true;
        }
      }
      return false;
    };
    if (compute()) return; // found immediately
    pollTimer.current = setInterval(() => {
      tries += 1;
      if (compute() || tries > 20) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }, 150);

    const onResize = () => compute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [i, open, steps, currentPath, navigate]);

  const finish = () => {
    try { localStorage.setItem("his:tour_seen", TOUR_VERSION); } catch {}
    // Land the user on the Estate/Dashboard when the tour ends, so the
    // finish always dumps them onto the "home" view regardless of which
    // page the last step happened to be on.
    try { navigate && navigate("/dashboard"); } catch {}
    onClose && onClose();
  };
  const next = () => (i + 1 >= steps.length ? finish() : setI(i + 1));
  const prev = () => setI(Math.max(0, i - 1));

  if (!open) return null;
  const step = steps[i];
  if (!step) return null;

  // Card position: near the target if we have one, else bottom-centre so
  // the user can still see the underlying page.
  let cardStyle;
  if (rect) {
    const pad = 12;
    const w = 340, h = 180;
    let top = rect.top + rect.height + pad;
    let left = rect.left + rect.width / 2 - w / 2;
    if (step.placement === "top")          top = rect.top - h - pad;
    if (step.placement === "left")         { top = rect.top; left = rect.left - w - pad; }
    if (step.placement === "right")        { top = rect.top; left = rect.left + rect.width + pad; }
    if (step.placement === "bottom-right") left = Math.min(rect.left + rect.width - w, window.innerWidth - w - 16);
    cardStyle = {
      top:  Math.max(16, Math.min(top,  window.innerHeight - h - 16)),
      left: Math.max(16, Math.min(left, window.innerWidth  - w - 16)),
      width: w,
    };
  } else {
    // No target — anchor at bottom-centre so the tour never covers the page.
    cardStyle = {
      bottom: 32,
      left: "50%",
      transform: "translateX(-50%)",
      width: 420,
    };
  }

  return (
    <div className="fixed inset-0 z-[9997] pointer-events-none" data-testid="quick-tour">
      {/* Dim backdrop. Full-black spotlight when we have a target, a light
          scrim when we don't (so the page underneath is visible). */}
      {rect ? (
        <div className="absolute pointer-events-none transition-all duration-200 rounded-xl"
             style={{
               top: rect.top - 6, left: rect.left - 6,
               width: rect.width + 12, height: rect.height + 12,
               boxShadow: "0 0 0 9999px rgba(2, 6, 23, 0.55)",
               border: "2px solid #F59E0B",
             }} />
      ) : (
        <div className="absolute inset-0 bg-black/25 pointer-events-none" />
      )}
      {/* Step card — pointer-events re-enabled so buttons work. */}
      <div className="absolute bg-white rounded-2xl shadow-2xl border border-black/5 p-5 pointer-events-auto"
           style={cardStyle}
           data-testid="quick-tour-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-mono mb-1 flex items-center gap-1.5">
              <Compass className="w-3 h-3" /> Step {i + 1} / {steps.length}
            </div>
            <div className="font-display text-base font-semibold tracking-tight">{step.title}</div>
          </div>
          <button onClick={finish} className="text-slate-500 hover:text-slate-900"
                  data-testid="quick-tour-skip">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <p className="mt-2 text-[13px] text-slate-700 leading-relaxed">{step.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <button onClick={prev} disabled={i === 0}
                  data-testid="quick-tour-prev"
                  className="text-[11px] font-mono uppercase tracking-widest text-slate-500 hover:text-slate-900 disabled:opacity-40 inline-flex items-center gap-1">
            <ChevronLeft className="w-3 h-3" /> Back
          </button>
          <button onClick={finish}
                  data-testid="quick-tour-skip-inline"
                  className="text-[11px] font-mono uppercase tracking-widest text-slate-500 hover:text-slate-900">
            Skip tour
          </button>
          <button onClick={next}
                  data-testid="quick-tour-next"
                  className="h-8 px-4 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-[12px] inline-flex items-center gap-1">
            {i + 1 === steps.length ? "Finish" : "Next"} <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Factory that builds the default 10-step HealthcareCanvas tour. `firstRoomId`
 * is optional — if the estate has no rooms yet, the room-editor steps
 * fall back to a Dashboard step.
 */
export function buildDefaultSteps(firstRoomId) {
  const roomPath = firstRoomId ? `/room/${firstRoomId}` : "/dashboard";
  const inRoom = Boolean(firstRoomId);
  return [
    {
      key: "welcome",
      title: "Welcome to HealthcareCanvas",
      body: "HealthcareCanvas is the co-design workspace for architects and infection-prevention leads. This 90-second walkthrough steps you through every surface you'll use.",
    },
    {
      key: "profile",
      path: "/dashboard",
      target: "profile-btn",
      placement: "bottom-right",
      title: "Your persona",
      body: "Your role, organisation and discipline appear next to your avatar. Everyone else in the room sees this in the live-presence panel.",
    },
    {
      key: "estate",
      path: "/dashboard",
      target: "estate-search",
      placement: "bottom",
      title: "Your estate",
      body: "Every building, ward and utility room in your portfolio rolls up here. Search or scroll to jump.",
    },
    {
      key: "open-room",
      path: "/dashboard",
      target: inRoom ? `node-card-${firstRoomId}` : "new-room-btn",
      placement: "top",
      title: inRoom ? "Open a room" : "Create your first room",
      body: inRoom
        ? "Any card opens the co-design canvas — a synchronised 2D plan and 3D volume."
        : "You don't have any rooms yet. Tap New room to create one and the rest of the tour will make sense.",
    },
    {
      key: "validate",
      path: roomPath,
      target: "run-validation",
      placement: "bottom",
      title: "Validate compliance",
      body: "Runs the layout against NHS HBN 00-09, HBN 04-01, ASHRAE 170 and WHO WASH FIT. Any flag is clickable and highlights the offending object in both panes.",
    },
    {
      key: "palette",
      path: roomPath,
      target: "tab-palette",
      placement: "right",
      title: "Component palette",
      body: "27+ Revit families come pre-loaded — sinks, macerators, PPE stations, trolleys, benches. Drag straight onto the plan and the 3D updates live.",
    },
    {
      key: "invite",
      path: roomPath,
      target: "invite-btn",
      placement: "bottom",
      title: "Invite the team",
      body: "Generate a Room / Building / Estate invite link so IPC leads, engineers and clinicians land in the right seat with the right permissions.",
    },
    {
      key: "export",
      path: roomPath,
      target: "export-btn",
      placement: "bottom-right",
      title: "Export & share",
      body: "PDF data sheet, Excel BOM, or IFC to bring the design back into Revit — all live behind the Export button.",
    },
    {
      key: "derogations",
      path: "/derogations",
      title: "Derogation log",
      body: "Every rule exception is captured here with who, when and why — a full audit trail for regulators and IPC sign-off.",
    },
    {
      key: "components",
      path: "/components",
      title: "Component Library",
      body: "The shared library of Revit families. Upload new .rfa files, tag them by category and they'll appear in every room's palette instantly.",
    },
    {
      key: "done",
      title: "That's it",
      body: "You can relaunch this tour anytime from the compass icon in the top bar. Happy designing.",
    },
  ];
}
