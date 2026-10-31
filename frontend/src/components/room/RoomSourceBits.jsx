import React, { useState } from "react";
import { api } from "@/lib/apiClient";
import { saveBlob, brandedName } from "@/lib/download";
import { toast } from "sonner";
import { Eye, Copy, FileDown, RefreshCw } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function ReadOnlyBanner({ node, user, onCopied }) {
  const [busy, setBusy] = useState(false);
  if (!node || node.can_edit !== false) return null;
  const copy = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/rooms/${node.id}/clone`, { name: `${node.name} (my copy)` });
      toast.success("Your own editable copy is ready");
      onCopied?.(r.data.room.id);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not make a copy");
    } finally { setBusy(false); }
  };
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-8 py-2.5 flex items-center justify-between gap-4"
         data-testid="readonly-banner">
      <div className="flex items-center gap-2 text-sm text-amber-900">
        <Eye className="w-4 h-4 shrink-0" />
        <span><b className="font-semibold">{node.owner_id ? "Shared room · view only." : "Template room · view only."}</b> Make your own copy to move, add or change anything.</span>
      </div>
      <button onClick={copy} disabled={busy} data-testid="readonly-make-copy-btn"
        className="h-8 px-4 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors disabled:opacity-60">
        <Copy className="w-3.5 h-3.5" /> {busy ? "Copying…" : "Make my own copy"}
      </button>
    </div>
  );
}

export function IfcSourceButton({ node, onReimport }) {
  const src = node?.metadata?.ifc_source;
  if (!src) return null;
  const download = async () => {
    try {
      const r = await api.get(`/rooms/${node.id}/ifc-source`, { responseType: "blob" });
      saveBlob(r.data, brandedName(node.name, "original", "ifc"));
    } catch { toast.error("Original IFC not available"); }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button data-testid="ifc-source-menu-btn" title={`Imported from ${src.filename} · ${src.space_name}`}
          className="ml-1 h-6 px-2 rounded-full inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest bg-violet-100 text-violet-900 hover:bg-violet-200 transition-colors">
          <FileDown className="w-3 h-3" /> IFC
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onClick={download} data-testid="ifc-source-download-btn">
          <FileDown className="w-3.5 h-3.5 mr-2" /> Download original ({src.filename})
        </DropdownMenuItem>
        {node.can_edit !== false && (
          <DropdownMenuItem onClick={onReimport} data-testid="ifc-reimport-btn">
            <RefreshCw className="w-3.5 h-3.5 mr-2" /> Upload a newer version…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
