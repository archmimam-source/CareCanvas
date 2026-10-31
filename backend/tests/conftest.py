"""Integration tests run against a live backend.

Start the API first (see README), then:
    REACT_APP_BACKEND_URL=http://localhost:8001 pytest backend/tests
"""
import os

os.environ.setdefault("REACT_APP_BACKEND_URL", "http://localhost:8001")
