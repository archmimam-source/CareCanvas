// Shared helpers for spatial analysis views.
export const BAND_COLOR = { Excellent: "#2E9E46", Good: "#005EB8", Fair: "#B07A00", Poor: "#C0504D", "n/a": "#94A3B8" };
export const ROLE_COLOR = {
  SOURCE: "#C0504D", HYG_BASIN: "#0EA5E9", HYG_TOWEL: "#38BDF8", HYG_GEL: "#22D3EE", PPE: "#8B5CF6",
  RCP_PAPER: "#F59E0B", RCP_LINEN: "#D97706", DRY_WORK: "#10B981", SECURE_STORE: "#059669",
  DOOR: "#1D1D1F", EXTRACT: "#64748B",
};
export const LAYERS = [
  ["integration", "Visual integration", "How central a spot is to everything visible (depthmap HH)"],
  ["connectivity", "Connectivity", "How much of the room each spot can see"],
  ["step_depth", "Steps from door", "Visual turns needed to see a spot from the door"],
];

// depthmapX-style spectral ramp: blue (low) → green → yellow → red (high).
export function ramp(t) {
  const stops = [[0, [43, 84, 200]], [0.33, [46, 158, 170]], [0.55, [120, 190, 70]], [0.75, [245, 200, 50]], [1, [215, 50, 40]]];
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], u = (x - a) / (b - a || 1);
      return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * u)).join(",")})`;
    }
  }
  return "rgb(215,50,40)";
}

export function gridRange(values) {
  let mn = Infinity, mx = -Infinity;
  values.forEach((row) => row.forEach((v) => { if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }));
  return mn === Infinity ? [0, 1] : [mn, mx];
}

export const fmtSecs = (s) => (s == null ? "—" : s < 60 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
