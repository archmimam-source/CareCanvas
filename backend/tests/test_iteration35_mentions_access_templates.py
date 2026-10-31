"""Iteration 35 backend tests:
- @Mentions in History (user_notes via invite accept, revoke, approve, deny)
- Access Requests (preview, request, list, approve, deny, self-request 400,
  duplicate 409, pending count, non-owner 403)
- Templates gallery (list + clone)
- Security regression: outsider is still 403 on all room endpoints
- Previous suite regression: shares/visibility/clone/audit endpoints work
"""
from pathlib import Path
import os
import time
import uuid
import pytest
import requests

def _read_env(path, key):
    try:
        with open(path) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or _read_env(str(Path(__file__).resolve().parents[2] / "frontend" / ".env"), "REACT_APP_BACKEND_URL")).rstrip("/")
API = f"{BASE_URL}/api"


def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login {email} failed: {r.status_code} {r.text}"
    return r.json()["token"]


def _h(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def tokens():
    return {
        "architect": _login("architect@his.dev", "demo1234"),
        "ipc":       _login("ipc@his.dev", "demo1234"),
        "contrib":   _login("contributor@his.dev", "demo1234"),
        "reviewer":  _login("reviewer@his.dev", "demo1234"),
        "admin":     _login("admin@his.dev", "admin123"),
    }


@pytest.fixture(scope="module")
def me(tokens):
    out = {}
    for k, t in tokens.items():
        r = requests.get(f"{API}/auth/me", headers=_h(t), timeout=30)
        assert r.status_code == 200, f"me({k}) {r.status_code}"
        out[k] = r.json()
    return out


def _find_estate(tok):
    r = requests.get(f"{API}/hierarchy", headers=_h(tok), timeout=30)
    assert r.status_code == 200
    for n in r.json():
        if n.get("type") == "estate":
            return n
    return None


def _create_room(tok, name):
    r = requests.post(f"{API}/rooms", headers=_h(tok),
                      json={"name": name, "kind": "clean_utility",
                            "size": "medium", "width": 3.0, "depth": 3.0},
                      timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    return j["room"], None


@pytest.fixture(scope="module")
def owner_room(tokens):
    """Room owned by architect; cleaned up at the end of the module."""
    room, bld = _create_room(tokens["architect"], f"TEST_ROOM_{uuid.uuid4().hex[:6]}")
    yield room
    # cleanup
    for nid in [room["id"]]:
        try:
            requests.delete(f"{API}/rooms/{nid}", headers=_h(tokens["architect"]), timeout=15)
        except Exception:
            pass


# ---------------- Security regression -----------------
class TestSecurityRegression:
    def test_outsider_forbidden_on_all_room_endpoints(self, tokens, owner_room):
        rid = owner_room["id"]
        t = tokens["contrib"]  # no invite, no share, no request
        # scene GET
        r = requests.get(f"{API}/rooms/{rid}/scene", headers=_h(t), timeout=15)
        assert r.status_code == 403, f"scene GET expected 403 got {r.status_code}"
        # scene PUT
        r = requests.put(f"{API}/rooms/{rid}/scene",
                         headers=_h(t), timeout=15,
                         json={"room_id": rid, "width": 3, "depth": 3,
                               "zones": {}, "items": []})
        assert r.status_code == 403
        # audit GET
        r = requests.get(f"{API}/rooms/{rid}/audit", headers=_h(t), timeout=15)
        assert r.status_code == 403


# ---------------- Access preview & requests -----------------
class TestAccessRequests:
    def test_access_preview_owner_vs_outsider(self, tokens, owner_room, me):
        rid = owner_room["id"]
        # owner
        r = requests.get(f"{API}/rooms/{rid}/access-preview",
                         headers=_h(tokens["architect"]), timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert j["room_id"] == rid
        assert j["has_access"] is True
        # outsider
        r = requests.get(f"{API}/rooms/{rid}/access-preview",
                         headers=_h(tokens["contrib"]), timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert j["has_access"] is False
        assert j["pending_request"] is False
        assert j["owner_email"] == me["architect"]["email"]

    def test_access_preview_404(self, tokens):
        r = requests.get(f"{API}/rooms/does-not-exist/access-preview",
                         headers=_h(tokens["contrib"]), timeout=15)
        assert r.status_code == 404

    def test_owner_cannot_request_own_room(self, tokens, owner_room):
        r = requests.post(f"{API}/rooms/{owner_room['id']}/access-request",
                          headers=_h(tokens["architect"]),
                          json={"note": "self"}, timeout=15)
        assert r.status_code == 400

    def test_request_duplicate_and_list(self, tokens, owner_room, me):
        rid = owner_room["id"]
        r = requests.post(f"{API}/rooms/{rid}/access-request",
                          headers=_h(tokens["contrib"]),
                          json={"note": "please add me"}, timeout=15)
        assert r.status_code == 200, r.text
        req_id = r.json()["request_id"]
        # duplicate
        r2 = requests.post(f"{API}/rooms/{rid}/access-request",
                           headers=_h(tokens["contrib"]),
                           json={"note": "again"}, timeout=15)
        assert r2.status_code == 409
        # non-owner list is forbidden
        r3 = requests.get(f"{API}/rooms/{rid}/access-requests",
                          headers=_h(tokens["contrib"]), timeout=15)
        assert r3.status_code == 403
        # owner list contains request
        r4 = requests.get(f"{API}/rooms/{rid}/access-requests?status=pending",
                          headers=_h(tokens["architect"]), timeout=15)
        assert r4.status_code == 200
        reqs = r4.json()["requests"]
        assert any(x["id"] == req_id for x in reqs)
        this_req = [x for x in reqs if x["id"] == req_id][0]
        assert this_req["requester_email"] == me["contrib"]["email"]
        assert this_req["note"] == "please add me"
        assert "ts" in this_req

    def test_approve_grants_access_and_notifies(self, tokens, owner_room):
        rid = owner_room["id"]
        # get pending
        r = requests.get(f"{API}/rooms/{rid}/access-requests?status=pending",
                         headers=_h(tokens["architect"]), timeout=15).json()
        req_id = r["requests"][0]["id"]
        # ack any pre-existing notes so we can inspect just the new one
        requests.post(f"{API}/user-notes/ack", headers=_h(tokens["contrib"]),
                      json={}, timeout=15)
        # approve
        r = requests.post(
            f"{API}/rooms/{rid}/access-requests/{req_id}/approve",
            headers=_h(tokens["architect"]),
            json={"role": "viewer", "note": "welcome"}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "approved"
        # requester now has access
        r = requests.get(f"{API}/rooms/{rid}/scene",
                         headers=_h(tokens["contrib"]), timeout=15)
        assert r.status_code == 200
        # note delivered
        r = requests.get(f"{API}/user-notes?unseen=true",
                         headers=_h(tokens["contrib"]), timeout=15)
        assert r.status_code == 200
        notes = r.json()["notes"]
        assert any(n["action"] == "approved" and n["note"] == "welcome" for n in notes), notes

    def test_deny_flow(self, tokens, owner_room):
        rid = owner_room["id"]
        # ipc lead is a fresh requester
        rq = requests.post(f"{API}/rooms/{rid}/access-request",
                           headers=_h(tokens["ipc"]),
                           json={"note": "for airflow review"}, timeout=15)
        assert rq.status_code == 200
        req_id = rq.json()["request_id"]
        # ack ipc's existing notes
        requests.post(f"{API}/user-notes/ack", headers=_h(tokens["ipc"]),
                      json={}, timeout=15)
        # deny
        d = requests.post(f"{API}/rooms/{rid}/access-requests/{req_id}/deny",
                          headers=_h(tokens["architect"]),
                          json={"note": "not this quarter"}, timeout=15)
        assert d.status_code == 200
        # ipc still forbidden on scene
        r = requests.get(f"{API}/rooms/{rid}/scene",
                         headers=_h(tokens["ipc"]), timeout=15)
        assert r.status_code == 403
        # denial note delivered
        notes = requests.get(f"{API}/user-notes?unseen=true",
                             headers=_h(tokens["ipc"]), timeout=15).json()["notes"]
        assert any(n["action"] == "denied" and n["note"] == "not this quarter"
                   for n in notes), notes

    def test_bell_count(self, tokens, owner_room):
        # currently zero pending — nothing outstanding after prior tests
        r = requests.get(f"{API}/my/access-requests-count",
                         headers=_h(tokens["architect"]), timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json()["count"], int)
        base = r.json()["count"]
        # reviewer requests
        rq = requests.post(f"{API}/rooms/{owner_room['id']}/access-request",
                           headers=_h(tokens["reviewer"]),
                           json={"note": "hi"}, timeout=15)
        assert rq.status_code == 200
        req_id = rq.json()["request_id"]
        r = requests.get(f"{API}/my/access-requests-count",
                         headers=_h(tokens["architect"]), timeout=15)
        assert r.json()["count"] == base + 1
        # cleanup — deny it
        requests.post(f"{API}/rooms/{owner_room['id']}/access-requests/{req_id}/deny",
                      headers=_h(tokens["architect"]), json={}, timeout=15)


# ---------------- @Mentions on invite/revoke -----------------
class TestMentions:
    def test_invite_note_delivers_on_accept(self, tokens, owner_room, me):
        rid = owner_room["id"]
        # create fresh room to keep this deterministic
        room2, bld2 = _create_room(tokens["architect"], f"TEST_M_{uuid.uuid4().hex[:6]}")
        try:
            note_txt = "Hey Ivan — focus on airflow"
            inv = requests.post(f"{API}/invites",
                                headers=_h(tokens["architect"]),
                                json={"scope": "room", "scope_id": room2["id"],
                                      "role": "viewer", "note": note_txt},
                                timeout=15)
            assert inv.status_code == 200, inv.text
            token = inv.json()["token"]
            # reviewer accepts
            requests.post(f"{API}/user-notes/ack", headers=_h(tokens["reviewer"]),
                          json={}, timeout=15)
            a = requests.post(f"{API}/invites/accept",
                              headers=_h(tokens["reviewer"]),
                              json={"token": token}, timeout=15)
            assert a.status_code == 200
            un = requests.get(f"{API}/user-notes?unseen=true",
                              headers=_h(tokens["reviewer"]), timeout=15).json()
            assert un["unseen_count"] >= 1
            matches = [n for n in un["notes"]
                       if n["action"] == "invited" and n["note"] == note_txt
                       and n["from_email"] == me["architect"]["email"]]
            assert matches, un
        finally:
            requests.delete(f"{API}/rooms/{room2['id']}", headers=_h(tokens["architect"]))
            

    def test_revoke_with_note(self, tokens, me):
        room, bld = _create_room(tokens["architect"], f"TEST_R_{uuid.uuid4().hex[:6]}")
        try:
            # invite contributor, accept
            inv = requests.post(f"{API}/invites",
                                headers=_h(tokens["architect"]),
                                json={"scope": "room", "scope_id": room["id"],
                                      "role": "viewer"},
                                timeout=15).json()
            requests.post(f"{API}/invites/accept",
                          headers=_h(tokens["contrib"]),
                          json={"token": inv["token"]}, timeout=15)
            # ack existing
            requests.post(f"{API}/user-notes/ack", headers=_h(tokens["contrib"]),
                          json={}, timeout=15)
            # revoke with note
            uid = me["contrib"]["id"]
            note_txt = "Wrong room"
            import urllib.parse as up
            r = requests.delete(
                f"{API}/rooms/{room['id']}/shares/{uid}?note={up.quote(note_txt)}",
                headers=_h(tokens["architect"]), timeout=15)
            assert r.status_code == 200, r.text
            # note delivered
            un = requests.get(f"{API}/user-notes",
                              headers=_h(tokens["contrib"]), timeout=15).json()
            assert any(n["action"] == "revoked" and n["note"] == note_txt
                       for n in un["notes"]), un
        finally:
            requests.delete(f"{API}/rooms/{room['id']}", headers=_h(tokens["architect"]))
            

    def test_note_truncation_240(self, tokens):
        room, bld = _create_room(tokens["architect"], f"TEST_T_{uuid.uuid4().hex[:6]}")
        try:
            long_note = "x" * 400
            inv = requests.post(f"{API}/invites",
                                headers=_h(tokens["architect"]),
                                json={"scope": "room", "scope_id": room["id"],
                                      "role": "viewer", "note": long_note},
                                timeout=15).json()
            requests.post(f"{API}/user-notes/ack", headers=_h(tokens["reviewer"]),
                          json={}, timeout=15)
            requests.post(f"{API}/invites/accept",
                          headers=_h(tokens["reviewer"]),
                          json={"token": inv["token"]}, timeout=15)
            un = requests.get(f"{API}/user-notes?unseen=true",
                              headers=_h(tokens["reviewer"]), timeout=15).json()
            matches = [n for n in un["notes"] if n["action"] == "invited"
                       and n["room_id"] == room["id"]]
            assert matches
            assert len(matches[0]["note"]) == 240
        finally:
            requests.delete(f"{API}/rooms/{room['id']}", headers=_h(tokens["architect"]))
            

    def test_ack_all_marks_seen(self, tokens):
        # generate a note
        room, bld = _create_room(tokens["architect"], f"TEST_A_{uuid.uuid4().hex[:6]}")
        try:
            inv = requests.post(f"{API}/invites",
                                headers=_h(tokens["architect"]),
                                json={"scope": "room", "scope_id": room["id"],
                                      "role": "viewer", "note": "hi"},
                                timeout=15).json()
            requests.post(f"{API}/invites/accept",
                          headers=_h(tokens["reviewer"]),
                          json={"token": inv["token"]}, timeout=15)
            un = requests.get(f"{API}/user-notes?unseen=true",
                              headers=_h(tokens["reviewer"]), timeout=15).json()
            assert un["unseen_count"] >= 1
            ack = requests.post(f"{API}/user-notes/ack",
                                headers=_h(tokens["reviewer"]),
                                json={}, timeout=15).json()
            assert ack["ok"] is True
            un2 = requests.get(f"{API}/user-notes?unseen=true",
                               headers=_h(tokens["reviewer"]), timeout=15).json()
            assert un2["unseen_count"] == 0
        finally:
            requests.delete(f"{API}/rooms/{room['id']}", headers=_h(tokens["architect"]))
            


# ---------------- Templates -----------------
class TestTemplates:
    def test_list_templates(self, tokens):
        r = requests.get(f"{API}/templates",
                         headers=_h(tokens["architect"]), timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert "templates" in j
        assert isinstance(j["templates"], list)
        assert len(j["templates"]) > 0
        t0 = j["templates"][0]
        # required fields
        for k in ("id", "name", "kind", "code", "size", "risk_rating",
                  "width_m", "depth_m", "area_m2", "items_count", "zones_count"):
            assert k in t0, f"missing field {k} in template {t0}"

    def test_templates_excludes_user_rooms(self, tokens):
        # A room the architect created is user-owned; must NOT appear in /templates
        room, bld = _create_room(tokens["architect"], f"TEST_UN_{uuid.uuid4().hex[:6]}")
        try:
            r = requests.get(f"{API}/templates",
                             headers=_h(tokens["architect"]), timeout=15).json()
            ids = [t["id"] for t in r["templates"]]
            assert room["id"] not in ids
        finally:
            requests.delete(f"{API}/rooms/{room['id']}", headers=_h(tokens["architect"]))
            

    def test_clone_template(self, tokens):
        r = requests.get(f"{API}/templates",
                         headers=_h(tokens["architect"]), timeout=15).json()
        tid = r["templates"][0]["id"]
        c = requests.post(f"{API}/rooms/{tid}/clone",
                          headers=_h(tokens["architect"]),
                          json={"name": f"TEST_CLONE_{uuid.uuid4().hex[:6]}"},
                          timeout=30)
        assert c.status_code == 200, c.text
        cj = c.json()
        room = cj.get("room") or cj
        assert "id" in room
        assert room.get("owner_id"), "clone should be owned by caller"
        # cleanup
        requests.delete(f"{API}/rooms/{room['id']}", headers=_h(tokens["architect"]))


# ---------------- Previous suite regression -----------------
class TestPrevSuiteRegression:
    def test_shares_endpoints(self, tokens, me):
        room, bld = _create_room(tokens["architect"], f"TEST_S_{uuid.uuid4().hex[:6]}")
        try:
            # GET shares
            r = requests.get(f"{API}/rooms/{room['id']}/shares",
                             headers=_h(tokens["architect"]), timeout=15)
            assert r.status_code == 200
            # PATCH visibility
            r = requests.patch(f"{API}/rooms/{room['id']}/visibility",
                               headers=_h(tokens["architect"]),
                               json={"visible_to_org": False}, timeout=15)
            assert r.status_code == 200
            # invite + accept + delete share
            inv = requests.post(f"{API}/invites",
                                headers=_h(tokens["architect"]),
                                json={"scope": "room", "scope_id": room["id"],
                                      "role": "viewer"},
                                timeout=15).json()
            requests.post(f"{API}/invites/accept",
                          headers=_h(tokens["contrib"]),
                          json={"token": inv["token"]}, timeout=15)
            r = requests.delete(
                f"{API}/rooms/{room['id']}/shares/{me['contrib']['id']}",
                headers=_h(tokens["architect"]), timeout=15)
            assert r.status_code == 200
            # audit still works
            r = requests.get(f"{API}/rooms/{room['id']}/audit",
                             headers=_h(tokens["architect"]), timeout=15)
            assert r.status_code == 200
            assert "events" in r.json()
        finally:
            requests.delete(f"{API}/rooms/{room['id']}", headers=_h(tokens["architect"]))
            
