import React, { useRef, useState } from "react";
import { api } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { motion } from "framer-motion";
import { X, FileUp, Loader2, Box, Check } from "lucide-react";
import { toast } from "sonner";

function SpaceRow({ s, active, onPick }) {
  return (
    <button type="button" onClick={onPick} data-testid={`ifc-space-${s.guid}`}
      className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
        active ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-400"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-slate-900 truncate">{s.name}</div>
        {active && <Check className="w-4 h-4 text-slate-900 shrink-0" />}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate-500">
        {s.width} × {s.depth} m · ceiling {s.ceiling_h} m · {s.items_count} fittings
        {s.generic_count > 0 && <span className="text-amber-700"> · {s.generic_count} generic</span>}
      </div>
    </button>
  );
}

function FloorPicker({ spaces, storeys, storey, setStorey, building, setBuilding }) {
  const onFloor = spaces.filter((s) => (s.storey || "Level") === storey);
  return (
    <div className="space-y-3" data-testid="ifc-floor-picker">
      <div className="flex flex-wrap gap-2">
        {storeys.map((st) => (
          <button key={st} type="button" onClick={() => setStorey(st)} data-testid={`ifc-storey-${st}`}
            className={`h-8 px-3 rounded-full border text-xs transition-colors ${st === storey ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 hover:border-slate-500"}`}>
            {st} · {spaces.filter((s) => (s.storey || "Level") === st).length} rooms
          </button>
        ))}
      </div>
      <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
        {onFloor.map((s) => (
          <div key={s.guid} className="px-3 py-2 flex justify-between text-xs">
            <span className="text-slate-900 truncate">{s.name}</span>
            <span className="font-mono text-slate-500 shrink-0 ml-2">{s.width}×{s.depth} m · {s.items_count}</span>
          </div>
        ))}
      </div>
      <Input value={building} onChange={(e) => setBuilding(e.target.value)} placeholder="Building name"
        data-testid="ifc-import-building-name" />
      <div className="text-[11px] text-slate-500">
        The building, floor and rooms stay private to you. You can ask to make the building public later; an admin approves it.
      </div>
    </div>
  );
}

export default function IfcImportDialog({ onClose, onCreated }) {
  const fileRef = useRef(null);
  const [stage, setStage] = useState("pick"); // pick | uploading | choose | creating
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState(null);
  const [guid, setGuid] = useState(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("room"); // room | floor
  const [storey, setStorey] = useState(null);
  const [building, setBuilding] = useState("");
  const storeys = result ? [...new Set(result.spaces.map((s) => s.storey || "Level"))] : [];

  const upload = async (file) => {
    if (!file) return;
    setStage("uploading"); setPct(0);
    const fd = new FormData(); fd.append("file", file);
    try {
      const r = await api.post("/ifc-import", fd, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (e) => e.total && setPct(Math.round((e.loaded / e.total) * 100)),
      });
      setResult(r.data);
      const first = r.data.spaces[0];
      setGuid(first.guid); setName(first.name);
      setStorey(first.storey || "Level"); setBuilding(first.building || `${r.data.project || "Imported"} building`);
      setStage("choose");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not read the IFC file");
      setStage("pick");
    }
  };

  const createFloor = async () => {
    setStage("creating");
    try {
      const r = await api.post(`/ifc-import/${result.id}/create-floor`, { storey, building_name: building });
      toast.success(`Created ${r.data.rooms.length} rooms in ${r.data.building.name} · ${storey}`);
      onCreated?.(null);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Floor import failed");
      setStage("choose");
    }
  };

  const create = async () => {
    if (mode === "floor") return createFloor();
    setStage("creating");
    try {
      const r = await api.post(`/ifc-import/${result.id}/create`, { space_guid: guid, name });
      toast.success(`Imported ${r.data.items} fittings from ${result.filename}`);
      onCreated?.(r.data.room);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Import failed");
      setStage("choose");
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose} data-testid="ifc-import-dialog">
      <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Revit · IFC export</div>
            <div className="font-display text-lg font-semibold tracking-tight mt-0.5">Import a room from IFC</div>
          </div>
          <button type="button" onClick={onClose} data-testid="ifc-import-close"
            className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        {stage === "pick" && (
          <button type="button" onClick={() => fileRef.current?.click()} data-testid="ifc-import-drop"
            className="w-full rounded-xl border-2 border-dashed border-slate-300 hover:border-slate-500 py-10 flex flex-col items-center gap-2 transition-colors">
            <FileUp className="w-6 h-6 text-slate-500" />
            <div className="text-sm font-medium text-slate-900">Choose an .ifc file</div>
            <div className="text-xs text-slate-500 max-w-xs text-center">
              In Revit: File → Export → IFC, with rooms/spaces included. Up to 150 MB.
            </div>
          </button>
        )}
        <input ref={fileRef} type="file" accept=".ifc" className="hidden" data-testid="ifc-import-input"
          onChange={(e) => upload(e.target.files?.[0])} />

        {stage === "uploading" && (
          <div className="py-8 space-y-3" data-testid="ifc-import-progress">
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Loader2 className="w-4 h-4 animate-spin" />
              {pct < 100 ? `Uploading… ${pct}%` : "Reading rooms and fittings…"}
            </div>
            <Progress value={pct} />
          </div>
        )}

        {(stage === "choose" || stage === "creating") && result && (
          <div className="space-y-4">
            <div className="text-xs text-slate-500" data-testid="ifc-import-summary">
              {result.filename} · {result.authoring_tool || result.schema}
              {result.project ? ` · ${result.project}` : ""} · {result.spaces.length} room(s) found
            </div>
            <div className="grid grid-cols-2 gap-1 p-1 rounded-full bg-slate-100" data-testid="ifc-import-mode">
              {[["room", "One room"], ["floor", "Whole floor"]].map(([m, l]) => (
                <button key={m} type="button" onClick={() => setMode(m)} data-testid={`ifc-mode-${m}`}
                  className={`h-8 rounded-full text-xs font-medium transition-colors ${mode === m ? "bg-white shadow-sm text-slate-900" : "text-slate-500"}`}>
                  {l}
                </button>
              ))}
            </div>
            {mode === "room" ? (
              <>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {result.spaces.map((s) => (
                    <SpaceRow key={s.guid} s={s} active={s.guid === guid}
                      onPick={() => { setGuid(s.guid); setName(s.name); }} />
                  ))}
                </div>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Room name"
                  data-testid="ifc-import-name" />
              </>
            ) : (
              <FloorPicker spaces={result.spaces} storeys={storeys} storey={storey} setStorey={setStorey}
                building={building} setBuilding={setBuilding} />
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <Box className="w-3 h-3" /> Unknown fittings become labelled boxes at true size
              </div>
              <Button onClick={create} disabled={stage === "creating" || (mode === "room" ? !name.trim() : !building.trim())}
                className="rounded-full bg-slate-900 hover:bg-slate-800 text-white" data-testid="ifc-import-create">
                {stage === "creating" ? "Creating…" : mode === "floor" ? "Create floor" : "Create room"}
              </Button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
