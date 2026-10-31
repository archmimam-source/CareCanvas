"""
Iteration 16 — Orientation metadata + HMAC-SHA256 E-Signature workflow

Covers:
- GET /api/components — orientation metadata on 12+ component kinds
    (macerator, basin, cabinet, cabinet_tall, bin, dispenser, ppe, door,
     vent, light, trolley, socket)
- Backend regression: SEED_VERSION bumped to 14, GEOM-POLY still present,
  /rooms/{id}/validate still returns flow_paths.
- POST /api/estate/derogation-report/sign        (create signature)
- GET  /api/estate/derogation-report/signatures  (list, sorted desc)
- POST /api/estate/derogation-report/verify      (valid / tampered / not found)
- GET  /api/estate/derogation-report.pdf?signature_id=<id>   (embeds signature)
- GET  /api/estate/derogation-report.xlsx?signature_id=<id>  (adds Signature sheet)
- Empty-result-set signing works (row_count = 0).
- Re-signing appends new records; each remains verifiable.
"""
from pathlib import Path
import os
import re
import io
import uuid
import base64
import pytest
import requests
from zipfile import ZipFile

def _load_frontend_env():
    try:
        with open(str(Path(__file__).resolve().parents[2] / "frontend" / ".env")) as f:
            for ln in f:
                if ln.startswith("REACT_APP_BACKEND_URL"):
                    return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _load_frontend_env()).rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL not set"
API = f"{BASE_URL}/api"


# ---------- fixtures ---------------------------------------------------------
@pytest.fixture(scope="module")
def guest_session():
    """Guest login — role=architect (can POST derogations, sign, verify)."""
    s = requests.Session()
    gid = f"iter16_{uuid.uuid4().hex[:10]}"
    r = s.post(f"{API}/auth/guest", json={"guest_id": gid})
    assert r.status_code == 200, r.text
    j = r.json()
    s.headers.update({
        "Authorization": f"Bearer {j['token']}",
        "Content-Type": "application/json",
    })
    s._user_email = j["email"]
    return s


@pytest.fixture(scope="module")
def reviewer_session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login",
               json={"email": "reviewer@his.dev", "password": "demo1234"})
    if r.status_code != 200:
        r = s.post(f"{API}/auth/login",
                   json={"email": "admin@his.dev", "password": "admin123"})
    assert r.status_code == 200, f"reviewer/admin login failed: {r.text}"
    j = r.json()
    s.headers.update({
        "Authorization": f"Bearer {j['token']}",
        "Content-Type": "application/json",
    })
    return s


@pytest.fixture(scope="module")
def hierarchy(guest_session):
    r = guest_session.get(f"{API}/hierarchy")
    assert r.status_code == 200
    nodes = r.json()
    return {"nodes": nodes, "by_id": {n["id"]: n for n in nodes}}


# ---------------------------------------------------------------------------
# Orientation metadata on /api/components
# ---------------------------------------------------------------------------
class TestOrientationMetadata:
    @pytest.fixture(scope="class")
    def components_by_kind(self, guest_session):
        r = guest_session.get(f"{API}/components")
        assert r.status_code == 200, r.text
        comps = r.json()
        assert isinstance(comps, list) and len(comps) > 0
        return {c["kind"]: c for c in comps if "kind" in c}

    def test_expected_kinds_have_orientation(self, components_by_kind):
        expected = ["macerator", "basin", "cabinet", "cabinet_tall", "bin",
                    "dispenser", "ppe", "door", "vent", "light", "trolley", "socket"]
        missing = [k for k in expected
                   if k not in components_by_kind
                   or not components_by_kind[k].get("orientation")]
        assert not missing, f"missing orientation on kinds: {missing}"

    def test_orientation_shape(self, components_by_kind):
        """Each face → list of {key, kind, label} (position_hint optional)."""
        allowed_faces = {"front", "back", "left", "right", "top", "bottom"}
        for kind, comp in components_by_kind.items():
            o = comp.get("orientation")
            if not o:
                continue
            assert isinstance(o, dict), f"{kind}.orientation not a dict"
            for face, items in o.items():
                assert face in allowed_faces, f"{kind}: bad face {face}"
                assert isinstance(items, list) and items, \
                    f"{kind}.{face} must be a non-empty list"
                for it in items:
                    for req in ("key", "kind", "label"):
                        assert req in it and it[req], \
                            f"{kind}.{face} entry missing {req}: {it}"

    def test_macerator_front_has_lcd_and_footpedal(self, components_by_kind):
        m = components_by_kind["macerator"]
        front = m["orientation"]["front"]
        assert len(front) >= 5, f"expected ≥5 front entries, got {len(front)}"
        keys = {e["key"] for e in front}
        assert "lcd_panel" in keys and "foot_pedal" in keys

    def test_macerator_top_has_exhaust_vent(self, components_by_kind):
        top = components_by_kind["macerator"]["orientation"]["top"]
        assert any(e["key"] == "exhaust_vent" for e in top)

    def test_macerator_back_has_water_and_drain(self, components_by_kind):
        back = components_by_kind["macerator"]["orientation"]["back"]
        keys = {e["key"] for e in back}
        assert "water_inlet" in keys and "drain_outlet" in keys

    def test_basin_top_has_sensor_tap(self, components_by_kind):
        top = components_by_kind["basin"]["orientation"]["top"]
        assert any(e["key"] == "sensor_tap" for e in top)

    def test_bin_front_has_foot_pedal(self, components_by_kind):
        front = components_by_kind["bin"]["orientation"]["front"]
        assert any(e["key"] == "foot_pedal" for e in front)

    def test_door_front_has_card_reader(self, components_by_kind):
        front = components_by_kind["door"]["orientation"]["front"]
        assert any(e["key"] == "card_reader" for e in front)


# ---------------------------------------------------------------------------
# Iteration-14 / regression
# ---------------------------------------------------------------------------
class TestRegression:
    def test_seed_version_is_14(self, guest_session):
        r = guest_session.get(f"{BASE_URL}/api/")
        assert r.status_code == 200
        assert r.json().get("seed_version") == 14

    def test_geom_poly_rule_seeded(self, guest_session):
        r = guest_session.get(f"{API}/rules")
        assert r.status_code == 200
        rule = next((x for x in r.json() if x.get("rule_id") == "GEOM-POLY"), None)
        assert rule is not None, "GEOM-POLY rule missing"
        assert rule.get("tier") == "baseline"

    def test_validate_returns_flow_paths(self, guest_session, hierarchy):
        util = next((n for n in hierarchy["nodes"] if n.get("type") == "utility"), None)
        assert util
        r = guest_session.post(f"{API}/rooms/{util['id']}/validate")
        assert r.status_code == 200
        fp = r.json().get("flow_paths")
        assert isinstance(fp, dict)
        for k in ("soiled", "clean_supply", "person", "waste"):
            assert k in fp


# ---------------------------------------------------------------------------
# Sign / list / verify
# ---------------------------------------------------------------------------
class TestSignVerify:
    @pytest.fixture(scope="class")
    def utility_room(self, guest_session):
        r = guest_session.get(f"{API}/hierarchy")
        util = next((n for n in r.json() if n.get("type") == "utility"), None)
        assert util
        return util

    @pytest.fixture(scope="class")
    def created_derog(self, guest_session, reviewer_session, utility_room):
        """Create a fresh derogation so at least 1 row exists in the report."""
        tag = f"TEST_iter16_{uuid.uuid4().hex[:8]}"
        r = guest_session.post(f"{API}/rooms/{utility_room['id']}/derogations", json={
            "rule_id": "ZONE-01",
            "justification": f"{tag} iter16 sign+verify test row",
        })
        assert r.status_code == 200, r.text
        d = r.json()
        # approve so approved_at is populated
        r2 = reviewer_session.patch(
            f"{API}/rooms/{utility_room['id']}/derogations/{d['id']}",
            json={"status": "approved", "reviewer_note": f"{tag} ok"},
        )
        assert r2.status_code == 200
        return {"id": d["id"], "tag": tag, "room_id": utility_room["id"]}

    def test_sign_shape(self, guest_session, created_derog):
        r = guest_session.post(f"{API}/estate/derogation-report/sign")
        assert r.status_code == 200, r.text
        j = r.json()
        for k in ("id", "kind", "signed_by", "signed_at", "row_count",
                  "body_hash", "filter", "token", "user_id"):
            assert k in j, f"sign response missing {k}: {j}"
        assert j["kind"] == "derogation_report"
        assert j["row_count"] >= 1
        assert isinstance(j["body_hash"], str) and len(j["body_hash"]) == 16
        assert isinstance(j["token"], str) and len(j["token"]) > 20
        assert j["filter"] == {"hospital": "", "ward": "", "status": ""}
        # store on class for reuse
        pytest._iter16_sig = j

    def test_signing_empty_result_set_succeeds(self, guest_session):
        # Filter that matches nothing → row_count 0 but still signs.
        r = guest_session.post(
            f"{API}/estate/derogation-report/sign?hospital=__nope__")
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["row_count"] == 0
        assert j["filter"]["hospital"] == "__nope__"
        assert j["token"]
        pytest._iter16_empty_sig = j

    def test_list_signatures_sorted_desc_and_contains_sign(
            self, guest_session):
        r = guest_session.get(f"{API}/estate/derogation-report/signatures")
        assert r.status_code == 200
        docs = r.json()
        assert isinstance(docs, list) and len(docs) >= 2
        # sorted by signed_at desc
        signed_ats = [d["signed_at"] for d in docs]
        assert signed_ats == sorted(signed_ats, reverse=True), \
            "signatures not sorted desc"
        sig = pytest._iter16_sig
        tokens = {d["token"] for d in docs}
        assert sig["token"] in tokens
        # match record shape (same keys as sign returned)
        found = next(d for d in docs if d["token"] == sig["token"])
        for k in ("id", "kind", "signed_by", "signed_at", "row_count",
                  "body_hash", "filter", "token", "user_id"):
            assert k in found

    def test_verify_valid_and_untampered(self, guest_session):
        sig = pytest._iter16_sig
        r = guest_session.post(f"{API}/estate/derogation-report/verify",
                               json={"token": sig["token"]})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["valid"] is True
        assert j["signed_by"] == sig["signed_by"]
        assert j["signed_at"] == sig["signed_at"]
        assert j["row_count_signed"] == sig["row_count"]
        assert j["body_hash_signed"] == sig["body_hash"]
        assert j["body_hash_now"] == sig["body_hash"]
        assert j["tampered"] is False

    def test_verify_detects_tampering(self, guest_session, reviewer_session,
                                       utility_room, created_derog):
        # Snapshot current sig, then mutate the underlying data by creating
        # + approving a new derogation → body_hash_now should differ →
        # tampered = True.
        sig_r = guest_session.post(f"{API}/estate/derogation-report/sign")
        sig = sig_r.json()

        tag = f"TEST_iter16_tamper_{uuid.uuid4().hex[:6]}"
        d = guest_session.post(f"{API}/rooms/{utility_room['id']}/derogations",
                               json={"rule_id": "ZONE-01",
                                     "justification": f"{tag} tamper row"}).json()
        reviewer_session.patch(
            f"{API}/rooms/{utility_room['id']}/derogations/{d['id']}",
            json={"status": "approved", "reviewer_note": f"{tag} ok"})

        r = guest_session.post(f"{API}/estate/derogation-report/verify",
                               json={"token": sig["token"]})
        j = r.json()
        assert j["valid"] is True, f"signature itself must still verify: {j}"
        assert j["body_hash_signed"] == sig["body_hash"]
        assert j["body_hash_now"] != sig["body_hash"], \
            "body_hash_now should differ after adding a row"
        assert j["tampered"] is True

    def test_verify_invalid_token(self, guest_session):
        r = guest_session.post(f"{API}/estate/derogation-report/verify",
                               json={"token": "obviously-garbage-token-xyz"})
        assert r.status_code == 200
        j = r.json()
        assert j["valid"] is False
        assert j.get("reason") == "Signature not found."

    def test_re_sign_creates_new_record_both_verifiable(self, guest_session):
        # Sign twice — signed_at differs so tokens differ; both records must
        # exist and both must independently verify.
        r1 = guest_session.post(f"{API}/estate/derogation-report/sign")
        r2 = guest_session.post(f"{API}/estate/derogation-report/sign")
        assert r1.status_code == 200 and r2.status_code == 200
        sig1, sig2 = r1.json(), r2.json()
        assert sig1["id"] != sig2["id"]
        docs = guest_session.get(
            f"{API}/estate/derogation-report/signatures").json()
        tokens = {d["token"] for d in docs}
        assert sig1["token"] in tokens
        assert sig2["token"] in tokens
        for s in (sig1, sig2):
            v = guest_session.post(f"{API}/estate/derogation-report/verify",
                                   json={"token": s["token"]}).json()
            assert v["valid"] is True, f"re-signed token failed to verify: {s['token']}"


# ---------------------------------------------------------------------------
# Signed PDF / XLSX exports
# ---------------------------------------------------------------------------
class TestSignedExports:
    @pytest.fixture(scope="class")
    def signature(self, guest_session):
        r = guest_session.post(f"{API}/estate/derogation-report/sign")
        assert r.status_code == 200
        return r.json()

    def test_pdf_with_signature_id_embeds_signer(self, guest_session, signature):
        r = guest_session.get(
            f"{API}/estate/derogation-report.pdf",
            params={"signature_id": signature["id"]})
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content.startswith(b"%PDF-")
        # Extract text via pypdf so we're not dependent on how ReportLab
        # encodes each font's content stream.
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(r.content))
        text = ""
        for p in reader.pages:
            text += p.extract_text() or ""
        assert signature["signed_by"] in text, \
            f"signed_by not found in PDF text: {signature['signed_by']}"
        assert signature["token"] in text, \
            f"signature token not found in PDF text: {signature['token']}"
        # Also assert the human-readable footer label is present.
        assert "Digitally signed" in text

    def test_xlsx_with_signature_id_has_signature_sheet(
            self, guest_session, signature):
        r = guest_session.get(
            f"{API}/estate/derogation-report.xlsx",
            params={"signature_id": signature["id"]})
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        assert r.content[:2] == b"PK"

        # Peek inside the zip → sheet names live in workbook.xml
        with ZipFile(io.BytesIO(r.content)) as z:
            names = z.namelist()
            assert "xl/workbook.xml" in names
            wb_xml = z.read("xl/workbook.xml").decode("utf-8", errors="ignore")
            assert "Signature" in wb_xml, "Signature sheet missing in workbook"
            assert "Derogations" in wb_xml, "Derogations sheet missing"

            # Signature sheet is typically sheet2.xml (second in order)
            # — just scan every sheet .xml for the required rows.
            sheet_files = [n for n in names if n.startswith("xl/worksheets/sheet")]
            all_sheet_text = ""
            for s in sheet_files:
                all_sheet_text += z.read(s).decode("utf-8", errors="ignore")
            # Also inspect the shared strings table (openpyxl usually inlines
            # short strings but may use sharedStrings on save).
            shared = ""
            if "xl/sharedStrings.xml" in names:
                shared = z.read("xl/sharedStrings.xml").decode("utf-8", errors="ignore")
            combined = all_sheet_text + shared
            for token_txt in ("Signed by", "Signature", "Body hash"):
                assert token_txt in combined, \
                    f"'{token_txt}' row missing in workbook payload"

    def test_pdf_without_signature_id_still_works(self, guest_session):
        r = guest_session.get(f"{API}/estate/derogation-report.pdf")
        assert r.status_code == 200
        assert r.content.startswith(b"%PDF-")
