import React, { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { motion } from "framer-motion";
import { toast } from "sonner";

export default function AuthScreen() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("architect@his.dev");
  const [password, setPassword] = useState("demo1234");
  const [name, setName] = useState("");
  const [role, setRole] = useState("architect");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = mode === "login"
      ? await login(email, password)
      : await register(email, password, name || email.split("@")[0], role);
    setBusy(false);
    if (!r.ok) toast.error(r.error);
    else toast.success(mode === "login" ? "Welcome back" : "Account created");
  };

  return (
    <div className="min-h-screen w-full flex items-stretch">
      {/* Left visual side */}
      <div className="hidden md:flex flex-1 relative overflow-hidden bg-[#0F0F10]">
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "url(https://images.unsplash.com/photo-1628012209120-d9db7abf7eab?crop=entropy&cs=srgb&fm=jpg&w=1600&q=80)",
            backgroundSize: "cover", backgroundPosition: "center",
            filter: "grayscale(30%) contrast(1.05)",
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/30 to-black/70" />
        <div className="relative z-10 p-12 flex flex-col justify-between text-white w-full">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-white/10 border border-white/20 flex items-center justify-center font-display font-bold">C</div>
            <div className="font-display text-sm tracking-widest uppercase text-white/70">HealthcareCanvas · Perkins&amp;Will × HIS</div>
          </div>
          <div className="max-w-xl">
            <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-white/60 mb-4">Pilot · Dirty Utility Rooms</div>
            <h1 className="font-display text-5xl leading-[1.05] font-semibold tracking-tight">
              Co-design healthcare rooms with the standards that govern them.
            </h1>
            <p className="mt-6 text-white/70 max-w-md leading-relaxed">
              A live 2D + 3D workspace where architects and infection-control leads negotiate layouts against NHS baseline and international comparators — in one auditable model.
            </p>
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/50">
            NHS HBN 00-09 · HTM 04-01 · ASHRAE 170 · FGI 2022
          </div>
        </div>
      </div>

      {/* Right form side */}
      <div className="flex-1 flex items-center justify-center p-6 md:p-16 bg-[#F5F5F7]">
        <motion.form
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          onSubmit={submit}
          className="w-full max-w-md"
          data-testid="auth-form"
        >
          <div className="mb-8">
            <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-slate-500 mb-2">
              {mode === "login" ? "Sign in" : "Create account"}
            </div>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-900">
              {mode === "login" ? "Enter the co-design space" : "Join the design team"}
            </h2>
          </div>

          {mode === "register" && (
            <div className="mb-4">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)}
                     className="mt-2 h-11 rounded-xl border-slate-200 bg-white"
                     data-testid="auth-name" placeholder="Jane Doe" />
            </div>
          )}

          <div className="mb-4">
            <Label className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)}
                   className="mt-2 h-11 rounded-xl border-slate-200 bg-white"
                   type="email" data-testid="auth-email" />
          </div>

          <div className="mb-4">
            <Label className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Password</Label>
            <Input value={password} onChange={(e) => setPassword(e.target.value)}
                   className="mt-2 h-11 rounded-xl border-slate-200 bg-white"
                   type="password" data-testid="auth-password" />
          </div>

          {mode === "register" && (
            <div className="mb-4">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="mt-2 h-11 rounded-xl border-slate-200 bg-white" data-testid="auth-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="architect">Architect / Designer</SelectItem>
                  <SelectItem value="ipc_lead">IPC Lead / Clinician</SelectItem>
                  <SelectItem value="reviewer">Reviewer</SelectItem>
                  <SelectItem value="contributor">Contributor</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <Button type="submit" disabled={busy}
                  className="w-full h-11 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-medium"
                  data-testid="auth-submit">
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </Button>

          <div className="mt-6 text-center">
            <button type="button" onClick={() => setMode(mode === "login" ? "register" : "login")}
                    className="text-sm text-slate-500 hover:text-slate-900 transition-colors"
                    data-testid="auth-toggle">
              {mode === "login" ? "Need an account? Register" : "Already have an account? Sign in"}
            </button>
          </div>

          <div className="mt-10 p-4 rounded-xl border border-slate-200 bg-white/60">
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-2">Demo accounts</div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono text-slate-600">
              <div>architect@his.dev</div><div>demo1234</div>
              <div>ipc@his.dev</div><div>demo1234</div>
              <div>reviewer@his.dev</div><div>demo1234</div>
              <div>contributor@his.dev</div><div>demo1234</div>
            </div>
          </div>
        </motion.form>
      </div>
    </div>
  );
}
