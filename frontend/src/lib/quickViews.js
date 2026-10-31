// Client-side quick views built from the spatial analysis result.

// How many staff routes pass through each grid cell (null = no traffic).
export function travelHeat(tasks, grid) {
  const { res, nx, ny } = grid;
  const v = Array.from({ length: ny }, () => Array(nx).fill(0));
  tasks.filter((t) => t.status === "ok" && t.path?.length > 1).forEach((t) => {
    const seen = new Set();
    for (let k = 1; k < t.path.length; k++) {
      const [x0, y0] = t.path[k - 1], [x1, y1] = t.path[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (res / 2)));
      for (let s = 0; s <= steps; s++) {
        const x = x0 + (x1 - x0) * s / steps, y = y0 + (y1 - y0) * s / steps;
        const i = Math.floor(x / res), j = Math.floor(y / res);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj, key = jj * nx + ii;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || seen.has(key)) continue;
          seen.add(key); v[jj][ii] += di || dj ? 0.5 : 1;
        }
      }
    }
  });
  return v.map((row) => row.map((c) => (c > 0 ? c : null)));
}

function segX([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [ax + t * (bx - ax), ay + t * (by - ay)] : null;
}

// Points where two different staff routes cross, merged when closer than 0.3 m.
export function flowClashes(tasks) {
  const ok = tasks.filter((t) => t.status === "ok" && t.path?.length > 1);
  const pts = [];
  for (let a = 0; a < ok.length; a++) for (let b = a + 1; b < ok.length; b++) {
    const A = ok[a].path, B = ok[b].path;
    for (let i = 1; i < A.length; i++) for (let j = 1; j < B.length; j++) {
      const p = segX(A[i - 1], A[i], B[j - 1], B[j]);
      if (!p) continue;
      const near = pts.find((q) => Math.hypot(q.x - p[0], q.y - p[1]) < 0.3);
      const pair = `${ok[a].label} × ${ok[b].label}`;
      const soiled = ok[a].crosses_clean || ok[b].crosses_clean;
      if (near) { near.pairs.add(pair); near.soiled ||= soiled; } else pts.push({ x: p[0], y: p[1], pairs: new Set([pair]), soiled });
    }
  }
  return pts.map((p, k) => ({ id: `c${k}`, x: p.x, y: p.y, soiled: p.soiled, pairs: [...p.pairs] }));
}
