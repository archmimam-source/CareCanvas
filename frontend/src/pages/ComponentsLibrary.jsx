import React, { useEffect, useMemo, useState, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/apiClient";
import { TopBar } from "./Dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, Search, Trash2, Loader2, Box, CheckCircle2, Filter, Pencil, Check, X as XIcon, AlertTriangle, Link2 } from "lucide-react";

/**
 * Unified Components library: every seed component is shown, and if a Revit
 * family has been uploaded for that component_key it becomes the visible
 * "override" (thumbnail, real title, category, Uniclass, size). Uploading
 * more .rfa/.ifc files further augments the library.
 */
export default function ComponentsLibrary() {
  const { user, logout } = useAuth();
  const [lib, setLib] = useState({ components: [], override_count: 0, seed_count: 0, orphans: [] });
  const [selected, setSelected] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all"); // all | revit | default
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // { comp }
  const [purge, setPurge] = useState(false);
  const inputRef = useRef(null);

  const reload = async () => {
    const r = await api.get("/components/library");
    setLib(r.data);
    if (selected) {
      const still = r.data.components.find((c) => c.key === selected.key);
      setSelected(still || null);
    }
  };
  useEffect(() => { reload(); /* eslint-disable-line */ }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (lib.components || []).filter((c) => {
      if (filter === "revit"   && !c.has_override) return false;
      if (filter === "default" &&  c.has_override) return false;
      if (!s) return true;
      const hay = `${c.key} ${c.name} ${c.description || ""} ${c.override?.revit_title || ""} ${c.override?.category || ""}`.toLowerCase();
      return hay.includes(s);
    });
  }, [lib, q, filter]);

  const grouped = useMemo(() => {
    const g = {};
    for (const c of filtered) {
      const cat = c.override?.category
                || c.zone_affinity?.replace(/^./, x => x.toUpperCase()) + " zone"
                || "General";
      g[cat] = g[cat] || [];
      g[cat].push(c);
    }
    return g;
  }, [filtered]);

  const onFile = async (file) => {
    if (!file) return;
    setUploading(true); setErr(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      await api.post("/families/upload", fd,
        { headers: { "Content-Type": "multipart/form-data" } });
      await reload();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Upload failed.");
    } finally { setUploading(false); }
  };

  const removeOverride = async (comp, force = false) => {
    if (!comp?.override) return;
    await api.delete(`/families/${comp.override.family_id}`, { params: { force } });
    await reload();
  };

  const renameOverride = async (comp, patch) => {
    if (!comp?.override) return;
    await api.patch(`/families/${comp.override.family_id}`, patch);
    await reload();
  };

  return (
    <div className="min-h-screen bg-[#FAFAFB] text-[#1D1D1F]">
      <TopBar user={user} onLogout={logout} />
      <div className="max-w-7xl mx-auto px-8 pt-10 pb-24">
        <div className="flex items-end justify-between mb-8">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-2">
              Component library · Revit-aware
            </div>
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-none">
              Components
            </h1>
            <p className="mt-3 text-sm text-[#6E6E73] max-w-2xl">
              Every reusable object in the platform. Upload Revit families
              (<code className="font-mono text-xs">.rfa</code> or
              <code className="font-mono text-xs"> .ifc</code>) to replace a
              default component with the manufacturer's real geometry and
              metadata. Components without a Revit override use the built-in
              defaults.
            </p>
          </div>
          <div className="flex gap-2">
            <input ref={inputRef} type="file" accept=".ifc,.rfa" hidden
                   onChange={(e) => onFile(e.target.files?.[0])}
                   data-testid="component-file-input" />
            <Button onClick={() => inputRef.current?.click()}
                    data-testid="upload-component-btn"
                    disabled={uploading}
                    className="rounded-full h-10 bg-[#1D1D1F] hover:bg-black text-white">
              {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              {uploading ? "Parsing…" : "Upload Revit file"}
            </Button>
          </div>
        </div>

        {err && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm"
               data-testid="upload-error">{err}</div>
        )}

        {/* Stats + filters */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <Metric label="Total components"   value={lib.seed_count}     testId="metric-seed" />
          <Metric label="Revit-backed"       value={lib.override_count} testId="metric-overridden" accent="emerald" />
          <Metric label="Using defaults"     value={Math.max(0, (lib.seed_count || 0) - (lib.override_count || 0))} testId="metric-default" />
        </div>

        {/* Orphans banner — uploads the classifier couldn't map */}
        {lib.orphans && lib.orphans.length > 0 && (
          <OrphansPanel orphans={lib.orphans} components={lib.components || []}
                        onReload={reload} />
        )}
        <div className="flex flex-wrap gap-3 mb-5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Search components, Revit titles, Uniclass…"
                   data-testid="component-search"
                   className="pl-9 h-10 w-96 rounded-full bg-white border-black/10 text-sm" />
          </div>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-56 rounded-full bg-white border-black/10 text-sm"
                           data-testid="filter-revit">
              <Filter className="w-3 h-3 mr-2" /><SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Show all</SelectItem>
              <SelectItem value="revit">Revit-backed only</SelectItem>
              <SelectItem value="default">Using default only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Grid of component tiles, grouped by category */}
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-7 space-y-8">
            {Object.keys(grouped).sort().map((cat) => (
              <div key={cat}>
                <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-3">
                  {cat} · {grouped[cat].length}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {grouped[cat].map((c) => <Tile key={c.key} c={c} selected={selected?.key === c.key}
                                                 onSelect={() => setSelected(c)} />)}
                </div>
              </div>
            ))}
            {!filtered.length && (
              <div className="rounded-2xl border border-dashed border-black/10 bg-white/40 p-16 text-center">
                <Box className="w-8 h-8 mx-auto text-[#86868B] mb-2" />
                <div className="text-sm font-medium">No components match</div>
              </div>
            )}
          </div>
          <div className="col-span-5">
            <div className="sticky top-24">
              {selected
                ? <DetailPanel c={selected}
                               allComponents={lib.components || []}
                               onRemoveOverride={() => { setPurge(false); setConfirmDelete({ comp: selected }); }}
                               onRename={(patch) => renameOverride(selected, patch)} />
                : <div className="rounded-2xl border border-dashed border-black/10 bg-white/40 p-10 text-sm text-[#6E6E73]">
                    Select a component to see its Revit metadata (or lack thereof).
                  </div>}
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent data-testid="delete-override-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Revit override?</AlertDialogTitle>
            <AlertDialogDescription>
              This unbinds the Revit family from{" "}
              <span className="font-medium">{confirmDelete?.comp?.name}</span>. The
              component will fall back to its built-in default geometry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50/60 p-3 cursor-pointer">
            <Checkbox checked={purge} onCheckedChange={(v) => setPurge(!!v)}
                      data-testid="purge-file-checkbox" className="mt-0.5" />
            <div className="text-[13px] leading-snug">
              <div className="font-medium text-rose-900">
                Also delete the .rfa / .ifc file from storage
              </div>
              <div className="text-rose-800/80 text-[12px] mt-0.5">
                Permanently frees disk space. You'll need to re-upload the
                file to restore this override. Leave unchecked for a safe
                soft-delete (the file stays on disk).
              </div>
            </div>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="delete-cancel-btn">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="delete-confirm-btn"
              className={purge ? "bg-rose-600 hover:bg-rose-700" : ""}
              onClick={async () => {
                const c = confirmDelete?.comp;
                setConfirmDelete(null);
                await removeOverride(c, purge);
                setPurge(false);
              }}>
              {purge ? "Remove & Purge file" : "Remove override"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Metric({ label, value, testId, accent }) {
  const c = accent === "emerald" ? "text-emerald-700" : "text-[#1D1D1F]";
  return (
    <div className="rounded-2xl bg-white border border-black/5 p-4" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tracking-tight tabular-nums ${c}`}>{value}</div>
    </div>
  );
}

function Tile({ c, selected, onSelect }) {
  const thumb = c.override?.thumbnail_url
    ? `${process.env.REACT_APP_BACKEND_URL}${c.override.thumbnail_url}` : null;
  return (
    <button onClick={onSelect}
            data-testid={`component-tile-${c.key}`}
            className={`text-left p-3 rounded-xl border transition group ${
              selected ? "bg-white border-[#1D1D1F]/25 shadow-[0_6px_18px_rgba(0,0,0,0.08)]"
                       : "bg-white/70 border-black/5 hover:bg-white hover:border-black/10"
            }`}>
      <div className="aspect-[4/3] rounded-lg bg-gradient-to-br from-[#EEF0F3] to-[#F7F7F9] flex items-center justify-center overflow-hidden mb-2">
        {thumb
          ? <img src={thumb} alt="" className="max-h-full max-w-full object-contain" />
          : <Box className="w-8 h-8 text-[#C0C4C9]" />
        }
      </div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate">
            {c.override?.revit_title
              ? _simplify(c.override.revit_title)
              : c.name}
          </div>
          <div className="text-[10px] font-mono text-[#86868B] truncate mt-0.5">{c.key}</div>
        </div>
        {c.has_override && (
          <span className="text-[9px] uppercase tracking-[0.16em] font-mono bg-violet-50 text-violet-700 px-1.5 py-[1px] rounded"
                title={`Revit: ${c.override.revit_title}`}>REVIT</span>
        )}
      </div>
    </button>
  );
}

function _simplify(title) {
  if (!title) return "";
  const m = /^IDP_[^_]+_[A-Z0-9]+-\s*(.+?)(\.rfa)?$/i.exec(title);
  const s = m ? m[1] : title.replace(/\.rfa$/i, "");
  return s.split(/\s+/).map(w => w[0] + w.slice(1).toLowerCase()).join(" ");
}

function DetailPanel({ c, allComponents, onRemoveOverride, onRename }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const startEdit = () => {
    setName(c.override?.revit_title
      ? _simplify(c.override.revit_title)
      : (c.name || ""));
    setKey(c.key);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const patch = {};
      if (name) patch.name = name;
      if (key && key !== c.key) patch.component_key = key;
      if (Object.keys(patch).length) await onRename(patch);
      setEditing(false);
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-black/5 bg-white overflow-hidden" data-testid="component-detail">
      <div className="px-4 py-3 border-b border-black/5 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">
            {c.override ? "Revit family override" : "Default component"}
          </div>
          {editing ? (
            <Input value={name} onChange={(e) => setName(e.target.value)}
                   data-testid="rename-input"
                   className="mt-1 h-8 text-base font-semibold tracking-tight" />
          ) : (
            <div className="text-base font-semibold tracking-tight mt-0.5 truncate">
              {c.override?.revit_title
                ? _simplify(c.override.revit_title)
                : c.name}
            </div>
          )}
          <div className="text-[10px] font-mono text-[#86868B] mt-0.5">{c.key} · {c.kind}</div>
        </div>
        {c.override && !editing && (
          <div className="flex items-center gap-1">
            <button onClick={startEdit}
                    data-testid="rename-override-btn"
                    className="text-[#86868B] hover:text-slate-900 p-1"
                    title="Rename / re-classify">
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={onRemoveOverride}
                    data-testid="remove-override-btn"
                    className="text-[#86868B] hover:text-rose-700 p-1"
                    title="Remove Revit override">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {editing && (
          <div className="flex items-center gap-1">
            <button onClick={save} disabled={busy}
                    data-testid="rename-save-btn"
                    className="text-emerald-700 hover:text-emerald-900 p-1"
                    title="Save">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => setEditing(false)}
                    data-testid="rename-cancel-btn"
                    className="text-[#86868B] hover:text-slate-900 p-1"
                    title="Cancel">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
      {editing && c.override && (
        <div className="px-4 py-3 border-b border-black/5 bg-slate-50/60">
          <div className="text-[10px] uppercase tracking-[0.18em] text-[#86868B] font-medium mb-1.5">
            Re-classify to component
          </div>
          <Select value={key} onValueChange={setKey}>
            <SelectTrigger className="h-9 bg-white text-sm" data-testid="rename-key-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {(allComponents || []).map((oc) => (
                <SelectItem key={oc.key} value={oc.key}>
                  {oc.name} <span className="opacity-60 font-mono text-[11px]">· {oc.key}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {key !== c.key && (
            <div className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              Changing the key will move this override to a different
              seed component. The current binding will be lost.
            </div>
          )}
        </div>
      )}
      {c.override ? (
        <>
          {c.override.thumbnail_url && (
            <img src={`${process.env.REACT_APP_BACKEND_URL}${c.override.thumbnail_url}`}
                 alt="" className="w-full max-h-56 object-contain bg-[#F7F7F9]"
                 data-testid="override-thumbnail" />
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 text-[12px]">
            <PropRow k="Full Revit title" v={c.override.revit_title} full />
            <PropRow k="Source file"       v={c.override.filename} full />
            <PropRow k="Category"          v={c.override.category} />
            <PropRow k="IFC PreDefined"    v={c.override.ifc_predefined} />
            <PropRow k="Size (declared)"   v={c.override.size_text} />
            <PropRow k="Uniclass 2015"     v={c.override.uniclass?.code} full />
            <PropRow k="Uniclass ref"      v={c.override.uniclass?.reference} />
            <PropRow k="Uniclass version"  v={c.override.uniclass?.version} />
            <PropRow k="Uploaded"          v={`${(c.override.uploaded_at || "").slice(0,16).replace("T"," ")} · ${c.override.uploaded_by || ""}`} full />
            <PropRow k="Description"       v={c.override.description || c.description} full />
          </dl>
        </>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 text-[12px]">
          <PropRow k="Kind"          v={c.kind} />
          <PropRow k="Mount"         v={c.mount_type} />
          <PropRow k="Zone affinity" v={c.zone_affinity} />
          <PropRow k="Footprint"     v={c.default_footprint ? `${c.default_footprint.w} × ${c.default_footprint.d} × ${c.default_footprint.h} m` : "—"} full />
          <PropRow k="Code"          v={c.code} />
          <PropRow k="Material"      v={c.material} />
          <PropRow k="Description"   v={c.description} full />
        </dl>
      )}
    </div>
  );
}

function PropRow({ k, v, full }) {
  if (!v) return null;
  return (
    <div className={`${full ? "col-span-2" : ""} min-w-0`}>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-[#86868B] font-medium">{k}</dt>
      <dd className="mt-0.5 break-words">{v}</dd>
    </div>
  );
}


function OrphansPanel({ orphans, components, onReload }) {
  const [selected, setSelected] = useState(new Set());
  const [targetKey, setTargetKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const selectAll = () => setSelected(new Set(orphans.map(o => o.family_id)));
  const clearAll  = () => setSelected(new Set());

  const rebindSelected = async () => {
    if (!targetKey || selected.size === 0) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.post("/families/rebind", {
        family_ids: Array.from(selected), component_key: targetKey,
      });
      setMsg(`Bound ${r.data.rebound}/${selected.size} to ${targetKey}.`);
      setSelected(new Set());
      setTargetKey("");
      await onReload();
    } catch (e) {
      setMsg(e?.response?.data?.detail || "Rebind failed.");
    } finally { setBusy(false); }
  };

  return (
    <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50/60 overflow-hidden"
         data-testid="orphans-panel">
      <div className="px-4 py-3 border-b border-amber-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-700 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.2em] text-amber-800 font-medium">
              Unmatched Revit uploads · {orphans.length}
            </div>
            <div className="text-xs text-amber-900/80 mt-0.5">
              The classifier couldn't map these files to a seed component. Select
              one or more and choose the component key to hand-bind them.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={selectAll} data-testid="orphans-select-all"
                  className="text-[11px] font-mono uppercase tracking-wider text-amber-800 hover:text-amber-950">
            Select all
          </button>
          <span className="text-amber-300">·</span>
          <button onClick={clearAll} data-testid="orphans-clear-selection"
                  className="text-[11px] font-mono uppercase tracking-wider text-amber-800 hover:text-amber-950">
            Clear
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3">
        {orphans.map((o) => {
          const on = selected.has(o.family_id);
          const thumb = o.thumbnail_url
            ? `${process.env.REACT_APP_BACKEND_URL}${o.thumbnail_url}` : null;
          return (
            <label key={o.family_id}
                   data-testid={`orphan-${o.family_id}`}
                   className={`flex items-center gap-3 p-2.5 rounded-lg bg-white border cursor-pointer transition-colors ${
                     on ? "border-amber-500 ring-1 ring-amber-500" : "border-amber-200 hover:border-amber-400"
                   }`}>
              <Checkbox checked={on} onCheckedChange={() => toggle(o.family_id)}
                        data-testid={`orphan-check-${o.family_id}`} />
              {thumb
                ? <img src={thumb} alt="" className="w-10 h-10 object-contain rounded bg-[#F5F5F7]" />
                : <div className="w-10 h-10 rounded bg-[#F5F5F7] flex items-center justify-center">
                    <Box className="w-4 h-4 text-slate-400" />
                  </div>}
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium truncate">{o.name || o.filename}</div>
                <div className="text-[10px] font-mono text-slate-500 truncate">
                  {o.reason === "no_classifier_match"
                    ? "no classifier match"
                    : `unknown key: ${o.suggested_key_unknown}`}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      <div className="border-t border-amber-200 px-4 py-3 bg-amber-100/40 flex items-center gap-3">
        <div className="text-[11px] font-mono uppercase tracking-wider text-amber-900">
          Bind {selected.size || "…"} to
        </div>
        <div className="flex-1 max-w-md">
          <Select value={targetKey} onValueChange={setTargetKey}>
            <SelectTrigger className="h-9 bg-white text-sm" data-testid="orphans-target-select">
              <SelectValue placeholder="Select a component key…" />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {(components || []).map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.name} <span className="opacity-60 font-mono text-[11px]">· {c.key}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm"
                onClick={rebindSelected}
                disabled={busy || selected.size === 0 || !targetKey}
                data-testid="orphans-rebind-btn"
                className="h-9 rounded-full bg-amber-700 hover:bg-amber-800 text-white">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Link2 className="w-3.5 h-3.5 mr-2" />}
          Rebind selected
        </Button>
      </div>

      {msg && (
        <div className="px-4 py-2 border-t border-amber-200 text-[12px] text-amber-900"
             data-testid="orphans-message">{msg}</div>
      )}
    </div>
  );
}
