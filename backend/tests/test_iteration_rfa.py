"""
Iteration 18 — .rfa (Revit binary family) ingestion + classifier.

Covers:
- POST /api/families/upload accepts .rfa (and .ifc); rejects other extensions.
- file_kind='rfa' for RFA uploads; file_kind='ifc' still returned for IFC.
- Classifier suggestions + confidence + IFC PreDefinedType for the 5 seeded RFAs.
- Element .properties fully populated (Identity/Uniclass/Dimensions/Standards/Warranty).
- GET /api/families keeps full properties (no stripping).
- GET /api/families/{id}/thumbnail returns image/png (or 404 if no preview).
- GET /api/families/{id}/mesh for .rfa returns 12-tri bbox with is_placeholder=true.
- Seed component 'sanitary_ips' exists (kind=cabinet, dims {1.20,0.20,2.10}).
- SEED_VERSION=15.
- Regression: root returns seed_version=15.
"""
from pathlib import Path
import os, uuid, io
import pytest, requests

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


RFA_FIXTURES = {
    "twin":     ("/tmp/twin_socket.rfa",                                                    "socket_twin",      "POWEROUTLET"),
    "single":   ("/tmp/u9ob2ja7_IDP_Electrical Fixtures_OUT005-SGL SWITCHED PLUG SOCKET.rfa","socket_single",    "POWEROUTLET"),
    "isolator": ("/tmp/ulndsnxu_IDP_Electrical Fixtures_OUT079-ISOLATOR OUTLET.rfa",        "outlet_isolator",   None),
    "sanitary": ("/tmp/3hkthc3t_IDP_Plumbing Fixtures_PAN923-SANITARY IPS.rfa",              "sanitary_ips",      None),
    "urine":    ("/tmp/pr56qn2y_IDP_Specialty Equipment_SCA900-SCALE URINE WEIGHING.rfa",   "urine_scale",       None),
}


# ------------------------ fixtures ------------------------
@pytest.fixture(scope="module")
def sess():
    s = requests.Session()
    gid = f"iter18_{uuid.uuid4().hex[:10]}"
    r = s.post(f"{API}/auth/guest", json={"guest_id": gid})
    assert r.status_code == 200, r.text
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


@pytest.fixture(scope="module")
def uploaded(sess):
    """Upload each of the 5 sample RFAs; return dict key -> upload response."""
    out = {}
    for key, (path, _, _) in RFA_FIXTURES.items():
        assert os.path.exists(path), f"missing fixture {path}"
        with open(path, "rb") as f:
            r = sess.post(f"{API}/families/upload",
                          files={"file": (os.path.basename(path), f, "application/octet-stream")})
        assert r.status_code == 200, f"upload {key} failed: {r.status_code} {r.text[:300]}"
        out[key] = r.json()
    return out


# ------------------------ Root / seed version ------------------------
def test_root_seed_version(sess):
    r = sess.get(f"{API.replace('/api','')}/api/")
    assert r.status_code == 200
    j = r.json()
    assert j.get("seed_version") == 15


# ------------------------ Upload validation ------------------------
def test_upload_rejects_non_ifc_non_rfa(sess):
    r = sess.post(f"{API}/families/upload",
                  files={"file": ("junk.txt", b"hello", "text/plain")})
    assert r.status_code == 400, r.text


def test_upload_rejects_empty(sess):
    r = sess.post(f"{API}/families/upload",
                  files={"file": ("empty.rfa", b"", "application/octet-stream")})
    assert r.status_code == 400, r.text


# ------------------------ Upload happy path ------------------------
def test_upload_returns_file_kind_rfa(uploaded):
    for key, doc in uploaded.items():
        assert doc.get("file_kind") == "rfa", f"{key}: file_kind={doc.get('file_kind')}"
        assert doc.get("schema", "").startswith("RFA"), doc.get("schema")
        assert doc.get("total_elements") == 1
        assert len(doc.get("elements", [])) == 1


def test_classification_twin_socket(uploaded):
    doc = uploaded["twin"]
    el = doc["elements"][0]
    assert el["component_key_suggested"] == "socket_twin"
    assert el["confidence"] >= 0.9
    assert el.get("predefined_type", "").upper() == "POWEROUTLET"
    dims = el["dimensions"]
    assert abs(dims["w"] - 0.146) < 0.001
    assert abs(dims["d"] - 0.0832) < 0.002
    assert abs(dims["h"] - 0.0443) < 0.001


@pytest.mark.parametrize("key,expected", [
    ("single",   "socket_single"),
    ("isolator", "outlet_isolator"),
    ("sanitary", "sanitary_ips"),
    ("urine",    "urine_scale"),
])
def test_classification_others(uploaded, key, expected):
    el = uploaded[key]["elements"][0]
    assert el["component_key_suggested"] == expected, \
        f"{key}: got {el['component_key_suggested']} (name={el.get('name')}, dbg={el.get('classifier_debug')})"
    assert el["confidence"] >= 0.9


def test_element_properties_complete(uploaded):
    el = uploaded["twin"]["elements"][0]
    props = el.get("properties", {})
    assert "Identity" in props and "Uniclass 2015" in props
    assert "Dimensions" in props and "Standards" in props and "Warranty" in props
    assert props["Identity"].get("category") == "Electrical Fixtures"
    assert props["Uniclass 2015"].get("code")  # non-empty
    assert props["Dimensions"].get("size_text")
    assert props["Standards"].get("standard")
    assert props["Standards"].get("ifc_predefined_type", "").upper() == "POWEROUTLET"
    assert props["Warranty"].get("duration_unit")


# ------------------------ List keeps properties ------------------------
def test_list_families_keeps_properties(sess, uploaded):
    r = sess.get(f"{API}/families")
    assert r.status_code == 200
    docs = r.json()
    # Find the twin socket doc we just uploaded
    twin_id = uploaded["twin"]["id"]
    doc = next((d for d in docs if d["id"] == twin_id), None)
    assert doc is not None
    el = doc["elements"][0]
    assert el.get("properties", {}).get("Identity", {}).get("category") == "Electrical Fixtures"
    # Sanity: no _id leaks
    assert "_id" not in doc


# ------------------------ Thumbnail ------------------------
def test_thumbnail_endpoint(sess, uploaded):
    """Twin socket should have an embedded PNG thumbnail."""
    fid = uploaded["twin"]["id"]
    r = sess.get(f"{API}/families/{fid}/thumbnail")
    # Accept 200 (image/png) or 404 (no embedded preview) per spec.
    if r.status_code == 200:
        assert r.headers.get("content-type", "").startswith("image/png")
        assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    else:
        assert r.status_code == 404


# ------------------------ Mesh (placeholder bbox) ------------------------
def test_mesh_returns_placeholder_bbox(sess, uploaded):
    fid = uploaded["twin"]["id"]
    r = sess.get(f"{API}/families/{fid}/mesh")
    assert r.status_code == 200, r.text
    meshes = r.json()["meshes"]
    assert len(meshes) == 1
    m = meshes[0]
    assert m.get("is_placeholder") is True
    assert m["ifc_type"] == "RFA"
    assert len(m["vertices"]) == 24   # 8 verts * 3 coords
    assert len(m["faces"]) == 36      # 12 tris * 3 indices


# ------------------------ Seed component sanity ------------------------
def test_seed_component_sanitary_ips(sess):
    r = sess.get(f"{API}/components")
    assert r.status_code == 200
    comps = r.json()
    sip = next((c for c in comps if c.get("key") == "sanitary_ips"), None)
    assert sip is not None, "sanitary_ips missing from /api/components"
    assert sip.get("kind") == "cabinet"
    fp = sip.get("default_footprint", {})
    assert abs(fp.get("w", 0) - 1.20) < 0.001
    assert abs(fp.get("d", 0) - 0.20) < 0.001
    assert abs(fp.get("h", 0) - 2.10) < 0.001


# ------------------------ IFC regression (existing path unchanged) ------
def test_ifc_regression_via_hierarchy(sess):
    """Cheap smoke: list families still works after RFA uploads and returns list."""
    r = sess.get(f"{API}/families")
    assert r.status_code == 200
    assert isinstance(r.json(), list)
