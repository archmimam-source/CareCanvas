# Iteration 37: IFC room import, ifc-source download/access, Revit family tags in PDF, scene persistence
import io
import os
import pytest
import requests
from pypdf import PdfReader

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
REAL_IFC = "/tmp/du.ifc"
SYN_IFC = os.path.join(os.path.dirname(__file__), "fixtures", "synthetic_two_rooms.ifc")
TEMPLATE_ID = "d383d3b7-bf5c-4f86-b4fd-6a5d03a68d5a"


def _login(email, pw):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}: {r.status_code}")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


def _upload(s, path, name=None):
    with open(path, "rb") as f:
        return s.post(f"{BASE_URL}/api/ifc-import",
                      files={"file": (name or os.path.basename(path), f, "application/octet-stream")},
                      timeout=180)


def _pdf_text(content):
    r = PdfReader(io.BytesIO(content))
    return "\n".join((p.extract_text() or "") for p in r.pages)


@pytest.fixture(scope="module")
def arch():
    return _login("architect@his.dev", "demo1234")


@pytest.fixture(scope="module")
def ipc():
    return _login("ipc@his.dev", "demo1234")


@pytest.fixture(scope="module")
def created(arch):
    ids = []
    yield ids
    for rid in ids:
        arch.delete(f"{BASE_URL}/api/rooms/{rid}")


@pytest.fixture(scope="module")
def real_import(arch):
    if not os.path.exists(REAL_IFC):
        pytest.skip("missing /tmp/du.ifc")
    r = _upload(arch, REAL_IFC)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def syn_import(arch):
    r = _upload(arch, SYN_IFC)
    assert r.status_code == 200, r.text
    return r.json()


# --- Parse real Revit IFC ---
class TestRealIfc:
    def test_parse_summary(self, real_import):
        d = real_import
        assert isinstance(d["id"], str) and d["id"]
        assert d["schema"] == "IFC2X3"
        assert d["authoring_tool"] == "Autodesk Revit 2026 (ENU)"
        assert len(d["spaces"]) == 1
        sp = d["spaces"][0]
        assert sp["name"] == "6222 · Dirty Utility (Medium)"
        assert abs(sp["width"] - 3.615) < 0.01 and abs(sp["depth"] - 2.5) < 0.01
        assert abs(sp["ceiling_h"] - 2.7) < 0.01
        assert sp["items_count"] == 42, sp
        assert sp["generic_count"] == 0, sp
        assert "items" not in sp

    def test_create_room_and_download(self, arch, ipc, real_import, created):
        sp = real_import["spaces"][0]
        r = arch.post(f"{BASE_URL}/api/ifc-import/{real_import['id']}/create",
                      json={"space_guid": sp["guid"], "name": "TEST_IFC real"})
        assert r.status_code == 200, r.text
        room = r.json()["room"]
        created.append(room["id"])
        assert r.json()["items"] == 42
        assert room["name"] == "TEST_IFC real"
        assert room["visible_to_org"] is False
        sc = arch.get(f"{BASE_URL}/api/rooms/{room['id']}/scene").json()
        assert len(sc["items"]) == 42
        assert all(it.get("revit_family") and it.get("label") and it.get("ifc_guid") for it in sc["items"])
        # owner download is byte-identical in size
        dl = arch.get(f"{BASE_URL}/api/rooms/{room['id']}/ifc-source")
        assert dl.status_code == 200
        assert len(dl.content) == os.path.getsize(REAL_IFC)
        assert "attachment" in dl.headers.get("content-disposition", "")
        # other user blocked
        assert ipc.get(f"{BASE_URL}/api/rooms/{room['id']}/ifc-source").status_code == 403
        assert ipc.post(f"{BASE_URL}/api/ifc-import/{real_import['id']}/create",
                        json={"space_guid": sp["guid"]}).status_code == 404
        # unauth blocked
        assert requests.get(f"{BASE_URL}/api/rooms/{room['id']}/ifc-source").status_code in (401, 403)
        # data sheet has Revit tags
        pdf = arch.get(f"{BASE_URL}/api/rooms/{room['id']}/data-sheet.pdf", timeout=120)
        assert pdf.status_code == 200, pdf.text[:300]
        assert pdf.content[:4] == b"%PDF"
        assert "Revit:" in _pdf_text(pdf.content)


# --- Synthetic two-room IFC ---
class TestSyntheticIfc:
    def test_two_spaces(self, syn_import):
        sps = {s["name"]: s for s in syn_import["spaces"]}
        assert set(sps) == {"A01 · Dirty Utility A", "B02 · Dirty Utility B"}, list(sps)
        a, b = sps["A01 · Dirty Utility A"], sps["B02 · Dirty Utility B"]
        assert abs(a["width"] - 3.0) < 0.01 and abs(a["depth"] - 2.4) < 0.01
        assert a["items_count"] == 2 and a["generic_count"] == 1
        assert abs(a["rotation_deg"]) < 0.5 or abs(a["rotation_deg"] - 90) < 0.5
        assert abs(b["width"] - 4.0) < 0.01 and abs(b["depth"] - 2.5) < 0.01
        assert abs(b["rotation_deg"] - 30) < 0.5
        assert b["items_count"] == 2

    def test_create_b_and_scene_persistence(self, arch, syn_import, created):
        b = next(s for s in syn_import["spaces"] if s["name"].startswith("B02"))
        r = arch.post(f"{BASE_URL}/api/ifc-import/{syn_import['id']}/create",
                      json={"space_guid": b["guid"], "name": "TEST_IFC B"})
        assert r.status_code == 200, r.text
        rid = r.json()["room"]["id"]
        created.append(rid)
        sc = arch.get(f"{BASE_URL}/api/rooms/{rid}/scene").json()
        keys = sorted(it["component_key"] for it in sc["items"])
        assert keys == ["generic_ifc", "macerator"], keys
        gen = next(it for it in sc["items"] if it["component_key"] == "generic_ifc")
        assert gen["label"] == "Mystery Equipment Rack"
        assert gen["revit_family"] and gen["ifc_guid"]
        for it in sc["items"]:
            assert 0 <= it["x"] and it["x"] + it["w"] <= 4.0 + 1e-3
            assert 0 <= it["y"] and it["y"] + it["d"] <= 2.5 + 1e-3
        # PUT scene keeps revit metadata
        items = [{k: it.get(k) for k in ("id", "component_key", "x", "y", "w", "d", "rotation", "zone",
                                         "mount_type", "elevation_m", "height_m", "revit_family",
                                         "label", "ifc_guid", "ifc_class")} for it in sc["items"]]
        items[0]["x"] = round(items[0]["x"] + 0.01, 3)
        p = arch.put(f"{BASE_URL}/api/rooms/{rid}/scene",
                     json={"room_id": rid, "width": sc["width"], "depth": sc["depth"],
                           "zones": sc["zones"], "items": items, "ceiling_h": sc.get("ceiling_h")})
        assert p.status_code == 200, p.text
        sc2 = arch.get(f"{BASE_URL}/api/rooms/{rid}/scene").json()
        g2 = next(it for it in sc2["items"] if it["component_key"] == "generic_ifc")
        assert g2["label"] == "Mystery Equipment Rack"
        assert g2["revit_family"] == gen["revit_family"] and g2["ifc_guid"] == gen["ifc_guid"]

    def test_unknown_space_guid_404(self, arch, syn_import):
        r = arch.post(f"{BASE_URL}/api/ifc-import/{syn_import['id']}/create", json={"space_guid": "nope"})
        assert r.status_code == 404


# --- Validation ---
class TestValidation:
    def test_non_ifc_name(self, arch):
        r = arch.post(f"{BASE_URL}/api/ifc-import", files={"file": ("x.txt", b"ISO-10303-21;", "text/plain")})
        assert r.status_code == 400 and "detail" in r.json()

    def test_not_step(self, arch):
        r = arch.post(f"{BASE_URL}/api/ifc-import", files={"file": ("x.ifc", b"hello world", "application/octet-stream")})
        assert r.status_code == 400

    def test_no_spaces_422(self, arch):
        with open(SYN_IFC, "rb") as f:
            txt = f.read().decode("utf-8", "ignore")
        lines = [l for l in txt.splitlines() if "IFCSPACE(" not in l.upper()]
        r = arch.post(f"{BASE_URL}/api/ifc-import",
                      files={"file": ("nospace.ifc", "\n".join(lines).encode(), "application/octet-stream")})
        assert r.status_code == 422, r.text
        assert "IfcSpace" in r.json()["detail"] or "No rooms" in r.json()["detail"]

    def test_unauth(self):
        r = requests.post(f"{BASE_URL}/api/ifc-import", files={"file": ("x.ifc", b"ISO-10303-21;", "a/b")})
        assert r.status_code in (401, 403)


# --- Standard regression + PDF tags ---
class TestStandardRevit:
    def test_apply_revit_ex01_and_pdf(self, arch, created):
        r = arch.post(f"{BASE_URL}/api/rooms", json={"name": "TEST_IFC std", "width": 3.615, "depth": 2.5})
        assert r.status_code in (200, 201)
        rid = r.json().get("id") or r.json().get("room", {}).get("id")
        created.append(rid)
        a = arch.post(f"{BASE_URL}/api/rooms/{rid}/apply-standard", json={"standard": "revit_ex01"})
        assert a.status_code == 200, a.text
        sc = arch.get(f"{BASE_URL}/api/rooms/{rid}/scene").json()
        keys = [it["component_key"] for it in sc["items"]]
        assert len(keys) == 44, len(keys)
        assert "smoke_detector" in keys and "call_lamp" in keys
        pdf = arch.get(f"{BASE_URL}/api/rooms/{rid}/data-sheet.pdf", timeout=120)
        assert pdf.status_code == 200
        assert "Revit:" in _pdf_text(pdf.content)

    def test_template_read_only_and_clone(self, arch, created):
        w = arch.post(f"{BASE_URL}/api/rooms/{TEMPLATE_ID}/apply-standard", json={"standard": "revit_ex01"})
        assert w.status_code == 403
        c = arch.post(f"{BASE_URL}/api/rooms/{TEMPLATE_ID}/clone", json={"name": "TEST_IFC clone"})
        assert c.status_code in (200, 201), c.text
        nid = c.json()["room"]["id"]
        created.append(nid)
        assert c.json()["room"]["owner_id"]
