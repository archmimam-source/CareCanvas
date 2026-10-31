# Iteration 47: background autofix job (POST /rooms/{id}/ai/autofix/jobs + GET /ai/jobs/{id})
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
ROOM = "8260854b-38e1-469f-b1b8-f1844f6091f8"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE_URL}/api/auth/login", json={"email": "ipc@his.dev", "password": "demo1234"})
    if r.status_code != 200:
        pytest.skip("login failed")
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        sess.headers["Authorization"] = f"Bearer {tok}"
    return sess


def test_job_unknown_404(s):
    r = s.get(f"{BASE_URL}/api/ai/jobs/does-not-exist")
    assert r.status_code == 404


def test_job_requires_auth():
    r = requests.get(f"{BASE_URL}/api/ai/jobs/does-not-exist")
    assert r.status_code == 401


def test_start_job_unauth():
    r = requests.post(f"{BASE_URL}/api/rooms/{ROOM}/ai/autofix/jobs?deep=true")
    assert r.status_code in (401, 403)


def test_deep_autofix_job_completes(s):
    t0 = time.time()
    r = s.post(f"{BASE_URL}/api/rooms/{ROOM}/ai/autofix/jobs?deep=true", timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "running" and isinstance(d["job_id"], str)
    assert time.time() - t0 < 10, "start must return quickly"
    job = d
    for _ in range(90):
        time.sleep(2)
        g = s.get(f"{BASE_URL}/api/ai/jobs/{d['job_id']}", timeout=30)
        assert g.status_code == 200, g.text
        job = g.json()
        assert "_id" not in job
        if job["status"] != "running":
            break
    print(f"job finished in {time.time()-t0:.1f}s status={job['status']}")
    assert job["status"] == "done", job.get("detail")
    res = job["result"]
    assert isinstance(res.get("moves", []), list)
    assert isinstance(res.get("adds", []), list)
    print("moves", len(res.get("moves", [])), "adds", len(res.get("adds", [])))


def test_other_user_cannot_read_job(s):
    r = s.post(f"{BASE_URL}/api/rooms/{ROOM}/ai/autofix/jobs", timeout=30)
    assert r.status_code == 200
    jid = r.json()["job_id"]
    other = requests.Session()
    lr = other.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@his.dev", "password": "admin123"})
    if lr.status_code != 200:
        pytest.skip("admin login failed")
    tok = lr.json().get("token") or lr.json().get("access_token")
    if tok:
        other.headers["Authorization"] = f"Bearer {tok}"
    g = other.get(f"{BASE_URL}/api/ai/jobs/{jid}")
    assert g.status_code == 404
