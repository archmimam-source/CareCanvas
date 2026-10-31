from pathlib import Path
# Iteration 38: whole-floor IFC import, publish/approve workflow, org/user IFC mappings,
# IFC re-import diff/apply, layout comparison vs standards
import os
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
FX = os.path.join(os.path.dirname(__file__), "fixtures")
V1 = os.path.join(FX, "synthetic_two_rooms.ifc")
V2 = os.path.join(FX, "synthetic_two_rooms_v2.ifc")
GIZMO_FAMILY = "Acme Custom Gizmo Unit:Type B"
SPACE_A = "3o9k0re8X5sRqk65hIPcxm"


def _env(key):
    for line in open(Path(__file__).resolve().parents[1] / ".env"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')


STATE = {}
MDB = MongoClient(_env("MONGO_URL"))[_env("DB_NAME")]


def _login(email, pw):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}")
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    s.uid = r.json().get("id") or s.get(f"{BASE_URL}/api/auth/me").json()["id"]
    return s


def _register(org):
    s = requests.Session()
    em = f"test_{uuid.uuid4().hex[:8]}@example.com"
    r = s.post(f"{BASE_URL}/api/auth/register", json={"email": em, "password": "Passw0rd!x", "name": "TEST user"})
    assert r.status_code in (200, 201), r.text
    tok = r.json().get("token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    if org:
        assert s.patch(f"{BASE_URL}/api/auth/me", json={"organization": org}).status_code == 200
    s.uid = s.get(f"{BASE_URL}/api/auth/me").json()["id"]
    s.email = em
    return s


def _upload(s, path):
    with open(path, "rb") as f:
        r = s.post(f"{BASE_URL}/api/ifc-import", files={"file": (os.path.basename(path), f)}, timeout=120)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def arch():
    return _login("architect@his.dev", "demo1234")


@pytest.fixture(scope="module")
def ipc():
    return _login("ipc@his.dev", "demo1234")


@pytest.fixture(scope="module")
def admin():
    return _login("admin@his.dev", "admin123")


@pytest.fixture(scope="module")
def cleanup():
    ids = []
    yield ids
    if ids:
        MDB.hierarchy.delete_many({"id": {"$in": ids}})
        MDB.scenes.delete_many({"room_id": {"$in": ids}})
        MDB.publish_requests.delete_many({"node_id": {"$in": ids}})
    MDB.users.delete_many({"email": {"$regex": "^test_.*@example.com$"}})
    MDB.ifc_mappings.delete_many({"scope": {"$regex": "^org:testorg_"}})


# ---------- Whole-floor import ----------
class TestFloor:
    def test_parse_has_storey_building(self, arch):
        d = _upload(arch, V1)
        assert len(d["spaces"]) == 2
        for sp in d["spaces"]:
            assert sp["storey"] == "L1" and sp["building"] == "B"

    def test_create_floor_private(self, arch, ipc, cleanup, request):
        d = _upload(arch, V1)
        r = arch.post(f"{BASE_URL}/api/ifc-import/{d['id']}/create-floor",
                      json={"storey": "L1", "building_name": "TEST_X"})
        assert r.status_code == 200, r.text
        out = r.json()
        b, f, rooms = out["building"], out["floor"], out["rooms"]
        cleanup += [b["id"], f["id"]] + [x["id"] for x in rooms]
        assert b["name"] == "TEST_X" and b["type"] == "building" and b["publish_status"] == "private"
        assert f["type"] == "zone" and f["parent_id"] == b["id"] and f["name"] == "L1"
        assert len(rooms) == 2
        h = {n["id"]: n for n in arch.get(f"{BASE_URL}/api/hierarchy").json()}
        assert b["id"] in h and f["id"] in h
        for x in rooms:
            assert h[x["id"]]["type"] == "utility" and h[x["id"]]["parent_id"] == f["id"]
            assert h[x["id"]]["owner_id"] == arch.uid
        hi = {n["id"] for n in ipc.get(f"{BASE_URL}/api/hierarchy").json()}
        assert not ({b["id"], f["id"]} | {x["id"] for x in rooms}) & hi
        assert ipc.get(f"{BASE_URL}/api/rooms/{rooms[0]['id']}/scene").status_code == 403
        STATE["floor"] = out

    def test_unknown_storey_404(self, arch):
        d = _upload(arch, V1)
        assert arch.post(f"{BASE_URL}/api/ifc-import/{d['id']}/create-floor",
                         json={"storey": "NOPE"}).status_code == 404

    def test_other_user_cannot_use_import(self, arch, ipc):
        d = _upload(arch, V1)
        assert ipc.post(f"{BASE_URL}/api/ifc-import/{d['id']}/create-floor",
                        json={"storey": "L1"}).status_code == 404


# ---------- Publish workflow ----------
class TestPublish:
    def test_publish_approve_unpublish(self, arch, ipc, admin, request):
        out = STATE.get("floor")
        assert out, "floor not created"
        bid, rid = out["building"]["id"], out["rooms"][0]["id"]
        assert ipc.post(f"{BASE_URL}/api/hierarchy/{bid}/publish-request", json={}).status_code == 403
        r = arch.post(f"{BASE_URL}/api/hierarchy/{bid}/publish-request", json={"note": "TEST please"})
        assert r.status_code == 200, r.text
        req = r.json()
        assert req["status"] == "pending"
        assert arch.post(f"{BASE_URL}/api/hierarchy/{bid}/publish-request", json={}).status_code == 400
        lr = admin.get(f"{BASE_URL}/api/publish-requests").json()
        assert lr["is_approver"] is True and any(x["id"] == req["id"] for x in lr["requests"])
        assert ipc.get(f"{BASE_URL}/api/publish-requests").json()["is_approver"] is False
        assert ipc.post(f"{BASE_URL}/api/publish-requests/{req['id']}/approve", json={}).status_code == 403
        # pending: still hidden from non-approver
        assert ipc.get(f"{BASE_URL}/api/rooms/{rid}/scene").status_code == 403
        assert admin.post(f"{BASE_URL}/api/publish-requests/{req['id']}/approve",
                          json={"note": "TEST ok"}).status_code == 200
        n = MDB.hierarchy.find_one({"id": rid})
        assert n["publish_status"] == "public" and n["published"] is True
        hi = {x["id"]: x for x in ipc.get(f"{BASE_URL}/api/hierarchy").json()}
        assert bid in hi and rid in hi and hi[rid].get("read_only")
        sc = ipc.get(f"{BASE_URL}/api/rooms/{rid}/scene")
        assert sc.status_code == 200
        assert ipc.put(f"{BASE_URL}/api/rooms/{rid}/scene", json=sc.json()).status_code == 403
        assert ipc.get(f"{BASE_URL}/api/hierarchy/{rid}").json()["can_edit"] is False
        notes = arch.get(f"{BASE_URL}/api/user-notes").json()["notes"]
        assert any(x.get("room_id") == bid and x["action"] == "approved" for x in notes)
        # decided twice -> 404
        assert admin.post(f"{BASE_URL}/api/publish-requests/{req['id']}/deny", json={}).status_code == 404
        # unpublish by non-owner -> 403, owner -> private
        assert ipc.post(f"{BASE_URL}/api/hierarchy/{bid}/unpublish").status_code == 403
        assert arch.post(f"{BASE_URL}/api/hierarchy/{bid}/unpublish").status_code == 200
        assert ipc.get(f"{BASE_URL}/api/rooms/{rid}/scene").status_code == 403
        assert MDB.hierarchy.find_one({"id": rid})["publish_status"] == "private"

    def test_deny_path(self, arch, ipc, admin, request):
        out = STATE.get("floor")
        bid, rid = out["building"]["id"], out["rooms"][0]["id"]
        req = arch.post(f"{BASE_URL}/api/hierarchy/{bid}/publish-request", json={"note": "again"}).json()
        assert admin.post(f"{BASE_URL}/api/publish-requests/{req['id']}/deny",
                          json={"note": "TEST no"}).status_code == 200
        assert MDB.hierarchy.find_one({"id": bid})["publish_status"] == "private"
        assert ipc.get(f"{BASE_URL}/api/rooms/{rid}/scene").status_code == 403
        notes = arch.get(f"{BASE_URL}/api/user-notes").json()["notes"]
        assert any(x.get("room_id") == bid and x["action"] == "denied" for x in notes)

    def test_publish_room_node_rejected(self, arch, request):
        out = STATE.get("floor")
        assert arch.post(f"{BASE_URL}/api/hierarchy/{out['rooms'][0]['id']}/publish-request",
                         json={}).status_code == 403


# ---------- Mappings ----------
class TestMappings:
    def _room_a(self, s):
        return next(x for x in _upload(s, V1)["spaces"] if x["guid"] == SPACE_A)

    def test_validation(self, arch):
        assert arch.post(f"{BASE_URL}/api/ifc-mappings", json={"family": "x", "component_key": "nope_zz"}).status_code == 404
        assert arch.post(f"{BASE_URL}/api/ifc-mappings", json={"family": "x", "component_key": "generic_ifc"}).status_code == 400

    def test_user_scope(self, arch, ipc):
        arch.delete(f"{BASE_URL}/api/ifc-mappings", params={"family": GIZMO_FAMILY})
        assert self._room_a(arch)["generic_count"] == 1
        r = arch.post(f"{BASE_URL}/api/ifc-mappings", json={"family": GIZMO_FAMILY, "component_key": "commode_store"})
        assert r.status_code == 200 and r.json()["scope"] == f"user:{arch.uid}"
        assert self._room_a(arch)["generic_count"] == 0
        assert self._room_a(ipc)["generic_count"] == 1

    def test_org_scope(self, cleanup):
        org = f"TESTORG_{uuid.uuid4().hex[:6]}"
        u1, u2, u3 = _register(org), _register(org), _register("TESTORG_other")
        assert self._room_a(u2)["generic_count"] == 1
        r = u1.post(f"{BASE_URL}/api/ifc-mappings", json={"family": GIZMO_FAMILY, "component_key": "commode_store"})
        assert r.json()["scope"] == f"org:{org.lower()}"
        assert self._room_a(u2)["generic_count"] == 0
        assert self._room_a(u3)["generic_count"] == 1


# ---------- Re-import ----------
class TestReimport:
    def test_diff_and_partial_apply(self, arch, ipc, cleanup):
        d1 = _upload(arch, V1)
        r = arch.post(f"{BASE_URL}/api/ifc-import/{d1['id']}/create", json={"space_guid": SPACE_A, "name": "TEST_reimport"})
        assert r.status_code == 200, r.text
        rid = r.json()["scene_room_id"]
        cleanup.append(rid)
        sc = arch.get(f"{BASE_URL}/api/rooms/{rid}/scene").json()
        sc["items"].append({"component_key": "hand_wash_basin", "x": 0.1, "y": 0.1, "w": 0.5, "d": 0.4, "rotation": 0, "zone": "clean"})
        pr = arch.put(f"{BASE_URL}/api/rooms/{rid}/scene", json=sc)
        assert pr.status_code == 200, pr.text
        manual_before = [i for i in pr.json()["items"] if not i.get("ifc_guid")]
        assert len(manual_before) == 1
        d2 = _upload(arch, V2)
        assert ipc.post(f"{BASE_URL}/api/rooms/{rid}/ifc-diff", json={"import_id": d2["id"]}).status_code in (403, 404)
        diff = arch.post(f"{BASE_URL}/api/rooms/{rid}/ifc-diff", json={"import_id": d2["id"]})
        assert diff.status_code == 200, diff.text
        ch = diff.json()["changes"]
        print([(c["type"], c["label"]) for c in ch])
        types = sorted(c["type"] for c in ch)
        assert types == ["added", "moved", "removed"], ch
        assert diff.json()["manual_items"] == 1
        mv = next(c for c in ch if c["type"] == "moved")
        ad = next(c for c in ch if c["type"] == "added")
        rm = next(c for c in ch if c["type"] == "removed")
        assert "trolley" in (mv["label"] or mv["component_key"]).lower()
        assert "sack" in (ad["label"] or "").lower()
        assert "gizmo" in (rm["label"] or "").lower()
        ap = arch.post(f"{BASE_URL}/api/rooms/{rid}/ifc-diff/apply",
                       json={"import_id": d2["id"], "accept": [mv["id"], ad["id"]]})
        assert ap.status_code == 200, ap.text
        items = arch.get(f"{BASE_URL}/api/rooms/{rid}/scene").json()["items"]
        guids = {i.get("ifc_guid") for i in items}
        assert rm["id"][2:] in guids  # unticked removal kept
        assert ad["id"][2:] in guids
        moved = next(i for i in items if i.get("ifc_guid") == mv["id"][2:])
        assert abs(moved["x"] - mv["after"]["x"]) < 0.01 and abs(moved["y"] - mv["after"]["y"]) < 0.01
        manual = [i for i in items if not i.get("ifc_guid")]
        assert len(manual) == 1 and manual[0]["id"] == manual_before[0]["id"]
        node = arch.get(f"{BASE_URL}/api/hierarchy/{rid}").json()
        assert node["metadata"]["ifc_source"]["import_id"] == d2["id"]
        # re-diff: only the removal remains
        rest = arch.post(f"{BASE_URL}/api/rooms/{rid}/ifc-diff", json={"import_id": d2["id"]}).json()["changes"]
        assert [c["type"] for c in rest] == ["removed"]
        assert ipc.post(f"{BASE_URL}/api/rooms/{rid}/ifc-diff/apply",
                        json={"import_id": d2["id"], "accept": [rm["id"]]}).status_code in (403, 404)


# ---------- Compare ----------
class TestCompare:
    def test_compare_all_standards(self, arch, cleanup):
        d1 = _upload(arch, V1)
        rid = arch.post(f"{BASE_URL}/api/ifc-import/{d1['id']}/create", json={"space_guid": SPACE_A}).json()["scene_room_id"]
        cleanup.append(rid)
        for st in ("nhp_v2", "hbn_f74", "hbn_f79", "revit_ex01"):
            r = arch.get(f"{BASE_URL}/api/rooms/{rid}/compare", params={"standard": st})
            assert r.status_code == 200, (st, r.text)
            j = r.json()
            for k in ("current", "reference", "pairs", "only_current", "only_reference", "summary"):
                assert k in j
            assert len(j["reference"]["items"]) > 0
        assert arch.get(f"{BASE_URL}/api/rooms/{rid}/compare", params={"standard": "bogus"}).status_code == 400

    def test_revit_applied_all_same(self, arch, ipc, cleanup):
        d1 = _upload(arch, V1)
        rid = arch.post(f"{BASE_URL}/api/ifc-import/{d1['id']}/create", json={"space_guid": SPACE_A}).json()["scene_room_id"]
        cleanup.append(rid)
        assert arch.post(f"{BASE_URL}/api/rooms/{rid}/apply-standard", json={"standard": "revit_ex01"}).status_code == 200
        j = arch.get(f"{BASE_URL}/api/rooms/{rid}/compare", params={"standard": "revit_ex01"}).json()
        s = j["summary"]
        assert s["moved"] == 0 and s["only_current"] == 0 and s["only_reference"] == 0 and s["same"] > 0, s
        assert ipc.get(f"{BASE_URL}/api/rooms/{rid}/compare", params={"standard": "nhp_v2"}).status_code == 403


def test_restore_architect_mapping(arch):
    # leave architect's pre-existing Gizmo mapping in place (it existed before testing)
    r = arch.post(f"{BASE_URL}/api/ifc-mappings", json={"family": GIZMO_FAMILY, "component_key": "commode_store"})
    assert r.status_code == 200
