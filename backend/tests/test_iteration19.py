"""
Iteration 19 — Components Library (rename Families → Components) + batch-2 RFAs.

Covers:
- SEED_VERSION=16, seed component 'door_open_button' exists (socket, wall, {0.12,0.03,0.12}).
- Batch-2 RFA classification: OUT131→data_double, OUT931→connection_box_32a,
  SWC901→door_open_button, APS902→extract_vent, OUT121→data_single.
- GET /api/components/library shape: components[], override_count, seed_count, orphans.
- has_override + override.* fields when override exists; override:null otherwise.
- Regression: /families endpoints still work.
"""
from pathlib import Path
import os, uuid, pytest, requests

def _base():
    try:
        with open(str(Path(__file__).resolve().parents[2] / "frontend" / ".env")) as f:
            for ln in f:
                if ln.startswith("REACT_APP_BACKEND_URL"):
                    return ln.split("=",1)[1].strip().strip('"').strip("'")
    except Exception: return ""
BASE = (os.environ.get("REACT_APP_BACKEND_URL") or _base()).rstrip("/")
API = f"{BASE}/api"

BATCH2 = {
    # path pattern, expected component_key
    "OUT131": ("/tmp/qbc2nxnm_IDP_Electrical Fixtures_OUT131-DOUBLE DATA.rfa",                 "data_double"),
    "OUT931": ("/tmp/btaxanek_IDP_Electrical Fixtures_OUT931-CONNECTION BOX 32AMP.rfa",         "connection_box_32a"),
    "SWC901": ("/tmp/p2f4s774_IDP_Electrical Fixtures_SWC901-ASSISTED DOOR TOUCHLESS BUTTON.rfa","door_open_button"),
    "APS902": ("/tmp/567dgl6i_IDP_Fire Protection_APS902-FIRE RATED PRESSURE STABILISER.rfa",   "extract_vent"),
    "OUT121": ("/tmp/bzjw1kk2_IDP_Electrical Fixtures_OUT121-SOCKET OUTLET DATA.rfa",           "data_single"),
}

@pytest.fixture(scope="module")
def sess():
    s = requests.Session()
    gid = f"iter19_{uuid.uuid4().hex[:10]}"
    r = s.post(f"{API}/auth/guest", json={"guest_id": gid})
    assert r.status_code == 200, r.text
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


# --- SEED_VERSION & seed component --------------------------------------------
def test_seed_version_16(sess):
    r = requests.get(f"{API}/")
    assert r.status_code == 200
    assert r.json().get("seed_version") == 16

def test_door_open_button_seed_present(sess):
    r = sess.get(f"{API}/components")
    assert r.status_code == 200
    comps = r.json()
    match = [c for c in comps if c.get("key") == "door_open_button"]
    assert len(match) == 1, "door_open_button seed component missing"
    c = match[0]
    assert c["kind"] == "socket"
    assert c["mount_type"] == "wall"
    fp = c["default_footprint"]
    assert (fp["w"], fp["d"], fp["h"]) == (0.12, 0.03, 0.12)


# --- Batch-2 classification ---------------------------------------------------
@pytest.fixture(scope="module")
def batch2_uploads(sess):
    out = {}
    for tag, (path, _) in BATCH2.items():
        assert os.path.exists(path), f"missing fixture {path}"
        with open(path, "rb") as f:
            r = sess.post(f"{API}/families/upload",
                          files={"file": (os.path.basename(path), f, "application/octet-stream")})
        assert r.status_code == 200, f"upload {tag} failed: {r.status_code} {r.text[:400]}"
        out[tag] = r.json()
    return out

@pytest.mark.parametrize("tag", list(BATCH2.keys()))
def test_batch2_classification(batch2_uploads, tag):
    expected_key = BATCH2[tag][1]
    fam = batch2_uploads[tag]
    els = fam.get("elements") or []
    assert els, f"no elements for {tag}"
    got = els[0].get("component_key_suggested")
    assert got == expected_key, f"{tag}: expected {expected_key} got {got}"


# --- /components/library shape ------------------------------------------------
def test_components_library_shape(sess, batch2_uploads):
    r = sess.get(f"{API}/components/library")
    assert r.status_code == 200
    data = r.json()
    for k in ("components", "override_count", "seed_count", "orphans"):
        assert k in data, f"missing key {k}"
    assert isinstance(data["components"], list) and data["components"]
    # seed_count should match /components length
    rc = sess.get(f"{API}/components")
    assert data["seed_count"] == len(rc.json())
    # every component has has_override + override
    for c in data["components"]:
        assert "has_override" in c and "override" in c
        if c["has_override"]:
            ov = c["override"]
            for f in ("family_id","filename","file_kind","revit_title","uploaded_at"):
                assert f in ov, f"override missing {f}"
        else:
            assert c["override"] is None

def test_library_override_count_matches_unique_keys(sess, batch2_uploads):
    r = sess.get(f"{API}/components/library")
    data = r.json()
    overridden_keys = {c["key"] for c in data["components"] if c["has_override"]}
    assert data["override_count"] == len(overridden_keys)
    # Batch-2 keys should be present as overrides
    for _, key in BATCH2.values():
        assert key in overridden_keys, f"{key} not overridden"


# --- Regression: /families endpoints -----------------------------------------
def test_families_list_still_works(sess):
    r = sess.get(f"{API}/families")
    assert r.status_code == 200
    assert isinstance(r.json(), list)

def test_family_detail_and_mesh(sess, batch2_uploads):
    fam = list(batch2_uploads.values())[0]
    fid = fam["id"]
    r = sess.get(f"{API}/families/{fid}")
    assert r.status_code == 200
    r = sess.get(f"{API}/families/{fid}/mesh")
    assert r.status_code == 200
    assert r.json()["meshes"][0]["is_placeholder"] is True
