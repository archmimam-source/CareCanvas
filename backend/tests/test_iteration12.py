"""Iteration 12 tests:
- Render publish should succeed when baseline_fail==0 even if v2_fail>0.
- DELETE /api/rooms/{room_id} cleans up utility rooms and returns deleted counts.
"""
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")
API = f"{BASE_URL}/api"

CREDS = {"email": "architect@his.dev", "password": "demo1234"}


@pytest.fixture(scope="module")
def auth_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json=CREDS, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    # attach JWT for browsers that block cookies
    s.headers["Authorization"] = f"Bearer {data['token']}"
    return s


@pytest.fixture(scope="module")
def seeded_inpatient_room(auth_session):
    """Find the seeded inpatient dirty utility room (kind=inpatient_dirty_utility)."""
    r = auth_session.get(f"{API}/hierarchy", timeout=15)
    assert r.status_code == 200, r.text
    nodes = r.json()
    room = next((n for n in nodes
                 if n.get("type") == "utility"
                 and (n.get("metadata") or {}).get("kind") == "inpatient_dirty_utility"), None)
    if not room:
        pytest.skip("Seeded inpatient_dirty_utility room not present in hierarchy")
    return room


# ---------- Render publish (bug fix) ----------
class TestRenderPublish:

    def test_validate_then_publish_render_succeeds_when_baseline_fail_zero(
            self, auth_session, seeded_inpatient_room):
        room_id = seeded_inpatient_room["id"]

        # Ensure the scene exists (auto-seeded on first GET)
        gs = auth_session.get(f"{API}/rooms/{room_id}/scene", timeout=15)
        assert gs.status_code == 200

        # Run validation
        v = auth_session.post(f"{API}/rooms/{room_id}/validate", timeout=30)
        assert v.status_code == 200, v.text
        val = v.json()
        counts = val.get("counts") or {}
        print(f"Validation counts: {counts}")

        # We expect baseline_fail==0 on this seeded scene per the review request.
        assert counts.get("baseline_fail", 0) == 0, (
            f"Precondition: seeded scene should have baseline_fail=0 (got {counts}). "
            "If this fails, the seed data has drifted."
        )

        # The whole point of the fix: publish should return 200 even when v2_fail > 0.
        r = auth_session.post(f"{API}/rooms/{room_id}/renders", timeout=30)
        assert r.status_code == 200, (
            f"Expected 200 with baseline_fail=0 and v2_fail={counts.get('v2_fail')}, "
            f"got {r.status_code}: {r.text}"
        )
        doc = r.json()
        assert "id" in doc
        assert doc.get("room_id") == room_id
        assert "scene_snapshot" in doc
        assert "validation_snapshot" in doc

        # Verify the render is now listed
        lst = auth_session.get(f"{API}/rooms/{room_id}/renders", timeout=15)
        assert lst.status_code == 200
        assert any(rr["id"] == doc["id"] for rr in lst.json())


# ---------- Delete room (new feature) ----------
class TestDeleteRoom:

    def test_create_then_delete_room_returns_deleted_counts(self, auth_session):
        # 1. Create throwaway utility room
        payload = {
            "name": f"TEST_delete_{uuid.uuid4().hex[:8]}",
            "kind": "clean_utility",
            "width": 3.0,
            "depth": 3.0,
            "risk_rating": "medium",
        }
        cr = auth_session.post(f"{API}/rooms", json=payload, timeout=15)
        assert cr.status_code == 200, cr.text
        created = cr.json()
        room_id = created["room"]["id"]

        # Confirm it shows up in hierarchy
        h = auth_session.get(f"{API}/hierarchy", timeout=15).json()
        assert any(n["id"] == room_id for n in h)

        # Optional: trigger extra data so counts include multiple collections
        auth_session.get(f"{API}/rooms/{room_id}/scene", timeout=15)
        auth_session.post(f"{API}/rooms/{room_id}/validate", timeout=30)

        # 2. Delete it
        d = auth_session.delete(f"{API}/rooms/{room_id}", timeout=15)
        assert d.status_code == 200, d.text
        body = d.json()
        assert body.get("ok") is True
        assert body.get("id") == room_id
        deleted = body.get("deleted") or {}
        assert isinstance(deleted, dict)
        # Must at least have deleted the hierarchy node and the scene
        assert deleted.get("hierarchy", 0) == 1, deleted
        assert deleted.get("scene", 0) >= 1, deleted
        # Fields must be present for other collections too
        for k in ("validations", "changelog", "renders", "ai_renders",
                  "ai_recommendations", "ai_chat_messages"):
            assert k in deleted, f"missing key '{k}' in deleted counts: {deleted}"

        # 3. Verify gone from hierarchy
        h2 = auth_session.get(f"{API}/hierarchy", timeout=15).json()
        assert not any(n["id"] == room_id for n in h2)

    def test_delete_nonexistent_room_returns_404(self, auth_session):
        r = auth_session.delete(f"{API}/rooms/does-not-exist-{uuid.uuid4().hex[:6]}", timeout=15)
        assert r.status_code == 404, r.text

    def test_delete_non_utility_room_returns_400(self, auth_session):
        h = auth_session.get(f"{API}/hierarchy", timeout=15).json()
        non_utility = next((n for n in h if n.get("type") != "utility"), None)
        if not non_utility:
            pytest.skip("No non-utility node in hierarchy to test guard")
        r = auth_session.delete(f"{API}/rooms/{non_utility['id']}", timeout=15)
        assert r.status_code == 400, r.text
