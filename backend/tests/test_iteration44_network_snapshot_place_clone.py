# Iteration 44: network snapshot -> PDF page, clone placement (parent_id) validation
import os, io
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
ARCH_PRIVATE_BUILDING = "58332a45-a7a9-4da5-a4c5-6a3a84dc929f"  # architect-owned private imported building
WARD_ICU = "f719ad6e-d39d-420b-9ac9-78862fb106d3"
ESTATE = "d53ad0d8-ef7e-4f5e-bfb2-ec4f0417df7d"
ROOM_LVL = "886e6d67-52ef-4f34-9711-ff82cda628ac"

SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200">'
       '<rect width="420" height="200" fill="#FFFFFF"/><text x="16" y="22" font-size="13">TEST net</text>'
       '<g transform="translate(10,40)"><circle cx="50" cy="50" r="10" fill="#2E9E46"/>'
       '<path d="M50 50 Q100 20 200 80" stroke="#C0504D" fill="none"/>'
       '<text x="50" y="72" stroke="#FAFAFA" stroke-width="3" paint-order="stroke">Sink</text></g></svg>')


def login(email, pw="demo1234"):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


def pdf_text(content):
    from pypdf import PdfReader
    rd = PdfReader(io.BytesIO(content))
    return [p.extract_text() or "" for p in rd.pages]


@pytest.fixture(scope="module")
def arch():
    return login("architect@his.dev")


@pytest.fixture(scope="module")
def ipc():
    return login("ipc@his.dev")


@pytest.fixture(scope="module")
def src(arch):
    nodes = arch.get(f"{BASE_URL}/api/hierarchy").json()
    return next(n for n in nodes if n.get("type") == "utility" and n.get("is_mine")
                and n.get("name") == "Dirty Utility")


created = []


@pytest.fixture(scope="module", autouse=True)
def cleanup(arch, ipc):
    yield
    for s, rid in created:
        s.delete(f"{BASE_URL}/api/rooms/{rid}")


def parent_of(s, rid):
    return next((n.get("parent_id") for n in s.get(f"{BASE_URL}/api/hierarchy").json() if n["id"] == rid), "MISSING")


# Clone placement
class TestClonePlacement:
    def test_clone_default_keeps_parent(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_p_default"})
        assert r.status_code == 200, r.text
        rid = r.json()["room"]["id"]; created.append((arch, rid))
        assert r.json()["room"]["parent_id"] == src.get("parent_id")
        assert parent_of(arch, rid) == src.get("parent_id")

    @pytest.mark.parametrize("pid", [ESTATE, WARD_ICU, ROOM_LVL, ARCH_PRIVATE_BUILDING])
    def test_clone_to_valid_level(self, arch, src, pid):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_p_lvl", "parent_id": pid})
        assert r.status_code == 200, r.text
        rid = r.json()["room"]["id"]; created.append((arch, rid))
        assert r.json()["room"]["parent_id"] == pid
        assert parent_of(arch, rid) == pid

    def test_clone_into_utility_400(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_bad", "parent_id": src["id"]})
        assert r.status_code == 400

    def test_clone_nonexistent_400(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_bad", "parent_id": "nope-123"})
        assert r.status_code == 400

    def test_clone_into_others_private_building_400(self, ipc):
        nodes = ipc.get(f"{BASE_URL}/api/hierarchy").json()
        mine = next(n for n in nodes if n.get("type") == "utility" and n.get("is_mine"))
        assert not any(n["id"] == ARCH_PRIVATE_BUILDING for n in nodes)  # not visible to ipc
        r = ipc.post(f"{BASE_URL}/api/rooms/{mine['id']}/clone", json={"name": "TEST_bad", "parent_id": ARCH_PRIVATE_BUILDING})
        assert r.status_code == 400


# Snapshot + PDF page
class TestSnapshotPdf:
    def test_snapshot_validation(self, arch, src):
        r = arch.put(f"{BASE_URL}/api/rooms/{src['id']}/network-layout/snapshot", json={"svg": "<html>x</html>"})
        assert r.status_code == 400
        r = arch.put(f"{BASE_URL}/api/rooms/{src['id']}/network-layout/snapshot", json={"svg": "<svg" + "a" * 600_001})
        assert r.status_code == 400

    def test_snapshot_forbidden_other_user(self, ipc, src):
        r = ipc.put(f"{BASE_URL}/api/rooms/{src['id']}/network-layout/snapshot", json={"svg": SVG})
        assert r.status_code in (403, 404)

    def test_pdf_without_snapshot_shows_note(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_nosnap"})
        rid = r.json()["room"]["id"]; created.append((arch, rid))
        p = arch.get(f"{BASE_URL}/api/rooms/{rid}/data-sheet.pdf")
        assert p.status_code == 200 and p.content[:4] == b"%PDF"
        pages = pdf_text(p.content)
        page = next((t for t in pages if "Room network" in t), None)
        assert page is not None, "network page missing"
        assert "No network picture yet" in page
        assert "Overall task score" in page

    def test_pdf_with_snapshot_get_and_post(self, arch, src):
        r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_snap"})
        rid = r.json()["room"]["id"]; created.append((arch, rid))
        s = arch.put(f"{BASE_URL}/api/rooms/{rid}/network-layout/snapshot", json={"svg": SVG})
        assert s.status_code == 200 and s.json()["ok"] is True
        lay = arch.get(f"{BASE_URL}/api/rooms/{rid}/network-layout").json()
        assert lay.get("svg", "").startswith("<svg") or "svg" not in lay
        for resp in (arch.get(f"{BASE_URL}/api/rooms/{rid}/data-sheet.pdf"),
                     arch.post(f"{BASE_URL}/api/rooms/{rid}/data-sheet.pdf", json={})):
            assert resp.status_code == 200 and resp.content[:4] == b"%PDF"
            page = next((t for t in pdf_text(resp.content) if "Room network" in t), None)
            assert page is not None
            assert "No network picture yet" not in page
            assert "saved network arrangement" in page
            assert "TEST net" in page  # drawn snapshot text
            assert "Overall task score" in page and "Rule gaps" in page
            assert "Task" in page and "Distance" in page
