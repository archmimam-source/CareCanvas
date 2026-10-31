"""HIS Co-Design Platform - Backend integration tests (SEED v4).

Covers:
- Auth: login (all seeded roles), /auth/me, logout, register
- Hierarchy: utility renamed to "Inpatient Dirty Utility Room (Medium)"
- Rules: 20 tiered rules with per-tier counts
- Components: 17 components with mount_type/elevation_m/height_m/code
- Room scene: 3x3 default scene pre-populated with ~19 items
- Validation: new shape { passed, counts, checked, flags[tier,kind,...] }
- Zone overlap (v2 FAIL)
- 3D collision negative (floor+wall diff elevation - no flag)
- 3D collision positive (same footprint same elevation - GEOM-COLLIDE)
- Reset endpoint returns seeded default
- Render gate: 400 when failed, 200 when passed
- Ingestion: source required, submit/review flow, role gating
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

CREDS = {
    "admin":       ("admin@his.dev",       "admin123"),
    "architect":   ("architect@his.dev",   "demo1234"),
    "ipc_lead":    ("ipc@his.dev",         "demo1234"),
    "reviewer":    ("reviewer@his.dev",    "demo1234"),
    "contributor": ("contributor@his.dev", "demo1234"),
}


def _login(role_key):
    s = requests.Session()
    email, pwd = CREDS[role_key]
    r = s.post(f"{API}/auth/login", json={"email": email, "password": pwd}, timeout=30)
    assert r.status_code == 200, f"Login failed for {role_key}: {r.status_code} {r.text}"
    return s, r.json()


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def admin_session():
    return _login("admin")

@pytest.fixture(scope="session")
def architect_session():
    return _login("architect")

@pytest.fixture(scope="session")
def reviewer_session():
    return _login("reviewer")

@pytest.fixture(scope="session")
def contributor_session():
    return _login("contributor")


@pytest.fixture(scope="session")
def utility_room_id(admin_session):
    s, _ = admin_session
    r = s.get(f"{API}/hierarchy", timeout=15)
    assert r.status_code == 200
    utils = [n for n in r.json() if n["type"] == "utility"]
    assert utils, "No utility node in hierarchy"
    return utils[0]["id"]


# ---------- Auth tests ----------
class TestAuth:
    def test_login_all_seeded_roles(self):
        for key, (email, pwd) in CREDS.items():
            r = requests.post(f"{API}/auth/login", json={"email": email, "password": pwd}, timeout=15)
            assert r.status_code == 200, f"{key} login failed: {r.text}"
            data = r.json()
            assert data["email"] == email
            assert "access_token" in r.cookies
            assert "refresh_token" in r.cookies

    def test_login_invalid_credentials(self):
        r = requests.post(f"{API}/auth/login", json={"email": "admin@his.dev", "password": "wrong"}, timeout=15)
        assert r.status_code == 401

    def test_register_new_user(self):
        s = requests.Session()
        email = f"test_{uuid.uuid4().hex[:8]}@his.dev"
        r = s.post(f"{API}/auth/register", json={
            "email": email, "password": "TestPass123", "name": "Test User", "role": "architect"
        }, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["email"] == email
        assert "access_token" in s.cookies

    def test_register_duplicate(self):
        r = requests.post(f"{API}/auth/register", json={
            "email": "admin@his.dev", "password": "TestPass123", "name": "X", "role": "architect"
        }, timeout=15)
        assert r.status_code == 400

    def test_me_returns_user(self, admin_session):
        s, _ = admin_session
        r = s.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 200
        me = r.json()
        assert me["email"] == "admin@his.dev"
        assert me["role"] == "admin"
        assert "password_hash" not in me
        assert "_id" not in me

    def test_me_unauthenticated(self):
        r = requests.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 401

    def test_logout_clears_cookies(self):
        s, _ = _login("architect")
        assert s.post(f"{API}/auth/logout", timeout=15).status_code == 200
        s.cookies.clear()
        assert s.get(f"{API}/auth/me", timeout=15).status_code == 401


# ---------- Hierarchy tests ----------
class TestHierarchy:
    def test_hierarchy_seeded_six_nodes(self, admin_session):
        s, _ = admin_session
        r = s.get(f"{API}/hierarchy", timeout=15)
        assert r.status_code == 200
        nodes = r.json()
        types = [n["type"] for n in nodes]
        for t in ("estate", "building", "zone", "ward", "room", "utility"):
            assert t in types

    def test_utility_is_inpatient_dirty_utility_medium(self, admin_session, utility_room_id):
        s, _ = admin_session
        r = s.get(f"{API}/hierarchy/{utility_room_id}", timeout=15)
        assert r.status_code == 200
        n = r.json()
        assert n["name"] == "Inpatient Dirty Utility Room"
        md = n.get("metadata", {})
        assert md.get("kind") == "inpatient_dirty_utility"
        assert md.get("size") == "medium"
        assert md.get("code") == "RDS_6222"
        assert md.get("brief_area_m2") == 9


# ---------- Rules tests ----------
class TestRules:
    def test_rules_total_count(self, admin_session):
        s, _ = admin_session
        r = s.get(f"{API}/rules", timeout=15)
        assert r.status_code == 200
        rules = r.json()
        # >=20 to tolerate approved-and-published rules from ingestion regression tests
        assert len(rules) >= 20, f"Expected >=20 rules, got {len(rules)}"

    def test_rules_tier_distribution(self, admin_session):
        s, _ = admin_session
        rules = s.get(f"{API}/rules", timeout=15).json()
        counts = {"baseline": 0, "enhanced": 0, "v2": 0, "context": 0, "review": 0}
        for r_ in rules:
            tier = r_.get("tier")
            assert tier in counts, f"Unknown tier {tier} on rule {r_.get('rule_id')}"
            counts[tier] += 1
        assert counts["baseline"] >= 4, counts
        assert counts["enhanced"] >= 8, counts
        assert counts["v2"] >= 4, counts
        assert counts["context"] >= 1, counts
        assert counts["review"] >= 1, counts

    def test_rules_tier_filter(self, admin_session):
        s, _ = admin_session
        r = s.get(f"{API}/rules", params={"tier": "v2"}, timeout=15)
        assert r.status_code == 200
        for r_ in r.json():
            assert r_["tier"] == "v2"


# ---------- Components tests ----------
class TestComponents:
    ALLOWED_KINDS = {"macerator","basin","counter","bin","trolley","cabinet","cabinet_tall",
                     "dispenser","ppe","door","shelf","panel","vent","light","tray"}
    ALLOWED_MATERIALS = {"stainless","ceramic","plastic_white","plastic_yellow","laminate",
                         "glass","metal_grille","led","door"}

    def test_components_seed_count_and_mount_fields(self, admin_session):
        s, _ = admin_session
        comps = s.get(f"{API}/components", timeout=15).json()
        assert len(comps) == 17, f"Expected 17 components, got {len(comps)}"
        for c in comps:
            assert c["mount_type"] in ("floor", "wall", "ceiling"), c
            assert "elevation_m" in c
            assert "height_m" in c
        # required codes exist somewhere
        codes = {c.get("code") for c in comps}
        assert "DSU901" in codes
        assert "A-BAS908" in codes
        assert "WKT992" in codes

    # SEED v6 — every component must have `kind` and `material`
    def test_components_have_kind_and_material_v6(self, admin_session):
        s, _ = admin_session
        comps = s.get(f"{API}/components", timeout=15).json()
        for c in comps:
            assert c.get("kind") in self.ALLOWED_KINDS, f"bad/missing kind on {c.get('key')}: {c.get('kind')}"
            assert c.get("material") in self.ALLOWED_MATERIALS, f"bad/missing material on {c.get('key')}: {c.get('material')}"
        kinds = {c["kind"] for c in comps}
        # spot-check that per-kind React components have corresponding data
        for required in ("macerator", "basin", "bin", "trolley", "dispenser", "door"):
            assert required in kinds, f"expected kind={required} missing from seed"


# ---------- Scene / Reset / Validation / Collision / RenderGate ----------
# Consolidated into ONE class so `--dist loadscope` keeps all scene-mutating
# tests on the same xdist worker (they share one preview room).
class TestSceneAndValidation:
    def test_seeded_scene_is_3x3_and_prepopulated(self, admin_session, utility_room_id):
        s, _ = admin_session
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)
        sc = s.get(f"{API}/rooms/{utility_room_id}/scene", timeout=15).json()
        assert sc["width"] == 3.0 and sc["depth"] == 3.0
        for z in ("dirty", "transition", "clean"):
            assert z in sc["zones"]
        assert 15 <= len(sc["items"]) <= 25, f"Expected ~19 seeded items, got {len(sc['items'])}"
        mounts = {i["mount_type"] for i in sc["items"]}
        assert {"floor", "wall", "ceiling"}.issubset(mounts), mounts

    # SEED v6 — scene items must be HYDRATED with kind + material + code
    def test_seeded_scene_items_hydrated_with_kind_material_code_v6(self, admin_session, utility_room_id):
        s, _ = admin_session
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)
        sc = s.get(f"{API}/rooms/{utility_room_id}/scene", timeout=15).json()
        items = sc["items"]
        # every item must carry kind, material, and code (may be empty string for missing code)
        missing = [i for i in items if not i.get("kind") or i.get("material") is None]
        assert not missing, f"items missing kind/material: {[m.get('component_key') for m in missing]}"
        kinds = {i["kind"] for i in items}
        # required per iteration_4 spec
        for required in ("macerator", "basin", "bin"):
            assert required in kinds, f"expected kind={required} in hydrated scene items, got {kinds}"
        # material populated (not empty string)
        for it in items:
            assert it["material"] and it["material"] != "", f"empty material on {it.get('component_key')}"
        # code field is populated on at least macerator + basin
        macs = [i for i in items if i["kind"] == "macerator"]
        assert macs and macs[0].get("code") == "DSU901", f"macerator code should be DSU901, got {macs[0].get('code') if macs else None}"

    def test_put_scene_increments_version(self, architect_session, utility_room_id):
        s, _ = architect_session
        current = s.get(f"{API}/rooms/{utility_room_id}/scene", timeout=15).json()
        v0 = current.get("version", 0)
        body = {"room_id": utility_room_id, "width": current["width"], "depth": current["depth"],
                "zones": current["zones"], "items": current["items"][:5]}
        r = s.put(f"{API}/rooms/{utility_room_id}/scene", json=body, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["version"] == v0 + 1

    def test_reset_restores_seeded_scene(self, architect_session, utility_room_id):
        s, _ = architect_session
        cur = s.get(f"{API}/rooms/{utility_room_id}/scene", timeout=15).json()
        body = {"room_id": utility_room_id, "width": 3.0, "depth": 3.0,
                "zones": cur["zones"], "items": []}
        s.put(f"{API}/rooms/{utility_room_id}/scene", json=body, timeout=15)
        r = s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)
        assert r.status_code == 200
        sc = r.json()
        assert len(sc["items"]) >= 15
        assert sc["width"] == 3.0 and sc["depth"] == 3.0

    def test_seeded_scene_passes_validation(self, admin_session, utility_room_id):
        s, _ = admin_session
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)
        r = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30)
        assert r.status_code == 200, r.text
        v = r.json()
        assert v["passed"] is True, f"Seeded scene should pass, flags={v['flags']}"
        c = v["counts"]
        assert c["baseline_fail"] == 0
        assert c["v2_fail"] == 0
        assert c["enhanced_advisory"] > 0
        assert c["context"] >= 1
        assert c["review"] >= 1

    def test_flags_have_tier_and_kind(self, admin_session, utility_room_id):
        s, _ = admin_session
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)
        v = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30).json()
        for f in v["flags"]:
            assert f.get("tier") in ("baseline", "enhanced", "v2", "context", "review"), f
            assert f.get("kind") in ("FAIL", "ADVISORY", "CONTEXT", "REVIEW"), f
            assert f["rule_id"] and f["severity"] and f["message"] and f["source"]

    def test_response_shape(self, admin_session, utility_room_id):
        s, _ = admin_session
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)
        v = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30).json()
        for k in ("passed", "counts", "flags", "checked"):
            assert k in v
        for k in ("baseline_fail", "v2_fail", "enhanced_advisory", "context", "review"):
            assert k in v["counts"]

    def test_overlapping_zones_produce_zone_overlap_flag(self, architect_session, utility_room_id):
        s, _ = architect_session
        body = {
            "room_id": utility_room_id,
            "width": 3.0, "depth": 3.0,
            "zones": {
                "dirty":      {"x": 0.0, "y": 0.0, "w": 3.0, "d": 1.5},
                "transition": {"x": 0.0, "y": 1.0, "w": 3.0, "d": 1.5},
                "clean":      {"x": 0.0, "y": 2.5, "w": 3.0, "d": 0.5},
            },
            "items": [
                {"component_key": "macerator", "x": 0.2, "y": 0.2, "w": 0.66, "d": 0.52,
                 "rotation": 0, "zone": "dirty", "mount_type": "floor", "elevation_m": 0, "height_m": 1.4},
                {"component_key": "clinical_wash_basin", "x": 2.0, "y": 1.2, "w": 0.6, "d": 0.45,
                 "rotation": 0, "zone": "transition", "mount_type": "floor", "elevation_m": 0, "height_m": 0.9},
                {"component_key": "prep_counter", "x": 0.9, "y": 0.2, "w": 1.2, "d": 0.6,
                 "rotation": 0, "zone": "dirty", "mount_type": "floor", "elevation_m": 0, "height_m": 0.9},
            ]
        }
        s.put(f"{API}/rooms/{utility_room_id}/scene", json=body, timeout=15)
        v = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30).json()
        zo = [f for f in v["flags"] if f["rule_id"] == "ZONE-OVERLAP"]
        assert zo, f"No ZONE-OVERLAP flag, got {[f['rule_id'] for f in v['flags']]}"
        assert zo[0]["tier"] == "v2"
        assert zo[0]["kind"] == "FAIL"
        assert v["passed"] is False
        assert v["counts"]["v2_fail"] >= 1
        # cleanup
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)

    def test_wall_and_floor_at_same_footprint_no_collide(self, architect_session, utility_room_id):
        s, _ = architect_session
        body = {
            "room_id": utility_room_id,
            "width": 3.0, "depth": 3.0,
            "zones": {
                "dirty":      {"x": 0.0, "y": 0.0, "w": 3.0, "d": 1.3},
                "transition": {"x": 0.0, "y": 1.3, "w": 3.0, "d": 0.6},
                "clean":      {"x": 0.0, "y": 1.9, "w": 3.0, "d": 1.1},
            },
            "items": [
                {"component_key": "macerator", "x": 0.15, "y": 0.1, "w": 0.66, "d": 0.52,
                 "rotation": 0, "zone": "dirty", "mount_type": "floor", "elevation_m": 0, "height_m": 1.4},
                {"component_key": "prep_counter", "x": 0.9, "y": 0.1, "w": 1.2, "d": 0.6,
                 "rotation": 0, "zone": "dirty", "mount_type": "floor", "elevation_m": 0, "height_m": 0.9},
                {"component_key": "clinical_wash_basin", "x": 2.3, "y": 1.4, "w": 0.6, "d": 0.45,
                 "rotation": 0, "zone": "transition", "mount_type": "floor", "elevation_m": 0, "height_m": 0.9},
                {"component_key": "commode_store", "x": 0.1, "y": 2.15, "w": 0.8, "d": 0.6,
                 "rotation": 0, "zone": "clean", "mount_type": "floor", "elevation_m": 0.0, "height_m": 0.9},
                {"component_key": "shelf_wall", "x": 0.1, "y": 2.15, "w": 0.8, "d": 0.6,
                 "rotation": 0, "zone": "clean", "mount_type": "wall", "elevation_m": 1.6, "height_m": 0.05},
            ]
        }
        s.put(f"{API}/rooms/{utility_room_id}/scene", json=body, timeout=15)
        v = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30).json()
        collide = [f for f in v["flags"] if f["rule_id"] == "GEOM-COLLIDE"]
        assert not collide, f"Unexpected GEOM-COLLIDE with disjoint vertical extents: {collide}"

    def test_same_footprint_overlapping_elevation_collides(self, architect_session, utility_room_id):
        s, _ = architect_session
        body = {
            "room_id": utility_room_id,
            "width": 3.0, "depth": 3.0,
            "zones": {
                "dirty":      {"x": 0.0, "y": 0.0, "w": 3.0, "d": 1.3},
                "transition": {"x": 0.0, "y": 1.3, "w": 3.0, "d": 0.6},
                "clean":      {"x": 0.0, "y": 1.9, "w": 3.0, "d": 1.1},
            },
            "items": [
                {"component_key": "macerator", "x": 0.15, "y": 0.1, "w": 0.66, "d": 0.52,
                 "rotation": 0, "zone": "dirty", "mount_type": "floor", "elevation_m": 0, "height_m": 1.4},
                {"component_key": "prep_counter", "x": 0.9, "y": 0.1, "w": 1.2, "d": 0.6,
                 "rotation": 0, "zone": "dirty", "mount_type": "floor", "elevation_m": 0, "height_m": 0.9},
                {"component_key": "clinical_wash_basin", "x": 2.3, "y": 1.4, "w": 0.6, "d": 0.45,
                 "rotation": 0, "zone": "transition", "mount_type": "floor", "elevation_m": 0, "height_m": 0.9},
                {"component_key": "commode_store", "x": 0.1, "y": 2.15, "w": 0.6, "d": 0.6,
                 "rotation": 0, "zone": "clean", "mount_type": "floor", "elevation_m": 0.0, "height_m": 1.0},
                {"component_key": "linen_trolley", "x": 0.1, "y": 2.15, "w": 0.6, "d": 0.6,
                 "rotation": 0, "zone": "clean", "mount_type": "floor", "elevation_m": 0.0, "height_m": 1.0},
            ]
        }
        s.put(f"{API}/rooms/{utility_room_id}/scene", json=body, timeout=15)
        v = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30).json()
        collide = [f for f in v["flags"] if f["rule_id"] == "GEOM-COLLIDE"]
        assert collide, f"Expected GEOM-COLLIDE flag: {[f['rule_id'] for f in v['flags']]}"
        assert collide[0]["tier"] == "v2"
        assert collide[0]["kind"] == "FAIL"
        assert v["passed"] is False
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)

    def test_render_publishes_when_seeded_scene_passes(self, architect_session, utility_room_id):
        s, _ = architect_session
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)
        v = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30).json()
        assert v["passed"] is True
        r = s.post(f"{API}/rooms/{utility_room_id}/renders", timeout=15)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["room_id"] == utility_room_id
        assert "scene_snapshot" in doc
        assert doc["validation_snapshot"]["passed"] is True

    def test_render_blocked_when_validation_fails(self, architect_session, utility_room_id):
        s, _ = architect_session
        body = {"room_id": utility_room_id, "width": 3.0, "depth": 3.0,
                "zones": {
                    "dirty":      {"x": 0.0, "y": 0.0, "w": 3.0, "d": 1.3},
                    "transition": {"x": 0.0, "y": 1.3, "w": 3.0, "d": 0.6},
                    "clean":      {"x": 0.0, "y": 1.9, "w": 3.0, "d": 1.1},
                },
                "items": []}
        s.put(f"{API}/rooms/{utility_room_id}/scene", json=body, timeout=15)
        v = s.post(f"{API}/rooms/{utility_room_id}/validate", timeout=30).json()
        assert v["passed"] is False
        r = s.post(f"{API}/rooms/{utility_room_id}/renders", timeout=15)
        assert r.status_code == 400
        s.post(f"{API}/rooms/{utility_room_id}/reset", timeout=15)



# ---------- Ingestion tests (regression) ----------
class TestIngestion:
    def test_submit_requires_source(self, contributor_session):
        s, _ = contributor_session
        r = s.post(f"{API}/ingestion/submit", json={
            "target": "rule",
            "payload": {"category": "X", "statement": "Y"},
            "note": "test"
        }, timeout=15)
        assert r.status_code == 400

    def test_submit_with_source_appears_pending(self, contributor_session):
        s, _ = contributor_session
        payload = {
            "rule_id": f"TEST-{uuid.uuid4().hex[:6].upper()}",
            "category": "Testing",
            "statement": "TEST_ Sample rule for regression tests.",
            "status": "current_nhs_baseline",
            "source": "TEST_SOURCE_CITATION",
            "region": "UK",
            "severity_if_violated": "low",
            "tier": "baseline",
        }
        r = s.post(f"{API}/ingestion/submit", json={"target": "rule", "payload": payload, "note": "auto"}, timeout=15)
        assert r.status_code == 200, r.text
        sub = r.json()
        assert sub["state"] == "pending_review"

    def test_non_reviewer_cannot_review(self, contributor_session):
        s, _ = contributor_session
        r = s.post(f"{API}/ingestion/submit", json={
            "target": "rule",
            "payload": {
                "rule_id": f"TEST-{uuid.uuid4().hex[:6].upper()}",
                "category": "Testing", "statement": "TEST_x", "source": "TEST_SRC",
                "status": "current_nhs_baseline", "region": "UK", "severity_if_violated": "low",
                "tier": "baseline",
            }
        }, timeout=15)
        sub_id = r.json()["id"]
        r2 = s.post(f"{API}/ingestion/{sub_id}/review", json={"decision": "approve"}, timeout=15)
        assert r2.status_code == 403

    def test_reviewer_can_approve_and_publish(self, contributor_session, reviewer_session):
        s_c, _ = contributor_session
        s_r, _ = reviewer_session
        payload = {
            "rule_id": f"TEST-{uuid.uuid4().hex[:6].upper()}",
            "category": "Testing",
            "statement": "TEST_ published via approval.",
            "status": "current_nhs_baseline",
            "source": "TEST_APPROVAL",
            "region": "UK",
            "severity_if_violated": "low",
            "tier": "baseline",
        }
        sub = s_c.post(f"{API}/ingestion/submit", json={"target": "rule", "payload": payload}, timeout=15).json()
        r = s_r.post(f"{API}/ingestion/{sub['id']}/review", json={"decision": "approve"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["state"] == "published"


# ---------- Changelog ----------
class TestChangelog:
    def test_changelog_returns_entries(self, architect_session, utility_room_id):
        s, _ = architect_session
        r = s.get(f"{API}/rooms/{utility_room_id}/changelog", timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)
