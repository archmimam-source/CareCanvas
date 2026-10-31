import React, { useState } from "react";
import { api } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { X, Plus } from "lucide-react";
import { toast } from "sonner";

const KIND_OPTIONS = [
  { value: "inpatient_dirty_utility", label: "Inpatient Dirty Utility" },
  { value: "clean_utility",           label: "Clean Utility" },
  { value: "isolation_room",          label: "Isolation Room" },
  { value: "sluice_room",             label: "Sluice Room" },
  { value: "custom",                  label: "Custom" },
];

export default function NewRoomDialog({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("clean_utility");
  const [code, setCode] = useState("");
  const [size, setSize] = useState("medium");
  const [width, setWidth] = useState(3.0);
  const [depth, setDepth] = useState(3.0);
  const [ceilingH, setCeilingH] = useState(2.7);
  const [risk, setRisk] = useState("medium");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name is required"); return; }
    setBusy(true);
    try {
      const r = await api.post(`/rooms`, {
        name: name.trim(), kind, code: code || null, size,
        width: Number(width), depth: Number(depth), ceiling_h: Number(ceilingH),
        risk_rating: risk,
      });
      toast.success(`${name} created`);
      onCreated?.(r.data.room);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create room");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
      data-testid="new-room-dialog"
    >
      <motion.form
        initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">New room type</div>
            <div className="font-display text-lg font-semibold tracking-tight mt-0.5">Add to estate</div>
          </div>
          <button type="button" onClick={onClose} className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center" data-testid="new-room-close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Name" testId="new-room-name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Clean Utility Room (Ward B)" data-testid="new-room-name-input"/>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Room kind">
              <select value={kind} onChange={(e) => setKind(e.target.value)}
                className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                data-testid="new-room-kind">
                {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </Field>
            <Field label="Code">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="RDS_1234" data-testid="new-room-code"/>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Width (m)">
              <Input type="number" step="0.1" value={width} onChange={(e) => setWidth(e.target.value)} data-testid="new-room-width"/>
            </Field>
            <Field label="Depth (m)">
              <Input type="number" step="0.1" value={depth} onChange={(e) => setDepth(e.target.value)} data-testid="new-room-depth"/>
            </Field>
            <Field label="Ceiling (m)">
              <Input type="number" step="0.1" value={ceilingH} onChange={(e) => setCeilingH(e.target.value)} data-testid="new-room-ceiling"/>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Size">
              <select value={size} onChange={(e) => setSize(e.target.value)}
                className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 text-sm">
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </Field>
            <Field label="Risk rating">
              <select value={risk} onChange={(e) => setRisk(e.target.value)}
                className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                data-testid="new-room-risk">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} className="rounded-full">Cancel</Button>
          <Button type="submit" disabled={busy} className="rounded-full bg-slate-900 hover:bg-slate-800 text-white" data-testid="new-room-submit">
            <Plus className="w-3.5 h-3.5 mr-1.5" /> {busy ? "Creating…" : "Create room"}
          </Button>
        </div>
      </motion.form>
    </motion.div>
  );
}

function Field({ label, children, testId }) {
  return (
    <div data-testid={testId}>
      <Label className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500 mb-1 block">{label}</Label>
      {children}
    </div>
  );
}
