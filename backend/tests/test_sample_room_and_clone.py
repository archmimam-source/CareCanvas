# Iteration 40: per-user 'Dirty Utility' sample room + Representation clone ('Use as template')
import os, uuid
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')


def login(email, pw):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}: {r.status_code}")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


def guest():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/guest", json={"guest_id": f"TEST_{uuid.uuid4().hex[:10]}"})
    assert r.status_code == 200, r.text
    tok = r.json().get("token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


def samples(nodes):
    return [n for n in nodes if n.get("type") == "utility" and n.get("name") == "Dirty Utility"
            and (n.get("metadata") or {}).get("sample_room")]


# Sample room: created exactly once for a brand-new user
class TestSampleRoom:
    def test_new_guest_gets_one_sample_room(self):
        s = guest()
        h1 = s.get(f"{BASE_URL}/api/hierarchy")
        assert h1.status_code == 200
        sm = samples(h1.json())
        assert len(sm) == 1, sm
        room = sm[0]
        assert not room.get("is_representation")
        assert not room.get("read_only")
        assert room["metadata"].get("cloned_from_name")
        # reload x2 -> no duplicates
        for _ in range(2):
            assert len(samples(s.get(f"{BASE_URL}/api/hierarchy").json())) == 1
        # scene has items (Revit content) and is editable
        sc = s.get(f"{BASE_URL}/api/rooms/{room['id']}/scene")
        assert sc.status_code == 200, sc.text
        items = sc.json().get("items") or sc.json().get("scene", {}).get("items") or []
        assert len(items) > 0

    def test_architect_has_exactly_one(self):
        s = login("architect@his.dev", "demo1234")
        for _ in range(2):
            h = s.get(f"{BASE_URL}/api/hierarchy")
            assert h.status_code == 200
        assert len(samples(h.json())) == 1

    def test_sample_not_visible_to_other_users(self):
        a = login("architect@his.dev", "demo1234")
        c = login("contributor@his.dev", "demo1234")
        a_ids = {n["id"] for n in samples(a.get(f"{BASE_URL}/api/hierarchy").json())}
        c_ids = {n["id"] for n in samples(c.get(f"{BASE_URL}/api/hierarchy").json())}
        assert len(c_ids) == 1
        assert not (a_ids & c_ids)


# Clone of representation room
class TestCloneTemplate:
    def test_clone_revit_representation(self):
        s = login("contributor@his.dev", "demo1234")
        nodes = s.get(f"{BASE_URL}/api/hierarchy").json()
        reps = [n for n in nodes if n.get("is_representation")]
        assert reps, "no representation rooms"
        src = next((n for n in reps if "Revit" in n.get("name", "")), reps[0])
        name = f"{src['name']} — my copy"
        r = s.post(f"{BASE_URL}/api/rooms/{src['id']}/clone", json={"name": name})
        assert r.status_code == 200, r.text
        new = r.json()["room"]
        try:
            assert new["name"] == name
            h = s.get(f"{BASE_URL}/api/hierarchy").json()
            got = next((n for n in h if n["id"] == new["id"]), None)
            assert got and not got.get("is_representation")
            sc = s.get(f"{BASE_URL}/api/rooms/{new['id']}/scene")
            assert sc.status_code == 200
        finally:
            d = s.delete(f"{BASE_URL}/api/rooms/{new['id']}")
            print("cleanup", d.status_code)
