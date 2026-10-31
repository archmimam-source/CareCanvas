"""Revit family (.rfa) metadata extractor.

.rfa files are Autodesk's proprietary binary format — no library can read the
geometry without desktop Revit or Autodesk Platform Services. HOWEVER, they
are Compound File Binary Format containers and expose several documented
streams. We read:

  * ``PartAtom`` — UTF-16-BE encoded XML that carries the family category,
    parameter definitions, and per-parameter values (Uniclass, dimensions,
    IFC PreDefined type, description, warranty…). This is the "metadata gold
    mine" our library needs to auto-classify + display properties.
  * ``RevitPreview4.0`` — PNG thumbnail Revit uses in its browser.
  * ``BasicFileInfo`` — text stream containing the Revit product/version.

The 3D geometry of the family is intentionally NOT parsed (impossible without
APS) — we render a bounding box using the dimensions declared in PartAtom.
"""
from __future__ import annotations
import re, xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, Any, Optional, List

import olefile


NS = {"a": "urn:schemas-autodesk-com:partatom",
      "atom": "http://www.w3.org/2005/Atom"}


def _read_partatom(path: str) -> Optional[str]:
    o = olefile.OleFileIO(path)
    try:
        if not o.exists("PartAtom"): return None
        raw = o.openstream("PartAtom").read()
        # PartAtom is UTF-8 XML (the file declares encoding="UTF-8" on line 1).
        try:
            txt = raw.decode("utf-8")
        except UnicodeDecodeError:
            txt = raw.decode("utf-8", errors="ignore")
        # Strip leading garbage before the '<?xml' declaration.
        i = txt.find("<?xml")
        return txt[i:] if i >= 0 else txt
    finally:
        o.close()


def _read_thumbnail(path: str) -> Optional[bytes]:
    o = olefile.OleFileIO(path)
    try:
        if not o.exists("RevitPreview4.0"): return None
        raw = o.openstream("RevitPreview4.0").read()
        # RevitPreview4.0 has a small header then embedded PNG bytes.
        m = re.search(b"\x89PNG\r\n\x1a\n", raw)
        return raw[m.start():] if m else None
    finally:
        o.close()


def _read_basic_info(path: str) -> Dict[str, str]:
    o = olefile.OleFileIO(path)
    try:
        if not o.exists("BasicFileInfo"): return {}
        raw = o.openstream("BasicFileInfo").read()
        # Try both encodings and keep whichever produces valid ASCII.
        candidates = []
        for enc in ("utf-16-le", "utf-16-be", "utf-8"):
            try: candidates.append(raw.decode(enc, errors="ignore"))
            except Exception: pass
        # Prefer the decoding with the most printable characters.
        best = max(candidates, key=lambda s: sum(c.isprintable() for c in s), default="")
        info: Dict[str, str] = {}
        for line in best.splitlines():
            m = re.match(r"\s*([A-Za-z ]+)\s*:\s*(.+)\s*$", line)
            if m: info[m.group(1).strip()] = m.group(2).strip()
        return info
    finally:
        o.close()


_SIZE_RE = re.compile(r"([\d.]+)\s*x\s*([\d.]+)(?:\s*x\s*([\d.]+))?\s*(mm|m)?",
                      re.IGNORECASE)

def _parse_size(size_text: str) -> Dict[str, Optional[float]]:
    """'146 x 8.3 x 44.3 mm' → {w:0.146, d:0.083, h:0.0443}"""
    m = _SIZE_RE.search(size_text or "")
    if not m: return {"w": None, "d": None, "h": None}
    unit = (m.group(4) or "mm").lower()
    scale = 0.001 if unit == "mm" else 1.0
    def _num(x): return None if x is None else round(float(x) * scale, 4)
    return {"w": _num(m.group(1)), "d": _num(m.group(2)), "h": _num(m.group(3))}


def _simplify_name(title: str) -> str:
    """'IDP_Electrical Fixtures_OUT010-TWIN SOCKET OUTLET' → 'Twin Socket Outlet'.
       'IDP_Plumbing Fixtures_PAN923-SANITARY IPS'         → 'Sanitary IPS'.
       'IDP_Specialty Equipment_SCA900-SCALE URINE WEIGHING'
                                                            → 'Scale Urine Weighing'.
    """
    if not title: return ""
    t = title.strip()
    # strip .rfa suffix
    t = re.sub(r"\.rfa$", "", t, flags=re.I)
    # strip common IDP prefix pattern: "IDP_<category>_<CODE>-<NAME>"
    m = re.match(r"^IDP_[^_]+_[A-Z0-9]+-\s*(.+)$", t)
    if m: t = m.group(1)
    else:
        # generic: drop leading prefix up to last dash
        t = re.sub(r"^.*[-_]\s*", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return " ".join(w.capitalize() for w in t.split(" "))


# ----- classification against the seed component library ------------------
# Keeps the same shape as ifc_families.classify_element so the frontend can
# consume both sources interchangeably.
_RFA_RULES: List[Dict[str, Any]] = [
    {"key": "outlet_isolator",     "match": ["isolator"]},
    {"key": "connection_box_32a",  "match": ["connection box", "connection unit"]},
    {"key": "data_double",         "match": ["twin data", "double data", "data/voice", "double socket data"]},
    {"key": "data_single",         "match": ["data outlet", "single data", "socket outlet data", "data socket", "rj45", "ethernet", "data"]},
    {"key": "socket_twin",         "match": ["twin socket", "twin sock", "double socket", "twin outlet", "twin 13a"]},
    {"key": "socket_single",       "match": ["single socket", "sgl socket", "sgl swi", "sgl switched", "single 13a", "single switched"]},
    {"key": "cold_water_outlet",   "match": ["cold water"]},
    {"key": "tundish_drain",       "match": ["tundish"]},
    {"key": "sanitary_ips",        "match": ["sanitary ips", "ips panel", "ips"]},
    {"key": "urine_scale",         "match": ["urine", "urine scale", "urine weighing"]},
    {"key": "clinical_wash_basin", "match": ["wash basin", "wash-hand", "hand wash", "clinical basin", "wash hand basin", "basin assembly"]},
    {"key": "macerator",           "match": ["macerator", "bedpan"]},
    {"key": "biohazard_bin",       "match": ["waste bin", "sharps", "clinical waste", "biohazard", "sack holder", "small sack"]},
    {"key": "soap_dispenser",      "match": ["soap"]},
    {"key": "sanitiser_unit",      "match": ["sanitiser", "sanitizer", "alcohol", "gel"]},
    {"key": "paper_towel_dispenser","match": ["paper towel", "hand towel", "towel dispenser"]},
    {"key": "wipes_dispenser",     "match": ["wipes", "wipe dispenser", "clinical wipes"]},
    {"key": "shelf_bracket",       "match": ["bracket shelving", "shelf bracket", "shelving bracket", "wall shelving"]},
    {"key": "sloping_storage",     "match": ["sloping", "sloping top", "modular storage sloping", "modular storage"]},
    {"key": "steel_tray",          "match": ["splash panel", "sit-on splash", "sit on splash", "backsplash"]},
    {"key": "prep_counter",        "match": ["worktop", "workbench", "heavy duty workbench", "counter", "bench", "stainless worktop"]},
    {"key": "ppe_station",         "match": ["ppe", "apron", "glove"]},
    {"key": "cabinet_coshh",       "match": ["tall cabinet", "coshh", "coshh cabinet"]},
    {"key": "cabinet_wall",        "match": ["wall cabinet", "upper cabinet"]},
    {"key": "cabinet_base",        "match": ["base cabinet", "under counter"]},
    {"key": "commode_store",       "match": ["commode"]},
    {"key": "linen_trolley",       "match": ["linen", "trolley"]},
    {"key": "exhaust_vent",        "match": ["vent", "grille", "diffuser", "extract air"]},
    {"key": "pressure_stabiliser", "match": ["pressure stabiliser", "fire rated pressure", "aps902"]},
    {"key": "led_light",           "match": ["light", "luminaire"]},
    {"key": "entry_door",          "match": ["entry door", "entrance door", "door leaf", "sliding door"]},
    {"key": "door_open_button",    "match": ["touchless button", "assisted door", "door button", "push button", "door open", "swc901"]},
    {"key": "nurse_call_lamp",     "match": ["nurse call", "call lamp", "sounder", "call point"]},
    # Generic fall-throughs (must be last)
    {"key": "socket_single",       "match": ["socket", "outlet"]},
]

def _classify(simple_name: str, category: str, ifc_predef: str) -> Dict[str, Any]:
    name_lc = f"{simple_name} {category}".lower()
    # Use word-boundary matching so 'bin' doesn't match 'plumbing'.
    for rule in _RFA_RULES:
        for kw in rule["match"]:
            if re.search(r"\b" + re.escape(kw) + r"\b", name_lc):
                return {"component_key": rule["key"], "confidence": 0.9, "reason": f"keyword:{kw}"}
    # fall-through: IFC predefined type as weak signal
    fallback = {
        "POWEROUTLET":       "socket_twin",
        "WASHHANDBASIN":     "clinical_wash_basin",
        "WASTEDISPOSALUNIT": "biohazard_bin",
        "AIRTERMINAL":       "exhaust_vent",
        "LIGHTFIXTURE":      "led_light",
        "DOOR":              "entry_door",
    }
    if ifc_predef and ifc_predef.upper() in fallback:
        return {"component_key": fallback[ifc_predef.upper()], "confidence": 0.55,
                "reason": f"ifc_predef:{ifc_predef}"}
    return {"component_key": None, "confidence": 0.0, "reason": "no_match"}


def _extract_atom_param(root: ET.Element, name: str) -> Optional[str]:
    """Find a leaf tag with local-name == name (or attribute matching), and
    return its text.  PartAtom parameters are addressed either by tag name
    (custom parameters like ``Standard``, ``Size``) or by ``<A:group>`` context.
    """
    # Search direct
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag == name and (el.text or "").strip():
            return el.text.strip()
    return None


def parse_rfa(path: str) -> Dict[str, Any]:
    """Return a normalised metadata payload for an .rfa file."""
    xml_txt = _read_partatom(path) or ""
    thumb = _read_thumbnail(path)
    basic = _read_basic_info(path)

    # Best-effort parse — Autodesk XML is not always well-formed with our
    # cleanup, so we fall back to regex if lxml/ET raises.
    def find_text(pattern: str) -> Optional[str]:
        m = re.search(pattern, xml_txt, re.IGNORECASE | re.DOTALL)
        return m.group(1).strip() if m else None

    title       = find_text(r"<title>([^<]+)</title>")               or ""
    category    = find_text(r"<category>\s*<term>([^<]+)</term>")    or ""
    ifc_predef  = find_text(r"Type_IFC_Predefined_Type[^>]*>([^<]+)")\
               or find_text(r"<Type_IFC_Predefined_Type[^>]*>([^<]+)") or ""
    size_txt    = find_text(r"<Size[^>]*>([^<]+)</Size>")             or ""
    standard    = find_text(r"<Standard[^>]*>([^<]+)</Standard>")     or ""
    desc_short  = find_text(r"<Uniclass2015Description[^>]*>([^<]+)")\
               or find_text(r"<Description[^>]*>([^<]+)")             or ""
    uniclass_pr = find_text(r"<Uniclass2015_Pr[^>]*>([^<]+)")         or ""
    uniclass_ver= find_text(r"<Uniclass2015Version[^>]*>([^<]+)")     or ""
    uniclass_ref= find_text(r"<Uniclass2015Reference[^>]*>([^<]+)")   or ""
    manufacturer= find_text(r"<Manufacturer[^>]*>([^<]+)")            or ""
    warranty_unit  = find_text(r"<WarrantyDurationUnit[^>]*>([^<]+)") or ""
    replacement_cost = find_text(r"<ReplacementCost[^>]*>([^<]+)")    or ""

    simple = _simplify_name(title)
    dims = _parse_size(size_txt)
    cls  = _classify(simple, category, ifc_predef)

    return {
        "kind": "rfa",
        "family_title_full": title,
        "family_name": simple,
        "category": category,
        "description": desc_short,
        "size_text": size_txt,
        "dimensions": dims,          # {w, d, h}  (metres, may be None)
        "ifc_predefined_type": ifc_predef,
        "standard": standard,
        "uniclass": {
            "code":     uniclass_pr,
            "version":  uniclass_ver,
            "reference": uniclass_ref,
        },
        "manufacturer": manufacturer,
        "warranty_duration_unit": warranty_unit,
        "replacement_cost": replacement_cost,
        "revit_product":         basic.get("Revit Build") or basic.get("Format"),
        "component_key_suggested": cls["component_key"],
        "confidence":             cls["confidence"],
        "classifier_debug":       {"reason": cls["reason"]},
        "thumbnail_bytes":        thumb,   # bytes | None (caller persists)
    }
