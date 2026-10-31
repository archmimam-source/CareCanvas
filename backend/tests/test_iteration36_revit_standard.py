# Iteration 36: Revit Example 01 standard + template + regression on other standards
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
TEMPLATE_NAME = "Revit Example 01 · Dirty Utility (Medium) 6222"
EPS = 0.002


def _login(email, pw):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}: {r.status_code}")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def arch():
    return _login("architect@his.dev", "demo1234")


@pytest.fixture(scope="module")
def created(arch):
    ids = []
    yield ids
    for rid in ids:
        arch.delete(f"{BASE_URL}/api/rooms/{rid}")


def _mk(arch, created, w, d, name=None):
    r = arch.post(f"{BASE_URL}/api/rooms", json={"name": name or f"TEST_RVT {w}x{d}", "width": w, "depth": d})
    assert r.status_code in (200, 201), r.text
    rid = r.json().get("id") or r.json().get("room", {}).get("id")
    assert rid
    created.append(rid)
    return rid


def _apply(arch, rid, std):
    return arch.post(f"{BASE_URL}/api/rooms/{rid}/apply-standard", json={"standard": std})


def _find(items, key):
    return [i for i in items if i["component_key"] == key]


def _assert_in_bounds(items, W, D):
    bad = [i for i in items if i["x"] < -EPS or i["y"] < -EPS
           or i["x"] + i["w"] > W + EPS or i["y"] + i["d"] > D + EPS]
    assert not bad, f"out of bounds: {[(b['component_key'], b['x'], b['y'], b['w'], b['d']) for b in bad]}"


# --- Revit Ex01 at native size ---
class TestRevitNative:
    def test_native_positions(self, arch, created):
        rid = _mk(arch, created, 3.615, 2.5)
        r = _apply(arch, rid, "revit_ex01")
        assert r.status_code == 200, r.text
        sc = r.json()
        items = sc["items"]
        assert len(items) == 44
        assert sc["standard_applied"] == "revit_ex01"
        assert all(isinstance(i.get("revit_family"), str) and i["revit_family"] for i in items)
        _assert_in_bounds(items, 3.615, 2.5)

        def chk(key, x, y, w, d, rot):
            m = [i for i in _find(items, key)
                 if abs(i["x"] - x) < EPS and abs(i["y"] - y) < EPS
                 and abs(i["w"] - w) < EPS and abs(i["d"] - d) < EPS and i["rotation"] == rot]
            assert m, f"{key} not matching; got {[(i['x'], i['y'], i['w'], i['d'], i['rotation']) for i in _find(items, key)]}"
        chk("prep_counter", 0, 0, 0.9, 0.602, 0)
        chk("macerator", 2.655, 0.657, 0.662, 0.518, 90)
        chk("clinical_wash_basin", 0, 1.879, 0.9, 0.621, 180)
        chk("entry_door", 0, 0.818, 0.1, 0.86, 270)
        lt = _find(items, "linen_trolley")
        assert len(lt) == 3
        for t in lt:
            assert t["rotation"] == 180
            assert abs(t["y"] + t["d"] - 2.5) < 0.05, t

        # persisted
        g = arch.get(f"{BASE_URL}/api/rooms/{rid}/scene")
        assert g.status_code == 200
        assert len(g.json()["items"]) == 44
        assert g.json().get("standard_applied") == "revit_ex01"


# --- Revit Ex01 re-fit to other sizes ---
class TestRevitRefit:
    @pytest.mark.parametrize("W,D", [(4.2, 3.0), (3.0, 2.3), (5.0, 4.0)])
    def test_refit(self, arch, created, W, D):
        rid = _mk(arch, created, W, D)
        r = _apply(arch, rid, "revit_ex01")
        assert r.status_code == 200, r.text
        sc = r.json()
        items = sc["items"]
        assert len(items) == 44
        assert abs(sc["width"] - W) < 1e-6 and abs(sc["depth"] - D) < 1e-6
        _assert_in_bounds(items, W, D)
        mac = _find(items, "macerator")[0]
        assert abs(mac["w"] - 0.662) < EPS and abs(mac["d"] - 0.518) < EPS
        # IFC: macerator sits 0.298 m off the east wall (in front of 0.2 m IPS panel)
        assert abs(W - (mac["x"] + mac["w"]) - 0.298) < 0.01, f"macerator east offset not preserved: {mac}"
        ips = _find(items, "sanitary_ips")[0]
        assert abs(ips["x"] + ips["w"] - W) < 0.01, f"IPS not flush east: {ips}"
        basin = _find(items, "clinical_wash_basin")[0]
        assert abs(basin["w"] - 0.9) < EPS
        assert abs(basin["y"] + basin["d"] - D) < 0.01, f"basin not flush south: {basin}"
        pc = _find(items, "prep_counter")[0]
        assert pc["x"] == 0 and pc["y"] == 0
        for t in _find(items, "linen_trolley"):
            assert abs(t["y"] + t["d"] - D) < 0.05


# --- Other standards & validation ---
class TestOtherStandards:
    def test_invalid_standard(self, arch, created):
        rid = _mk(arch, created, 3.615, 2.5)
        r = _apply(arch, rid, "bogus")
        assert r.status_code == 400

    @pytest.mark.parametrize("std", ["hbn_f74", "hbn_f79", "nhp_v2"])
    def test_existing(self, arch, created, std):
        rid = _mk(arch, created, 3.615, 2.5)
        r = _apply(arch, rid, std)
        assert r.status_code == 200, r.text
        sc = r.json()
        assert sc["standard_applied"] == std
        assert len(sc["items"]) > 0
        _assert_in_bounds(sc["items"], sc["width"], sc["depth"])


# --- Template gallery + clone + access ---
class TestRevitTemplate:
    def test_template_listed_and_clone(self, arch, created):
        r = arch.get(f"{BASE_URL}/api/templates")
        assert r.status_code == 200
        t = [x for x in r.json()["templates"] if x["name"] == TEMPLATE_NAME]
        assert len(t) == 1, "revit template missing or duplicated"
        t = t[0]
        assert t["width_m"] == 3.615 and t["depth_m"] == 2.5 and t["items_count"] == 44
        # read-only
        w = _apply(arch, t["id"], "nhp_v2")
        assert w.status_code == 403
        g = arch.get(f"{BASE_URL}/api/rooms/{t['id']}/scene")
        assert g.status_code == 200
        src_items = g.json()["items"]
        # clone
        c = arch.post(f"{BASE_URL}/api/rooms/{t['id']}/clone", json={"name": "TEST_RVT clone"})
        assert c.status_code in (200, 201), c.text
        cj = c.json()
        nid = cj.get("id") or cj.get("room", {}).get("id") or cj.get("room_id")
        assert nid and nid != t["id"]
        created.append(nid)
        cs = arch.get(f"{BASE_URL}/api/rooms/{nid}/scene").json()
        assert len(cs["items"]) == 44
        key = lambda i: (i["component_key"], i["x"], i["y"], i["w"], i["d"], i["rotation"])
        assert sorted(map(key, cs["items"])) == sorted(map(key, src_items))
        # clone is writable by owner
        a = _apply(arch, nid, "revit_ex01")
        assert a.status_code == 200

    def test_template_unauth(self):
        r = requests.post(f"{BASE_URL}/api/rooms/d383d3b7-bf5c-4f86-b4fd-6a5d03a68d5a/apply-standard",
                          json={"standard": "revit_ex01"})
        assert r.status_code in (401, 403)
