"""File storage for user uploads and generated files.

Durable copies live in MongoDB (GridFS bucket `uploads`), so no separate
storage service or persistent disk is needed. The local folder DATA_DIR is a
cache: files are written there too and re-fetched from the database whenever
a restart has wiped them.

    DATA_DIR   default: <repo>/uploads

Each file is keyed by its path relative to DATA_DIR (e.g. `avatars/<id>.png`).
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

_fs = None


def _gridfs():
    global _fs
    if _fs is None:
        import gridfs
        from pymongo import MongoClient
        db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
        _fs = gridfs.GridFS(db, collection="uploads")
    return _fs


def _key(path) -> Optional[str]:
    """Storage key for a path inside DATA_DIR; None for anything else."""
    try:
        return Path(path).resolve().relative_to(DATA_DIR).as_posix()
    except ValueError:
        return None


def put_upload(path, data: bytes, mime: str = "application/octet-stream") -> None:
    """Write `data` to `path` and store the durable copy in the database."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    key = _key(path)
    if key:
        fs = _gridfs()
        for old in fs.find({"filename": key}):
            fs.delete(old._id)
        fs.put(data, filename=key, contentType=mime)


def ensure_local(path) -> bool:
    """Make sure `path` exists on local disk, restoring it from the database
    if needed. Returns False when the file exists nowhere."""
    path = Path(path)
    if path.exists():
        return True
    key = _key(path)
    if not key:
        return False
    try:
        data = _gridfs().get_last_version(key).read()
    except Exception:  # NoFile, or database unreachable
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return True


def read_upload(path) -> Optional[bytes]:
    """Return the file's bytes, or None if it doesn't exist."""
    return Path(path).read_bytes() if ensure_local(path) else None


def delete_upload(path) -> None:
    """Remove a file locally and from the database."""
    path = Path(path)
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass
    key = _key(path)
    if key:
        try:
            fs = _gridfs()
            for old in fs.find({"filename": key}):
                fs.delete(old._id)
        except Exception as e:  # noqa
            log.warning("upload delete failed for %s: %s", key, e)
