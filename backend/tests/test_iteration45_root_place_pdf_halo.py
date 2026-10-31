# Iteration 45: clone to "__root__" (top of estate), PDF network page halo + timestamp format
import os, io, re
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
WARD_ICU = "f719ad6e-d39d-420b-9ac9-78862fb106d3"

SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200">'
       '<rect width="420" height="200" fill="#FFFFFF"/><text x="16" y="22" font-size="13">TEST net</text>'
       '<g transform="translate(10,40)"><circle cx="50" cy="50" r="10" fill="#2E9E46"/>'
       '<text x="50" y="72" fill="#1D1D1F" stroke="#FAFAFA" stroke-width="3" paint-order="stroke">HaloSink</text></g></svg>')


def login(email, pw="demo1234"):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


@pytest.fixture(scope="module")
def arch():
    return login("architect@his.dev")


@pytest.fixture(scope="module")
def src(arch):
    nodes = arch.get(f"{BASE_URL}/api/hierarchy").json()
    return next(n for n in nodes if n.get("type") == "utility" and n.get("is_mine") and n.get("parent_id"))


created = []


@pytest.fixture(scope="module", autouse=True)
def cleanup(arch):
    yield
    for rid in created:
        arch.delete(f"{BASE_URL}/api/rooms/{rid}")


def parent_of(s, rid):
    return next((n.get("parent_id") for n in s.get(f"{BASE_URL}/api/hierarchy").json() if n["id"] == rid), "MISSING")


class TestRootPlacement:
    def test_clone_root_sentinel(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_root", "parent_id": "__root__"})
        assert r.status_code == 200, r.text
        rid = r.json()["room"]["id"]; created.append(rid)
        assert r.json()["room"]["parent_id"] is None
        assert parent_of(arch, rid) is None

    def test_clone_default_null_keeps_parent(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_def", "parent_id": None})
        assert r.status_code == 200
        rid = r.json()["room"]["id"]; created.append(rid)
        assert parent_of(arch, rid) == src["parent_id"]

    def test_clone_level(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_lvl", "parent_id": WARD_ICU})
        assert r.status_code == 200, r.text
        rid = r.json()["room"]["id"]; created.append(rid)
        assert parent_of(arch, rid) == WARD_ICU

    def test_root_room_scene_access(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_root2", "parent_id": "__root__"})
        rid = r.json()["room"]["id"]; created.append(rid)
        g = arch.get(f"{BASE_URL}/api/rooms/{rid}/scene")
        assert g.status_code == 200


class TestPdfHalo:
    def test_pdf_halo_and_timestamp(self, arch, src):
        from pypdf import PdfReader
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_halo"})
        rid = r.json()["room"]["id"]; created.append(rid)
        assert arch.put(f"{BASE_URL}/api/rooms/{rid}/network-layout/snapshot", json={"svg": SVG}).status_code == 200
        p = arch.get(f"{BASE_URL}/api/rooms/{rid}/data-sheet.pdf")
        assert p.status_code == 200 and p.content[:4] == b"%PDF"
        pages = [pg.extract_text() or "" for pg in PdfReader(io.BytesIO(p.content)).pages]
        page = next(t for t in pages if "Room network" in t)
        assert page.count("HaloSink") >= 2, page  # halo copy + plain text
        assert page.count("TEST net") == 1  # un-haloed text not duplicated
        assert re.search(r"Arrangement saved \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC", page), page
