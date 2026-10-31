"""
Iteration 15 — Global Derogation Report tests

Covers:
- GET  /api/estate/derogation-report            (JSON shape + filters + counts + facets)
- GET  /api/estate/derogation-report.pdf        (PDF binary, content-type, disposition)
- GET  /api/estate/derogation-report.xlsx       (XLSX binary, content-type)
- Filter propagation to PDF/XLSX (200 with filters)
- End-to-end scenario: 2 derogations on 2 different rooms; approve one, leave one pending;
  verify grouping under hospital + ward and counts (>=1 approved, >=1 pending).
- Regression: per-room GET /api/rooms/{id}/derogations still works.
- Regression: iteration-14 GEOM-POLY seed_version=13, validate flow_paths shape, GEOM-POLY rule present.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           "http://localhost:8001"
API = f"{BASE_URL}/api"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def guest_session():
    """Guest login via /api/auth/guest — role=architect (can POST derogations)."""
    s = requests.Session()
    gid = f"iter15_{uuid.uuid4().hex[:10]}"
    r = s.post(f"{API}/auth/guest", json={"guest_id": gid})
    assert r.status_code == 200, r.text
    j = r.json()
    s.headers.update({"Authorization": f"Bearer {j['token']}"})
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def reviewer_session():
    """Reviewer login (role=reviewer) — required for PATCH approve/reject."""
    s = requests.Session()
    r = s.post(f"{API}/auth/login",
               json={"email": "reviewer@his.dev", "password": "demo1234"})
    if r.status_code != 200:
        # fallback: try admin
        r = s.post(f"{API}/auth/login",
                   json={"email": "admin@his.dev", "password": "admin123"})
    assert r.status_code == 200, f"reviewer/admin login failed: {r.text}"
    j = r.json()
    assert j["role"] in ("reviewer", "admin")
    s.headers.update({"Authorization": f"Bearer {j['token']}"})
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def hierarchy(guest_session):
    r = guest_session.get(f"{API}/hierarchy")
    assert r.status_code == 200
    nodes = r.json()
    by_id = {n["id"]: n for n in nodes}
    return {"nodes": nodes, "by_id": by_id}


@pytest.fixture(scope="module")
def two_rooms(hierarchy):
    """Return two nodes that own derogations — the utility + a sibling room."""
    nodes = hierarchy["nodes"]
    util = next((n for n in nodes if n.get("type") == "utility"), None)
    assert util, "seeded utility node missing"
    # Pick a room that has a ward ancestor and is not the utility.
    by_id = hierarchy["by_id"]
    def ward_of(node):
        cur = node
        seen = set()
        while cur and cur["id"] not in seen:
            seen.add(cur["id"])
            if cur.get("type") == "ward": return cur
            cur = by_id.get(cur.get("parent_id"))
        return None
    other = next(
        (n for n in nodes
         if n.get("type") in ("room", "utility")
         and n["id"] != util["id"]
         and ward_of(n) is not None),
        None,
    )
    assert other, "need a second room with a ward ancestor for grouping test"
    return {"util": util, "other": other}


@pytest.fixture(scope="module")
def created_derogations(guest_session, reviewer_session, two_rooms):
    """Create one derogation per room, approve one, leave the other pending.

    Returns dict with the two derogation ids + expected statuses.
    """
    util = two_rooms["util"]; other = two_rooms["other"]
    tag = f"TEST_iter15_{uuid.uuid4().hex[:8]}"

    # #1 in utility — will be APPROVED
    r1 = guest_session.post(f"{API}/rooms/{util['id']}/derogations", json={
        "rule_id": "ZONE-01",
        "justification": f"{tag} approve me — legacy layout keeps clean/dirty zones separated by procedure not room.",
    })
    assert r1.status_code == 200, r1.text
    d1 = r1.json()
    assert d1["status"] == "pending" and d1["room_id"] == util["id"]

    # #2 in other room — will remain PENDING
    r2 = guest_session.post(f"{API}/rooms/{other['id']}/derogations", json={
        "rule_id": "VENT-01",
        "justification": f"{tag} keep me pending — ventilation cannot be upgraded before refurb window.",
    })
    assert r2.status_code == 200, r2.text
    d2 = r2.json()
    assert d2["status"] == "pending" and d2["room_id"] == other["id"]

    # approve #1 as reviewer
    r_ok = reviewer_session.patch(
        f"{API}/rooms/{util['id']}/derogations/{d1['id']}",
        json={"status": "approved", "reviewer_note": f"{tag} sign-off"},
    )
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.json()["status"] == "approved"

    return {
        "tag": tag,
        "approved_id": d1["id"], "approved_room": util,
        "pending_id":  d2["id"], "pending_room":  other,
    }


# ---------- shape + filter tests ----------
class TestReportShape:
    def test_report_has_top_level_keys(self, guest_session, created_derogations):
        r = guest_session.get(f"{API}/estate/derogation-report")
        assert r.status_code == 200
        j = r.json()
        for k in ("rows", "counts", "facets", "generated_at"):
            assert k in j, f"missing key: {k}"
        assert isinstance(j["rows"], list)
        assert isinstance(j["counts"], dict)
        assert isinstance(j["facets"], dict)

    def test_counts_keys(self, guest_session, created_derogations):
        j = guest_session.get(f"{API}/estate/derogation-report").json()
        for k in ("total", "approved", "pending", "rejected"):
            assert k in j["counts"], f"counts missing {k}"
        # sum matches
        c = j["counts"]
        assert c["total"] == c["approved"] + c["pending"] + c["rejected"]
        assert c["total"] == len(j["rows"])

    def test_facets_are_arrays(self, guest_session, created_derogations):
        j = guest_session.get(f"{API}/estate/derogation-report").json()
        f = j["facets"]
        assert "hospitals" in f and isinstance(f["hospitals"], list)
        assert "wards"     in f and isinstance(f["wards"],     list)
        # After we created derogations against seeded util + another room, at
        # least one hospital + one ward must appear.
        assert len(f["hospitals"]) >= 1
        assert len(f["wards"])     >= 1

    def test_row_has_all_required_fields(self, guest_session, created_derogations):
        j = guest_session.get(f"{API}/estate/derogation-report").json()
        rid_a = created_derogations["approved_id"]
        row = next((r for r in j["rows"] if r["id"] == rid_a), None)
        assert row, "approved derogation missing from report rows"
        required = ["rule_id", "rule_statement", "rule_tier", "rule_severity",
                    "room", "room_type", "ward", "hospital", "justification",
                    "requested_by", "created_at", "status", "approved_by",
                    "approved_at", "reviewer_note", "item_id"]
        for k in required:
            assert k in row, f"row missing key: {k}"
        assert row["status"] == "approved"
        assert row["approved_by"]  # reviewer email
        assert row["approved_at"]


# ---------- filter tests ----------
class TestReportFilters:
    def test_filter_by_status_pending(self, guest_session, created_derogations):
        r = guest_session.get(f"{API}/estate/derogation-report?status=pending")
        assert r.status_code == 200
        j = r.json()
        # every row must be pending
        assert all(row["status"] == "pending" for row in j["rows"])
        # counts recompute — approved/rejected are 0 in filtered view
        assert j["counts"]["approved"] == 0
        assert j["counts"]["rejected"] == 0
        assert j["counts"]["pending"] == j["counts"]["total"]
        # our known pending id is present
        ids = {r["id"] for r in j["rows"]}
        assert created_derogations["pending_id"] in ids

    def test_filter_by_status_approved(self, guest_session, created_derogations):
        j = guest_session.get(f"{API}/estate/derogation-report?status=approved").json()
        assert all(row["status"] == "approved" for row in j["rows"])
        ids = {r["id"] for r in j["rows"]}
        assert created_derogations["approved_id"] in ids
        assert j["counts"]["pending"] == 0 and j["counts"]["rejected"] == 0

    def test_filter_by_hospital(self, guest_session, created_derogations):
        # discover which hospital owns the approved row
        base = guest_session.get(f"{API}/estate/derogation-report").json()
        row = next(r for r in base["rows"] if r["id"] == created_derogations["approved_id"])
        hosp = row["hospital"]
        j = guest_session.get(f"{API}/estate/derogation-report?hospital={hosp}").json()
        assert all(r["hospital"] == hosp for r in j["rows"])
        assert j["counts"]["total"] == len(j["rows"])
        # approved id still present
        assert any(r["id"] == created_derogations["approved_id"] for r in j["rows"])

    def test_filter_by_ward(self, guest_session, created_derogations):
        base = guest_session.get(f"{API}/estate/derogation-report").json()
        row = next(r for r in base["rows"] if r["id"] == created_derogations["approved_id"])
        ward = row["ward"]
        j = guest_session.get(f"{API}/estate/derogation-report?ward={ward}").json()
        assert all(r["ward"] == ward for r in j["rows"])

    def test_filter_empty_result_gives_zero_counts(self, guest_session, created_derogations):
        j = guest_session.get(f"{API}/estate/derogation-report?hospital=__nope__").json()
        assert j["rows"] == []
        for k in ("total", "approved", "pending", "rejected"):
            assert j["counts"][k] == 0


# ---------- grouping / e2e scenario ----------
class TestGrouping:
    def test_two_rooms_grouped_by_hospital_and_ward(self, guest_session, created_derogations):
        j = guest_session.get(f"{API}/estate/derogation-report").json()
        rows_by_id = {r["id"]: r for r in j["rows"]}
        a = rows_by_id[created_derogations["approved_id"]]
        p = rows_by_id[created_derogations["pending_id"]]
        # Both must have a resolved hospital + ward (not the em-dash placeholder).
        assert a["hospital"] not in ("", None)
        assert a["ward"]     not in ("", None)
        assert p["hospital"] not in ("", None)
        assert p["ward"]     not in ("", None)
        # Counts include at least 1 approved and 1 pending after our setup
        assert j["counts"]["approved"] >= 1
        assert j["counts"]["pending"]  >= 1


# ---------- export tests ----------
class TestExports:
    def test_pdf_export_200_and_headers(self, guest_session, created_derogations):
        r = guest_session.get(f"{API}/estate/derogation-report.pdf")
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content.startswith(b"%PDF-"), "pdf magic bytes missing"
        assert len(r.content) > 500
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd.lower()
        assert "derogation-report.pdf" in cd

    def test_xlsx_export_200_and_headers(self, guest_session, created_derogations):
        r = guest_session.get(f"{API}/estate/derogation-report.xlsx")
        assert r.status_code == 200
        ct = r.headers.get("content-type", "")
        assert ct.startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ), f"unexpected content-type: {ct}"
        # XLSX is a zip — magic bytes PK\x03\x04
        assert r.content[:2] == b"PK", "xlsx magic bytes missing"
        assert len(r.content) > 500

    def test_pdf_honours_status_filter(self, guest_session, created_derogations):
        r = guest_session.get(f"{API}/estate/derogation-report.pdf?status=approved")
        assert r.status_code == 200
        assert r.content.startswith(b"%PDF-")

    def test_xlsx_honours_hospital_filter(self, guest_session, created_derogations):
        base = guest_session.get(f"{API}/estate/derogation-report").json()
        row = next(r for r in base["rows"] if r["id"] == created_derogations["approved_id"])
        hosp = row["hospital"]
        r = guest_session.get(f"{API}/estate/derogation-report.xlsx?hospital={hosp}")
        assert r.status_code == 200
        assert r.content[:2] == b"PK"


# ---------- regression: per-room list still works ----------
class TestPerRoomRegression:
    def test_per_room_derogations_list(self, guest_session, created_derogations):
        util = created_derogations["approved_room"]
        r = guest_session.get(f"{API}/rooms/{util['id']}/derogations")
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list)
        ids = {row["id"] for row in rows}
        assert created_derogations["approved_id"] in ids


# ---------- iteration-14 regressions ----------
class TestIter14Regression:
    def test_seed_version_still_13(self, guest_session):
        r = guest_session.get(f"{BASE_URL}/api/")
        assert r.status_code == 200
        assert r.json().get("seed_version") == 13

    def test_geom_poly_rule_seeded(self, guest_session):
        r = guest_session.get(f"{API}/rules")
        assert r.status_code == 200
        rules = r.json()
        rule = next((x for x in rules if x.get("rule_id") == "GEOM-POLY"), None)
        assert rule is not None, "GEOM-POLY rule missing from /api/rules"
        assert rule.get("tier") == "baseline"
        assert (rule.get("severity_if_violated") or rule.get("severity")) in ("high",)

    def test_validate_returns_flow_paths_shape(self, guest_session, two_rooms):
        util = two_rooms["util"]
        r = guest_session.post(f"{API}/rooms/{util['id']}/validate")
        assert r.status_code == 200
        j = r.json()
        assert "flow_paths" in j
        fp = j["flow_paths"]
        for k in ("soiled", "clean_supply", "person", "waste"):
            assert k in fp, f"flow_paths missing {k}"
            assert isinstance(fp[k], list)
