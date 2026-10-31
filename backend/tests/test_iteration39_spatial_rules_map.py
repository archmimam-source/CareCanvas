from pathlib import Path
# Iteration 39: spatial analysis (room VGA/tasks/network/route, floor network/routes),
# rules-map (sources → rules → plans), rule-change proposal vetting (supersedes)
import os
import time
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
FX = os.path.join(os.path.dirname(__file__), "fixtures", "synthetic_floor.ifc")
ROOM = "3958aa58-5565-426c-a854-6f2f84e8357d"
TEMPLATE = "d383d3b7-bf5c-4f86-b4fd-6a5d03a68d5a"
TASK_IDS = {"ppe_on", "dispose", "hygiene", "linen", "waste", "exit", "escort"}


def _env(key):
    for line in open(Path(__file__).resolve().parents[1] / ".env"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')


MDB = MongoClient(_env("MONGO_URL"))[_env("DB_NAME")]
STATE = {}


def _login(email, pw):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}")
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


def _register():
    s = requests.Session()
    em = f"test_{uuid.uuid4().hex[:8]}@example.com"
    r = s.post(f"{BASE_URL}/api/auth/register", json={"email": em, "password": "Passw0rd!x", "name": "TEST user"})
    assert r.status_code in (200, 201), r.text
    if r.json().get("token"):
        s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


@pytest.fixture(scope="module")
def arch():
    return _login("architect@his.dev", "demo1234")


@pytest.fixture(scope="module")
def admin():
    return _login("admin@his.dev", "admin123")


@pytest.fixture(scope="module")
def ipc():
    return _login("ipc@his.dev", "demo1234")


@pytest.fixture(scope="module")
def stranger():
    return _register()


# ---- room spatial ----
class TestRoomSpatial:
    @pytest.mark.parametrize("rid", [ROOM, TEMPLATE])
    def test_room_spatial(self, arch, rid):
        t = time.time()
        r = arch.get(f"{BASE_URL}/api/rooms/{rid}/spatial", timeout=30)
        dt = time.time() - t
        assert r.status_code == 200, r.text
        print(f"spatial {rid} took {dt:.2f}s")
        assert dt < 5
        d = r.json()
        g = d["grid"]; assert g["nx"] > 1 and g["ny"] > 1
        v = d["vga"]
        for k in ("connectivity", "integration", "step_depth"):
            assert isinstance(v[k], list) and isinstance(v[k][0], list), k
            assert len(v[k]) == g["ny"] and len(v[k][0]) == g["nx"], k
        assert "door_isovist_share" in v
        assert {t["id"] for t in d["tasks"]} == TASK_IDS
        ok = [t for t in d["tasks"] if t["status"] == "ok"]
        print("tasks", [(t["id"], t["status"], t.get("score"), t.get("band")) for t in d["tasks"]])
        for t in ok:
            assert t["path"] and t["length_m"] > 0 and t["seconds"] >= 0
            assert 0 <= t["score"] <= 100 and t["band"] in ("Excellent", "Good", "Fair", "Poor")
        kinds = {e["kind"] for e in d["network"]["edges"]}
        assert kinds <= {"touch", "rule", "flow"}
        assert d["network"]["nodes"]
        assert "task_score" in d["summary"]

    def test_room_spatial_stranger_403(self, stranger):
        r = stranger.get(f"{BASE_URL}/api/rooms/{ROOM}/spatial")
        assert r.status_code == 403, r.status_code

    def test_room_spatial_unauth(self):
        assert requests.get(f"{BASE_URL}/api/rooms/{ROOM}/spatial").status_code in (401, 403)


class TestRoomRoute:
    @pytest.mark.parametrize("flow", ["patient", "visitor", "staff", "emergency", "escort"])
    def test_route_flows(self, arch, flow):
        r = arch.get(f"{BASE_URL}/api/rooms/{ROOM}/spatial/route",
                     params={"ax": 0.4, "ay": 0.4, "bx": 2.8, "by": 2.0, "flow": flow})
        assert r.status_code in (200, 422), r.text
        if r.status_code == 200:
            d = r.json()
            assert d["length_m"] > 0 and d["path"] and "score" in d and "band" in d
            STATE.setdefault("route_ok", []).append(flow)
            print(flow, d["length_m"], d["seconds"], d["score"], d["band"])

    def test_some_route_ok(self):
        assert STATE.get("route_ok"), "no flow produced a route"

    def test_route_invalid_flow(self, arch):
        r = arch.get(f"{BASE_URL}/api/rooms/{ROOM}/spatial/route",
                     params={"ax": 0.4, "ay": 0.4, "bx": 2.8, "by": 2.0, "flow": "bogus"})
        assert r.status_code == 400

    def test_route_template_read_only(self, arch):
        r = arch.get(f"{BASE_URL}/api/rooms/{TEMPLATE}/spatial/route",
                     params={"ax": 0.4, "ay": 0.4, "bx": 2.5, "by": 1.8, "flow": "staff"})
        assert r.status_code in (200, 422), r.text

    def test_route_stranger_403(self, stranger):
        r = stranger.get(f"{BASE_URL}/api/rooms/{ROOM}/spatial/route",
                         params={"ax": 0.4, "ay": 0.4, "bx": 2.8, "by": 2.0})
        assert r.status_code == 403


# ---- floor spatial ----
class TestFloorSpatial:
    def test_import_and_create_floor(self, arch):
        with open(FX, "rb") as f:
            r = arch.post(f"{BASE_URL}/api/ifc-import", files={"file": ("synthetic_floor.ifc", f)}, timeout=120)
        assert r.status_code == 200, r.text
        imp = r.json()
        r = arch.post(f"{BASE_URL}/api/ifc-import/{imp['id']}/create-floor", json={"storey": "Level 02"}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        fid = d.get("floor_id") or d.get("id") or (d.get("floor") or {}).get("id")
        assert fid, d
        STATE["floor"] = fid
        STATE["import"] = imp["id"]

    def test_floor_spatial(self, arch):
        fid = STATE.get("floor") or pytest.skip("no floor")
        t = time.time()
        r = arch.get(f"{BASE_URL}/api/hierarchy/{fid}/spatial", timeout=60)
        print(f"floor spatial {time.time()-t:.2f}s")
        assert r.status_code == 200, r.text
        d = r.json()
        assert len(d["rooms"]) == 6
        names = {x["id"]: x["name"] for x in d["rooms"]}
        print(names)
        corr = next(i for i, n in names.items() if "orridor" in n)
        STATE["corr"] = corr
        STATE["rooms"] = list(names)
        door_edges = [e for e in d["network"]["edges"] if e.get("door") and corr in (e["a"], e["b"])]
        assert len(door_edges) == 5, d["network"]["edges"]
        assert d["vga"] and d["vga"]["integration"]
        nodes = {n["id"]: n for n in d["network"]["nodes"]}
        integ = {k: n["integration"] for k, n in nodes.items() if n["integration"] is not None}
        print(integ)
        assert max(integ, key=integ.get) == corr

    def test_floor_routes(self, arch):
        fid = STATE.get("floor") or pytest.skip("no floor")
        src = STATE["corr"]
        r = arch.get(f"{BASE_URL}/api/hierarchy/{fid}/spatial", params={"source": src, "flow": "staff"}, timeout=60)
        assert r.status_code == 200
        routes = r.json()["routes"]
        assert len(routes) == 5
        for rt in routes:
            assert rt["status"] == "ok", rt
            assert rt["length_m"] > 0 and rt["band"] in ("Excellent", "Good", "Fair", "Poor") and isinstance(rt["score"], int)
        # from an end room to other rooms (must traverse corridor)
        other = next(x for x in STATE["rooms"] if x != src)
        r = arch.get(f"{BASE_URL}/api/hierarchy/{fid}/spatial", params={"source": other, "flow": "patient"}, timeout=60)
        assert r.status_code == 200
        assert all(x["status"] == "ok" for x in r.json()["routes"]), r.json()["routes"]

    def test_floor_other_user_404(self, stranger):
        fid = STATE.get("floor") or pytest.skip("no floor")
        r = stranger.get(f"{BASE_URL}/api/hierarchy/{fid}/spatial")
        assert r.status_code == 404, r.status_code

    def test_floor_existing(self, arch):
        r = arch.get(f"{BASE_URL}/api/hierarchy/ea128dce-1ae4-4ebc-877a-faa29ea25473/spatial", timeout=60)
        assert r.status_code in (200, 422), r.text
        print("existing floor", r.status_code, r.text[:200] if r.status_code != 200 else len(r.json()["rooms"]))

    def test_floor_without_positions_422(self, arch):
        fid = STATE.get("floor") or pytest.skip("no floor")
        # clone a zone with a child lacking poly_world
        node = MDB.hierarchy.find_one({"id": fid}, {"_id": 0})
        zid, cid = "TEST_zone_" + uuid.uuid4().hex[:6], "TEST_room_" + uuid.uuid4().hex[:6]
        MDB.hierarchy.insert_one({**node, "id": zid, "name": "TEST old floor", "metadata": {}})
        MDB.hierarchy.insert_one({"id": cid, "parent_id": zid, "type": "utility", "name": "TEST room",
                                  "owner_id": node.get("owner_id"), "metadata": {}})
        try:
            r = arch.get(f"{BASE_URL}/api/hierarchy/{zid}/spatial")
            assert r.status_code == 422, r.text
            assert "Re-import" in r.text
        finally:
            MDB.hierarchy.delete_many({"id": {"$in": [zid, cid]}})

    def test_zz_cleanup_created_floor(self):
        # Teardown: remove the floor/building/rooms this class imported
        fid = STATE.get("floor") or pytest.skip("no floor")
        z = MDB.hierarchy.find_one({"id": fid}, {"_id": 0})
        kids = [k["id"] for k in MDB.hierarchy.find({"parent_id": fid}, {"id": 1})]
        ids = kids + [fid]
        if z and MDB.hierarchy.count_documents({"parent_id": z["parent_id"]}) == 1:
            ids.append(z["parent_id"])
        MDB.hierarchy.delete_many({"id": {"$in": ids}})
        MDB.scenes.delete_many({"room_id": {"$in": kids}})
        MDB.ifc_imports.delete_one({"id": STATE.get("import")})


# ---- rules map ----
class TestRulesMap:
    def test_rules_map_shape(self, arch):
        r = arch.get(f"{BASE_URL}/api/rules-map", timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["sources"] and d["rules"] and d["roles"]
        assert d["can_approve"] is False
        ids = {x["id"] for x in d["rules"]}
        assert any(i.startswith("ADJ-") for i in ids), list(ids)[:20]
        for x in d["rules"]:
            assert "plans" in x and "pending_proposals" in x

    def test_validate_then_plans(self, arch):
        r = arch.post(f"{BASE_URL}/api/rooms/{ROOM}/validate", json={}, timeout=60)
        assert r.status_code == 200, r.text
        d = arch.get(f"{BASE_URL}/api/rules-map").json()
        hits = [(x["id"], p["status"], p["item_ids"]) for x in d["rules"] for p in x["plans"] if p["room_id"] == ROOM]
        print("plans for room:", hits[:10], len(hits))
        assert hits
        assert d["rooms_validated"] >= 1

    def test_admin_can_approve(self, admin):
        assert admin.get(f"{BASE_URL}/api/rules-map").json()["can_approve"] is True


class TestProposalFlow:
    def test_propose_and_approve(self, arch, admin, ipc):
        old = MDB.rules.find_one({"rule_id": "SPZ-02"}, {"_id": 0})
        if not old:
            pytest.skip("SPZ-02 missing")
        n_before = MDB.rules.count_documents({"rule_id": "SPZ-02"})
        hist_before = MDB.rule_history.count_documents({"rule_id": "SPZ-02"})
        new_stmt = "TEST_ updated SPZ-02 statement " + uuid.uuid4().hex[:6]
        try:
            r = arch.post(f"{BASE_URL}/api/ingestion/submit", json={"target": "rule", "payload": {
                "rule_id": "SPZ-02", "supersedes_rule_id": "SPZ-02", "statement": new_stmt, "source": "TEST source"}})
            assert r.status_code == 200, r.text
            sid = r.json()["id"]
            rm = arch.get(f"{BASE_URL}/api/rules-map").json()
            spz = next(x for x in rm["rules"] if x["id"] == "SPZ-02")
            assert spz["pending_proposals"] >= 1
            # non-reviewer cannot approve
            r = ipc.post(f"{BASE_URL}/api/ingestion/{sid}/review", json={"decision": "approve"})
            assert r.status_code == 403
            r = arch.post(f"{BASE_URL}/api/ingestion/{sid}/review", json={"decision": "approve"})
            assert r.status_code == 403
            r = admin.post(f"{BASE_URL}/api/ingestion/{sid}/review", json={"decision": "approve"})
            assert r.status_code == 200, r.text
            assert r.json()["version"] == int(old.get("version") or 1) + 1
            assert MDB.rules.count_documents({"rule_id": "SPZ-02"}) == n_before
            cur = MDB.rules.find_one({"rule_id": "SPZ-02"}, {"_id": 0})
            assert cur["statement"] == new_stmt
            assert cur["version"] == int(old.get("version") or 1) + 1
            assert MDB.rule_history.count_documents({"rule_id": "SPZ-02"}) == hist_before + 1
            rm = arch.get(f"{BASE_URL}/api/rules-map").json()
            spz = next(x for x in rm["rules"] if x["id"] == "SPZ-02")
            assert spz["statement"] == new_stmt and spz["pending_proposals"] == 0
            # re-review rejected
            r = admin.post(f"{BASE_URL}/api/ingestion/{sid}/review", json={"decision": "approve"})
            assert r.status_code == 400
        finally:
            MDB.rules.update_one({"rule_id": "SPZ-02"}, {"$set": {k: old.get(k) for k in
                                 ("statement", "source", "version", "reviewed_by", "last_reviewed")}})
            MDB.rules.update_one({"rule_id": "SPZ-02"}, {"$unset": {"proposed_by": ""}} if "proposed_by" not in old else {"$set": {"proposed_by": old["proposed_by"]}})

    def test_proposal_without_source_400(self, arch):
        r = arch.post(f"{BASE_URL}/api/ingestion/submit", json={"target": "rule", "payload": {
            "rule_id": "SPZ-02", "supersedes_rule_id": "SPZ-02", "statement": "x"}})
        assert r.status_code == 400
