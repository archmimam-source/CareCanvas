"""PDF Extraction endpoint tests - NEW feature (Gemini 2.5 Flash via GEMINI_API_KEY)."""
import os
import io
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") if os.environ.get("REACT_APP_BACKEND_URL") else "http://localhost:8001"
API = f"{BASE_URL}/api"
PDF_PATH = "/tmp/test_rules.pdf"


def _login(email, pwd):
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": email, "password": pwd}, timeout=30)
    assert r.status_code == 200, r.text
    return s


@pytest.fixture(scope="session")
def architect():
    return _login("architect@his.dev", "demo1234")


class TestPdfExtract:
    """POST /api/ingestion/pdf-extract"""

    def test_non_pdf_rejected(self, architect):
        # Send a .txt file → 400
        files = {"file": ("dummy.txt", io.BytesIO(b"not a pdf"), "text/plain")}
        r = architect.post(f"{API}/ingestion/pdf-extract", files=files, timeout=30)
        assert r.status_code == 400, r.text
        assert "PDF" in r.text or "pdf" in r.text

    def test_oversize_rejected(self, architect):
        # Create a >25MB PDF-named binary payload (just needs .pdf name)
        big = b"%PDF-1.4\n" + (b"A" * (26 * 1024 * 1024))
        files = {"file": ("big.pdf", io.BytesIO(big), "application/pdf")}
        r = architect.post(f"{API}/ingestion/pdf-extract", files=files, timeout=60)
        assert r.status_code == 400, r.text

    def test_unauthenticated_rejected(self):
        with open(PDF_PATH, "rb") as f:
            files = {"file": ("test_rules.pdf", f, "application/pdf")}
            r = requests.post(f"{API}/ingestion/pdf-extract", files=files, timeout=30)
        assert r.status_code == 401

    def test_extract_returns_candidates_from_real_pdf(self, architect):
        """Uploads a small synthetic PDF; expects Gemini to return >=1 candidate."""
        with open(PDF_PATH, "rb") as f:
            files = {"file": ("test_rules.pdf", f, "application/pdf")}
            r = architect.post(f"{API}/ingestion/pdf-extract", files=files, timeout=120)
        assert r.status_code == 200, r.text
        data = r.json()
        # Envelope fields
        assert data["source_file"] == "test_rules.pdf"
        assert "extracted_at" in data
        assert data["extracted_by"] == "architect@his.dev"
        assert isinstance(data["candidates"], list)
        assert len(data["candidates"]) >= 1, "Gemini returned zero candidates"
        # Each candidate schema
        for c in data["candidates"]:
            assert "rule_id" in c and c["rule_id"]
            assert "statement" in c and c["statement"]
            assert "source" in c and c["source"]
            assert "_preview_id" in c and c["_preview_id"]
            assert c.get("severity_if_violated") in ("low", "medium", "high")
