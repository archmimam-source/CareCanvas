# Iteration 48 — branded exports: filenames, metadata, footer, no app URL/name leakage
import io, os, re, zipfile
from datetime import datetime, timezone
import pytest, requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
BRAND = "HealthcareCanvas_P&W_HIS"
ROOM = "8260854b-38e1-469f-b1b8-f1844f6091f8"
IFC_ROOM = "2c912b83-4ff9-46bd-9f67-30bfe66f3e2b"
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
BAD = [b"his-room", b"validator", b"preview"]


def _login(email):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": "demo1234"})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


@pytest.fixture(scope="module")
def ipc():
    return _login("ipc@his.dev")


@pytest.fixture(scope="module")
def arch():
    return _login("architect@his.dev")


def _fname(r):
    cd = r.headers.get("content-disposition", "")
    m = re.search(r'filename="([^"]+)"', cd)
    return m.group(1) if m else ""


def _no_leak(blob: bytes):
    low = blob.lower()
    for b in BAD:
        assert b not in low, f"leak {b!r}"


def _xlsx_no_leak(content):
    z = zipfile.ZipFile(io.BytesIO(content))
    for n in z.namelist():
        _no_leak(z.read(n))
    core = z.read("docProps/core.xml").decode()
    assert re.search(r"<dc:creator[^>]*>HealthcareCanvas_P&amp;W_HIS</dc:creator>", core)


def _pdf_checks(content):
    from pypdf import PdfReader
    rd = PdfReader(io.BytesIO(content))
    md = rd.metadata
    assert md.get("/Author") == BRAND and md.get("/Creator") == BRAND and md.get("/Subject") == BRAND
    for i, p in enumerate(rd.pages, 1):
        t = p.extract_text() or ""
        assert BRAND in t, f"page {i} missing brand footer"
        assert f"Page {i}" in t, f"page {i} missing page number"
        tl = t.lower()
        for b in BAD:
            assert b.decode() not in tl
    _no_leak(content)  # raw bytes (metadata etc.)
    return len(rd.pages)


# Room data sheet PDF (GET)
def test_data_sheet_pdf_get(ipc):
    r = ipc.get(f"{BASE_URL}/api/rooms/{ROOM}/data-sheet.pdf")
    assert r.status_code == 200
    fn = _fname(r)
    assert fn.startswith(BRAND + "_") and fn.endswith(f"_data-sheet_{TODAY}.pdf"), fn
    assert "access-control-expose-headers" in {k.lower() for k in r.headers}
    print("pages", _pdf_checks(r.content), fn)


# Room data sheet PDF (POST with no snapshots)
def test_data_sheet_pdf_post(ipc):
    r = ipc.post(f"{BASE_URL}/api/rooms/{ROOM}/data-sheet.pdf", json={})
    assert r.status_code == 200
    assert _fname(r).endswith(f"_data-sheet_{TODAY}.pdf")
    _pdf_checks(r.content)


# Room data sheet XLSX
def test_data_sheet_xlsx(ipc):
    r = ipc.get(f"{BASE_URL}/api/rooms/{ROOM}/data-sheet.xlsx")
    assert r.status_code == 200
    fn = _fname(r)
    assert fn.startswith(BRAND + "_") and fn.endswith(f"_data-sheet_{TODAY}.xlsx"), fn
    _xlsx_no_leak(r.content)


# Room IFC export (no kind)
def test_export_ifc(ipc):
    r = ipc.get(f"{BASE_URL}/api/rooms/{ROOM}/export.ifc")
    assert r.status_code == 200
    fn = _fname(r)
    assert fn.startswith(BRAND + "_") and fn.endswith(f"_{TODAY}.ifc") and "__" not in fn, fn
    txt = r.content.decode("utf-8", "ignore")
    hdr = txt.split("ENDSEC;")[0]
    fnl = [l for l in hdr.splitlines() if l.startswith("FILE_NAME")][0]
    print(fnl)
    assert fnl.count(BRAND) >= 4, fnl
    _no_leak(r.content)


# Original IFC source download
def test_ifc_source_original(arch):
    r = arch.get(f"{BASE_URL}/api/rooms/{IFC_ROOM}/ifc-source")
    assert r.status_code == 200
    fn = _fname(r)
    assert fn.startswith(BRAND + "_") and fn.endswith(f"_original_{TODAY}.ifc"), fn


def test_ifc_source_missing_404(ipc):
    r = ipc.get(f"{BASE_URL}/api/rooms/{ROOM}/ifc-source")
    assert r.status_code == 404


# Estate derogation report PDF / XLSX
def test_derogation_pdf(ipc):
    r = ipc.get(f"{BASE_URL}/api/estate/derogation-report.pdf")
    assert r.status_code == 200
    assert _fname(r) == f"{BRAND}_Estate_derogation-report_{TODAY}.pdf"
    _pdf_checks(r.content)


def test_derogation_xlsx(ipc):
    r = ipc.get(f"{BASE_URL}/api/estate/derogation-report.xlsx")
    assert r.status_code == 200
    assert _fname(r) == f"{BRAND}_Estate_derogation-report_{TODAY}.xlsx"
    _xlsx_no_leak(r.content)
