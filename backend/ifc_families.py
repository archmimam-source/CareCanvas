"""IFC family / Revit interop utilities.

Two-way IFC bridge (Path B in the roadmap):
  · Ingest .ifc files uploaded by architects (each file = one Revit family
    exported via File → Export → IFC, OR a full room export).
  · Auto-classify each incoming IFC element against our component library so
    the Palette can offer real Revit families instead of generic geometry.
  · Emit .ifc from our scene so a Revit user can File → Link IFC to see the
    room layout with correct dimensions and positions.

Fidelity note: Revit families lose their IfcType identity through IFC unless
we also ship a companion family-lookup Revit add-in — this is the trade-off
we accepted with Path B.
"""
from __future__ import annotations
import os, math, hashlib, re
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as elutil

from object_storage import FAMILIES_DIR  # noqa: E402


# ---------- Component-key classifier ---------------------------------------
# Maps regex substrings + IFC entity types to a component_key from our seed
# library.  Ordered — first match wins.  Confidence is a float 0..1 based on
# how many signals matched (name + ifc_type + predefined_type).

_CLASSIFIER: List[Tuple[str, Dict[str, Any]]] = [
    ("macerator",         {"kinds": {"macerator"},                    "ifc": {"IfcElectricAppliance", "IfcFlowTerminal", "IfcMedicalDevice"}, "keywords": ["macerator", "bedpan washer", "pulp"]}),
    ("bedpan_washer",     {"kinds": {"macerator"},                    "ifc": {"IfcElectricAppliance"}, "keywords": ["bedpan"]}),
    ("clinical_wash_basin", {"kinds": {"basin"},                      "ifc": {"IfcSanitaryTerminal"},  "keywords": ["basin", "sink", "washbasin", "hand wash", "hb"]}),
    ("biohazard_bin",     {"kinds": {"bin"},                          "ifc": {"IfcWasteTerminal", "IfcFurniture"}, "keywords": ["waste", "bin", "sharp", "clinical waste", "yellow"]}),
    ("soap_dispenser",    {"kinds": {"dispenser"},                    "ifc": {"IfcSanitaryTerminal", "IfcElectricAppliance"}, "keywords": ["soap"]}),
    ("sanitiser_dispenser", {"kinds": {"dispenser"},                  "ifc": {"IfcSanitaryTerminal", "IfcElectricAppliance"}, "keywords": ["sanitiser", "sanitizer", "gel", "alcohol"]}),
    ("ppe_station",       {"kinds": {"ppe"},                          "ifc": {"IfcFurniture"}, "keywords": ["ppe", "apron", "glove", "protective"]}),
    ("cabinet_tall",      {"kinds": {"cabinet_tall", "cabinet"},      "ifc": {"IfcFurniture"}, "keywords": ["tall cabinet", "storage cabinet", "coshh", "chemical"]}),
    ("cabinet_wall",      {"kinds": {"cabinet"},                      "ifc": {"IfcFurniture"}, "keywords": ["wall cabinet", "upper cabinet"]}),
    ("cabinet_base",      {"kinds": {"cabinet"},                      "ifc": {"IfcFurniture"}, "keywords": ["base cabinet", "under counter", "under-counter"]}),
    ("prep_counter",      {"kinds": {"counter", "worktop"},           "ifc": {"IfcFurniture"}, "keywords": ["worktop", "counter", "bench"]}),
    ("commode_store",     {"kinds": {"cabinet", "trolley"},           "ifc": {"IfcFurniture"}, "keywords": ["commode"]}),
    ("linen_trolley",     {"kinds": {"trolley"},                      "ifc": {"IfcFurniture"}, "keywords": ["linen", "trolley", "cart"]}),
    ("entry_door",        {"kinds": {"door"},                         "ifc": {"IfcDoor"},      "keywords": ["door", "entrance"]}),
    ("extract_vent",      {"kinds": {"vent"},                         "ifc": {"IfcAirTerminal"}, "keywords": ["vent", "extract", "grille", "diffuser"]}),
    ("led_light",         {"kinds": {"light"},                        "ifc": {"IfcLightFixture"}, "keywords": ["light", "luminaire", "led"]}),
    ("socket_wall",       {"kinds": {"socket"},                       "ifc": {"IfcOutlet", "IfcElectricAppliance"}, "keywords": ["socket", "outlet", "power"]}),
]

def classify_element(name: str, ifc_type: str, predefined_type: str = "") -> Tuple[Optional[str], float, Dict[str, Any]]:
    """Return (best_component_key, confidence, debug).  None if no match."""
    n = (name or "").lower()
    p = (predefined_type or "").lower()
    best_key: Optional[str] = None
    best_score = 0.0
    best_debug = {"name": name, "ifc_type": ifc_type, "predefined_type": predefined_type}
    for key, rule in _CLASSIFIER:
        score = 0.0
        if any(kw in n or kw in p for kw in rule["keywords"]):
            score += 0.6
        if ifc_type in rule["ifc"]:
            score += 0.4
        if score > best_score:
            best_score, best_key = score, key
    # Fallback by IFC type only when no keyword matches
    if best_score == 0.0:
        for key, rule in _CLASSIFIER:
            if ifc_type in rule["ifc"]:
                return key, 0.35, {**best_debug, "reason": "ifc_type_fallback"}
    return best_key, best_score, best_debug


# ---------- IFC upload ingest ----------------------------------------------
def ingest_ifc(path: str) -> Dict[str, Any]:
    """Parse an .ifc file and return a family record (or a list of them when
    the file contains more than one product).

    Returns:
      {
        "elements": [{
           "guid", "name", "ifc_type", "predefined_type",
           "dimensions": {w,d,h in metres},
           "component_key_suggested", "confidence",
           "properties": { pset name → { key: value } },
        }, ...],
        "schema": "IFC4",
        "total_elements": int,
      }
    """
    ifc = ifcopenshell.open(path)
    schema = ifc.schema
    # Products = things you can place in a scene (walls, doors, furniture, …)
    products = ifc.by_type("IfcProduct")
    # We only care about physically-instanceable elements — skip spaces / axes
    filtered: List[Any] = [
        p for p in products
        if not p.is_a("IfcSpace") and not p.is_a("IfcGrid")
        and not p.is_a("IfcAnnotation") and not p.is_a("IfcOpeningElement")
    ]

    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)

    out: List[Dict[str, Any]] = []
    for p in filtered:
        name = p.Name or p.is_a()
        ifc_type = p.is_a()
        predef = getattr(p, "PredefinedType", None) or ""

        # Bounding box from geometry
        w = d = h = None
        try:
            shape = ifcopenshell.geom.create_shape(settings, p)
            verts = shape.geometry.verts  # flat [x,y,z, x,y,z, …]
            xs = verts[0::3]; ys = verts[1::3]; zs = verts[2::3]
            if xs:
                w = round(max(xs) - min(xs), 3)
                d = round(max(ys) - min(ys), 3)
                h = round(max(zs) - min(zs), 3)
        except Exception:
            pass

        psets = elutil.get_psets(p) or {}
        key, conf, dbg = classify_element(name, ifc_type, predef)
        out.append({
            "guid": p.GlobalId,
            "name": name,
            "ifc_type": ifc_type,
            "predefined_type": predef,
            "dimensions": {"w": w, "d": d, "h": h},
            "component_key_suggested": key,
            "confidence": round(conf, 2),
            "properties": psets,
            "classifier_debug": dbg,
        })
    return {"elements": out, "schema": schema, "total_elements": len(out)}


def extract_meshes(path: str, max_elements: int = 50) -> List[Dict[str, Any]]:
    """Return simplified mesh JSON per product for browser 3D preview:
       [{ guid, name, vertices:[x,y,z…], faces:[i,j,k…], transform:[4×4] }]
    """
    ifc = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    out = []
    for p in ifc.by_type("IfcProduct")[:max_elements]:
        if p.is_a("IfcSpace") or p.is_a("IfcGrid") or p.is_a("IfcAnnotation"):
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, p)
        except Exception:
            continue
        verts = list(shape.geometry.verts)
        faces = list(shape.geometry.faces)
        if not verts or not faces: continue
        out.append({
            "guid": p.GlobalId,
            "name": p.Name or p.is_a(),
            "ifc_type": p.is_a(),
            "vertices": verts,
            "faces": faces,
        })
    return out


# ---------- IFC emit (export our scene → .ifc) -----------------------------
def _mkguid() -> str:
    return ifcopenshell.guid.new()

def export_scene_to_ifc(scene: Dict[str, Any], components_by_key: Dict[str, Dict[str, Any]],
                        family_map: Optional[Dict[str, str]] = None,
                        project_name: str = "HealthcareCanvas_P&W_HIS Room Export",
                        brand: str = "HealthcareCanvas_P&W_HIS") -> bytes:
    """Emit an IFC4 file describing the scene: one IfcBuildingStorey with an
    IfcSpace for the room, plus one IfcFurniture (or best-fit IFC entity)
    per item using its footprint as an extruded box.
    """
    ifc = ifcopenshell.file(schema="IFC4")
    owner = None  # simple write; ifcopenshell will infer defaults

    # Project + context skeleton
    project = ifc.create_entity("IfcProject", GlobalId=_mkguid(), Name=project_name)
    unit_len = ifc.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    unit_ang = ifc.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN")
    unit_ass = ifc.create_entity("IfcUnitAssignment", Units=[unit_len, unit_ang])
    project.UnitsInContext = unit_ass

    origin = ifc.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    axis   = ifc.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    refdir = ifc.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
    placement3d = ifc.create_entity("IfcAxis2Placement3D", Location=origin, Axis=axis, RefDirection=refdir)
    ctx = ifc.create_entity(
        "IfcGeometricRepresentationContext", ContextType="Model",
        CoordinateSpaceDimension=3, Precision=1e-5,
        WorldCoordinateSystem=placement3d)
    project.RepresentationContexts = [ctx]

    def local_placement(x, y, z, parent=None):
        pt = ifc.create_entity("IfcCartesianPoint", Coordinates=(float(x), float(y), float(z)))
        ax = ifc.create_entity("IfcAxis2Placement3D", Location=pt)
        return ifc.create_entity("IfcLocalPlacement", RelativePlacement=ax, PlacementRelTo=parent)

    site_placement = local_placement(0, 0, 0)
    site = ifc.create_entity("IfcSite", GlobalId=_mkguid(), Name="Site",
                              ObjectPlacement=site_placement, CompositionType="ELEMENT")
    building = ifc.create_entity("IfcBuilding", GlobalId=_mkguid(), Name="Building",
                                  ObjectPlacement=local_placement(0, 0, 0, site_placement),
                                  CompositionType="ELEMENT")
    storey_placement = local_placement(0, 0, 0, building.ObjectPlacement)
    storey = ifc.create_entity("IfcBuildingStorey", GlobalId=_mkguid(), Name="Ground floor",
                                ObjectPlacement=storey_placement, Elevation=0.0,
                                CompositionType="ELEMENT")

    # Aggregation relationships
    ifc.create_entity("IfcRelAggregates", GlobalId=_mkguid(), Name="Project→Site",
                      RelatingObject=project, RelatedObjects=[site])
    ifc.create_entity("IfcRelAggregates", GlobalId=_mkguid(), Name="Site→Building",
                      RelatingObject=site, RelatedObjects=[building])
    ifc.create_entity("IfcRelAggregates", GlobalId=_mkguid(), Name="Building→Storey",
                      RelatingObject=building, RelatedObjects=[storey])

    # Room as IfcSpace
    W = float(scene.get("width", 3.0)); D = float(scene.get("depth", 2.5))
    H = float(scene.get("ceiling_h", 2.7))
    space_placement = local_placement(0, 0, 0, storey_placement)
    room = ifc.create_entity("IfcSpace", GlobalId=_mkguid(), Name=scene.get("name", "Room"),
                              ObjectPlacement=space_placement, CompositionType="ELEMENT",
                              PredefinedType="INTERNAL")
    ifc.create_entity("IfcRelAggregates", GlobalId=_mkguid(), Name="Storey→Room",
                      RelatingObject=storey, RelatedObjects=[room])

    products: List[Any] = []
    IFC_KIND_MAP = {
        "macerator":     ("IfcElectricAppliance", "USERDEFINED"),
        "basin":         ("IfcSanitaryTerminal",  "WASHHANDBASIN"),
        "bin":           ("IfcWasteTerminal",     "WASTEDISPOSALUNIT"),
        "dispenser":     ("IfcSanitaryTerminal",  "NOTDEFINED"),
        "ppe":           ("IfcFurniture",         "NOTDEFINED"),
        "cabinet":       ("IfcFurniture",         "NOTDEFINED"),
        "cabinet_tall":  ("IfcFurniture",         "NOTDEFINED"),
        "trolley":       ("IfcFurniture",         "NOTDEFINED"),
        "commode_store": ("IfcFurniture",         "NOTDEFINED"),
        "door":          ("IfcDoor",              "DOOR"),
        "vent":          ("IfcAirTerminal",       "DIFFUSER"),
        "light":         ("IfcLightFixture",      "NOTDEFINED"),
        "socket":        ("IfcOutlet",            "USERDEFINED"),
        "counter":       ("IfcFurniture",         "NOTDEFINED"),
        "worktop":       ("IfcFurniture",         "NOTDEFINED"),
        "prep_counter":  ("IfcFurniture",         "NOTDEFINED"),
    }
    for it in scene.get("items", []) or []:
        comp = components_by_key.get(it.get("component_key")) or {}
        kind = comp.get("kind") or it.get("kind") or "cabinet"
        ifc_klass, ifc_predef = IFC_KIND_MAP.get(kind, ("IfcFurniture", "NOTDEFINED"))
        cx = float(it["x"]) + float(it["w"]) / 2.0
        cy = float(it["y"]) + float(it["d"]) / 2.0
        elev = float(it.get("elevation_m") or 0.0)
        h_m = float(it.get("height_m") or comp.get("footprint", {}).get("h") or 0.9)
        placement = local_placement(cx, cy, elev, space_placement)
        # Extruded box geometry
        rect_pts = [(-it["w"]/2, -it["d"]/2), ( it["w"]/2, -it["d"]/2),
                    ( it["w"]/2,  it["d"]/2), (-it["w"]/2,  it["d"]/2), (-it["w"]/2, -it["d"]/2)]
        ifc_pts = [ifc.create_entity("IfcCartesianPoint", Coordinates=(float(x), float(y))) for x, y in rect_pts]
        polyline = ifc.create_entity("IfcPolyline", Points=ifc_pts)
        profile = ifc.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA",
                                    OuterCurve=polyline)
        solid_axis = ifc.create_entity("IfcAxis2Placement3D",
            Location=ifc.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)))
        solid = ifc.create_entity("IfcExtrudedAreaSolid",
            SweptArea=profile, Position=solid_axis,
            ExtrudedDirection=ifc.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
            Depth=float(h_m))
        rep = ifc.create_entity("IfcShapeRepresentation",
            ContextOfItems=ctx, RepresentationIdentifier="Body",
            RepresentationType="SweptSolid", Items=[solid])
        product_shape = ifc.create_entity("IfcProductDefinitionShape", Representations=[rep])

        name = comp.get("display_name") or it.get("component_key") or ifc_klass
        # PredefinedType is only allowed on some entities; wrap in try/except
        try:
            e = ifc.create_entity(ifc_klass, GlobalId=_mkguid(), Name=name,
                                   ObjectPlacement=placement, Representation=product_shape,
                                   PredefinedType=ifc_predef)
        except Exception:
            e = ifc.create_entity(ifc_klass, GlobalId=_mkguid(), Name=name,
                                   ObjectPlacement=placement, Representation=product_shape)
        # Custom property set with our component_key so re-import can rebind
        try:
            pset = ifc.create_entity("IfcPropertySet", GlobalId=_mkguid(), Name="HIS_Component",
                HasProperties=[
                    ifc.create_entity("IfcPropertySingleValue", Name="component_key",
                        NominalValue=ifc.create_entity("IfcText", it.get("component_key") or "")),
                    ifc.create_entity("IfcPropertySingleValue", Name="rotation",
                        NominalValue=ifc.create_entity("IfcReal", float(it.get("rotation") or 0))),
                    ifc.create_entity("IfcPropertySingleValue", Name="zone",
                        NominalValue=ifc.create_entity("IfcText", it.get("zone") or "")),
                    ifc.create_entity("IfcPropertySingleValue", Name="mount_type",
                        NominalValue=ifc.create_entity("IfcText", it.get("mount_type") or "floor")),
                ])
            ifc.create_entity("IfcRelDefinesByProperties", GlobalId=_mkguid(),
                RelatedObjects=[e], RelatingPropertyDefinition=pset)
        except Exception:
            pass
        products.append(e)

    if products:
        ifc.create_entity("IfcRelContainedInSpatialStructure", GlobalId=_mkguid(),
                          Name="Items in room", RelatingStructure=room,
                          RelatedElements=products)

    # Serialise to bytes — branded STEP header, no server paths or tool names.
    fn = ifc.header.file_name
    fn.name = f"{project_name}.ifc"
    fn.author = (brand,)
    fn.organization = (brand,)
    fn.preprocessor_version = brand
    fn.originating_system = brand
    fn.authorization = brand
    tmp = FAMILIES_DIR / f".export_{_mkguid()[:8]}.ifc"
    ifc.write(str(tmp))
    data = tmp.read_bytes()
    tmp.unlink(missing_ok=True)
    return data


def import_ifc_to_items(path: str, components_by_key: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Parse an IFC (usually a whole room export), map IfcProducts back to
    our component_key + footprint. If the file was originally created by
    export_scene_to_ifc it carries a HIS_Component Pset — we rebind exactly.
    """
    ifc = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)

    items: List[Dict[str, Any]] = []
    W = D = H = None
    for space in ifc.by_type("IfcSpace"):
        try:
            shape = ifcopenshell.geom.create_shape(settings, space)
            v = shape.geometry.verts
            W = max(v[0::3]) - min(v[0::3])
            D = max(v[1::3]) - min(v[1::3])
            H = max(v[2::3]) - min(v[2::3])
        except Exception: pass

    for p in ifc.by_type("IfcProduct"):
        if p.is_a("IfcSpace") or p.is_a("IfcGrid") or p.is_a("IfcAnnotation"):
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, p)
        except Exception: continue
        v = shape.geometry.verts
        if not v: continue
        xs = v[0::3]; ys = v[1::3]; zs = v[2::3]
        w = round(max(xs) - min(xs), 3)
        d = round(max(ys) - min(ys), 3)
        h = round(max(zs) - min(zs), 3)
        cx = (min(xs) + max(xs)) / 2.0
        cy = (min(ys) + max(ys)) / 2.0
        elev = round(min(zs), 3)

        # Try to recover HIS_Component pset (round-trip fast path)
        component_key = None
        rotation = 0.0; zone = ""; mount = "floor"
        psets = elutil.get_psets(p) or {}
        his = psets.get("HIS_Component") or {}
        if his.get("component_key"):
            component_key = his["component_key"]
            rotation = float(his.get("rotation") or 0)
            zone = his.get("zone") or ""
            mount = his.get("mount_type") or "floor"
        else:
            key, conf, _ = classify_element(p.Name or "", p.is_a(),
                                            getattr(p, "PredefinedType", None) or "")
            component_key = key
        if not component_key: continue
        items.append({
            "component_key": component_key,
            "x": round(cx - w / 2, 3), "y": round(cy - d / 2, 3),
            "w": w, "d": d, "h": h,
            "rotation": rotation,
            "zone": zone, "mount_type": mount,
            "elevation_m": elev, "height_m": h,
        })
    return {"items": items, "width": W, "depth": D, "ceiling_h": H, "count": len(items)}


def save_upload(raw_bytes: bytes, original_name: str) -> Dict[str, Any]:
    """Persist an uploaded IFC file and return { path, sha256, size }."""
    h = hashlib.sha256(raw_bytes).hexdigest()[:16]
    safe = re.sub(r"[^A-Za-z0-9_.\\-]", "_", original_name)[-80:]
    fname = f"{h}_{safe}"
    fpath = FAMILIES_DIR / fname
    from object_storage import put_upload as _put_upload  # noqa
    _put_upload(fpath, raw_bytes, "application/octet-stream")
    return {"path": str(fpath), "sha256": h, "size": len(raw_bytes), "filename": fname}
