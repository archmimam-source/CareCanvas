"""Generic IFC → room extractor.

Reads every IfcSpace in an IFC file, aligns each space to its own
rectangle (min-area box of the footprint), and collects the fittings
inside it as on-plan footprints in room-local metres (x from the west
face, y from the north face). Fittings are matched to the component
library by Revit family code or keywords; anything unmatched becomes a
labelled `generic_ifc` box at its true size.
"""
from __future__ import annotations
import math, re
from typing import Any, Dict, List, Optional

import numpy as np
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as elutil

GENERIC_KEY = "generic_ifc"

_SKIP_CLASSES = ("IfcSlab", "IfcCovering", "IfcRoof", "IfcBeam", "IfcColumn", "IfcStair",
                 "IfcStairFlight", "IfcRailing", "IfcCurtainWall", "IfcPlate", "IfcMember",
                 "IfcFooting", "IfcPile", "IfcRamp", "IfcRampFlight", "IfcWindow",
                 "IfcFeatureElement", "IfcVirtualElement", "IfcFlowSegment", "IfcFlowFitting")
_STRUCTURAL_WALL = re.compile(r"^(basic|curtain|stacked) wall", re.I)

# Family codes that map to more than one catalogue key → explicit choice.
_CODE_PREF = {"PAN923": "sanitary_ips", "DIS913": "paper_towel", "SPL901": "steel_tray",
              "DIS064": "wipes_dispenser", "CAL920": "call_lamp",
              "SWC901": "door_open_button"}
# Keyword fallback for non-NHS families (first match wins).
_KEYWORDS = [
    ("macerator", ["macerator", "bedpan", "pulp"]),
    ("clinical_wash_basin", ["basin", "sink", "washbasin"]),
    ("soap_dispenser", ["soap"]),
    ("sanitiser_unit", ["sanitiser", "sanitizer"]),
    ("paper_towel", ["towel"]),
    ("ppe_station", ["glove", "apron", "ppe"]),
    ("biohazard_bin", ["sack", "bin", "waste"]),
    ("linen_trolley", ["trolley", "linen", "cart"]),
    ("cabinet_coshh", ["coshh"]),
    ("sloping_storage", ["sloping"]),
    ("prep_counter", ["workbench", "worktop", "counter", "bench"]),
    ("shelf_bracket", ["bracket"]),
    ("shelf_wall", ["shelf"]),
    ("exhaust_vent", ["extract", "grille", "diffuser", "vent"]),
    ("emergency_light", ["emergency light", "emergency luminaire"]),
    ("ceiling_light", ["light", "luminaire", "led panel"]),
    ("presence_sensor", ["pir", "presence"]),
    ("smoke_detector", ["smoke"]),
    ("wifi_ap", ["wireless", "access point"]),
    ("socket_twin", ["twin socket"]),
    ("socket_single", ["socket"]),
]


def _code_map(components: Dict[str, Dict[str, Any]]) -> Dict[str, str]:
    m: Dict[str, str] = {}
    for key, c in components.items():
        for code in {c.get("code") or "", *re.findall(r"\(([^)]+)\)", c.get("name") or "")}:
            code = code.strip().upper()
            if code and code not in m:
                m[code] = key
    m.update({k: v for k, v in _CODE_PREF.items() if v in components})
    return m


def _match(name: str, cls: str, codes: Dict[str, str], components) -> Optional[str]:
    if cls == "IfcDoor" and "entry_door" in components:
        return "entry_door"
    up = (name or "").upper()
    for code in re.findall(r"\b(?:[A-Z]-)?[A-Z]{3}\d{3}\b", up):
        if code in codes:
            return codes[code]
        short = code.split("-")[-1]
        if short in codes:
            return codes[short]
    low = (name or "").lower()
    for key, words in _KEYWORDS:
        if key in components and any(w in low for w in words):
            return key
    return None


def _label(name: str) -> str:
    """'IDP_Furniture_HOL004-SMALL SACK HOLDER:HOL004:2264' → 'Small Sack Holder'."""
    parts = (name or "").split(":")
    base = parts[0]
    if re.search(r"[A-Z]{3}\d{3}-", base):
        base = re.sub(r"^.*?[A-Z]{3}\d{3}-", "", base)
    elif "door" in base.lower() and len(parts) > 1:
        base = parts[1]
    base = re.sub(r"^IDP_[A-Za-z ]+_", "", base).replace("_", " ").strip()
    upper = sum(ch.isupper() for ch in base) > sum(ch.islower() for ch in base)
    return (base.title() if upper else base)[:60] or "IFC element"


def _family(name: str) -> str:
    parts = (name or "").split(":")
    return ":".join(parts[:2]) if len(parts) > 2 else (name or "")


def _hull(pts: np.ndarray) -> np.ndarray:
    pts = np.unique(np.round(pts, 4), axis=0)
    if len(pts) < 3:
        return pts
    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]
    def half(seq):
        h = []
        for p in seq:
            while len(h) >= 2 and np.cross(h[-1] - h[-2], p - h[-2]) <= 0:
                h.pop()
            h.append(p)
        return h
    lower, upper = half(pts), half(pts[::-1])
    return np.array(lower[:-1] + upper[:-1])


def _min_area_angle(xy: np.ndarray) -> float:
    h = _hull(xy)
    best, best_a = None, 0.0
    for i in range(len(h)):
        e = h[(i + 1) % len(h)] - h[i]
        a = math.atan2(e[1], e[0]) % (math.pi / 2)
        r = _rot(h, -a)
        area = np.ptp(r[:, 0]) * np.ptp(r[:, 1])
        if best is None or area < best - 1e-9:
            best, best_a = area, a
    return best_a


def _rot(xy: np.ndarray, a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return xy @ np.array([[c, s], [-s, c]])


def _verts(settings, el) -> Optional[np.ndarray]:
    try:
        sh = ifcopenshell.geom.create_shape(settings, el)
        v = np.array(sh.geometry.verts).reshape(-1, 3)
        return v if len(v) else None
    except Exception:
        return None


def _storey_and_building(sp):
    storey = building = None
    cur = sp
    for _ in range(6):
        cur = elutil.get_aggregate(cur) or elutil.get_container(cur)
        if cur is None:
            break
        if cur.is_a("IfcBuildingStorey") and storey is None:
            storey = cur
        if cur.is_a("IfcBuilding"):
            building = cur
            break
    return storey, building


def parse_ifc_rooms(path: str, components: Dict[str, Dict[str, Any]],
                    overrides: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    f = ifcopenshell.open(path)
    st = ifcopenshell.geom.settings()
    st.set("use-world-coords", True)
    codes = _code_map(components)

    elements = []
    for el in f.by_type("IfcElement"):
        if any(el.is_a(c) for c in _SKIP_CLASSES):
            continue
        if el.is_a("IfcWall") and _STRUCTURAL_WALL.match(el.Name or ""):
            continue
        parent = elutil.get_aggregate(el)
        if parent is not None and parent.is_a("IfcElement"):
            continue
        v = None
        if el.is_a("IfcDoor"):
            for rel in getattr(el, "FillsVoids", None) or []:
                v = _verts(st, rel.RelatingOpeningElement)
        v = v if v is not None else _verts(st, el)
        if v is None:
            continue
        elements.append((el, v))
    ceilings = [v for c in f.by_type("IfcCovering")
                if (c.PredefinedType == "CEILING" or "ceiling" in (c.Name or "").lower())
                for v in [_verts(st, c)] if v is not None]

    spaces = []
    for sp in f.by_type("IfcSpace"):
        sv = _verts(st, sp)
        if sv is None:
            continue
        ang = _min_area_angle(sv[:, :2])
        r = _rot(sv[:, :2], -ang)
        x0, x1 = r[:, 0].min(), r[:, 0].max()
        y0, y1 = r[:, 1].min(), r[:, 1].max()
        z0, z1 = sv[:, 2].min(), sv[:, 2].max()
        W, D, H = x1 - x0, y1 - y0, z1 - z0
        if W < 0.5 or D < 0.5:
            continue
        scx, scy = sv[:, 0].mean(), sv[:, 1].mean()
        for cv in ceilings:
            if cv[:, 0].min() <= scx <= cv[:, 0].max() and cv[:, 1].min() <= scy <= cv[:, 1].max():
                cz = cv[:, 2].min() - z0
                if 1.8 < cz < H:
                    H = cz
        items, generic = [], 0
        for el, v in elements:
            er = _rot(v[:, :2], -ang)
            ex0, ex1 = er[:, 0].min() - x0, er[:, 0].max() - x0
            ey0, ey1 = y1 - er[:, 1].max(), y1 - er[:, 1].min()
            ez0, ez1 = v[:, 2].min() - z0, v[:, 2].max() - z0
            cx, cy = (ex0 + ex1) / 2, (ey0 + ey1) / 2
            is_door = el.is_a("IfcDoor")
            m = 0.35 if is_door else 0.05
            if not (-m <= cx <= W + m and -m <= cy <= D + m):
                continue
            if is_door and not (cx < 0.3 or cx > W - 0.3 or cy < 0.3 or cy > D - 0.3):
                continue
            if ez1 < -0.2 or ez0 > H + 0.6:
                continue
            if max(ex1 - ex0, ey1 - ey0, ez1 - ez0) < 0.03:
                continue
            items.append(_to_item(el, ex0, ex1, ey0, ey1, ez0, ez1, W, D, H, codes, components, overrides or {}))
            generic += items[-1]["component_key"] == GENERIC_KEY
        name = " · ".join(x for x in [sp.Name, sp.LongName] if x) or "Space"
        storey, building = _storey_and_building(sp)
        spaces.append({
            "storey": (storey.Name if storey else None) or "Level",
            "storey_elevation": getattr(storey, "Elevation", None) if storey else None,
            "building": (building.Name if building else None) or None,
            "guid": sp.GlobalId, "name": name,
            "width": round(W, 3), "depth": round(D, 3), "ceiling_h": round(H, 3),
            "rotation_deg": round(math.degrees(ang), 2),
            "poly_world": [[round(float(c[0]), 3), round(float(c[1]), 3)] for c in
                           _rot(np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), ang)],
            "z0": round(float(z0), 3),
            "items": items, "items_count": len(items),
            "matched_count": len(items) - generic, "generic_count": generic,
        })
    doors = []
    for el, v in elements:
        if el.is_a("IfcDoor"):
            doors.append({"bbox": [round(float(v[:, 0].min()), 3), round(float(v[:, 1].min()), 3),
                                   round(float(v[:, 0].max()), 3), round(float(v[:, 1].max()), 3)],
                          "z0": round(float(v[:, 2].min()), 3), "guid": el.GlobalId})
    proj = (f.by_type("IfcProject") or [None])[0]
    app = (f.by_type("IfcApplication") or [None])[0]
    return {
        "schema": f.schema, "project": getattr(proj, "Name", None),
        "authoring_tool": getattr(app, "ApplicationFullName", None),
        "spaces": sorted(spaces, key=lambda s: s["name"]), "doors": doors,
    }


def _to_item(el, x0, x1, y0, y1, z0, z1, W, D, H, codes, components, overrides) -> Dict[str, Any]:
    x0, x1 = max(0.0, x0), min(W, x1)
    y0, y1 = max(0.0, y0), min(D, y1)
    w, d = max(0.05, x1 - x0), max(0.05, y1 - y0)
    x, y = min(x0, W - w), min(y0, D - d)
    is_door = el.is_a("IfcDoor")
    if is_door:
        # Draw doors as a thin leaf on the wall they sit in.
        dists = {"W": x, "E": W - (x + w), "N": y, "S": D - (y + d)}
        wall = min(dists, key=dists.get)
        if wall in ("W", "E"):
            w = 0.1; x = 0.0 if wall == "W" else W - 0.1
        else:
            d = 0.1; y = 0.0 if wall == "N" else D - 0.1
    z0 = max(0.0, z0)
    h = max(0.03, z1 - z0)
    if z0 >= H - 0.6 and z1 >= H - 0.05:
        mount = "ceiling"
    elif z0 > 0.25 and not is_door:
        mount = "wall"
    else:
        mount = "floor"
    dists = {"N": y, "S": D - (y + d), "W": x, "E": W - (x + w)}
    wall = min(dists, key=dists.get)
    rot = {"N": 0, "S": 180, "W": 270, "E": 90}[wall] if (mount != "ceiling" and dists[wall] < 0.6) else 0
    cy = y + d / 2
    zone = "dirty" if cy < D * 0.42 else ("transition" if cy < D * 0.64 else "clean")
    name = el.Name or el.is_a()
    key = overrides.get(_family(name)) or _match(name, el.is_a(), codes, components) or GENERIC_KEY
    return {
        "component_key": key,
        "x": round(x, 3), "y": round(y, 3), "w": round(w, 3), "d": round(d, 3),
        "rotation": rot, "zone": zone, "mount_type": mount,
        "elevation_m": round(z0, 3), "height_m": round(min(h, 2.1) if is_door else h, 3),
        "revit_family": _family(name), "label": _label(name), "ifc_guid": el.GlobalId,
        "ifc_class": el.is_a(),
    }
