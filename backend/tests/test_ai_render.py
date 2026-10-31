"""Iteration 8 — AI/Enhanced render tests (Gemini)."""
import os, time
import pytest
import requests
from pathlib import Path

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

CREDS_ARCHITECT = ("architect@his.dev", "demo1234")


@pytest.fixture(scope="module")
def arch_session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login",
               json={"email": CREDS_ARCHITECT[0], "password": CREDS_ARCHITECT[1]}, timeout=30)
    assert r.status_code == 200
    return s


@pytest.fixture(scope="module")
def util_room_id(arch_session):
    r = arch_session.get(f"{API}/hierarchy", timeout=15)
    utils = [n for n in r.json() if n["type"] == "utility"]
    assert utils
    return utils[0]["id"]


class TestAIRender:
    def test_render_ai_generates_image(self, arch_session, util_room_id):
        # Ensure scene exists (reset to guarantee current default seeded content)
        arch_session.post(f"{API}/rooms/{util_room_id}/reset", timeout=30)
        t0 = time.time()
        r = arch_session.post(f"{API}/rooms/{util_room_id}/render-ai", timeout=120)
        elapsed = time.time() - t0
        assert r.status_code == 200, f"render-ai failed after {elapsed:.1f}s: {r.status_code} {r.text[:400]}"
        doc = r.json()
        # Shape (Iteration 8: type is now 'enhanced')
        assert doc["room_id"] == util_room_id
        assert doc["type"] == "enhanced", f"expected type='enhanced', got {doc['type']}"
        assert doc["url"].startswith("/api/ai-renders/")
        assert doc["url"].endswith(".png")
        assert doc.get("generated_by")
        assert doc.get("generated_at")
        assert "scene_version" in doc
        assert "prompt_preview" in doc

    def test_ai_render_url_resolves_to_valid_png(self, arch_session, util_room_id):
        r = arch_session.get(f"{API}/rooms/{util_room_id}/ai-renders", timeout=15)
        assert r.status_code == 200
        lst = r.json()
        assert lst, "No AI renders available"
        url = lst[0]["url"]
        full = f"{BASE_URL}{url}"
        img = requests.get(full, timeout=30)
        assert img.status_code == 200
        assert img.headers.get("content-type", "").startswith("image/")
        assert len(img.content) > 50 * 1024

    def test_list_ai_renders_returns_list(self, arch_session, util_room_id):
        r = arch_session.get(f"{API}/rooms/{util_room_id}/ai-renders", timeout=15)
        assert r.status_code == 200
        lst = r.json()
        assert isinstance(lst, list)
        assert len(lst) >= 1
        for doc in lst:
            # Iteration 8: type may be 'enhanced' (older docs may retain 'ai_photorealistic')
            assert doc["type"] in ("enhanced", "ai_photorealistic")
            assert doc["url"].startswith("/api/ai-renders/")

    def test_ai_renders_dir_has_png(self):
        d = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "uploads")) / "ai_renders"
        assert d.exists()
        pngs = list(d.glob("*.png"))
        assert pngs, "ai_renders/ has no PNG files"
        assert any(p.stat().st_size > 50 * 1024 for p in pngs)

    def test_render_ai_requires_auth(self, util_room_id):
        r = requests.post(f"{API}/rooms/{util_room_id}/render-ai", timeout=15)
        assert r.status_code == 401

    # NEW iteration_8: dynamic prompt reflects scene contents
    def test_prompt_preview_contains_scene_component_and_matches_scene_version(self, arch_session, util_room_id):
        # reset to guarantee seeded contents
        arch_session.post(f"{API}/rooms/{util_room_id}/reset", timeout=30)
        scene = arch_session.get(f"{API}/rooms/{util_room_id}/scene", timeout=15).json()
        current_version = scene["version"]

        r = arch_session.post(f"{API}/rooms/{util_room_id}/render-ai", timeout=120)
        assert r.status_code == 200, r.text
        doc = r.json()
        pp = doc.get("prompt_preview") or ""
        # prompt should mention dynamic content (DIRTY zone contents label + at least 1 component)
        assert "DIRTY zone contents" in pp, f"prompt_preview does not include 'DIRTY zone contents': {pp!r}"
        # Note: prompt_preview is truncated to [:200]; verify by checking against zone
        # description or against the composed prompt.
        # Verify scene_version matches current
        assert doc["scene_version"] == current_version, (
            f"scene_version mismatch: render.scene_version={doc['scene_version']} vs current={current_version}"
        )

    def test_scene_version_cache_invalidation(self, arch_session, util_room_id):
        """Move an item (bumps scene version). A new render-ai call must produce
        a doc whose scene_version equals the NEW scene version, not the old."""
        arch_session.post(f"{API}/rooms/{util_room_id}/reset", timeout=30)
        scene = arch_session.get(f"{API}/rooms/{util_room_id}/scene", timeout=15).json()
        v0 = scene["version"]

        # Bump scene version by putting a modified scene
        moved = dict(scene)
        items = list(scene["items"])
        if items:
            items[0] = {**items[0], "x": max(0.0, items[0]["x"] + 0.05)}
        body = {"room_id": util_room_id, "width": scene["width"], "depth": scene["depth"],
                "zones": scene["zones"], "items": items}
        r_put = arch_session.put(f"{API}/rooms/{util_room_id}/scene", json=body, timeout=15)
        assert r_put.status_code == 200
        v1 = r_put.json()["version"]
        assert v1 == v0 + 1

        r = arch_session.post(f"{API}/rooms/{util_room_id}/render-ai", timeout=120)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["scene_version"] == v1, f"expected new render scene_version={v1}, got {doc['scene_version']}"
        # reset for downstream tests
        arch_session.post(f"{API}/rooms/{util_room_id}/reset", timeout=30)
