import { api } from "@/lib/apiClient";

export const BRAND = "HealthcareCanvas_P&W_HIS";

const slug = (s) => (s || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

// e.g. HealthcareCanvas_P&W_HIS_Dirty-Utility_network_2026-06-12.png
export const brandedName = (subject, kind, ext) =>
  [BRAND, slug(subject), kind && slug(kind), today()].filter(Boolean).join("_") + `.${ext}`;

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Fetch an export through the API (no new tab, no app URL shown) and save it under the server's branded name.
export async function downloadExport(path, { method = "get", body, fallbackName } = {}) {
  const r = method === "post"
    ? await api.post(path, body, { responseType: "blob" })
    : await api.get(path, { responseType: "blob" });
  const cd = r.headers?.["content-disposition"] || "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  saveBlob(r.data, m ? decodeURIComponent(m[1]) : fallbackName);
}
