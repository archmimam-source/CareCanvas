"""Iteration 13 — Guest login + regression on existing auth & protected endpoints."""
from pathlib import Path
import os
import uuid
import time
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
# Fallback to reading from frontend/.env if not exported into the pytest env
if not BASE_URL:
    try:
        with open(str(Path(__file__).resolve().parents[2] / "frontend" / ".env")) as fh:
            for line in fh:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                    break
    except Exception:
        pass
assert BASE_URL, "REACT_APP_BACKEND_URL not set"
API = BASE_URL + "/api"


# ---------------------------------------------------------------------------
# Guest login contract
# ---------------------------------------------------------------------------
class TestGuestAuth:
    def _new_gid(self):
        return "g_" + uuid.uuid4().hex

    def test_guest_login_success(self):
        s = requests.Session()
        gid = self._new_gid()
        r = s.post(f"{API}/auth/guest", json={"guest_id": gid})
        assert r.status_code == 200, r.text
        data = r.json()
        assert "id" in data and isinstance(data["id"], str)
        assert data["email"] == f"guest+{gid}@his.local"
        assert data["role"] == "architect"
        assert data.get("auth") == "guest"
        assert "token" in data and len(data["token"]) > 20
        # cookies must be set on the session
        cookie_names = {c.name for c in s.cookies}
        assert "access_token" in cookie_names
        assert "refresh_token" in cookie_names

    def test_guest_missing_field_returns_422(self):
        r = requests.post(f"{API}/auth/guest", json={})
        assert r.status_code == 422, r.text

    def test_guest_short_id_returns_400(self):
        r = requests.post(f"{API}/auth/guest", json={"guest_id": "abc"})
        assert r.status_code == 400, r.text

    def test_guest_idempotent_same_id(self):
        gid = self._new_gid()
        r1 = requests.post(f"{API}/auth/guest", json={"guest_id": gid}).json()
        r2 = requests.post(f"{API}/auth/guest", json={"guest_id": gid}).json()
        assert r1["id"] == r2["id"]
        assert r1["email"] == r2["email"]

    def test_guest_me_returns_correct_data(self):
        s = requests.Session()
        gid = self._new_gid()
        login = s.post(f"{API}/auth/guest", json={"guest_id": gid}).json()
        r = s.get(f"{API}/auth/me")
        assert r.status_code == 200
        me = r.json()
        assert me["email"] == login["email"]
        # id may be under `id` or `sub` depending on token path
        assert me.get("id") == login["id"] or me.get("sub") == login["id"] or me.get("user_id") == login["id"]

    def test_guest_logout_clears_session(self):
        s = requests.Session()
        s.post(f"{API}/auth/guest", json={"guest_id": self._new_gid()})
        assert s.get(f"{API}/auth/me").status_code == 200
        assert s.post(f"{API}/auth/logout").status_code == 200
        # session ought to be gone
        r = s.get(f"{API}/auth/me")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Regression on existing email/password auth
# ---------------------------------------------------------------------------
class TestExistingAuth:
    def test_login_seed_admin(self):
        r = requests.post(f"{API}/auth/login", json={"email": "architect@his.dev", "password": "demo1234"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["email"] == "architect@his.dev"
        assert d["role"] == "architect"
        assert "token" in d

    def test_register_and_login_new_user(self):
        email = f"TEST_reg_{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(f"{API}/auth/register",
                          json={"email": email, "password": "pw123456", "name": "T"})
        assert r.status_code == 200, r.text
        # second attempt = 400
        r2 = requests.post(f"{API}/auth/register",
                           json={"email": email, "password": "pw123456", "name": "T"})
        assert r2.status_code == 400
        # login works
        r3 = requests.post(f"{API}/auth/login", json={"email": email, "password": "pw123456"})
        assert r3.status_code == 200


# ---------------------------------------------------------------------------
# Protected endpoints work with a guest cookie session
# ---------------------------------------------------------------------------
class TestGuestProtectedEndpoints:
    @pytest.fixture(scope="class")
    def guest_session(self):
        s = requests.Session()
        gid = "g_" + uuid.uuid4().hex
        r = s.post(f"{API}/auth/guest", json={"guest_id": gid})
        assert r.status_code == 200
        return s

    def test_hierarchy(self, guest_session):
        r = guest_session.get(f"{API}/hierarchy")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list) and len(data) > 0

    def test_rules(self, guest_session):
        r = guest_session.get(f"{API}/rules")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_components(self, guest_session):
        r = guest_session.get(f"{API}/components")
        assert r.status_code == 200
        comps = r.json()
        assert len(comps) > 5

    def test_scene_get(self, guest_session):
        # find a utility room
        h = guest_session.get(f"{API}/hierarchy").json()
        util = next((n for n in h if n.get("type") == "utility"), None)
        assert util, "no utility room seeded"
        r = guest_session.get(f"{API}/rooms/{util['id']}/scene")
        assert r.status_code == 200
        scene = r.json()
        assert "items" in scene and "zones" in scene

    def test_autofix_and_delete_room(self, guest_session):
        # create a throwaway utility so autofix + delete are safe
        create = guest_session.post(f"{API}/rooms",
            json={"name": f"TEST_it13_{uuid.uuid4().hex[:6]}",
                  "kind": "inpatient_dirty_utility",
                  "width": 3.0, "depth": 3.0}).json()
        rid = create["scene_room_id"]
        # autofix requires validation history first
        guest_session.post(f"{API}/rooms/{rid}/validate")
        r = guest_session.post(f"{API}/rooms/{rid}/ai/autofix?deep=false", timeout=90)
        # AI can rate-limit / be flaky — accept 200 OR 500 with clear message but never 401/403
        assert r.status_code in (200, 500), r.text
        assert r.status_code != 401 and r.status_code != 403

        # delete the room
        d = guest_session.delete(f"{API}/rooms/{rid}")
        assert d.status_code == 200
        assert d.json()["deleted"]["hierarchy"] == 1


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
