"""File storage for user uploads and generated files.

Every runtime-written file (avatars, standards PDFs, Revit/IFC families,
IFC imports, AI renders) lives under a single directory, DATA_DIR, so one
persistent disk covers all of it in production.

    DATA_DIR   default: <repo>/uploads   (on Render: the persistent disk mount)

Files bundled with the code (seed families, adjacency matrix) stay in the
repo and are addressed relative to BACKEND_DIR.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR") or (BACKEND_DIR.parent / "uploads")).resolve()

AVATAR_DIR = DATA_DIR / "avatars"
PDF_DIR = DATA_DIR / "pdfs"
FAMILIES_DIR = DATA_DIR / "families"
RENDERS_DIR = DATA_DIR / "ai_renders"

for _d in (AVATAR_DIR, PDF_DIR, FAMILIES_DIR, RENDERS_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def put_upload(path: Path, data: bytes, mime: str = "application/octet-stream") -> None:
    """Write `data` to `path`, creating parent folders. Raises on failure so
    the caller can report it instead of losing the upload silently."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def read_upload(path: Path) -> Optional[bytes]:
    """Return the file's bytes, or None if it doesn't exist."""
    try:
        p = Path(path)
        return p.read_bytes() if p.exists() else None
    except Exception as e:  # noqa
        log.warning("upload read failed for %s: %s", path, e)
        return None
