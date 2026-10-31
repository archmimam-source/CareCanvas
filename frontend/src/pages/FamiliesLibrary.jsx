import React, { useEffect, useState, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/apiClient";
import { TopBar } from "./Dashboard";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import * as THREE from "three";
import { Upload, Trash2, CheckCircle2, AlertCircle, FileBox, Loader2 } from "lucide-react";

const CONF_TINT = (c) =>
  c >= 0.9 ? "text-emerald-700 bg-emerald-50 border-emerald-200"
  : c >= 0.5 ? "text-amber-700 bg-amber-50 border-amber-200"
  : "text-rose-700 bg-rose-50 border-rose-200";

export default function FamiliesLibrary() {
  const { user, logout } = useAuth();
  const [families, setFamilies] = useState([]);
  const [components, setComponents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  const reload = async () => {
    const [f, c] = await Promise.all([
      api.get("/families"),
      api.get("/components"),
    ]);
    setFamilies(f.data);
    setComponents(c.data);
    if (selected) {
      const still = f.data.find((x) => x.id === selected.id);
      setSelected(still || null);
    }
  };
  useEffect(() => { reload(); /* eslint-disable-line */ }, []);

  const onFile = async (file) => {
    if (!file) return;
    setUploading(true); setErr(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await api.post("/families/upload", fd, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      await reload();
      setSelected(r.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Upload failed.");
    } finally { setUploading(false); }
  };

  const rebind = async (guid, newKey) => {
    await api.patch(`/families/${selected.id}`, { guid, component_key: newKey });
    await reload();
  };

  const removeFamily = async (id) => {
    if (!confirm("Delete this family?")) return;
    await api.delete(`/families/${id}`);
    if (selected?.id === id) setSelected(null);
    await reload();
  };

  return (
    <div className="min-h-screen bg-[#FAFAFB] text-[#1D1D1F]">
      <TopBar user={user} onLogout={logout} />
      <div className="max-w-7xl mx-auto px-8 pt-10 pb-24">
        <div className="flex items-end justify-between mb-8">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-2">
              IFC · Revit interop
            </div>
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-none">
              Family library
            </h1>
            <p className="mt-3 text-sm text-[#6E6E73] max-w-2xl">
              Upload Revit families exported to <code className="font-mono text-xs">.ifc</code>.
              We auto-classify each element against your component library and keep the
              real geometry attached so downstream exports carry the correct family metadata.
            </p>
          </div>
          <div className="flex gap-2">
            <input ref={inputRef} type="file" accept=".ifc,.rfa" hidden
                   onChange={(e) => onFile(e.target.files?.[0])}
                   data-testid="family-file-input" />
            <Button onClick={() => inputRef.current?.click()}
                    data-testid="upload-family-btn"
                    disabled={uploading}
                    className="rounded-full h-10 bg-[#1D1D1F] hover:bg-black text-white">
              {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              {uploading ? "Parsing…" : "Upload .ifc / .rfa"}
            </Button>
          </div>
        </div>

        {err && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm"
               data-testid="upload-error">
            {err}
          </div>
        )}

        <div className="grid grid-cols-12 gap-6">
          {/* Family list */}
          <div className="col-span-4">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#86868B] font-medium mb-3">
              {families.length} file{families.length === 1 ? "" : "s"}
            </div>
            {families.length === 0 && (
              <div className="rounded-2xl border border-dashed border-black/10 bg-white/40 p-8 text-center"
                   data-testid="families-empty">
                <FileBox className="w-8 h-8 mx-auto text-[#86868B] mb-2" />
                <div className="text-sm font-medium">No IFC / RFA families yet</div>
                <div className="text-[12px] text-[#6E6E73] mt-1">
                  Upload a Revit family — either <code className="font-mono text-[11px]">.rfa</code> (binary — we extract metadata + thumbnail) or <code className="font-mono text-[11px]">.ifc</code> (open — full 3D geometry).
                </div>
              </div>
            )}
            <div className="space-y-2">
              {families.map((f) => (
                <button key={f.id} onClick={() => setSelected(f)}
                        data-testid={`family-card-${f.id}`}
                        className={`w-full text-left p-3 rounded-xl border transition ${
                          selected?.id === f.id
                            ? "bg-white border-[#1D1D1F]/20 shadow-[0_4px_16px_rgba(0,0,0,0.06)]"
                            : "bg-white/60 border-black/5 hover:bg-white"
                        }`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {f.elements?.[0]?.name || f.filename}
                      </div>
                      <div className="text-[11px] text-[#6E6E73] mt-0.5 flex items-center gap-1.5">
                        <span className={`inline-block px-1.5 py-[1px] rounded text-[9px] font-mono uppercase tracking-wider ${
                          f.file_kind === "rfa" ? "bg-violet-50 text-violet-700" : "bg-sky-50 text-sky-700"
                        }`}>{f.file_kind || "ifc"}</span>
                        <span>{f.total_elements} element{f.total_elements === 1 ? "" : "s"}</span>
                      </div>
                      {f.elements?.[0]?.properties?.Identity?.category && (
                        <div className="text-[10px] text-[#86868B] mt-0.5 truncate">
                          {f.elements[0].properties.Identity.category}
                        </div>
                      )}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeFamily(f.id); }}
                            data-testid={`del-family-${f.id}`}
                            className="text-[#86868B] hover:text-rose-700 p-1">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Element inspector */}
          <div className="col-span-8">
            {!selected ? (
              <div className="h-96 rounded-2xl border border-dashed border-black/10 bg-white/40 flex items-center justify-center text-sm text-[#6E6E73]">
                Select a family to inspect its elements.
              </div>
            ) : (
              <FamilyDetail family={selected} components={components} onRebind={rebind} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FamilyDetail({ family, components, onRebind }) {
  const [meshes, setMeshes] = useState(null);
  useEffect(() => {
    (async () => {
      setMeshes(null);
      const r = await api.get(`/families/${family.id}/mesh`);
      setMeshes(r.data.meshes);
    })();
  }, [family.id]);

  return (
    <div className="space-y-4" data-testid="family-detail">
      <div className="grid grid-cols-2 gap-4">
        <MeshPreview meshes={meshes} />
        <ThumbPreview family={family} />
      </div>
      {family.file_kind === "rfa" && family.elements?.[0]?.properties && (
        <RfaPropsPanel el={family.elements[0]} />
      )}
      <div className="rounded-2xl border border-black/5 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-black/5 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">Elements</div>
            <div className="text-sm font-medium">{family.filename}</div>
          </div>
          <div className="text-[11px] text-[#6E6E73] font-mono">
            sha256 · {family.sha256}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-[#FAFAFB] text-[10px] uppercase tracking-[0.18em] text-[#86868B]">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Element</th>
              <th className="text-left px-4 py-2 font-medium">IFC type</th>
              <th className="text-left px-4 py-2 font-medium">Dimensions</th>
              <th className="text-left px-4 py-2 font-medium">Suggested component</th>
              <th className="text-left px-4 py-2 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5">
            {family.elements.map((e) => (
              <tr key={e.guid} data-testid={`family-element-${e.guid}`}>
                <td className="px-4 py-3">
                  <div className="text-[13px] font-medium">{e.name}</div>
                  <div className="text-[10px] text-[#6E6E73] font-mono">{e.guid.slice(0, 12)}…</div>
                </td>
                <td className="px-4 py-3 text-[12px] text-[#6E6E73]">
                  {e.ifc_type}
                  {e.predefined_type && <div className="text-[10px]">{e.predefined_type}</div>}
                </td>
                <td className="px-4 py-3 text-[12px] font-mono text-[#6E6E73]">
                  {e.dimensions.w?.toFixed(2) ?? "?"} × {e.dimensions.d?.toFixed(2) ?? "?"} × {e.dimensions.h?.toFixed(2) ?? "?"} m
                </td>
                <td className="px-4 py-3">
                  <Select value={e.component_key_suggested || "__none"}
                          onValueChange={(v) => onRebind(e.guid, v === "__none" ? null : v)}>
                    <SelectTrigger className="h-8 w-56 text-xs bg-white"
                                   data-testid={`bind-${e.guid}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">— unbind —</SelectItem>
                      {components.map((c) => (
                        <SelectItem key={c.key} value={c.key}>
                          {c.display_name || c.key} ({c.kind})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-[10px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-full border ${CONF_TINT(e.confidence)}`}>
                    {e.confidence >= 0.9 ? <CheckCircle2 className="w-3 h-3 inline mr-1" />
                     : e.confidence >= 0.5 ? <CheckCircle2 className="w-3 h-3 inline mr-1" />
                     : <AlertCircle className="w-3 h-3 inline mr-1" />}
                    {(e.confidence * 100).toFixed(0)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ThumbPreview({ family }) {
  const el = family.elements?.[0];
  if (family.file_kind !== "rfa" || !el?.thumbnail_url) {
    return (
      <div className="h-64 rounded-2xl bg-[#FAFAFB] border border-black/5 flex flex-col items-center justify-center text-[12px] text-[#6E6E73]">
        <div className="text-[10px] uppercase tracking-[0.24em] text-[#86868B] mb-2">
          {family.file_kind === "rfa" ? "Revit binary" : "IFC"}
        </div>
        <div>{family.file_kind === "rfa"
          ? "No embedded preview in this .rfa."
          : "3D preview on the left."}</div>
      </div>
    );
  }
  const url = `${process.env.REACT_APP_BACKEND_URL}${el.thumbnail_url}`;
  return (
    <div className="h-64 rounded-2xl bg-gradient-to-b from-[#EEF0F3] to-[#F7F7F9] border border-black/5 overflow-hidden flex items-center justify-center">
      <img src={url} alt="Revit preview" className="max-h-full max-w-full object-contain"
           data-testid="rfa-thumbnail" />
    </div>
  );
}

function RfaPropsPanel({ el }) {
  const p = el.properties || {};
  const rows = [
    ["Full Revit title",  p.Identity?.family_title_full],
    ["Category",          p.Identity?.category],
    ["Description",       p.Identity?.description],
    ["Manufacturer",      p.Identity?.manufacturer],
    ["Revit product",     p.Identity?.revit_product],
    ["Size (declared)",   p.Dimensions?.size_text],
    ["Uniclass 2015 Pr",  p["Uniclass 2015"]?.code],
    ["Uniclass reference",p["Uniclass 2015"]?.reference],
    ["Uniclass version",  p["Uniclass 2015"]?.version],
    ["IFC PreDefined",    p.Standards?.ifc_predefined_type],
    ["Standard",          p.Standards?.standard],
    ["Warranty unit",     p.Warranty?.duration_unit],
    ["Replacement cost",  p.Warranty?.replacement_cost],
  ].filter(([, v]) => v && String(v).trim() && v !== "n/a");
  if (!rows.length) return null;
  return (
    <div className="rounded-2xl border border-black/5 bg-white overflow-hidden" data-testid="rfa-props-panel">
      <div className="px-4 py-3 border-b border-black/5 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-[#86868B] font-medium">Revit properties</div>
          <div className="text-sm font-medium">{el.name}</div>
        </div>
        <div className="text-[10px] text-[#86868B] uppercase tracking-[0.14em]">
          Extracted from .rfa
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[10px] uppercase tracking-[0.18em] text-[#86868B] font-medium">{k}</dt>
            <dd className="text-[13px] mt-0.5 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function MeshPreview({ meshes }) {
  if (!meshes) {
    return <div className="h-64 rounded-2xl bg-[#FAFAFB] border border-black/5 flex items-center justify-center text-sm text-[#6E6E73]">
      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Rendering geometry…
    </div>;
  }
  if (!meshes.length) {
    return <div className="h-64 rounded-2xl bg-[#FAFAFB] border border-black/5 flex items-center justify-center text-sm text-[#6E6E73]">
      No renderable geometry in this file.
    </div>;
  }
  return (
    <div className="h-64 rounded-2xl bg-gradient-to-b from-[#EEF0F3] to-[#F7F7F9] border border-black/5 overflow-hidden">
      <Canvas camera={{ position: [1.5, 1.2, 1.5], fov: 40 }} shadows>
        <ambientLight intensity={0.55} />
        <directionalLight position={[3, 4, 2]} intensity={0.9} castShadow />
        <Grid infiniteGrid cellSize={0.1} sectionSize={1} fadeDistance={5}
              cellColor="#D2D2D7" sectionColor="#B0B0B4" />
        {meshes.map((m) => <MeshFromIFC key={m.guid} data={m} />)}
        <OrbitControls enableDamping />
      </Canvas>
    </div>
  );
}

function MeshFromIFC({ data }) {
  const geom = React.useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(data.vertices, 3));
    g.setIndex(data.faces);
    g.computeVertexNormals();
    return g;
  }, [data]);
  return (
    <mesh geometry={geom} castShadow receiveShadow>
      <meshStandardMaterial color="#C8CBD0" metalness={0.2} roughness={0.7} />
    </mesh>
  );
}
