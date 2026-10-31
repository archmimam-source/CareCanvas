"""
Iteration 17 — IFC bidirectional interop for Revit (Path B).

Covers:
- POST /api/families/upload  (multipart .ifc, 400 for non-IFC/empty)
- Response shape: id, filename, sha256, size, path, schema, total_elements,
  elements[] each with guid,name,ifc_type,predefined_type,dimensions,
  component_key_suggested, confidence, properties, classifier_debug
- Classifier accuracy for basin/door/vent/macerator/waste_bin/linen_trolley
- GET /api/families  (sorted uploaded_at desc)
- GET /api/families/{id}, /mesh, PATCH (confidence->1.0), DELETE
- GET /api/rooms/{id}/export.ifc  (ISO-10303-21;, FILE_SCHEMA(('IFC4')),
  IfcProduct count == len(scene.items))
- POST /api/rooms/{id}/import.ifc  round-trip item count + component_keys
- Regression: iteration 16 sign/verify still works
"""
from pathlib import Path
import os, io, uuid, time, tempfile, re
import pytest, requests
import ifcopenshell

def _load_env():
    try:
        with open(str(Path(__file__).resolve().parents[2] / "frontend" / ".env")) as f:
            for ln in f:
                if ln.startswith("REACT_APP_BACKEND_URL"):
                    return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        return ""

BASE = (os.environ.get("REACT_APP_BACKEND_URL") or _load_env()).rstrip("/")
API = f"{BASE}/api"


# ------------------------ fixtures ------------------------
@pytest.fixture(scope="module")
def sess():
    s = requests.Session()
    gid = f"iter17_{uuid.uuid4().hex[:10]}"
    r = s.post(f"{API}/auth/guest", json={"guest_id": gid})
    assert r.status_code == 200, r.text
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


@pytest.fixture(scope="module")
def room_id(sess):
    r = sess.get(f"{API}/hierarchy"); assert r.status_code == 200
    util = next(n for n in r.json() if n.get("type") == "utility")
    return util["id"]


# ------------------------ IFC synthesis helpers ------------------------
def _mk_ifc_header(ifc):
    """ifcopenshell 0.8.5 usually writes a valid header on .write, but the
    minimal in-memory file may lack SPFF header lines when write_to_string is
    used. write() to a real file always emits ISO-10303-21;"""
    return ifc


def _extruded_box(ifc, ctx, w=0.6, d=0.5, h=0.9):
    pts_2d = [(-w/2, -d/2), ( w/2, -d/2), ( w/2,  d/2),
              (-w/2,  d/2), (-w/2, -d/2)]
    pts = [ifc.create_entity("IfcCartesianPoint", Coordinates=(float(x), float(y))) for x, y in pts_2d]
    poly = ifc.create_entity("IfcPolyline", Points=pts)
    prof = ifc.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=poly)
    ax = ifc.create_entity("IfcAxis2Placement3D",
        Location=ifc.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)))
    solid = ifc.create_entity("IfcExtrudedAreaSolid",
        SweptArea=prof, Position=ax,
        ExtrudedDirection=ifc.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=float(h))
    rep = ifc.create_entity("IfcShapeRepresentation",
        ContextOfItems=ctx, RepresentationIdentifier="Body",
        RepresentationType="SweptSolid", Items=[solid])
    return ifc.create_entity("IfcProductDefinitionShape", Representations=[rep])


def _placement(ifc, parent=None):
    p = ifc.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    ax = ifc.create_entity("IfcAxis2Placement3D", Location=p)
    return ifc.create_entity("IfcLocalPlacement", RelativePlacement=ax, PlacementRelTo=parent)


def make_ifc_with(entities):
    """entities = list of dicts {klass, name, predef?}"""
    ifc = ifcopenshell.file(schema="IFC4")
    project = ifc.create_entity("IfcProject", GlobalId=ifcopenshell.guid.new(), Name="Test")
    unit_len = ifc.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    unit_ang = ifc.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN")
    project.UnitsInContext = ifc.create_entity("IfcUnitAssignment", Units=[unit_len, unit_ang])
    origin = ifc.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    axis = ifc.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    refdir = ifc.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
    plc3d = ifc.create_entity("IfcAxis2Placement3D", Location=origin, Axis=axis, RefDirection=refdir)
    ctx = ifc.create_entity("IfcGeometricRepresentationContext",
        ContextType="Model", CoordinateSpaceDimension=3, Precision=1e-5, WorldCoordinateSystem=plc3d)
    project.RepresentationContexts = [ctx]
    for e in entities:
        klass = e["klass"]
        kwargs = dict(GlobalId=ifcopenshell.guid.new(), Name=e["name"],
                      ObjectPlacement=_placement(ifc), Representation=_extruded_box(ifc, ctx))
        if e.get("predef"):
            try:
                ifc.create_entity(klass, PredefinedType=e["predef"], **kwargs)
                continue
            except Exception:
                pass
        ifc.create_entity(klass, **kwargs)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".ifc")
    tmp.close()
    ifc.write(tmp.name)
    with open(tmp.name, "rb") as f:
        data = f.read()
    os.unlink(tmp.name)
    return data


# ------------------------ Upload validation ------------------------
class TestUploadValidation:
    def test_non_ifc_rejected(self, sess):
        files = {"file": ("bad.txt", b"hello world", "text/plain")}
        r = sess.post(f"{API}/families/upload", files=files)
        assert r.status_code == 400

    def test_empty_rejected(self, sess):
        files = {"file": ("empty.ifc", b"", "application/octet-stream")}
        r = sess.post(f"{API}/families/upload", files=files)
        assert r.status_code == 400


# ------------------------ Upload + shape ------------------------
@pytest.fixture(scope="module")
def uploaded_family(sess):
    data = make_ifc_with([
        {"klass": "IfcSanitaryTerminal", "name": "Clinical Wash-Hand Basin", "predef": "WASHHANDBASIN"},
    ])
    files = {"file": ("basin.ifc", data, "application/octet-stream")}
    r = sess.post(f"{API}/families/upload", files=files)
    assert r.status_code == 200, r.text
    j = r.json()
    return j


class TestUploadResponse:
    def test_top_level_fields(self, uploaded_family):
        for k in ["id", "filename", "sha256", "size", "path", "schema",
                  "total_elements", "elements", "uploaded_by", "uploaded_at"]:
            assert k in uploaded_family, f"missing {k}"
        assert uploaded_family["schema"] == "IFC4"
        assert uploaded_family["total_elements"] >= 1
        assert isinstance(uploaded_family["elements"], list)

    def test_element_fields(self, uploaded_family):
        e = uploaded_family["elements"][0]
        for k in ["guid", "name", "ifc_type", "predefined_type", "dimensions",
                  "component_key_suggested", "confidence", "properties",
                  "classifier_debug"]:
            assert k in e, f"element missing {k}"
        for d in ("w", "d", "h"):
            assert d in e["dimensions"]
        assert 0.0 <= e["confidence"] <= 1.0
        assert isinstance(e["properties"], dict)


# ------------------------ Classifier accuracy ------------------------
class TestClassifier:
    CASES = [
        ({"klass": "IfcSanitaryTerminal", "name": "Clinical Wash-Hand Basin", "predef": "WASHHANDBASIN"},
         "clinical_wash_basin", 0.9),
        ({"klass": "IfcDoor", "name": "entrance door", "predef": "DOOR"},
         "entry_door", 0.9),
        ({"klass": "IfcAirTerminal", "name": "Extract Grille", "predef": "DIFFUSER"},
         "extract_vent", 0.9),
        ({"klass": "IfcElectricAppliance", "name": "Macerator Unit"},
         "macerator", 0.9),
        ({"klass": "IfcWasteTerminal", "name": "Clinical Waste Bin", "predef": "WASTEDISPOSALUNIT"},
         "biohazard_bin", 0.9),
        ({"klass": "IfcFurniture", "name": "Linen Trolley"},
         "linen_trolley", 0.9),
    ]

    @pytest.mark.parametrize("spec,expected_key,min_conf", CASES)
    def test_classification(self, sess, spec, expected_key, min_conf):
        data = make_ifc_with([spec])
        files = {"file": (f"{expected_key}.ifc", data, "application/octet-stream")}
        r = sess.post(f"{API}/families/upload", files=files)
        assert r.status_code == 200, r.text
        j = r.json()
        el = j["elements"][0]
        assert el["component_key_suggested"] == expected_key, (
            f"expected {expected_key}, got {el['component_key_suggested']} "
            f"(name={spec['name']}, ifc={spec['klass']}, debug={el.get('classifier_debug')})"
        )
        assert el["confidence"] >= min_conf, (
            f"confidence too low: {el['confidence']} for {expected_key}"
        )
        # cleanup
        sess.delete(f"{API}/families/{j['id']}")


# ------------------------ List / Get / Mesh / Patch / Delete ------------------------
class TestListAndCrud:
    def test_list_sorted_desc(self, sess):
        # upload two more with a small delay so uploaded_at differ
        d1 = make_ifc_with([{"klass": "IfcDoor", "name": "Door A", "predef": "DOOR"}])
        r1 = sess.post(f"{API}/families/upload", files={"file": ("a.ifc", d1)})
        assert r1.status_code == 200
        time.sleep(1.1)
        d2 = make_ifc_with([{"klass": "IfcDoor", "name": "Door B", "predef": "DOOR"}])
        r2 = sess.post(f"{API}/families/upload", files={"file": ("b.ifc", d2)})
        assert r2.status_code == 200

        r = sess.get(f"{API}/families"); assert r.status_code == 200
        docs = r.json()
        assert isinstance(docs, list) and len(docs) >= 2
        # sorted desc by uploaded_at (ISO strings sort lexically desc)
        times = [d["uploaded_at"] for d in docs]
        assert times == sorted(times, reverse=True), f"not sorted desc: {times[:5]}"

        # cleanup
        sess.delete(f"{API}/families/{r1.json()['id']}")
        sess.delete(f"{API}/families/{r2.json()['id']}")

    def test_get_by_id(self, sess, uploaded_family):
        r = sess.get(f"{API}/families/{uploaded_family['id']}")
        assert r.status_code == 200
        assert r.json()["id"] == uploaded_family["id"]

    def test_mesh(self, sess, uploaded_family):
        r = sess.get(f"{API}/families/{uploaded_family['id']}/mesh")
        assert r.status_code == 200
        j = r.json()
        assert "meshes" in j and isinstance(j["meshes"], list)
        assert len(j["meshes"]) >= 1
        m = j["meshes"][0]
        assert "vertices" in m and "faces" in m and "guid" in m

    def test_patch_rebind(self, sess, uploaded_family):
        guid = uploaded_family["elements"][0]["guid"]
        r = sess.patch(f"{API}/families/{uploaded_family['id']}",
                       json={"guid": guid, "component_key": "cabinet_wall"})
        assert r.status_code == 200
        # verify persisted
        r2 = sess.get(f"{API}/families/{uploaded_family['id']}")
        el = next(e for e in r2.json()["elements"] if e["guid"] == guid)
        assert el["component_key_suggested"] == "cabinet_wall"
        assert el["confidence"] == 1.0

    def test_delete_removes_disk_and_db(self, sess):
        d = make_ifc_with([{"klass": "IfcDoor", "name": "temp", "predef": "DOOR"}])
        r = sess.post(f"{API}/families/upload", files={"file": ("del.ifc", d)})
        assert r.status_code == 200
        j = r.json()
        path = j["path"]
        assert os.path.exists(path)
        rd = sess.delete(f"{API}/families/{j['id']}")
        assert rd.status_code == 200
        # gone from disk
        assert not os.path.exists(path)
        # gone from db
        r2 = sess.get(f"{API}/families/{j['id']}")
        assert r2.status_code == 404


# ------------------------ Room IFC export ------------------------
@pytest.fixture(scope="module")
def seeded_scene(sess, room_id):
    """Put a couple of items into the room scene so exports have content."""
    # fetch components to find valid keys
    comps = sess.get(f"{API}/components").json()
    by_kind = {}
    for c in comps:
        by_kind.setdefault(c.get("kind"), c)
    basin = next((c for c in comps if c["key"] == "clinical_wash_basin"), None)
    macer = next((c for c in comps if c["key"] == "macerator"), None)
    if not basin or not macer:
        # fallback to any two
        basin = comps[0]; macer = comps[1]
    items = [
        {"id": str(uuid.uuid4()), "component_key": basin["key"], "kind": basin.get("kind"),
         "x": 0.2, "y": 0.2, "w": 0.6, "d": 0.5, "rotation": 0,
         "zone": "clean", "mount_type": basin.get("mount_type") or "wall",
         "elevation_m": 0.85, "height_m": 0.9},
        {"id": str(uuid.uuid4()), "component_key": macer["key"], "kind": macer.get("kind"),
         "x": 1.2, "y": 0.4, "w": 0.55, "d": 0.55, "rotation": 90,
         "zone": "dirty", "mount_type": macer.get("mount_type") or "floor",
         "elevation_m": 0.0, "height_m": 0.9},
    ]
    scene = {"room_id": room_id, "width": 3.0, "depth": 2.5, "ceiling_h": 2.7,
             "items": items}
    r = sess.put(f"{API}/rooms/{room_id}/scene", json=scene)
    assert r.status_code == 200, r.text
    return {"items": items}


class TestRoomExportIfc:
    def test_export_header_and_schema(self, sess, room_id, seeded_scene):
        r = sess.get(f"{API}/rooms/{room_id}/export.ifc")
        assert r.status_code == 200
        content = r.content
        assert content[:len(b"ISO-10303-21;")] == b"ISO-10303-21;", content[:80]
        text = content.decode("utf-8", errors="replace")
        assert "FILE_SCHEMA(('IFC4'))" in text, "FILE_SCHEMA IFC4 not present"

    def test_export_product_count_matches_items(self, sess, room_id, seeded_scene, tmp_path):
        r = sess.get(f"{API}/rooms/{room_id}/export.ifc")
        assert r.status_code == 200
        f = tmp_path / "out.ifc"
        f.write_bytes(r.content)
        ifc = ifcopenshell.open(str(f))
        # Only physical products count — spaces/sites/buildings/storeys/openings excluded
        physical = [p for p in ifc.by_type("IfcProduct")
                    if not p.is_a("IfcSpace") and not p.is_a("IfcSite")
                    and not p.is_a("IfcBuilding") and not p.is_a("IfcBuildingStorey")
                    and not p.is_a("IfcOpeningElement") and not p.is_a("IfcAnnotation")
                    and not p.is_a("IfcGrid")]
        assert len(physical) == len(seeded_scene["items"]), (
            f"expected {len(seeded_scene['items'])} products, got {len(physical)}"
        )


# ------------------------ Round-trip import ------------------------
class TestRoundTrip:
    def test_round_trip(self, sess, room_id, seeded_scene):
        # export
        r = sess.get(f"{API}/rooms/{room_id}/export.ifc")
        assert r.status_code == 200
        exported = r.content

        # remember original keys
        orig_keys = sorted([it["component_key"] for it in seeded_scene["items"]])
        orig_count = len(seeded_scene["items"])

        # wipe scene by writing empty items
        empty = {"room_id": room_id, "width": 3.0, "depth": 2.5, "ceiling_h": 2.7, "items": []}
        rw = sess.put(f"{API}/rooms/{room_id}/scene", json=empty)
        assert rw.status_code == 200

        # re-import
        files = {"file": ("round.ifc", exported, "application/octet-stream")}
        # multipart POST — don't send JSON content-type
        s2 = requests.Session()
        s2.headers.update({"Authorization": sess.headers["Authorization"]})
        ri = s2.post(f"{API}/rooms/{room_id}/import.ifc", files=files)
        assert ri.status_code == 200, ri.text

        # fetch reconstructed scene
        rs = sess.get(f"{API}/rooms/{room_id}/scene")
        assert rs.status_code == 200
        items = rs.json().get("items") or []
        assert len(items) == orig_count, f"round-trip lost items: {len(items)} vs {orig_count}"
        got_keys = sorted([it["component_key"] for it in items])
        assert got_keys == orig_keys, f"component_keys not preserved: {got_keys} vs {orig_keys}"


# ------------------------ Iteration 16 regression ------------------------
class TestIter16Regression:
    def test_sign_and_verify(self, sess):
        r = sess.post(f"{API}/estate/derogation-report/sign", json={"filters": {}})
        assert r.status_code == 200, r.text
        j = r.json()
        sig_id = j.get("signature_id") or j.get("id")
        token = j.get("token")
        assert sig_id and token
        v = sess.post(f"{API}/estate/derogation-report/verify",
                      json={"signature_id": sig_id, "token": token})
        assert v.status_code == 200
        assert v.json().get("valid") is True

    def test_orientation_metadata_still_present(self, sess):
        r = sess.get(f"{API}/components"); assert r.status_code == 200
        comps = r.json()
        kinds = {c.get("kind") for c in comps}
        for expected in ["basin", "door", "vent", "macerator", "bin"]:
            assert expected in kinds, f"kind {expected} missing"
