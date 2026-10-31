"""Iteration 9 — refactor + polish tests.

Covers:
- Split: seed_data.py present with 17 components + 20 rules.
- Prompt snapshot: /render-ai stores full `prompt` (long) + `prompt_preview[:1500]`.
- Auto-gen on publish: /rooms/{id}/renders triggers BG enhanced render (auto=True).
"""
from pathlib import Path
import os, time
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

ARCH = ("architect@his.dev", "demo1234")


@pytest.fixture(scope="module")
def arch_session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": ARCH[0], "password": ARCH[1]}, timeout=30)
    assert r.status_code == 200
    return s


@pytest.fixture(scope="module")
def util_id(arch_session):
    r = arch_session.get(f"{API}/hierarchy", timeout=15)
    utils = [n for n in r.json() if n["type"] == "utility"]
    assert utils
    return utils[0]["id"]


# ---------- SPLIT / seed_data ----------
class TestSeedDataSplit:
    def test_seed_data_module_importable(self):
        """seed_data.py exists and exposes get_components() + get_rules()."""
        import sys, importlib
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        mod = importlib.import_module("seed_data")
        C = mod.get_components()
        R = mod.get_rules()
        assert isinstance(C, list) and len(C) == 17, f"seed_data.get_components() must return 17 items, got {len(C)}"
        assert isinstance(R, list) and len(R) == 20, f"seed_data.get_rules() must return 20 items, got {len(R)}"

    def test_components_endpoint_returns_17(self, arch_session):
        r = arch_session.get(f"{API}/components", timeout=15)
        assert r.status_code == 200
        assert len(r.json()) == 17, f"expected 17 components, got {len(r.json())}"

    def test_rules_endpoint_returns_20(self, arch_session):
        r = arch_session.get(f"{API}/rules", timeout=15)
        assert r.status_code == 200
        # >=20 to tolerate approved-and-published rules from ingestion regression tests
        assert len(r.json()) >= 20, f"expected >=20 rules, got {len(r.json())}"


# ---------- PROMPT SNAPSHOT ----------
class TestPromptSnapshot:
    def test_full_prompt_stored_and_longer_than_preview(self, arch_session, util_id):
        arch_session.post(f"{API}/rooms/{util_id}/reset", timeout=30)
        r = arch_session.post(f"{API}/rooms/{util_id}/render-ai", timeout=120)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert "prompt" in doc, f"prompt missing from render-ai doc: {list(doc.keys())}"
        assert "prompt_preview" in doc
        p = doc["prompt"]
        pp = doc["prompt_preview"]
        assert isinstance(p, str) and len(p) > 0
        assert isinstance(pp, str) and len(pp) > 0
        # Preview must be a strict prefix of the full prompt
        assert p.startswith(pp), "prompt_preview should be a prefix of full prompt"
        # Preview is capped at 1500 chars — full scene prompt should exceed this.
        assert len(pp) <= 1500, f"prompt_preview should be capped at 1500, got {len(pp)}"
        assert len(p) >= 1500, f"full prompt seems short ({len(p)} chars); expected >=1500"
        # Full prompt should be strictly longer than the 1500-char preview
        # (a fully seeded scene composes ~2000+ chars).
        assert len(p) > len(pp), "prompt should be longer than prompt_preview for seeded scene"

    def test_prompt_visible_via_ai_renders_listing(self, arch_session, util_id):
        r = arch_session.get(f"{API}/rooms/{util_id}/ai-renders", timeout=15)
        assert r.status_code == 200
        docs = r.json()
        assert len(docs) >= 1
        latest = docs[0]
        assert "prompt" in latest and isinstance(latest["prompt"], str) and len(latest["prompt"]) > 0
        assert "prompt_preview" in latest


# ---------- AUTO-GENERATION ON PUBLISH ----------
class TestAutoGenerateOnPublish:
    def test_publish_triggers_bg_enhanced_render(self, arch_session, util_id):
        # Reset and bump scene version enough times that we land on a version with no
        # existing ai_render (BG task short-circuits when one already exists for this ver).
        arch_session.post(f"{API}/rooms/{util_id}/reset", timeout=30)
        scene = arch_session.get(f"{API}/rooms/{util_id}/scene", timeout=15).json()

        existing_docs = arch_session.get(f"{API}/rooms/{util_id}/ai-renders", timeout=15).json()
        existing_versions = {d.get("scene_version") for d in existing_docs}

        # Perform successive PUTs to advance the scene version past any pre-existing ai_render
        v_new = scene["version"]
        for _ in range(6):
            if v_new not in existing_versions:
                break
            items = list(scene["items"])
            if items:
                items[0] = {**items[0], "x": max(0.0, items[0]["x"] + 0.01)}
            body = {"room_id": util_id, "width": scene["width"], "depth": scene["depth"],
                    "zones": scene["zones"], "items": items}
            r_put = arch_session.put(f"{API}/rooms/{util_id}/scene", json=body, timeout=15)
            assert r_put.status_code == 200
            v_new = r_put.json()["version"]
            scene["items"] = items
        assert v_new not in existing_versions, (
            f"could not advance to a fresh scene version; existing={existing_versions}, v_new={v_new}"
        )

        # Validate & publish
        v = arch_session.post(f"{API}/rooms/{util_id}/validate", timeout=30)
        assert v.status_code == 200 and v.json()["passed"]

        # Publish — POST returns fast; BG kicks off enhanced render
        t0 = time.time()
        r = arch_session.post(f"{API}/rooms/{util_id}/renders", timeout=15)
        publish_elapsed = time.time() - t0
        assert r.status_code == 200, r.text
        # Publish itself must not block on image gen; allow generous 15s
        assert publish_elapsed < 15, f"publish took {publish_elapsed:.1f}s (should be fast)"

        # Poll ai-renders for up to ~90s for the auto=True doc matching v_new
        deadline = time.time() + 90
        auto_doc = None
        while time.time() < deadline:
            docs = arch_session.get(f"{API}/rooms/{util_id}/ai-renders", timeout=15).json()
            matches = [d for d in docs
                       if d.get("auto") is True and d.get("scene_version") == v_new]
            if matches:
                auto_doc = matches[0]
                break
            time.sleep(5)

        assert auto_doc is not None, (
            f"No auto=True enhanced render with scene_version={v_new} appeared within 90s. "
            f"Publish is expected to schedule _generate_enhanced_render_bg()."
        )
        # Verify snapshot fields
        assert auto_doc["type"] == "enhanced"
        assert auto_doc["url"].startswith("/api/ai-renders/") and auto_doc["url"].endswith(".png")
        assert "prompt" in auto_doc and len(auto_doc["prompt"]) > 0
        assert "prompt_preview" in auto_doc
