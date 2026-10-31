"""Spatial analysis for HealthcareCanvas — room and floor scale.

Adapted from the Perkins&Will James Paget Department Toolkit (v176):
  * VGA space syntax: visibility graph over an occupancy grid →
    connectivity, visual integration [HH] (Dk/RA, depthmapX convention),
    visual step depth from an origin, plus the door isovist.
  * Travel paths: A* on the grid with a clearance-preference cost
    (cells tighter than the flow's comfortable width cost more) and a
    line-of-sight smoothing pass; five flow types with walking speeds.
  * Adjacency score 0–100 with Excellent / Good / Fair / Poor bands.
  * Network graph: physical "touch" edges, rule edges, and flow edges.
Coordinates are room-local metres (x from west wall, y from north wall).
"""
from __future__ import annotations
import heapq, math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

FLOW_TYPES = [
    {"id": "patient",   "label": "Inpatient / Bed traffic", "speed": 1.0, "clear": 1.2, "color": "#C0504D"},
    {"id": "visitor",   "label": "Outpatient / Visitor",    "speed": 1.2, "clear": 0.9, "color": "#005EB8"},
    {"id": "staff",     "label": "Staff",                   "speed": 1.4, "clear": 0.6, "color": "#2E9E46"},
    {"id": "emergency", "label": "Emergency",               "speed": 1.2, "clear": 1.2, "color": "#D97706"},
    {"id": "escort",    "label": "Staff escorted",          "speed": 1.0, "clear": 1.0, "color": "#7C3AED"},
]
FLOW = {f["id"]: f for f in FLOW_TYPES}
LIFT = {"speed": 1.6, "wait": 30, "door": 8}
EYE_H = 1.5          # items taller than this block sightlines
BODY_R = 0.2         # cells closer than this to an obstacle are not walkable

# Role groups used by built-in room tasks (component_key → role).
ROLE = {
    "macerator": "SOURCE", "bedpan_washer": "SOURCE", "slop_hopper": "SOURCE", "sluice": "SOURCE",
    "clinical_wash_basin": "HYG_BASIN", "paper_towel": "HYG_TOWEL", "alcohol_gel": "HYG_GEL",
    "sanitiser_unit": "HYG_GEL", "ppe_station": "PPE", "glove_dispenser": "PPE", "apron_dispenser": "PPE",
    "biohazard_bin": "RCP_PAPER", "waste_bin": "RCP_PAPER", "linen_trolley": "RCP_LINEN", "linen_bag": "RCP_LINEN",
    "prep_counter": "DRY_WORK", "worktop": "DRY_WORK", "entry_door": "DOOR", "staff_door": "DOOR",
    "exhaust_vent": "EXTRACT",
}

# Built-in tasks for a dirty utility. `soiled` paths must not cross the clean zone.
ROOM_TASKS = [
    {"id": "ppe_on",    "label": "Don PPE on entry",               "from": "DOOR",      "to": "PPE",       "flow": "staff", "soiled": False},
    {"id": "dispose",   "label": "Carry soiled item to disposal",  "from": "DOOR",      "to": "SOURCE",    "flow": "staff", "soiled": True},
    {"id": "hygiene",   "label": "Hand hygiene after disposal",    "from": "SOURCE",    "to": "HYG_BASIN", "flow": "staff", "soiled": True},
    {"id": "linen",     "label": "Bag soiled linen",               "from": "DOOR",      "to": "RCP_LINEN", "flow": "staff", "soiled": True},
    {"id": "waste",     "label": "Dispose of towels / PPE",        "from": "HYG_BASIN", "to": "RCP_PAPER", "flow": "staff", "soiled": False},
    {"id": "exit",      "label": "Exit clean",                     "from": "HYG_BASIN", "to": "DOOR",      "flow": "staff", "soiled": False},
    {"id": "escort",    "label": "Escorted specimen drop to bench","from": "DOOR",      "to": "DRY_WORK",  "flow": "escort", "soiled": False},
]


def band(score: Optional[float]):
    if score is None:
        return "n/a"
    return "Excellent" if score >= 80 else "Good" if score >= 60 else "Fair" if score >= 40 else "Poor"


def floor_score(length_m: Optional[float], floors_apart: int = 0) -> Optional[int]:
    """Reference department-scale score (same floor vs via lifts)."""
    if length_m is None:
        return None
    if floors_apart == 0:
        return round(max(50, 100 - length_m / 5))
    return round(max(0, 45 - 5 * (max(1, floors_apart) - 1) - length_m / 10))


def room_score(length, straight, min_clear, need_clear, crosses_clean):
    """Room-scale score: short, direct, comfortable, and hygienic paths win."""
    detour = length / max(straight, 0.05)
    s = 100 - 10 * max(0.0, length - 2.0) - 50 * max(0.0, detour - 1.15)
    if min_clear < need_clear / 2:
        s -= 15
    if crosses_clean:
        s -= 20
    return round(max(0, min(100, s)))


# ───────────────────────── grid ─────────────────────────
class Grid:
    def __init__(self, W, D, res):
        self.W, self.D, self.res = W, D, res
        self.nx, self.ny = max(2, int(math.ceil(W / res))), max(2, int(math.ceil(D / res)))
        self.move = np.ones((self.ny, self.nx), bool)
        self.sight = np.ones((self.ny, self.nx), bool)

    def cell(self, x, y):
        return (min(self.nx - 1, max(0, int(x / self.res))), min(self.ny - 1, max(0, int(y / self.res))))

    def centre(self, c):
        return ((c[0] + 0.5) * self.res, (c[1] + 0.5) * self.res)

    def block_rect(self, x, y, w, d, layer):
        i0, j0 = int(max(0, x) / self.res), int(max(0, y) / self.res)
        i1, j1 = int(math.ceil(min(self.W, x + w) / self.res)), int(math.ceil(min(self.D, y + d) / self.res))
        layer[j0:j1, i0:i1] = False

    def clearance(self):
        """Distance (m) from each cell to the nearest blocked cell or wall (two-pass chamfer)."""
        INF = 1e9
        d = np.where(self.move, INF, 0.0)
        d[0, :] = np.minimum(d[0, :], 0.5); d[-1, :] = np.minimum(d[-1, :], 0.5)
        d[:, 0] = np.minimum(d[:, 0], 0.5); d[:, -1] = np.minimum(d[:, -1], 0.5)
        ny, nx = d.shape
        s2 = math.sqrt(2)
        for j in range(ny):
            for i in range(nx):
                v = d[j, i]
                if i > 0: v = min(v, d[j, i - 1] + 1)
                if j > 0:
                    v = min(v, d[j - 1, i] + 1)
                    if i > 0: v = min(v, d[j - 1, i - 1] + s2)
                    if i < nx - 1: v = min(v, d[j - 1, i + 1] + s2)
                d[j, i] = v
        for j in range(ny - 1, -1, -1):
            for i in range(nx - 1, -1, -1):
                v = d[j, i]
                if i < nx - 1: v = min(v, d[j, i + 1] + 1)
                if j < ny - 1:
                    v = min(v, d[j + 1, i] + 1)
                    if i < nx - 1: v = min(v, d[j + 1, i + 1] + s2)
                    if i > 0: v = min(v, d[j + 1, i - 1] + s2)
                d[j, i] = v
        return d * self.res


def room_grid(scene, res=None) -> Tuple[Grid, List[dict]]:
    W, D = float(scene.get("width") or 3.6), float(scene.get("depth") or 2.5)
    res = res or max(0.08, round(math.sqrt(W * D / 1100), 3))
    g = Grid(W, D, res)
    floor_items = []
    for it in scene.get("items", []):
        if it.get("mount_type") == "ceiling" or it.get("component_key") in ("entry_door", "staff_door"):
            continue
        top = float(it.get("elevation_m") or 0) + float(it.get("height_m") or 0.9)
        if it.get("mount_type") == "floor" or float(it.get("elevation_m") or 0) < 0.3:
            g.block_rect(it["x"], it["y"], it["w"], it["d"], g.move)
            floor_items.append(it)
            if top >= EYE_H:
                g.block_rect(it["x"], it["y"], it["w"], it["d"], g.sight)
    for p in scene.get("partitions", []) or []:
        x1, y1, x2, y2 = (float(p.get(k, 0)) for k in ("x1", "y1", "x2", "y2"))
        t = float(p.get("thickness") or 0.1)
        x, y = min(x1, x2) - t / 2, min(y1, y2) - t / 2
        g.block_rect(x, y, abs(x2 - x1) + t, abs(y2 - y1) + t, g.move)
        g.block_rect(x, y, abs(x2 - x1) + t, abs(y2 - y1) + t, g.sight)
    return g, floor_items


# ───────────────────────── VGA ─────────────────────────
def _visible_from(g: Grid, src, targets_xy, K):
    sx, sy = src
    t = np.linspace(0.0, 1.0, K)[None, :]
    px = sx + (targets_xy[:, 0:1] - sx) * t
    py = sy + (targets_xy[:, 1:2] - sy) * t
    ii = np.clip((px / g.res).astype(int), 0, g.nx - 1)
    jj = np.clip((py / g.res).astype(int), 0, g.ny - 1)
    return g.sight[jj, ii].all(axis=1)


def vga(g: Grid, origin_xy=None, max_sources=600):
    walk = g.move & g.sight
    cells = np.argwhere(walk)                      # (j, i)
    n = len(cells)
    if n < 4:
        return None
    xy = np.stack([(cells[:, 1] + 0.5) * g.res, (cells[:, 0] + 0.5) * g.res], axis=1)
    K = int(max(g.nx, g.ny) * 2.2) + 2
    exact = n <= max_sources
    rng = np.random.default_rng(12345)
    sources = np.arange(n) if exact else rng.choice(n, max_sources, replace=False)
    vis = np.zeros((n, n), bool) if n <= 2500 else None
    conn = np.zeros(n)
    if vis is not None:
        for v in range(n):
            vis[v] = _visible_from(g, xy[v], xy, K)
        vis |= vis.T
        np.fill_diagonal(vis, False)
        conn = vis.sum(axis=1).astype(float)
    # All-pairs visual step depth by repeated boolean expansion (BLAS matmul).
    depth_all = None
    if vis is not None:
        A = vis.astype(np.float32)
        depth_all = np.full((n, n), -1, np.int16)
        np.fill_diagonal(depth_all, 0)
        reach = np.eye(n, dtype=bool)
        frontier = np.eye(n, dtype=np.float32)
        d = 0
        while frontier.any() and d < 60:
            d += 1
            nxt = (frontier @ A) > 0
            nxt &= ~reach
            depth_all[nxt] = d
            reach |= nxt
            frontier = nxt.astype(np.float32)

    def bfs(s):
        return depth_all[s].astype(int)

    integ = np.full(n, np.nan)
    if depth_all is not None:
        k = n
        dep = depth_all.astype(float)
        dep[dep <= 0] = np.nan
        MD = np.nanmean(dep, axis=1)
        for v in range(n):
            if not np.isfinite(MD[v]) or k < 4:
                continue
            RA = 2 * (MD[v] - 1) / (k - 2)
            Dk = 2 * (k * (math.log2((k + 2) / 3) - 1) + 1) / ((k - 1) * (k - 2))
            integ[v] = Dk / RA if RA > 1e-9 else np.nan
        finite = integ[np.isfinite(integ)]
        integ[np.isnan(integ) & (conn >= n - 1)] = finite.max() if len(finite) else 1.0
        exact = True
    adj = depth_all

    step = np.full(n, np.nan)
    iso_share = None
    if origin_xy is not None and adj is not None:
        oc = g.cell(*origin_xy)
        d2 = (cells[:, 1] - oc[0]) ** 2 + (cells[:, 0] - oc[1]) ** 2
        o = int(np.argmin(d2))
        dep = bfs(o).astype(float); dep[dep < 0] = np.nan
        step = dep
        iso_share = float((dep == 1).sum() + 1) / n

    def to_grid(vals):
        out = np.full((g.ny, g.nx), np.nan)
        out[cells[:, 0], cells[:, 1]] = vals
        return [[None if not np.isfinite(v) else round(float(v), 3) for v in row] for row in out]

    return {"connectivity": to_grid(conn), "integration": to_grid(integ), "step_depth": to_grid(step),
            "exact": bool(exact), "cells": int(n), "door_isovist_share": iso_share,
            "_visible_from_origin": (step <= 1) if origin_xy is not None and adj is not None else None,
            "_cells": cells}


# ───────────────────────── routing ─────────────────────────
def _cost_field(g: Grid, clear_m, need):
    h = max(need / 2, 0.3)
    mult = np.where(clear_m >= h, 1.0, 1.0 + 5.0 * (h - clear_m) / h)
    blocked = (~g.move) | (clear_m < BODY_R)
    return mult, blocked


def astar(g: Grid, mult, blocked, a, b):
    if blocked[a[1], a[0]] or blocked[b[1], b[0]]:
        return None
    nx, ny = g.nx, g.ny
    dist = {a: 0.0}; prev = {}
    pq = [(0.0, a)]
    steps = [(1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)]
    while pq:
        _, u = heapq.heappop(pq)
        if u == b:
            break
        du = dist[u]
        for dx, dy, c in steps:
            v = (u[0] + dx, u[1] + dy)
            if not (0 <= v[0] < nx and 0 <= v[1] < ny) or blocked[v[1], v[0]]:
                continue
            if dx and dy and (blocked[u[1], v[0]] or blocked[v[1], u[0]]):
                continue
            nd = du + c * mult[v[1], v[0]]
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = u
                heapq.heappush(pq, (nd + math.hypot(b[0] - v[0], b[1] - v[1]), v))
    if b not in dist:
        return None
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    return path[::-1]


def _los(g, blocked, mult, p, q):
    n = int(max(abs(q[0] - p[0]), abs(q[1] - p[1])) * 3) + 1
    lim = max(mult[p[1], p[0]], mult[q[1], q[0]]) * 1.05 + 1e-6
    for k in range(n + 1):
        x = p[0] + (q[0] - p[0]) * k / n; y = p[1] + (q[1] - p[1]) * k / n
        for cx, cy in ((math.floor(x), math.floor(y)), (math.ceil(x), math.ceil(y))):
            cx = min(g.nx - 1, max(0, cx)); cy = min(g.ny - 1, max(0, cy))
            if blocked[cy, cx] or mult[cy, cx] > lim:
                return False
    return True


def smooth(g, blocked, mult, path):
    if len(path) < 3:
        return path[:]
    out, i = [path[0]], 0
    while i < len(path) - 1:
        j = i + 1
        while j + 1 < len(path) and _los(g, blocked, mult, path[i], path[j + 1]):
            j += 1
        out.append(path[j]); i = j
    return out


def _nearest_free(blocked, c, max_r=12):
    if not blocked[c[1], c[0]]:
        return c
    ny, nx = blocked.shape
    for r in range(1, max_r):
        best = None
        for dx in range(-r, r + 1):
            for dy in (-r, r) if abs(dx) != r else range(-r, r + 1):
                v = (c[0] + dx, c[1] + dy)
                if 0 <= v[0] < nx and 0 <= v[1] < ny and not blocked[v[1], v[0]]:
                    dd = dx * dx + dy * dy
                    if best is None or dd < best[0]:
                        best = (dd, v)
        if best:
            return best[1]
    return None


def access_point(it, W, D, stand=0.35):
    """Point where a person stands to use an item: in front of its room-facing side."""
    x, y, w, d = it["x"], it["y"], it["w"], it["d"]
    cx, cy = x + w / 2, y + d / 2
    rot = int(it.get("rotation") or 0) % 360
    if it.get("component_key") in ("entry_door", "staff_door"):
        if x < 0.2: return (stand, cy)
        if x + w > W - 0.2: return (W - stand, cy)
        if y < 0.2: return (cx, stand)
        return (cx, D - stand)
    return {0: (cx, y + d + stand), 180: (cx, y - stand), 90: (x - stand, cy), 270: (x + w + stand, cy)}.get(rot, (cx, y + d + stand))


def route(g, clear_m, a_xy, b_xy, flow_id, clean_rect=None, soiled=False):
    f = FLOW.get(flow_id, FLOW["staff"])
    mult, blocked = _cost_field(g, clear_m, f["clear"])
    a = _nearest_free(blocked, g.cell(*a_xy)); b = _nearest_free(blocked, g.cell(*b_xy))
    if a is None or b is None:
        return None
    p = astar(g, mult, blocked, a, b)
    if p is None:
        return None
    raw = p
    p = smooth(g, blocked, mult, p)
    pts = [g.centre(c) for c in p]
    length = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    straight = math.dist(g.centre(a), g.centre(b))
    min_clear = float(min(clear_m[c[1], c[0]] for c in raw))
    crosses = False
    if soiled and clean_rect:
        cx, cy, cw, cd = clean_rect
        crosses = any(cx + 0.15 < x < cx + cw - 0.15 and cy + 0.15 < y < cy + cd - 0.15 for x, y in (g.centre(c) for c in raw))
    score = room_score(length, straight, min_clear, f["clear"], crosses)
    return {"path": [[round(x, 3), round(y, 3)] for x, y in pts], "length_m": round(length, 2),
            "straight_m": round(straight, 2), "detour": round(length / max(straight, 0.05), 2),
            "seconds": round(length / f["speed"], 1), "min_clearance_m": round(min_clear, 2),
            "crosses_clean": crosses, "score": score, "band": band(score), "flow": flow_id}


# ───────────────────────── room analysis ─────────────────────────
def _gap(a, b):
    dx = max(0.0, max(a["x"], b["x"]) - min(a["x"] + a["w"], b["x"] + b["w"]))
    dy = max(0.0, max(a["y"], b["y"]) - min(a["y"] + a["d"], b["y"] + b["d"]))
    return math.hypot(dx, dy)


def analyse_room(scene, relations, labels):
    W, D = float(scene.get("width") or 3.6), float(scene.get("depth") or 2.5)
    g, _ = room_grid(scene)
    clear_m = g.clearance()
    items = [it for it in scene.get("items", []) if it.get("mount_type") != "ceiling"]
    by_role: Dict[str, List[dict]] = {}
    for it in items:
        r = ROLE.get(it["component_key"])
        if r: by_role.setdefault(r, []).append(it)
    door = (by_role.get("DOOR") or [None])[0]
    origin = access_point(door, W, D) if door else None
    v = vga(g, origin)
    zones = scene.get("zones") or {}
    cz = zones.get("clean")
    clean_rect = (cz["x"], cz["y"], cz["w"], cz["d"]) if cz else None

    tasks = []
    for t in ROOM_TASKS:
        A = by_role.get(t["from"]) or []; B = by_role.get(t["to"]) or []
        if not A or not B:
            tasks.append({**t, "status": "missing", "missing": t["from"] if not A else t["to"]}); continue
        best = None
        for a in A:
            for b in B:
                r = route(g, clear_m, access_point(a, W, D), access_point(b, W, D), t["flow"], clean_rect, t["soiled"])
                if r and (best is None or r["length_m"] < best["length_m"]):
                    best = {**r, "from_id": a["id"], "to_id": b["id"]}
        tasks.append({**t, **(best or {"status": "blocked"}), "status": "ok" if best else "blocked"})

    visible_from_door = []
    if v and v.get("_visible_from_origin") is not None:
        vis_cells = {(int(c[1]), int(c[0])) for c, ok in zip(v["_cells"], v["_visible_from_origin"]) if ok}
        for it in items:
            if it["component_key"] in ("entry_door", "staff_door"):
                continue
            i0, j0 = g.cell(it["x"] - g.res, it["y"] - g.res)
            i1, j1 = g.cell(it["x"] + it["w"] + g.res, it["y"] + it["d"] + g.res)
            if any((i, j) in vis_cells for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)):
                visible_from_door.append(it["id"])

    nodes = [{"id": it["id"], "key": it["component_key"], "label": labels(it), "role": ROLE.get(it["component_key"]),
              "x": round(it["x"] + it["w"] / 2, 3), "y": round(it["y"] + it["d"] / 2, 3),
              "zone": it.get("zone"), "mount": it.get("mount_type")} for it in items]
    edges = []
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            gp = _gap(a, b)
            if gp <= 0.05:
                edges.append({"a": a["id"], "b": b["id"], "kind": "touch", "gap_m": round(gp, 3)})
    for rel in relations:
        roles = rel.get("roles") or []
        thr = rel.get("threshold_mm")
        if len(roles) != 2 or not isinstance(thr, (int, float)) or rel.get("kind") not in ("near", "touching", "far", "near-centre"):
            continue
        for a in by_role.get(roles[0], []):
            for b in by_role.get(roles[1], []):
                if a["id"] == b["id"]:
                    continue
                dmm = math.dist((a["x"] + a["w"] / 2, a["y"] + a["d"] / 2), (b["x"] + b["w"] / 2, b["y"] + b["d"] / 2)) * 1000
                ok = dmm >= thr if rel["kind"] == "far" else dmm <= thr
                edges.append({"a": a["id"], "b": b["id"], "kind": "rule", "rule_id": rel["id"], "relation": rel["kind"],
                              "threshold_mm": thr, "distance_mm": round(dmm), "status": "pass" if ok else "fail",
                              "tier": rel.get("tier"), "note": rel.get("note")})
    for t in tasks:
        if t.get("status") == "ok":
            edges.append({"a": t["from_id"], "b": t["to_id"], "kind": "flow", "task": t["id"], "flow": t["flow"],
                          "length_m": t["length_m"], "seconds": t["seconds"], "band": t["band"]})
    deg: Dict[str, int] = {}
    for e in edges:
        deg[e["a"]] = deg.get(e["a"], 0) + 1; deg[e["b"]] = deg.get(e["b"], 0) + 1
    for n in nodes:
        n["degree"] = deg.get(n["id"], 0)

    scored = [t["score"] for t in tasks if t.get("status") == "ok"]
    fails = [e for e in edges if e["kind"] == "rule" and e["status"] == "fail"]
    out_v = {k: v[k] for k in ("connectivity", "integration", "step_depth", "exact", "cells", "door_isovist_share")} if v else None
    return {
        "grid": {"res": g.res, "nx": g.nx, "ny": g.ny, "width": W, "depth": D,
                 "walkable": [[bool(x) for x in row] for row in (g.move & (clear_m >= BODY_R))]},
        "vga": out_v, "origin": origin, "visible_from_door": visible_from_door,
        "tasks": tasks, "flow_types": FLOW_TYPES,
        "network": {"nodes": nodes, "edges": edges},
        "summary": {"task_score": round(sum(scored) / len(scored)) if scored else None,
                    "task_band": band(sum(scored) / len(scored)) if scored else "n/a",
                    "rule_edges": sum(e["kind"] == "rule" for e in edges), "rule_fails": len(fails),
                    "door_isovist_share": out_v and out_v.get("door_isovist_share"),
                    "soiled_visible_from_door": [n["id"] for n in nodes if n["role"] == "SOURCE" and n["id"] in visible_from_door]},
    }


def custom_route(scene, a_xy, b_xy, flow_id):
    g, _ = room_grid(scene)
    return route(g, g.clearance(), a_xy, b_xy, flow_id)


# ───────────────────────── floor analysis ─────────────────────────
def _poly_bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _pip(p, poly):
    c = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i - 1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1] + 1e-12) + a[0]:
            c = not c
    return c


def floor_model(rooms: List[dict], doors: List[dict], res=None):
    """rooms: [{id, name, poly:[[x,y]..] world metres}]; doors: [{bbox:[x0,y0,x1,y1]}]."""
    allp = [p for r in rooms for p in r["poly"]]
    x0, y0, x1, y1 = _poly_bbox(allp)
    x0 -= 1; y0 -= 1; x1 += 1; y1 += 1
    area = (x1 - x0) * (y1 - y0)
    res = res or max(0.4, round(math.sqrt(area / 2500), 2))
    g = Grid(x1 - x0, y1 - y0, res)
    label = np.full((g.ny, g.nx), -1, int)
    jj, ii = np.mgrid[0:g.ny, 0:g.nx]
    px = x0 + (ii + 0.5) * res; py = y1 - (jj + 0.5) * res    # y flipped: north at top
    for k, r in enumerate(rooms):
        poly = r["poly"]
        bx0, by0, bx1, by1 = _poly_bbox(poly)
        m = (px >= bx0) & (px <= bx1) & (py >= by0) & (py <= by1)
        for j, i in zip(*np.nonzero(m)):
            if _pip((px[j, i], py[j, i]), poly):
                label[j, i] = k
    walk = label >= 0
    # walls between different rooms: a cell is a wall if a 4-neighbour belongs to another room
    wall = np.zeros_like(walk)
    for dj, di in ((0, 1), (1, 0), (0, -1), (-1, 0)):
        sh = np.full_like(label, -2)
        sj = slice(max(0, dj), g.ny + min(0, dj)); si = slice(max(0, di), g.nx + min(0, di))
        tj = slice(max(0, -dj), g.ny + min(0, -dj)); ti = slice(max(0, -di), g.nx + min(0, -di))
        sh[tj, ti] = label[sj, si]
        wall |= walk & (sh != label) & (sh >= -1)
    walk &= ~wall
    for dr in doors:
        bx0, by0, bx1, by1 = dr["bbox"]
        pad = res * 1.5
        m = (px >= bx0 - pad) & (px <= bx1 + pad) & (py >= by0 - pad) & (py <= by1 + pad) & (label >= 0)
        walk |= m
    g.move = walk.copy(); g.sight = walk.copy()
    return g, label, (x0, y1)


def analyse_floor(rooms, doors, source_id=None, flow_id="staff"):
    g, label, (ox, oy) = floor_model(rooms, doors)
    to_w = lambda c: (ox + (c[0] + 0.5) * g.res, oy - (c[1] + 0.5) * g.res)
    to_c = lambda p: g.cell(p[0] - ox, oy - p[1])
    clear_m = g.clearance()
    centres = []
    for k, r in enumerate(rooms):
        cells = np.argwhere((label == k) & g.move)
        if len(cells) == 0:
            centres.append(None); continue
        mj, mi = cells.mean(axis=0)
        best = cells[np.argmin((cells[:, 0] - mj) ** 2 + (cells[:, 1] - mi) ** 2)]
        centres.append((int(best[1]), int(best[0])))
    # network: rooms touching (share a wall) and connected through a door
    edges = []
    def shift(m, dj, di):
        o = np.zeros_like(m)
        o[max(0, dj):g.ny + min(0, dj), max(0, di):g.nx + min(0, di)] = m[max(0, -dj):g.ny + min(0, -dj), max(0, -di):g.nx + min(0, -di)]
        return o
    for a in range(len(rooms)):
        ma, wa = label == a, (label == a) & g.move
        near_a = np.zeros_like(ma); near_w = np.zeros_like(ma)
        for dj, di in ((0, 1), (1, 0), (0, -1), (-1, 0)):
            near_a |= shift(ma, dj, di); near_w |= shift(wa, dj, di)
        for b in range(a + 1, len(rooms)):
            mb = label == b
            if (near_a & mb).any():
                edges.append({"a": rooms[a]["id"], "b": rooms[b]["id"], "kind": "touch",
                              "door": bool((near_w & mb & g.move).any())})
    v = vga(g, None, max_sources=150) if int(g.move.sum()) <= 1500 else None
    routes = []
    if source_id is not None:
        f = FLOW.get(flow_id, FLOW["staff"])
        mult, blocked = _cost_field(g, clear_m, f["clear"])
        blocked = (~g.move)
        si = next((k for k, r in enumerate(rooms) if r["id"] == source_id), None)
        if si is not None and centres[si] is not None:
            for k, r in enumerate(rooms):
                if k == si or centres[k] is None:
                    continue
                p = astar(g, mult, blocked, centres[si], centres[k])
                if not p:
                    routes.append({"to": r["id"], "status": "unreachable"}); continue
                p = smooth(g, blocked, mult, p)
                pts = [to_w(c) for c in p]
                L = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
                sc = floor_score(L)
                routes.append({"to": r["id"], "status": "ok", "path": [[round(x, 2), round(y, 2)] for x, y in pts],
                               "length_m": round(L, 1), "seconds": round(L / f["speed"]), "score": sc, "band": band(sc)})
    deg: Dict[str, int] = {}
    for e in edges:
        deg[e["a"]] = deg.get(e["a"], 0) + 1; deg[e["b"]] = deg.get(e["b"], 0) + 1
    integ_by_room = {}
    if v:
        integ = np.array([[np.nan if x is None else x for x in row] for row in v["integration"]], float)
        for k, r in enumerate(rooms):
            vals = integ[(label == k) & np.isfinite(integ)]
            integ_by_room[r["id"]] = round(float(vals.mean()), 3) if len(vals) else None
    return {
        "grid": {"res": g.res, "nx": g.nx, "ny": g.ny, "origin": [round(ox, 3), round(oy, 3)]},
        "vga": {k: v[k] for k in ("connectivity", "integration", "exact", "cells")} if v else None,
        "network": {"nodes": [{"id": r["id"], "name": r["name"], "degree": deg.get(r["id"], 0),
                               "integration": integ_by_room.get(r["id"]),
                               "x": round(to_w(centres[k])[0], 2) if centres[k] else None,
                               "y": round(to_w(centres[k])[1], 2) if centres[k] else None}
                              for k, r in enumerate(rooms)], "edges": edges},
        "routes": routes, "flow_types": FLOW_TYPES,
    }
