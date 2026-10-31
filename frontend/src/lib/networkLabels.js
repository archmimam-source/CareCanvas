// Greedy label placement: try spots around each bubble, skip spots that hit
// another label or bubble. Labels with no free spot stay hidden (shown on hover).
const CHAR_W = 5.4, LH = 11;
const SPOTS = [
  [0, 1, "middle"], [0, -1, "middle"], [1, 0, "start"], [-1, 0, "end"],
  [0.8, 0.8, "start"], [-0.8, 0.8, "end"], [0.8, -0.8, "start"], [-0.8, -0.8, "end"],
];

export const nodeRadius = (p) => 7 + Math.min(10, p.degree * 0.8);

function box(p, r, [sx, sy, anchor], text) {
  const w = text.length * CHAR_W, gap = 4;
  const dx = sx * (r + gap), dy = sy > 0 ? r + LH : sy < 0 ? -(r + gap) : LH / 3;
  const ax = p.px + dx, ay = p.py + dy;
  const x0 = anchor === "middle" ? ax - w / 2 : anchor === "start" ? ax : ax - w;
  return { dx, dy, anchor, x0, y0: ay - LH + 2, x1: x0 + w, y1: ay + 2 };
}

const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export function placeLabels(P, wanted, W, H, obstacles = []) {
  const circles = P.map((p) => { const r = nodeRadius(p); return { id: p.id, x0: p.px - r, y0: p.py - r, x1: p.px + r, y1: p.py + r }; });
  const placed = [], out = {}, flowSpots = {};
  let hidden = 0;
  // Travel labels first: slide along the curve's normal until they find space.
  obstacles.forEach((f) => {
    const w = f.text.length * 5.6;
    const spot = [0, -12, 12, -24, 24].map((dy) => ({ x: f.mx, y: f.my + dy, x0: f.mx - w / 2, x1: f.mx + w / 2, y0: f.my + dy - 10, y1: f.my + dy + 3 }))
      .find((b) => !placed.some((o) => hit(b, o)) && !circles.some((c) => hit(b, c)));
    if (spot) { placed.push(spot); flowSpots[f.key] = spot; } else hidden += 1;
  });
  [...P].filter((p) => wanted.has(p.id)).sort((a, b) => b.degree - a.degree).forEach((p) => {
    const r = nodeRadius(p);
    const spot = SPOTS.map((s) => box(p, r, s, p.label)).find((b) =>
      b.x0 >= 2 && b.x1 <= W - 2 && b.y0 >= 2 && b.y1 <= H - 2 &&
      !placed.some((o) => hit(b, o)) && !circles.some((c) => c.id !== p.id && hit(b, c)));
    if (spot) { placed.push(spot); out[p.id] = spot; } else hidden += 1;
  });
  return { spots: out, flowSpots, hidden };
}
