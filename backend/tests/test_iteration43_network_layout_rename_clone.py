# Iteration 43: shared network layouts, room rename, clone with pin remap
import os, uuid
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')


def login(email, pw="demo1234"):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}: {r.status_code}")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


def items_of(sc):
    j = sc.json()
    return j.get("items") or (j.get("scene") or {}).get("items") or []


@pytest.fixture(scope="module")
def arch():
    return login("architect@his.dev")


@pytest.fixture(scope="module")
def room(arch):
    nodes = arch.get(f"{BASE_URL}/api/hierarchy").json()
    src = next(n for n in nodes if n.get("type") == "utility" and n.get("name") == "Dirty Utility"
               and (n.get("metadata") or {}).get("sample_room"))
    r = arch.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": "TEST_net_room"})
    assert r.status_code == 200, r.text
    rid = r.json()["room"]["id"]
    yield rid
    arch.delete(f"{BASE_URL}/api/rooms/{rid}")


# Network layout GET/PUT
class TestNetworkLayout:
    def test_empty_then_put_get(self, arch, room):
        g = arch.get(f"{BASE_URL}/api/rooms/{room}/network-layout")
        assert g.status_code == 200
        assert g.json()["pins"] == {}
        its = items_of(arch.get(f"{BASE_URL}/api/rooms/{room}/scene"))
        assert len(its) >= 2
        pins = {its[0]["id"]: {"px": 123.456, "py": 78.9}, its[1]["id"]: {"px": -5, "py": 10}}
        p = arch.put(f"{BASE_URL}/api/rooms/{room}/network-layout", json={"pins": pins})
        assert p.status_code == 200, p.text
        d = p.json()
        assert d["updated_by"] and d["updated_at"]
        assert d["pins"][its[0]["id"]] == {"px": 123.5, "py": 78.9}
        g2 = arch.get(f"{BASE_URL}/api/rooms/{room}/network-layout").json()
        assert g2["pins"][its[1]["id"]] == {"px": -5.0, "py": 10.0}
        assert g2["updated_by"]

    def test_no_access_user_forbidden(self, room):
        c = login("contributor@his.dev")
        assert c.get(f"{BASE_URL}/api/rooms/{room}/network-layout").status_code in (403, 404)
        assert c.put(f"{BASE_URL}/api/rooms/{room}/network-layout", json={"pins": {}}).status_code in (403, 404)
        assert c.patch(f"{BASE_URL}/api/rooms/{room}/name", json={"name": "hack"}).status_code in (403, 404)

    def test_unauthenticated(self, room):
        assert requests.get(f"{BASE_URL}/api/rooms/{room}/network-layout").status_code == 401

    def test_shared_user_sees_same_layout(self, arch, room):
        c = login("contributor@his.dev")
        rq = c.post(f"{BASE_URL}/api/rooms/{room}/access-request", json={"note": "TEST"})
        assert rq.status_code == 200, rq.text
        ap = arch.post(f"{BASE_URL}/api/rooms/{room}/access-requests/{rq.json()['request_id']}/approve",
                       json={"role": "architect"})
        assert ap.status_code == 200, ap.text
        mine = arch.get(f"{BASE_URL}/api/rooms/{room}/network-layout").json()["pins"]
        theirs = c.get(f"{BASE_URL}/api/rooms/{room}/network-layout")
        assert theirs.status_code == 200
        assert theirs.json()["pins"] == mine
        # contributor updates -> architect sees it with contributor's name
        k = next(iter(mine))
        new = {**mine, k: {"px": 1, "py": 2}}
        p = c.put(f"{BASE_URL}/api/rooms/{room}/network-layout", json={"pins": new})
        assert p.status_code == 200
        g = arch.get(f"{BASE_URL}/api/rooms/{room}/network-layout").json()
        assert g["pins"][k] == {"px": 1.0, "py": 2.0}
        assert "ontributor" in (g["updated_by"] or "") or "contributor" in (g["updated_by"] or "").lower()
        # restore pin for clone test
        arch.put(f"{BASE_URL}/api/rooms/{room}/network-layout", json={"pins": mine})

    def test_invalid_payload(self, arch, room):
        r = arch.put(f"{BASE_URL}/api/rooms/{room}/network-layout", json={"pins": {"x": {"px": "abc"}}})
        assert r.status_code in (400, 422), r.status_code


# Rename
class TestRename:
    def test_rename_and_empty(self, arch, room):
        r = arch.patch(f"{BASE_URL}/api/rooms/{room}/name", json={"name": "  TEST_renamed  "})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_renamed"
        h = arch.get(f"{BASE_URL}/api/hierarchy").json()
        assert next(n for n in h if n["id"] == room)["name"] == "TEST_renamed"
        assert arch.patch(f"{BASE_URL}/api/rooms/{room}/name", json={"name": "   "}).status_code == 400

    def test_rename_representation_forbidden(self, arch):
        reps = [n for n in arch.get(f"{BASE_URL}/api/hierarchy").json() if n.get("is_representation")]
        if not reps:
            pytest.skip("no reps")
        r = arch.patch(f"{BASE_URL}/api/rooms/{reps[0]['id']}/name", json={"name": "x"})
        assert r.status_code == 403


# Clone remaps pins
class TestCloneRemap:
    def test_clone_remaps_pins(self, arch, room):
        src_pins = arch.get(f"{BASE_URL}/api/rooms/{room}/network-layout").json()["pins"]
        if not src_pins:  # xdist loadscope may run this class on a fresh room
            its0 = items_of(arch.get(f"{BASE_URL}/api/rooms/{room}/scene"))
            arch.put(f"{BASE_URL}/api/rooms/{room}/network-layout",
                     json={"pins": {its0[0]["id"]: {"px": 100.0, "py": 100.0}}})
            src_pins = arch.get(f"{BASE_URL}/api/rooms/{room}/network-layout").json()["pins"]
        assert src_pins
        src_items = items_of(arch.get(f"{BASE_URL}/api/rooms/{room}/scene"))
        r = arch.post(f"{BASE_URL}/api/rooms/{room}/clone", json={"name": "TEST_dup"})
        assert r.status_code == 200
        nid = r.json()["room"]["id"]
        try:
            assert r.json()["room"]["name"] == "TEST_dup"
            new_items = items_of(arch.get(f"{BASE_URL}/api/rooms/{nid}/scene"))
            assert len(new_items) == len(src_items)
            new_ids = {i["id"] for i in new_items}
            assert not (new_ids & {i["id"] for i in src_items})
            lay = arch.get(f"{BASE_URL}/api/rooms/{nid}/network-layout").json()
            assert len(lay["pins"]) == len(src_pins)
            assert set(lay["pins"]).issubset(new_ids)
            # positions preserved via index mapping
            idx = {i["id"]: n for n, i in enumerate(src_items)}
            for k, v in src_pins.items():
                assert lay["pins"][new_items[idx[k]]["id"]] == v
        finally:
            arch.delete(f"{BASE_URL}/api/rooms/{nid}")

    def test_default_copy_name(self, arch, room):
        r = arch.post(f"{BASE_URL}/api/rooms/{room}/clone", json={})
        assert r.status_code == 200
        try:
            assert r.json()["room"]["name"].endswith("(copy)")
        finally:
            arch.delete(f"{BASE_URL}/api/rooms/{r.json()['room']['id']}")
