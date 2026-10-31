import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, ChevronDown, User2 } from "lucide-react";
import { toast } from "sonner";
import { Wordmark } from "@/components/brand/Logo";

/**
 * Apple.com/ca visual system, professional-tool language.
 * Two entry paths only: Sign in with email  |  Continue as guest.
 * Guest sign-in prompts for Name + Role so peers show up as e.g.
 *   "Mohamed Imam (Architect)" in the live cursor overlay.
 */
export default function Landing() {
  const nav = useNavigate();
  const [mode, setMode] = useState(null); // null | "guest" | "email"

  return (
    <div className="min-h-screen bg-[#FBFBFD] text-[#1D1D1F] antialiased">
      {/* Sticky glass nav */}
      <header className="sticky top-0 z-40 hb-glass">
        <div className="max-w-6xl mx-auto px-6 md:px-8 h-12 flex items-center justify-between">
          <Wordmark size="base" solid />
          <div className="flex items-center gap-5">
            <button onClick={() => setMode("guest")}
              className="text-xs font-medium tracking-tight text-[#1D1D1F]/60 hover:text-[#1D1D1F]"
              data-testid="nav-guest">
              Continue as guest
            </button>
            <button onClick={() => setMode("email")}
              className="text-xs font-medium tracking-tight text-[#0071E3] hover:text-[#0077ED]"
              data-testid="nav-signin">
              Sign in
            </button>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="max-w-6xl mx-auto px-6 md:px-8 pt-24 md:pt-32 pb-16 md:pb-24 text-center">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}>
          <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-5">
            HealthcareCanvas Co-Design Pilot Module
          </div>
          <h1 className="font-display font-semibold tracking-tighter text-5xl md:text-7xl leading-[1.05]"
              data-testid="landing-h1">
            A computational workspace
            <br />
            for healthcare design.
          </h1>
          <p className="mt-6 mx-auto max-w-2xl text-lg md:text-xl leading-relaxed text-[#1D1D1F]/70">
            A layout tool for architects and infection-prevention leads. The workspace
            checks spatial configurations against NHS HBN&nbsp;00-09, 00-03, 04-01, 11-01,
            ASHRAE&nbsp;170, WHO WASH&nbsp;FIT, and others.
          </p>

          {/* CTAs */}
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button onClick={() => setMode("email")}
              className="h-11 px-6 rounded-full hb-btn-primary text-sm font-medium inline-flex items-center gap-2"
              data-testid="email-signin-btn">
              Sign in with email <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setMode("guest")}
              className="h-11 px-6 rounded-full text-sm font-medium border border-black/10 bg-white hover:bg-[#F5F5F7] text-[#1D1D1F] inline-flex items-center gap-2"
              data-testid="guest-signin-btn">
              <User2 className="w-3.5 h-3.5" /> Continue as guest
            </button>
          </div>

          <AnimatePresence>
            {mode === "email" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden">
                <EmailForm onDone={() => nav("/", { replace: true })} onSwitch={() => setMode("guest")} />
              </motion.div>
            )}
            {mode === "guest" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden">
                <GuestForm onDone={() => nav("/", { replace: true })} onSwitch={() => setMode("email")} />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-16 text-[11px] uppercase tracking-[0.24em] text-[#86868B]">
            Features
          </div>
        </motion.div>
      </section>

      {/* FEATURES — bento grid */}
      <section id="features" className="max-w-6xl mx-auto px-6 md:px-8 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-4 md:gap-5">
          <Tile
            variant="dark"
            span="md:col-span-3"
            eyebrow="Multi-view editing"
            title="2D plan, 3D volume, and render update together."
            testId="tile-views"
          />
          <Tile
            variant="light"
            span="md:col-span-3"
            eyebrow="Live compliance"
            title="Layout errors are flagged against encoded healthcare standards."
            testId="tile-rules"
          />
          <Tile
            variant="light"
            span="md:col-span-3"
            eyebrow="Shared workspace"
            title="Architects and IPC leads edit the same model simultaneously."
            testId="tile-team"
          />
          <Tile
            variant="dark"
            span="md:col-span-3"
            eyebrow="Layout assistance"
            title="The engine highlights clearance issues and proposes compliant alternatives to evaluate and approve."
            testId="tile-autofix"
          />
        </div>
      </section>

      <footer className="border-t border-black/5 bg-[#F5F5F7]">
        <div className="max-w-6xl mx-auto px-6 md:px-8 py-8 flex flex-col md:flex-row items-center justify-between gap-3">
          <Wordmark size="sm" solid className="text-[#1D1D1F]/80" />
          <div className="text-[11px] text-[#86868B]">
            © Perkins&amp;Will &middot; Healthcare Infection Society &middot; Pilot build
          </div>
        </div>
      </footer>
    </div>
  );
}

function Tile({ variant, span, eyebrow, title, copy, testId }) {
  const isDark = variant === "dark";
  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className={`${span} rounded-3xl p-8 md:p-10 relative overflow-hidden ${
        isDark
          ? "bg-[#1D1D1F] text-white"
          : "bg-white text-[#1D1D1F] border border-black/5"
      } shadow-[0_4px_24px_rgba(0,0,0,0.04)] hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)] transition-shadow`}
      data-testid={testId}
    >
      <div className={`text-[11px] uppercase tracking-[0.22em] font-medium ${isDark ? "text-white/50" : "text-[#86868B]"}`}>
        {eyebrow}
      </div>
      <h3 className={`mt-3 font-display font-semibold tracking-tight text-2xl md:text-3xl leading-[1.15] ${isDark ? "text-white" : "text-[#1D1D1F]"}`}>
        {title}
      </h3>
      {copy && (
        <p className={`mt-4 text-sm md:text-base leading-relaxed max-w-md ${isDark ? "text-white/70" : "text-[#1D1D1F]/70"}`}>
          {copy}
        </p>
      )}
    </motion.div>
  );
}

const ROLE_OPTIONS = [
  { v: "architect", label: "Architect" },
  { v: "ipc",       label: "Infection Prevention & Control" },
  { v: "engineer",  label: "Engineer / Facilities" },
  { v: "clinician", label: "Clinician" },
  { v: "viewer",    label: "Observer / Viewer" },
];

function GuestForm({ onDone, onSwitch }) {
  const { guestLogin } = useAuth();
  // Fields intentionally start blank — pre-filling from localStorage was
  // confusing on shared devices where the previous user's name/org would
  // appear as if it belonged to the current visitor.
  const [name, setName] = useState("");
  const [role, setRole] = useState("architect");
  const [organization, setOrganization] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { toast.error("Enter your name so others see who's live"); return; }
    setBusy(true);
    try {
      await guestLogin({
        name: trimmed, role,
        organization: organization.trim() || undefined,
        discipline: discipline.trim() || undefined,
      });
      try {
        localStorage.setItem("his:lastGuestName", trimmed);
        localStorage.setItem("his:lastGuestRole", role);
        localStorage.setItem("his:lastGuestOrg",  organization.trim());
        localStorage.setItem("his:lastGuestDisc", discipline.trim());
      } catch {}
      toast.success(`Session started as ${trimmed}${organization ? ` · ${organization}` : ""}`);
      onDone && onDone();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not start guest session");
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="mt-8 mx-auto max-w-sm text-left space-y-3"
          data-testid="guest-form">
      <div>
        <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B]">Your name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)}
               placeholder="e.g. Alex Chen"
               className="mt-1 rounded-xl"
               data-testid="guest-name" autoFocus />
      </div>
      <div>
        <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B]">Role</Label>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="mt-1 rounded-xl h-10" data-testid="guest-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((r) => (
              <SelectItem key={r.v} value={r.v}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B]">Organization</Label>
          <Input value={organization} onChange={(e) => setOrganization(e.target.value)}
                 placeholder="e.g. NHS Trust"
                 className="mt-1 rounded-xl"
                 data-testid="guest-organization" />
        </div>
        <div>
          <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B]">Discipline</Label>
          <Input value={discipline} onChange={(e) => setDiscipline(e.target.value)}
                 placeholder="e.g. IPC · Estates"
                 className="mt-1 rounded-xl"
                 data-testid="guest-discipline" />
        </div>
      </div>
      <Button type="submit" disabled={busy}
              className="w-full h-11 rounded-full hb-btn-primary text-sm"
              data-testid="guest-submit">
        {busy ? "Starting session…" : "Enter the workspace"}
      </Button>
      <button type="button" onClick={onSwitch}
              className="w-full text-[11px] uppercase tracking-[0.22em] text-[#86868B] hover:text-[#1D1D1F]"
              data-testid="guest-switch-email">
        Have an account? Sign in with email
      </button>
    </form>
  );
}

function EmailForm({ onDone, onSwitch }) {
  const { login, register } = useAuth();
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!email || !password) { toast.error("Email and password required"); return; }
    setBusy(true);
    try {
      if (isSignup) await register(email, password, name || email.split("@")[0]);
      else await login(email, password);
      toast.success(isSignup ? "Account created" : "Signed in");
      onDone && onDone();
    } catch (err) {
      toast.error(err.response?.data?.detail || (isSignup ? "Sign-up failed" : "Wrong email or password"));
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="mt-8 mx-auto max-w-sm text-left space-y-3">
      {isSignup && (
        <div>
          <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B]">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Green" className="mt-1 rounded-xl" data-testid="signup-name" />
        </div>
      )}
      <div>
        <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B]">Email</Label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@studio.com" className="mt-1 rounded-xl" data-testid="signin-email" />
      </div>
      <div>
        <Label className="text-[11px] uppercase tracking-[0.22em] text-[#86868B]">Password</Label>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="•••••••••" className="mt-1 rounded-xl" data-testid="signin-password" />
      </div>
      <Button type="submit" disabled={busy}
        className="w-full h-11 rounded-full hb-btn-primary text-sm"
        data-testid="signin-submit">
        {busy ? "…" : (isSignup ? "Create account" : "Sign in")}
      </Button>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setIsSignup(!isSignup)}
          className="text-[11px] uppercase tracking-[0.22em] text-[#86868B] hover:text-[#1D1D1F]"
          data-testid="toggle-signup">
          {isSignup ? "Have an account? Sign in" : "Need an account? Create one"}
        </button>
        <button type="button" onClick={onSwitch}
                className="text-[11px] uppercase tracking-[0.22em] text-[#86868B] hover:text-[#1D1D1F]">
          Continue as guest
        </button>
      </div>
    </form>
  );
}
