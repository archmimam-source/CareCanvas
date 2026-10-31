"""
Regression tests for HealthcareCanvas iteration:
  1. Sharing panel (list / revoke / revoke-invite)
  2. Org workspaces (visible_to_org toggle, read-only for org peers)
  3. Room templates (POST /api/rooms/{id}/clone from Representation)
  4. 30-day audit log + TTL index
  5. Security regression: cross-user room isolation still enforced.
"""
import os
import uuid
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback for tests running inside the container
    BASE_URL = "http://localhost:8001"
API = f"{BASE_URL}/api"

# Seeded credentials (see backend/.env.example)
ARCHITECT = ("architect@his.dev", "demo1234")
IPC       = ("ipc@his.dev", "demo1234")
CONTRIB   = ("contributor@his.dev", "demo1234")   # role=contributor
ADMIN     = ("admin@his.dev", "admin123")


# --------------------------- helpers ---------------------------
def _login(email: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in login response: {r.json()}"
    return tok


def _guest_login() -> tuple[str, str]:
    gid = "TEST_" + uuid.uuid4().hex[:12]
    r = requests.post(f"{API}/auth/guest", json={"guest_id": gid}, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    return j["token"], j["id"]


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _me(token: str) -> dict:
    r = requests.get(f"{API}/auth/me", headers=_h(token), timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _create_room(token: str, name: str) -> str:
    r = requests.post(f"{API}/rooms", headers=_h(token),
                      json={"name": name, "kind": "inpatient_dirty_utility",
                            "width": 3.6, "depth": 2.5}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["room"]["id"] if "room" in r.json() else r.json()["id"]


def _patch_org(token: str, org: str):
    r = requests.patch(f"{API}/auth/me", headers=_h(token),
                       json={"organization": org}, timeout=30)
    assert r.status_code == 200, r.text


# --------------------------- fixtures ---------------------------
@pytest.fixture(scope="module")
def tok_arch():
    return _login(*ARCHITECT)


@pytest.fixture(scope="module")
def tok_ipc():
    return _login(*IPC)


@pytest.fixture(scope="module")
def tok_contrib():
    return _login(*CONTRIB)


@pytest.fixture(scope="module")
def owned_room(tok_arch):
    rid = _create_room(tok_arch, f"TEST_{uuid.uuid4().hex[:8]}")
    yield rid
    # cleanup: delete room
    try:
        requests.delete(f"{API}/rooms/{rid}", headers=_h(tok_arch), timeout=15)
    except Exception:
        pass


# --------------------------- 1. Security regression ---------------------------
class TestSecurityRegression:
    def test_non_owner_cannot_see_room_in_hierarchy(self, tok_arch, tok_contrib, owned_room):
        r = requests.get(f"{API}/hierarchy", headers=_h(tok_contrib), timeout=30)
        assert r.status_code == 200
        ids = {n["id"] for n in r.json()}
        assert owned_room not in ids, "contributor should NOT see architect's private room"

    def test_non_owner_cannot_get_scene(self, tok_contrib, owned_room):
        r = requests.get(f"{API}/rooms/{owned_room}/scene", headers=_h(tok_contrib), timeout=30)
        assert r.status_code == 403

    def test_non_owner_cannot_put_scene(self, tok_contrib, owned_room):
        r = requests.put(f"{API}/rooms/{owned_room}/scene", headers=_h(tok_contrib),
                         json={"room_id": owned_room, "width": 3.6, "depth": 2.5,
                               "ceiling_h": 2.7, "zones": {}, "items": []}, timeout=30)
        assert r.status_code == 403

    def test_non_owner_cannot_delete_room(self, tok_contrib, owned_room):
        r = requests.delete(f"{API}/rooms/{owned_room}", headers=_h(tok_contrib), timeout=30)
        assert r.status_code in (403, 404)


# --------------------------- 2. Sharing panel ---------------------------
class TestSharingPanel:
    def test_list_shares_owner(self, tok_arch, owned_room):
        r = requests.get(f"{API}/rooms/{owned_room}/shares", headers=_h(tok_arch), timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        for k in ("accepted", "pending", "visible_to_org", "owner_org"):
            assert k in j, f"missing {k} in shares response: {j}"

    def test_list_shares_non_owner_forbidden(self, tok_contrib, owned_room):
        r = requests.get(f"{API}/rooms/{owned_room}/shares", headers=_h(tok_contrib), timeout=30)
        assert r.status_code == 403

    def test_invite_accept_revoke_flow(self, tok_arch, tok_ipc, owned_room):
        # 1. Owner creates invite
        inv = requests.post(f"{API}/invites", headers=_h(tok_arch),
                            json={"scope": "room", "scope_id": owned_room, "role": "viewer"},
                            timeout=30)
        assert inv.status_code == 200, inv.text
        token = inv.json()["token"]

        # 2. IPC accepts
        acc = requests.post(f"{API}/invites/accept", headers=_h(tok_ipc),
                            json={"token": token}, timeout=30)
        assert acc.status_code == 200

        # 3. IPC can now read scene
        r = requests.get(f"{API}/rooms/{owned_room}/scene", headers=_h(tok_ipc), timeout=30)
        assert r.status_code == 200

        # 4. Owner lists shares → IPC in accepted
        sh = requests.get(f"{API}/rooms/{owned_room}/shares", headers=_h(tok_arch), timeout=30)
        assert sh.status_code == 200
        ipc_uid = _me(tok_ipc)["id"]
        assert any(a["user_id"] == ipc_uid for a in sh.json()["accepted"]), sh.json()

        # 5. Owner revokes
        rv = requests.delete(f"{API}/rooms/{owned_room}/shares/{ipc_uid}",
                             headers=_h(tok_arch), timeout=30)
        assert rv.status_code == 200

        # 6. IPC loses access
        r2 = requests.get(f"{API}/rooms/{owned_room}/scene", headers=_h(tok_ipc), timeout=30)
        assert r2.status_code == 403
        r3 = requests.put(f"{API}/rooms/{owned_room}/scene", headers=_h(tok_ipc),
                          json={"room_id": owned_room, "width": 3.6, "depth": 2.5,
                                "ceiling_h": 2.7, "zones": {}, "items": []}, timeout=30)
        assert r3.status_code == 403

    def test_revoke_invite_only_creator(self, tok_arch, tok_ipc, owned_room):
        # Owner creates invite
        inv = requests.post(f"{API}/invites", headers=_h(tok_arch),
                            json={"scope": "room", "scope_id": owned_room, "role": "viewer"},
                            timeout=30)
        assert inv.status_code == 200
        invite_id = inv.json()["id"]

        # Different user (IPC) tries to delete → 404 (endpoint filters by invited_by)
        bad = requests.delete(f"{API}/invites/{invite_id}", headers=_h(tok_ipc), timeout=30)
        assert bad.status_code == 404

        # Owner succeeds
        ok = requests.delete(f"{API}/invites/{invite_id}", headers=_h(tok_arch), timeout=30)
        assert ok.status_code == 200


# --------------------------- 3. Org workspaces ---------------------------
class TestOrgWorkspaces:
    ORG = "TEST_Perkins_Will_" + uuid.uuid4().hex[:6]

    def test_org_visibility_toggle_and_readonly(self, tok_arch, tok_contrib):
        # Set same org on both
        _patch_org(tok_arch, self.ORG)
        _patch_org(tok_contrib, self.ORG)
        # Re-login to refresh JWT-carried session (safe)
        arch = _login(*ARCHITECT)
        contrib = _login(*CONTRIB)

        # Owner creates a fresh room (owner_org will snapshot the new org)
        rid = _create_room(arch, f"TEST_org_{uuid.uuid4().hex[:6]}")

        # Before toggle: contrib should NOT see it
        h = requests.get(f"{API}/hierarchy", headers=_h(contrib), timeout=30).json()
        assert rid not in {n["id"] for n in h}

        # Turn org visibility on
        r = requests.patch(f"{API}/rooms/{rid}/visibility", headers=_h(arch),
                           json={"visible_to_org": True}, timeout=30)
        assert r.status_code == 200

        # Now contrib should see it with via_org=True, read_only=True
        h2 = requests.get(f"{API}/hierarchy", headers=_h(contrib), timeout=30).json()
        node = next((n for n in h2 if n["id"] == rid), None)
        assert node is not None, "org peer should now see the room"
        assert node.get("via_org") is True
        assert node.get("read_only") is True

        # GET scene works
        gs = requests.get(f"{API}/rooms/{rid}/scene", headers=_h(contrib), timeout=30)
        assert gs.status_code == 200

        # PUT scene forbidden (read-only for org peers)
        ps = requests.put(f"{API}/rooms/{rid}/scene", headers=_h(contrib),
                          json={"room_id": rid, "width": 3.6, "depth": 2.5,
                                "ceiling_h": 2.7, "zones": {}, "items": []}, timeout=30)
        assert ps.status_code == 403

        # Toggle off → contrib loses access
        r_off = requests.patch(f"{API}/rooms/{rid}/visibility", headers=_h(arch),
                               json={"visible_to_org": False}, timeout=30)
        assert r_off.status_code == 200

        gs2 = requests.get(f"{API}/rooms/{rid}/scene", headers=_h(contrib), timeout=30)
        assert gs2.status_code == 403

        # Cleanup — clear org on both, delete room
        requests.patch(f"{API}/auth/me", headers=_h(arch), json={"organization": ""}, timeout=15)
        requests.patch(f"{API}/auth/me", headers=_h(contrib), json={"organization": ""}, timeout=15)
        requests.delete(f"{API}/rooms/{rid}", headers=_h(arch), timeout=15)

    def test_user_with_different_org_denied(self, tok_arch, tok_ipc):
        _patch_org(tok_arch, "TEST_OrgA_" + uuid.uuid4().hex[:4])
        _patch_org(tok_ipc,  "TEST_OrgB_" + uuid.uuid4().hex[:4])
        arch = _login(*ARCHITECT)
        ipc = _login(*IPC)
        rid = _create_room(arch, f"TEST_diff_org_{uuid.uuid4().hex[:6]}")
        requests.patch(f"{API}/rooms/{rid}/visibility", headers=_h(arch),
                       json={"visible_to_org": True}, timeout=15)
        gs = requests.get(f"{API}/rooms/{rid}/scene", headers=_h(ipc), timeout=30)
        assert gs.status_code == 403
        # cleanup
        requests.patch(f"{API}/auth/me", headers=_h(arch), json={"organization": ""}, timeout=15)
        requests.patch(f"{API}/auth/me", headers=_h(ipc),  json={"organization": ""}, timeout=15)
        requests.delete(f"{API}/rooms/{rid}", headers=_h(arch), timeout=15)


# --------------------------- 4. Room templates ---------------------------
class TestRoomTemplates:
    def _find_representation(self, token: str) -> str | None:
        h = requests.get(f"{API}/hierarchy", headers=_h(token), timeout=30).json()
        reps = [n for n in h if n.get("is_representation")]
        return reps[0]["id"] if reps else None

    def test_representation_exists(self, tok_arch):
        rid = self._find_representation(tok_arch)
        assert rid is not None, "no is_representation utility room found in hierarchy"

    def test_clone_creates_owned_copy_with_items(self, tok_arch):
        rep_id = self._find_representation(tok_arch)
        assert rep_id
        src_scene = requests.get(f"{API}/rooms/{rep_id}/scene", headers=_h(tok_arch), timeout=30).json()
        src_items = len(src_scene.get("items") or [])

        name = f"TEST_clone_{uuid.uuid4().hex[:6]}"
        r = requests.post(f"{API}/rooms/{rep_id}/clone", headers=_h(tok_arch),
                          json={"name": name}, timeout=30)
        assert r.status_code == 200, r.text
        new_room = r.json().get("room") or {}
        new_id = new_room.get("id") or r.json().get("scene_room_id")
        assert new_id
        assert new_room.get("metadata", {}).get("cloned_from") == rep_id

        # appears in hierarchy as mine
        h = requests.get(f"{API}/hierarchy", headers=_h(tok_arch), timeout=30).json()
        mine = next((n for n in h if n["id"] == new_id), None)
        assert mine is not None
        assert mine.get("is_mine") is True

        # item count matches
        new_scene = requests.get(f"{API}/rooms/{new_id}/scene", headers=_h(tok_arch), timeout=30).json()
        assert len(new_scene.get("items") or []) == src_items

        # cleanup
        requests.delete(f"{API}/rooms/{new_id}", headers=_h(tok_arch), timeout=15)

    def test_guest_can_clone_representation(self, tok_arch):
        rep_id = TestRoomTemplates()._find_representation(tok_arch)
        assert rep_id
        gtok, _ = _guest_login()
        r = requests.post(f"{API}/rooms/{rep_id}/clone", headers=_h(gtok),
                          json={"name": f"TEST_guest_clone_{uuid.uuid4().hex[:6]}"}, timeout=30)
        assert r.status_code == 200, r.text
        new_id = (r.json().get("room") or {}).get("id")
        assert new_id
        requests.delete(f"{API}/rooms/{new_id}", headers=_h(gtok), timeout=15)


# --------------------------- 5. Audit log ---------------------------
class TestAuditLog:
    def test_audit_events_full_flow(self, tok_arch, tok_ipc):
        # Fresh room for a clean audit trail
        rid = _create_room(tok_arch, f"TEST_audit_{uuid.uuid4().hex[:6]}")
        try:
            # Trigger events: opened (GET), edited (PUT), invited, visibility, revoked, cloned
            requests.get(f"{API}/rooms/{rid}/scene", headers=_h(tok_arch), timeout=15)
            requests.put(f"{API}/rooms/{rid}/scene", headers=_h(tok_arch),
                         json={"room_id": rid, "width": 3.6, "depth": 2.5,
                               "ceiling_h": 2.7, "zones": {}, "items": []}, timeout=15)
            inv = requests.post(f"{API}/invites", headers=_h(tok_arch),
                                json={"scope": "room", "scope_id": rid, "role": "viewer"}, timeout=15)
            token = inv.json()["token"]
            requests.post(f"{API}/invites/accept", headers=_h(tok_ipc),
                          json={"token": token}, timeout=15)
            requests.patch(f"{API}/rooms/{rid}/visibility", headers=_h(tok_arch),
                           json={"visible_to_org": True}, timeout=15)
            ipc_uid = _me(tok_ipc)["id"]
            requests.delete(f"{API}/rooms/{rid}/shares/{ipc_uid}", headers=_h(tok_arch), timeout=15)
            clone = requests.post(f"{API}/rooms/{rid}/clone", headers=_h(tok_arch),
                                  json={"name": f"TEST_audit_clone_{uuid.uuid4().hex[:6]}"}, timeout=15)
            new_rid = (clone.json().get("room") or {}).get("id")

            time.sleep(0.3)
            r = requests.get(f"{API}/rooms/{rid}/audit", headers=_h(tok_arch), timeout=15)
            assert r.status_code == 200, r.text
            events = r.json()["events"]
            actions = {e["action"] for e in events}
            # 'opened' + 'edited' emitted by scene endpoints; 'invited', 'visibility', 'revoked' emitted here.
            # 'cloned' event is written to the NEW room's audit (source_room_id in meta) — not this one.
            for a in ("invited", "revoked", "visibility"):
                assert a in actions, f"missing '{a}' in audit actions: {actions}"
            # Verify each event has the required fields
            for e in events:
                for k in ("id", "room_id", "actor_id", "actor_email", "action", "meta", "ts"):
                    assert k in e, f"audit event missing field {k}: {e}"

            if new_rid:
                requests.delete(f"{API}/rooms/{new_rid}", headers=_h(tok_arch), timeout=15)
        finally:
            requests.delete(f"{API}/rooms/{rid}", headers=_h(tok_arch), timeout=15)

    def test_audit_non_owner_forbidden(self, tok_arch, tok_contrib, owned_room):
        r = requests.get(f"{API}/rooms/{owned_room}/audit", headers=_h(tok_contrib), timeout=15)
        assert r.status_code == 403

    def test_audit_ttl_index_exists(self):
        """Directly query MongoDB to verify TTL index (30 days) on audit_events.ts."""
        try:
            from pymongo import MongoClient
        except ImportError:
            pytest.skip("pymongo not available")
        mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
        db_name = os.environ.get("DB_NAME", "his_platform")
        client = MongoClient(mongo_url, serverSelectionTimeoutMS=3000)
        idxs = list(client[db_name].audit_events.list_indexes())
        ttl = [i for i in idxs if i.get("expireAfterSeconds") is not None]
        assert ttl, f"no TTL index on audit_events: {idxs}"
        # Check it's on 'ts' and 30 days
        found = False
        for i in ttl:
            keys = list(i.get("key", {}).keys())
            if "ts" in keys and i.get("expireAfterSeconds") == 30 * 24 * 60 * 60:
                found = True
                break
        assert found, f"TTL index found but not (ts, 2592000): {ttl}"
