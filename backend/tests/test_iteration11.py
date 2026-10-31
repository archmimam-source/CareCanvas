"""Iteration 11 tests — new endpoints for:
- Clear changelog: DELETE /api/rooms/{room_id}/changelog
- Clear renders: DELETE /api/rooms/{room_id}/renders
- Create utility room: POST /api/rooms
- AI recommendations: POST /api/rooms/{room_id}/ai/recommendations
- AI chat (multi-turn): POST /api/rooms/{room_id}/ai/chat + GET/DELETE history
- Utility renamed to "Inpatient Dirty Utility Room" (without "(Medium)")
"""
import os
import uuid
import time
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"


def _login(email, password):
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, r.text
    return s


@pytest.fixture(scope="module")
def sess():
    return _login("architect@his.dev", "demo1234")


@pytest.fixture(scope="module")
def util_id(sess):
    r = sess.get(f"{API}/hierarchy", timeout=15)
    assert r.status_code == 200
    utils = [n for n in r.json() if n["type"] == "utility" and "Inpatient" in n["name"]]
    assert utils, "seeded inpatient utility not found"
    return utils[0]["id"]


# ---------- Rename ----------
class TestRename:
    def test_utility_name_no_medium(self, sess, util_id):
        r = sess.get(f"{API}/hierarchy/{util_id}", timeout=15)
        assert r.status_code == 200
        n = r.json()
        assert n["name"] == "Inpatient Dirty Utility Room", f"Got name: {n['name']!r}"
        # metadata still holds size and code
        md = n.get("metadata", {})
        assert md.get("code") == "RDS_6222"
        assert md.get("brief_area_m2") == 9


# ---------- Clear Changelog ----------
class TestClearChangelog:
    def test_clear_changelog_returns_ok_and_empties_list(self, sess, util_id):
        # Ensure at least one entry: run a Save
        sc = sess.get(f"{API}/rooms/{util_id}/scene", timeout=15).json()
        body = {"room_id": util_id, "width": sc["width"], "depth": sc["depth"],
                "zones": sc["zones"], "items": sc["items"]}
        sess.put(f"{API}/rooms/{util_id}/scene", json=body, timeout=15)
        # Verify there is at least 1
        cl = sess.get(f"{API}/rooms/{util_id}/changelog", timeout=15).json()
        assert len(cl) >= 1
        # Clear
        r = sess.delete(f"{API}/rooms/{util_id}/changelog", timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert j["ok"] is True and j["cleared"] >= 1
        # After clear, list is empty
        after = sess.get(f"{API}/rooms/{util_id}/changelog", timeout=15).json()
        assert after == []


# ---------- Clear Renders ----------
class TestClearRenders:
    def test_clear_renders_deletes_all(self, sess, util_id):
        # Reset + validate + publish to guarantee a render exists
        sess.post(f"{API}/rooms/{util_id}/reset", timeout=15)
        v = sess.post(f"{API}/rooms/{util_id}/validate", timeout=30).json()
        assert v["passed"] is True
        pub = sess.post(f"{API}/rooms/{util_id}/renders", timeout=30)
        assert pub.status_code == 200, pub.text
        # renders list is non-empty
        rl = sess.get(f"{API}/rooms/{util_id}/renders", timeout=15).json()
        assert len(rl) >= 1
        # Clear
        r = sess.delete(f"{API}/rooms/{util_id}/renders", timeout=30)
        assert r.status_code == 200
        j = r.json()
        assert j["ok"] is True
        assert j["cleared_renders"] >= 1
        # After clear, list is empty
        after = sess.get(f"{API}/rooms/{util_id}/renders", timeout=15).json()
        assert after == []


# ---------- New Room ----------
class TestCreateRoom:
    def test_create_room_defaults_parent_and_blank_scene(self, sess):
        payload = {
            "name": f"TEST_QA Clean Utility {uuid.uuid4().hex[:6]}",
            "kind": "clean_utility",
            "width": 3.0,
            "depth": 3.0,
        }
        r = sess.post(f"{API}/rooms", json=payload, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "room" in body and body["room"]["name"] == payload["name"]
        assert body["room"]["type"] == "utility"
        new_id = body["room"]["id"]
        # Scene should be loadable and blank items
        sc = sess.get(f"{API}/rooms/{new_id}/scene", timeout=15).json()
        assert sc["items"] == []
        assert set(sc["zones"].keys()) == {"dirty", "transition", "clean"}
        # Cleanup
        sess.delete(f"{API}/rooms/{new_id}/renders", timeout=15)
        sess.delete(f"{API}/rooms/{new_id}/changelog", timeout=15)

    def test_create_room_requires_name(self, sess):
        r = sess.post(f"{API}/rooms", json={"width": 3, "depth": 3}, timeout=15)
        assert r.status_code == 422  # Pydantic validation


# ---------- AI Recommendations ----------
class TestAiRecommendations:
    def test_ai_recommendations_returns_three_groups(self, sess, util_id):
        # Ensure scene exists and validation has run
        sess.post(f"{API}/rooms/{util_id}/reset", timeout=15)
        sess.post(f"{API}/rooms/{util_id}/validate", timeout=30)
        r = sess.post(f"{API}/rooms/{util_id}/ai/recommendations", timeout=90)
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("layout_suggestions", "compliance_fixes", "missing_components"):
            assert k in data, f"missing key {k}"
            assert isinstance(data[k], list)
        # Should be scene-anchored
        assert data.get("room_id") == util_id


# ---------- AI Chat multi-turn ----------
class TestAiChat:
    def test_ai_chat_multi_turn_persists_context(self, sess, util_id):
        session_id = f"test-{uuid.uuid4().hex[:8]}"
        # Turn 1
        r1 = sess.post(f"{API}/rooms/{util_id}/ai/chat",
                       json={"session_id": session_id,
                             "message": "My name is TESTER. Please remember it."},
                       timeout=90)
        assert r1.status_code == 200, r1.text
        reply1 = r1.json()["reply"]
        assert isinstance(reply1, str) and len(reply1) > 0
        # Turn 2 — ask it to recall
        r2 = sess.post(f"{API}/rooms/{util_id}/ai/chat",
                       json={"session_id": session_id,
                             "message": "What name did I just give you? Respond in one word."},
                       timeout=90)
        assert r2.status_code == 200, r2.text
        reply2 = r2.json()["reply"]
        # History has 4 messages
        hist = sess.get(f"{API}/rooms/{util_id}/ai/chat/{session_id}", timeout=15).json()
        assert len(hist) == 4
        assert [m["role"] for m in hist] == ["user", "assistant", "user", "assistant"]
        # Cleanup
        d = sess.delete(f"{API}/rooms/{util_id}/ai/chat/{session_id}", timeout=15)
        assert d.status_code == 200
        assert d.json()["cleared"] == 4
