import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";

const COPY = {
  clone: { title: "Use as template", desc: "Name your private, editable copy and choose where it lives in your estate.", cta: "Create my copy" },
  duplicate: { title: "Duplicate room", desc: "Creates a full copy of the layout, zones, fittings and network arrangement.", cta: "Duplicate" },
  rename: { title: "Rename room", desc: "Everyone with access sees the new name.", cta: "Save name" },
};

const KIND = { estate: "Estate", building: "Building", zone: "Floor / zone", ward: "Ward", room: "Room" };

// Every non-room level of the estate, in tree order, labelled with its full path.
export function buildPlaces(nodes) {
  const kids = {}, list = nodes.filter((n) => KIND[n.type]), ids = new Set(list.map((n) => n.id));
  list.forEach((n) => { (kids[ids.has(n.parent_id) ? n.parent_id : "root"] ||= []).push(n); });
  const out = [];
  const walk = (pid, trail) => (kids[pid] || []).sort((a, b) => a.name.localeCompare(b.name)).forEach((n) => {
    const path = [...trail, n.name];
    out.push({ id: n.id, label: path.join(" › "), kind: KIND[n.type], depth: trail.length });
    walk(n.id, path);
  });
  walk("root", []);
  return out;
}

// One in-app prompt for cloning, duplicating and renaming rooms.
export default function RoomNameDialog({ state, places = [], onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state) { setName(state.name || ""); setParent(state.parent_id || ""); } }, [state]);
  const c = COPY[state?.mode] || COPY.rename;
  const showPlace = state && state.mode !== "rename";
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onSubmit(name.trim(), parent || null); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md rounded-2xl" data-testid="room-name-dialog">
        <DialogHeader>
          <DialogTitle>{c.title}</DialogTitle>
          <DialogDescription>{c.desc}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[#86868B] font-medium">Name</span>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
              data-testid="room-name-input" className="mt-1.5 h-11 rounded-xl" placeholder="Room name" />
          </label>
          {showPlace && (
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.18em] text-[#86868B] font-medium">Place it in</span>
              <select value={parent} onChange={(e) => setParent(e.target.value)} data-testid="room-place-select"
                className="mt-1.5 w-full h-11 rounded-xl border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1D1D1F]/20">
                <option value="">Same place as the original</option>
                <option value="__root__">Top of estate (not placed)</option>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>{"\u00A0\u00A0".repeat(p.depth)}{p.label.split(" › ").pop()} · {p.kind}</option>
                ))}
              </select>
              {parent && parent !== "__root__" && (
                <span className="mt-1 block text-[11px] text-[#86868B] truncate" data-testid="room-place-path">
                  {places.find((p) => p.id === parent)?.label}
                </span>
              )}
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} data-testid="room-name-cancel"
              className="h-9 px-4 rounded-full border border-black/10 text-sm hover:bg-[#F5F5F7]">Cancel</button>
            <button type="submit" disabled={!name.trim() || busy} data-testid="room-name-submit"
              className="h-9 px-4 rounded-full bg-[#1D1D1F] text-white text-sm font-medium hover:bg-[#333] disabled:opacity-50 inline-flex items-center gap-1.5">
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{c.cta}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
