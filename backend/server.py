"""HealthcareCanvas — Perkins & Will × Healthcare Infection Society (HIS) Co-Design Platform — Backend."""
from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os, logging, uuid, bcrypt, jwt, tempfile, re, asyncio, math
import json as _json
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any, Literal

from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends, UploadFile, File, BackgroundTasks, WebSocket, WebSocketDisconnect, Query, Body
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr
import base64
import llm

RENDER_SYSTEM = ("You are an expert architectural visualizer producing precise "
                 "isometric cutaway diagrams of healthcare rooms.")

SEED_VERSION = 20  # bump to force re-seed

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]
JWT_ALGO = "HS256"
JWT_SECRET = os.environ['JWT_SECRET']

from object_storage import (RENDERS_DIR, AVATAR_DIR, PDF_DIR,  # noqa: E402
                            put_upload, ensure_local, delete_upload)

BRAND = "HealthcareCanvas_P&W_HIS"


def _brand_fname(subject: str, kind: str, ext: str) -> str:
    """HealthcareCanvas_P&W_HIS_<Subject>_<kind>_<YYYY-MM-DD>.<ext> — used for every export."""
    slug = lambda s: re.sub(r"[^A-Za-z0-9]+", "-", s or "").strip("-")
    parts = [BRAND, slug(subject), slug(kind), datetime.now(timezone.utc).strftime("%Y-%m-%d")]
    return "_".join(p for p in parts if p) + f".{ext}"


def _brand_disposition(subject: str, kind: str, ext: str) -> dict:
    from urllib.parse import quote
    fn = _brand_fname(subject, kind, ext)
    ascii_fn = fn.encode("ascii", "ignore").decode()
    return {"Content-Disposition": f"attachment; filename=\"{ascii_fn}\"; filename*=UTF-8''{quote(fn)}",
            "Access-Control-Expose-Headers": "Content-Disposition"}


def _brand_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColorRGB(0.53, 0.53, 0.55)
    w, _h = doc.pagesize
    canvas.drawString(doc.leftMargin, 10 * 2.835, BRAND)
    canvas.drawRightString(w - doc.rightMargin, 10 * 2.835, f"Page {doc.page}")
    canvas.restoreState()


def _brand_workbook(wb, title: str):
    p = wb.properties
    p.creator = p.lastModifiedBy = BRAND
    p.title, p.subject, p.company = title, BRAND, BRAND
    return wb

app = FastAPI(title="HealthcareCanvas Co-Design Platform")
api = APIRouter(prefix="/api")


def now_iso(): return datetime.now(timezone.utc).isoformat()
def new_id():  return str(uuid.uuid4())
def hash_password(p): return bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode()
def verify_password(p, h):
    try: return bcrypt.checkpw(p.encode(), h.encode())
    except Exception: return False


def create_access_token(uid, email, role):
    return jwt.encode({"sub": uid, "email": email, "role": role,
                       "exp": datetime.now(timezone.utc) + timedelta(minutes=60),
                       "type": "access"}, JWT_SECRET, algorithm=JWT_ALGO)

def create_refresh_token(uid):
    return jwt.encode({"sub": uid, "exp": datetime.now(timezone.utc) + timedelta(days=7),
                       "type": "refresh"}, JWT_SECRET, algorithm=JWT_ALGO)

def set_auth_cookies(response, at, rt):
    response.set_cookie("access_token", at, httponly=True, secure=False, samesite="lax", max_age=3600, path="/")
    response.set_cookie("refresh_token", rt, httponly=True, secure=False, samesite="lax", max_age=604800, path="/")

async def get_current_user(request: Request) -> Dict[str, Any]:
    # JWT via cookie or Authorization header
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        if payload.get("type") != "access":
            raise HTTPException(401, "Invalid token")
        user = await db.users.find_one({"id": payload["sub"]})
        if not user:
            raise HTTPException(401, "User not found")
        user.pop("_id", None); user.pop("password_hash", None)
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

def require_role(*roles):
    async def dep(user=Depends(get_current_user)):
        if user["role"] not in roles and user["role"] != "admin":
            raise HTTPException(403, f"Requires role: {roles}")
        return user
    return dep


# ---------- Room-level access control ----------
# A room (hierarchy node) is accessible to a user when:
#   1. The user is the owner (`owner_id == user.id`), OR
#   2. An accepted access_grant exists for (user_id, scope=room, scope_id=room_id), OR
#   3. The node is a seed / representational node (no `owner_id`, marked `is_seed`
#      or has the legacy `read_only` field from the seed script) — visible to
#      everyone but read-only for non-admins.
#   4. `role == "admin"` — always allowed (for legacy/unassigned recovery).
# Writes (POST/PUT/PATCH/DELETE) additionally require ownership, grant, or admin.
async def _enforce_room_access(user: Dict[str, Any], room_id: str, write: bool = False):
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    if not node:
        raise HTTPException(404, "Room not found")
    if user.get("role") == "admin":
        return node
    owner = node.get("owner_id")
    # Legacy pre-fix rooms are admin-only (already handled above via role check).
    if node.get("is_legacy") or owner == "legacy":
        raise HTTPException(403, "This room is unassigned. Contact an administrator.")
    if not owner:
        # Seed / representation node
        if write:
            raise HTTPException(403, "Representation rooms are read-only. Create your own room to edit.")
        return node
    if owner == user.get("id"):
        return node
    grant = await db.access_grants.find_one({
        "user_id": user["id"], "scope": "room", "scope_id": room_id,
    })
    if grant:
        return node
    # Ancestor-scope grants (building/estate) — still grant full access
    cur = node
    while cur and cur.get("parent_id"):
        parent = await db.hierarchy.find_one({"id": cur["parent_id"]},
                                             {"_id": 0, "id": 1, "type": 1, "parent_id": 1})
        if not parent: break
        g = await db.access_grants.find_one({
            "user_id": user["id"], "scope": parent["type"], "scope_id": parent["id"],
        })
        if g:
            return node
        cur = parent
    # Published (admin-approved) rooms are readable by everyone; approvers can
    # inspect rooms awaiting their decision.
    if not write and (node.get("published") or
                      (node.get("publish_status") == "pending" and _is_approver(user))):
        return node
    # Org visibility — read-only for org peers with same organization string.
    # Writes still require an explicit grant.
    if node.get("visible_to_org") and not write:
        my_org = (user.get("organization") or "").strip().lower()
        owner_org = (node.get("owner_org") or "").strip().lower()
        if my_org and owner_org and my_org == owner_org:
            return node
    raise HTTPException(403, "You do not have access to this room.")


async def _room_access(request: Request, room_id: str,
                       user=Depends(get_current_user)) -> Dict[str, Any]:
    """FastAPI dependency: enforces room-level access based on HTTP method."""
    write = request.method.upper() not in ("GET", "HEAD", "OPTIONS")
    await _enforce_room_access(user, room_id, write=write)
    return user


async def _require_room_owner(room_id: str, user: Dict[str, Any]) -> Dict[str, Any]:
    """Owner or admin only. Used for management actions (share, revoke,
    visibility toggle, audit log)."""
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    if not node:
        raise HTTPException(404, "Room not found")
    if user.get("role") == "admin":
        return node
    if node.get("owner_id") == user.get("id"):
        return node
    raise HTTPException(403, "Only the room owner can perform this action.")


async def _audit_log(room_id: str, user: Dict[str, Any], action: str,
                     meta: Optional[Dict[str, Any]] = None):
    """Append an audit event. TTL index (30 days) prunes old entries."""
    try:
        await db.audit_events.insert_one({
            "id": new_id(),
            "room_id": room_id,
            "actor_id": user.get("id"),
            "actor_email": user.get("email"),
            "actor_name": user.get("name"),
            "action": action,           # opened | edited | invited | revoked | cloned | visibility
            "meta": meta or {},
            "ts": datetime.now(timezone.utc),  # BSON date — TTL uses this
            "ts_iso": now_iso(),
        })
    except Exception as e:
        # Never break the primary flow on audit failures
        logging.warning(f"audit_log failed: {e}")


async def _create_user_note(recipient_user_id: str, from_user: Dict[str, Any],
                            room_id: str, room_name: Optional[str],
                            action: str, note: str):
    """Deliver a one-liner (≤240 chars) to a specific user. Surfaced by
    the top-bar notifications bell on the recipient's next visit.
    Used by revoke/invite/approve/deny flows."""
    try:
        await db.user_notes.insert_one({
            "id": new_id(),
            "recipient_user_id": recipient_user_id,
            "from_user_id": from_user.get("id"),
            "from_email": from_user.get("email"),
            "from_name": from_user.get("name"),
            "room_id": room_id,
            "room_name": room_name,
            "action": action,           # revoked | invited | approved | denied
            "note": (note or "")[:240],
            "seen": False,
            "created_at": now_iso(),
            "ts": datetime.now(timezone.utc),
        })
    except Exception as e:
        logging.warning(f"user_note create failed: {e}")


# ---------- Models ----------
class RegisterIn(BaseModel):
    email: EmailStr; password: str; name: str
    role: Literal["architect","ipc_lead","reviewer","contributor"] = "architect"

class LoginIn(BaseModel):
    email: EmailStr; password: str

class SceneItemIn(BaseModel):
    id: Optional[str] = None
    component_key: str
    x: float; y: float
    w: float; d: float
    rotation: float = 0
    zone: Literal["clean","transition","dirty"]
    mount_type: Literal["floor","wall","ceiling"] = "floor"
    elevation_m: float = 0.0   # bottom of item above floor
    height_m: float = 0.9      # vertical extent
    revit_family: Optional[str] = None
    label: Optional[str] = None
    ifc_guid: Optional[str] = None
    ifc_class: Optional[str] = None

class SceneIn(BaseModel):
    room_id: str
    width: float = 3.0
    depth: float = 3.0
    zones: Dict[str, Any] = Field(default_factory=dict)
    items: List[SceneItemIn] = Field(default_factory=list)
    # Interior partitions — thin free-standing walls users can draw inside
    # a room so wall-mounted components can honestly hang on them.
    partitions: Optional[List[Dict[str, Any]]] = None
    shape: Optional[Dict[str, Any]] = None
    ceiling_h: Optional[float] = None

class IngestionSubmitIn(BaseModel):
    target: Literal["rule","component"]
    payload: Dict[str, Any]
    note: Optional[str] = None

class IngestionReviewIn(BaseModel):
    decision: Literal["approve","reject"]
    note: Optional[str] = None


# ---------- Auth ----------
@api.post("/auth/register")
async def register(body: RegisterIn, response: Response):
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    uid = new_id()
    doc = {"id": uid, "email": email, "name": body.name,
           "password_hash": hash_password(body.password),
           "role": body.role, "created_at": now_iso()}
    await db.users.insert_one(doc)
    at = create_access_token(uid, email, body.role); rt = create_refresh_token(uid)
    set_auth_cookies(response, at, rt)
    return {"id": uid, "email": email, "name": body.name, "role": body.role, "token": at}

@api.post("/auth/login")
async def login(body: LoginIn, response: Response):
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not user.get("password_hash") or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Invalid credentials")
    at = create_access_token(user["id"], email, user["role"]); rt = create_refresh_token(user["id"])
    set_auth_cookies(response, at, rt)
    return {"id": user["id"], "email": email, "name": user["name"], "role": user["role"], "token": at}

@api.post("/auth/logout")
async def logout(request: Request, response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"ok": True}


@api.get("/auth/me")
async def me(user=Depends(get_current_user)):
    # Hydrate optional persona fields from the users collection so the UI
    # can show organization / discipline / bio in the peer chip tooltip.
    doc = await db.users.find_one({"email": user["email"]}, {"_id": 0}) or {}
    for k in ("organization", "discipline", "location", "phone", "bio",
              "avatar_url", "tos_accepted_version", "tos_accepted_at"):
        user[k] = doc.get(k) or None
    return user


class MeUpdateIn(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    organization: Optional[str] = None
    discipline: Optional[str] = None
    location: Optional[str] = None
    phone: Optional[str] = None
    bio: Optional[str] = None
    avatar_url: Optional[str] = None

class TermsAcceptIn(BaseModel):
    version: str

@api.post("/auth/terms/accept")
async def accept_terms(body: TermsAcceptIn, user=Depends(get_current_user)):
    v = (body.version or "").strip()
    if not v: raise HTTPException(400, "version required")
    await db.users.update_one(
        {"email": user["email"]},
        {"$set": {"tos_accepted_version": v, "tos_accepted_at": now_iso()}},
    )
    return {"ok": True, "version": v}

@api.patch("/auth/me")
async def update_me(body: MeUpdateIn, user=Depends(get_current_user)):
    """Update the user's profile persona fields. Used by the "My profile"
    modal to keep organization / discipline / location / phone / bio in
    sync between the auth record and what peers see in presence chips.
    """
    set_doc = {}
    if body.name        and body.name.strip():          set_doc["name"] = body.name.strip()
    if body.role:
        role = body.role.strip().lower()
        if role in ALLOWED_GUEST_ROLES:
            set_doc["role"] = role
    for f in ("organization", "discipline", "location", "phone", "bio", "avatar_url"):
        v = getattr(body, f)
        if v is not None:
            set_doc[f] = v.strip() or None
    if not set_doc:
        raise HTTPException(400, "No fields to update.")
    await db.users.update_one({"email": user["email"]}, {"$set": set_doc})
    doc = await db.users.find_one({"email": user["email"]}, {"_id": 0})
    return {"ok": True, "user": doc}


AVATAR_DIR.mkdir(parents=True, exist_ok=True)

@api.post("/auth/me/avatar")
async def upload_avatar(file: UploadFile = File(...), user=Depends(get_current_user)):
    """Upload a profile avatar. Stores under DATA_DIR/avatars/{user_id}.{ext}
    and updates the user's `avatar_url` to a public-ish `/api/auth/me/avatar/{uid}`.
    """
    ct = (file.content_type or "").lower()
    if not ct.startswith("image/"):
        raise HTTPException(400, "avatar must be an image")
    ext = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
        "image/webp": ".webp", "image/gif": ".gif",
    }.get(ct, ".png")
    data = await file.read()
    if len(data) > 3 * 1024 * 1024:
        raise HTTPException(413, "avatar exceeds 3 MB")
    uid = user["id"]
    for e in (".png", ".jpg", ".webp", ".gif"):
        if e != ext:
            delete_upload(AVATAR_DIR / f"{uid}{e}")
    dest = AVATAR_DIR / f"{uid}{ext}"
    put_upload(dest, data, f"image/{ext.strip('.')}" if ext else "application/octet-stream")
    url = f"/api/auth/me/avatar/{uid}"
    await db.users.update_one({"email": user["email"]}, {"$set": {"avatar_url": url}})
    return {"ok": True, "avatar_url": url}

@api.get("/auth/me/avatar/{uid}")
async def get_avatar(uid: str):
    for e in (".png", ".jpg", ".webp", ".gif"):
        p = AVATAR_DIR / f"{uid}{e}"
        if ensure_local(p):
            from fastapi.responses import FileResponse
            return FileResponse(str(p))
    raise HTTPException(404, "avatar not found")


# ---------- Guest access ----------
# Frontend passes a stable browser-scoped guest_id (localStorage). Backend upserts
# a lightweight user record (role=architect, auth=guest) and issues a legacy JWT
# cookie so every downstream endpoint just works.
class GuestIn(BaseModel):
    guest_id: str
    label: Optional[str] = None
    role: Optional[str] = None
    organization: Optional[str] = None
    discipline: Optional[str] = None

ALLOWED_GUEST_ROLES = {"architect", "ipc", "engineer", "clinician", "viewer"}

@api.post("/auth/guest")
async def guest_login(body: GuestIn, response: Response):
    gid = (body.guest_id or "").strip()
    if not gid or len(gid) < 6:
        raise HTTPException(400, "Missing guest_id")
    email = f"guest+{gid}@his.local"
    name = (body.label or "").strip() or f"Guest {gid[:6]}"
    role = (body.role or "").strip().lower()
    if role not in ALLOWED_GUEST_ROLES:
        role = "architect"
    org  = (body.organization or "").strip() or None
    disc = (body.discipline  or "").strip() or None
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        uid = existing.get("id") or existing.get("user_id") or new_id()
        # Refresh the persona each time — a guest may sign in with a new
        # name / role / org in a new tab and expect their peer badge to reflect it.
        set_doc = {"last_login_at": now_iso(), "name": name, "role": role}
        if org:  set_doc["organization"] = org
        if disc: set_doc["discipline"]   = disc
        await db.users.update_one({"email": email}, {"$set": set_doc})
    else:
        uid = new_id()
        await db.users.insert_one({
            "id": uid, "user_id": uid,
            "email": email, "name": name,
            "role": role, "auth": "guest",
            "organization": org, "discipline": disc,
            "location": None, "phone": None, "bio": None,
            "created_at": now_iso(), "last_login_at": now_iso(),
        })
    at = create_access_token(uid, email, role)
    rt = create_refresh_token(uid)
    set_auth_cookies(response, at, rt)
    return {"id": uid, "email": email, "name": name, "role": role,
            "organization": org, "discipline": disc,
            "auth": "guest", "token": at}

@api.post("/auth/refresh")
async def refresh_token(request: Request, response: Response):
    rt = request.cookies.get("refresh_token")
    if not rt: raise HTTPException(401, "No refresh token")
    try:
        payload = jwt.decode(rt, JWT_SECRET, algorithms=[JWT_ALGO])
        if payload.get("type") != "refresh": raise HTTPException(401, "Bad token type")
        user = await db.users.find_one({"id": payload["sub"]})
        if not user: raise HTTPException(401, "User not found")
        at = create_access_token(user["id"], user["email"], user["role"])
        response.set_cookie("access_token", at, httponly=True, secure=False, samesite="lax", max_age=3600, path="/")
        return {"ok": True}
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


# ---------- Hierarchy ----------
@api.get("/hierarchy")
async def list_hierarchy(user=Depends(get_current_user)):
    """Return only hierarchy nodes this user can see:
    - Every non-utility node (estate/building/zone/ward/room) so the tree
      renders. These are shared representational scaffolding.
    - Utility nodes marked `is_seed` — read-only demo/representation rooms
      visible to everyone.
    - Utility nodes this user owns (`owner_id == user.id`).
    - Utility nodes this user has an accepted access_grant for.
    - Utility nodes marked `visible_to_org` where owner_org matches user's org.
    - `is_legacy` rooms are hidden from non-admins (pre-fix unassigned rooms).
    Admin users see everything (with the flags preserved so the UI can tag).
    """
    await _ensure_sample_room(user)
    all_nodes = await db.hierarchy.find({}, {"_id": 0}).to_list(5000)
    is_admin = user.get("role") == "admin"
    my_uid = user.get("id")
    my_org = (user.get("organization") or "").strip().lower()
    grants = await db.access_grants.find(
        {"user_id": my_uid},
        {"_id": 0, "scope": 1, "scope_id": 1},
    ).to_list(2000)
    grant_ids = {g["scope_id"] for g in grants if g.get("scope_id")}

    approver = _is_approver(user)
    out = []
    for n in all_nodes:
        typ = n.get("type")
        if typ != "utility":
            # Imported buildings/floors are private to their uploader until published.
            o = n.get("owner_id")
            if not o or o == my_uid or n.get("published") or is_admin \
                    or (approver and n.get("publish_status") == "pending"):
                out.append({**n, "is_mine": True} if o and o == my_uid else n)
            continue
        owner = n.get("owner_id")
        if n.get("is_legacy") or owner == "legacy":
            if not is_admin:
                continue
            out.append({**n, "read_only": True, "is_legacy": True})
            continue
        if not owner:
            out.append({**n, "read_only": True, "is_representation": True})
            continue
        if owner == my_uid:
            out.append({**n, "is_mine": True})
            continue
        if n["id"] in grant_ids:
            out.append({**n, "shared_with_me": True})
            continue
        # Ancestor-scope grant
        parents = set()
        cur = n
        while cur and cur.get("parent_id"):
            parents.add(cur["parent_id"])
            cur = next((x for x in all_nodes if x.get("id") == cur.get("parent_id")), None)
        if parents & grant_ids:
            out.append({**n, "shared_with_me": True})
            continue
        if n.get("published") or (approver and n.get("publish_status") == "pending"):
            out.append({**n, "read_only": True, "published_view": True})
            continue
        # Org visibility — read-only for org peers
        if n.get("visible_to_org") and my_org:
            owner_org = (n.get("owner_org") or "").strip().lower()
            if owner_org and owner_org == my_org:
                out.append({**n, "shared_with_me": True, "via_org": True, "read_only": True})
                continue
        if is_admin:
            out.append({**n, "_admin_view": True})
    return out

@api.get("/hierarchy/{node_id}")
async def get_node(node_id: str, user=Depends(get_current_user)):
    node = await db.hierarchy.find_one({"id": node_id}, {"_id": 0})
    if not node: raise HTTPException(404)
    if node.get("type") != "utility" and node.get("owner_id") and node["owner_id"] != user.get("id") \
            and not node.get("published") and user.get("role") != "admin" \
            and not (_is_approver(user) and node.get("publish_status") == "pending"):
        raise HTTPException(404)
    # If it's a utility room, enforce access. Structural nodes stay public.
    if node.get("type") == "utility":
        await _enforce_room_access(user, node_id, write=False)
        try:
            await _enforce_room_access(user, node_id, write=True)
            node["can_edit"] = True
        except HTTPException:
            node["can_edit"] = False
    return node


# ---------- Rules ----------
@api.get("/rules")
async def list_rules(tier: Optional[str] = None, kind: Optional[str] = None,
                     room_id: Optional[str] = None, user=Depends(get_current_user)):
    q = {"published": True}
    if tier: q["tier"] = tier
    if kind: q["kind"] = kind
    if room_id:
        # Global rules + rules pinned to this room. Excludes rules pinned to *other* rooms.
        q["$or"] = [{"scope": "global"}, {"scope": {"$exists": False}}, {"room_id": room_id}]
    # Session scoping: a user-authored rule (identified by `submitted_by`
    # being set to a real user's email) is only visible to that user OR to
    # reviewers/admins. Seeded baseline rules have no `submitted_by` and
    # remain global.
    if user.get("role") not in ("reviewer", "admin"):
        q["$and"] = q.get("$and", []) + [{"$or": [
            {"submitted_by": {"$exists": False}},
            {"submitted_by": None},
            {"submitted_by": user["email"]},
        ]}]
    return await db.rules.find(q, {"_id": 0}).to_list(2000)

@api.get("/rules/{rule_id}")
async def get_rule(rule_id: str, user=Depends(get_current_user)):
    r = await db.rules.find_one({"id": rule_id, "published": True}, {"_id": 0})
    if not r: raise HTTPException(404)
    return r


class RuleToggleIn(BaseModel):
    enabled: bool

@api.patch("/rules/{rule_id}/toggle")
async def toggle_rule(rule_id: str, body: RuleToggleIn, user=Depends(get_current_user)):
    """Enable / disable a rule so validation + Compliance Assistant skip it.
    Anyone can toggle — the audit trail records who did it."""
    r = await db.rules.find_one({"id": rule_id})
    if not r: raise HTTPException(404)
    await db.rules.update_one({"id": rule_id}, {"$set": {
        "enabled": body.enabled,
        "toggled_by": user["email"],
        "toggled_at": now_iso(),
    }})
    return {"ok": True, "id": rule_id, "enabled": body.enabled}


class RulePinIn(BaseModel):
    room_id: Optional[str] = None   # None → back to global

@api.patch("/rules/{rule_id}/pin")
async def pin_rule(rule_id: str, body: RulePinIn, user=Depends(get_current_user)):
    """Attach a rule to a specific room (or detach → global)."""
    r = await db.rules.find_one({"id": rule_id})
    if not r: raise HTTPException(404)
    scope = "room" if body.room_id else "global"
    await db.rules.update_one({"id": rule_id}, {"$set": {
        "scope": scope, "room_id": body.room_id,
        "pinned_by": user["email"], "pinned_at": now_iso(),
    }})
    return {"ok": True, "id": rule_id, "scope": scope, "room_id": body.room_id}


# ---------- Components ----------
@api.get("/components")
async def list_components(user=Depends(get_current_user)):
    return await db.components.find({"published": True}, {"_id": 0}).to_list(2000)


# ---------- Ingestion ----------
@api.post("/ingestion/submit")
async def ingestion_submit(body: IngestionSubmitIn, user=Depends(get_current_user)):
    if not body.payload.get("source"):
        raise HTTPException(400, "Source citation is required (no source, no publish)")
    doc = {"id": new_id(), "target": body.target, "payload": body.payload, "note": body.note,
           "state": "pending_review", "submitted_by": user["email"],
           "submitted_at": now_iso(), "reviewed_by": None, "reviewed_at": None, "version": 1}
    await db.ingestion.insert_one(doc); doc.pop("_id", None)
    return doc


# ---------- Knowledge export / import (per-session portability) ----------
@api.get("/knowledge/export")
async def knowledge_export(user=Depends(get_current_user)):
    """Bundle every rule / interpretation / submission this user authored
    into a single JSON payload so they can move it to another session or
    share it with a colleague. Baseline (unowned) rules are NOT included —
    those come from the seed on every deploy."""
    rules = await db.rules.find({"submitted_by": user["email"]}, {"_id": 0}).to_list(2000)
    subs  = await db.ingestion.find({"submitted_by": user["email"]}, {"_id": 0}).to_list(2000)
    return {
        "schema": "healthcarecanvas.knowledge-bundle.v1",
        "exported_at": now_iso(),
        "exported_by": user["email"],
        "rules": [r for r in rules if r.get("kind") != "interpretation"],
        "interpretations": [r for r in rules if r.get("kind") == "interpretation"],
        "submissions": subs,
    }

@api.post("/knowledge/import")
async def knowledge_import(body: Dict[str, Any] = Body(...),
                           user=Depends(get_current_user)):
    """Take a knowledge bundle produced by /knowledge/export and re-create
    every entry owned by the CURRENT user. Existing entries with the same
    `rule_id` for this user are skipped (idempotent). Returns per-collection
    counts."""
    if body.get("schema") != "healthcarecanvas.knowledge-bundle.v1":
        raise HTTPException(400, "Unsupported bundle schema")
    counts = {"rules": 0, "interpretations": 0, "submissions": 0, "skipped": 0}
    for rule in (body.get("rules") or []):
        rule_id = rule.get("rule_id")
        if rule_id and await db.rules.find_one({"rule_id": rule_id, "submitted_by": user["email"]}):
            counts["skipped"] += 1; continue
        rec = {**rule, "id": new_id(), "submitted_by": user["email"],
               "last_reviewed": now_iso(), "published": True, "version": 1}
        rec.pop("_id", None)
        rec.setdefault("kind", "rule")
        rec.setdefault("scope", "global")
        rec.setdefault("enabled", True)
        rec.setdefault("is_custom", True)
        await db.rules.insert_one(rec)
        counts["rules"] += 1
    for interp in (body.get("interpretations") or []):
        rule_id = interp.get("rule_id")
        if rule_id and await db.rules.find_one({"rule_id": rule_id, "submitted_by": user["email"]}):
            counts["skipped"] += 1; continue
        rec = {**interp, "id": new_id(), "submitted_by": user["email"],
               "last_reviewed": now_iso(), "published": True, "version": 1,
               "kind": "interpretation"}
        rec.pop("_id", None)
        rec.setdefault("scope", "global"); rec.setdefault("enabled", True)
        rec.setdefault("is_custom", True); rec.setdefault("tier", "context")
        await db.rules.insert_one(rec)
        counts["interpretations"] += 1
    for sub in (body.get("submissions") or []):
        rec = {**sub, "id": new_id(), "submitted_by": user["email"],
               "submitted_at": now_iso(), "state": sub.get("state", "pending_review"),
               "reviewed_by": None, "reviewed_at": None, "version": 1}
        rec.pop("_id", None)
        await db.ingestion.insert_one(rec)
        counts["submissions"] += 1
    return {"ok": True, "counts": counts}


@api.get("/ingestion")
async def ingestion_list(state: Optional[str] = None, user=Depends(get_current_user)):
    q = {} if not state else {"state": state}
    # Session scoping: users only see their own submissions. Reviewers /
    # admins see every submission so they can approve/reject on behalf of
    # anyone.
    if user.get("role") not in ("reviewer", "admin"):
        q["submitted_by"] = user["email"]
    return await db.ingestion.find(q, {"_id": 0}).sort("submitted_at", -1).to_list(2000)

@api.post("/ingestion/{sub_id}/review")
async def ingestion_review(sub_id: str, body: IngestionReviewIn,
                           user=Depends(require_role("reviewer","admin"))):
    sub = await db.ingestion.find_one({"id": sub_id})
    if not sub: raise HTTPException(404)
    if sub["state"] != "pending_review": raise HTTPException(400, "Already reviewed")
    if body.decision == "reject":
        await db.ingestion.update_one({"id": sub_id}, {"$set": {
            "state": "rejected", "reviewed_by": user["email"], "reviewed_at": now_iso(),
            "review_note": body.note}})
        return {"ok": True, "state": "rejected"}
    sup = (sub.get("payload") or {}).get("supersedes_rule_id")
    if sub["target"] == "rule" and sup:
        old = await db.rules.find_one({"rule_id": sup}, {"_id": 0})
        if not old:
            raise HTTPException(404, "The rule this proposal changes no longer exists")
        await db.rule_history.insert_one({**old, "archived_at": now_iso(), "superseded_by": sub_id})
        allowed = ("statement", "severity_if_violated", "category", "source", "source_page", "source_url", "tier", "note")
        changes = {k: v for k, v in sub["payload"].items() if k in allowed}
        changes.update({"version": int(old.get("version") or 1) + 1, "reviewed_by": user["email"],
                        "last_reviewed": now_iso(), "proposed_by": sub["submitted_by"]})
        await db.rules.update_one({"rule_id": sup}, {"$set": changes})
        await db.ingestion.update_one({"id": sub_id}, {"$set": {
            "state": "published", "reviewed_by": user["email"], "reviewed_at": now_iso(),
            "review_note": body.note, "published_id": old.get("id")}})
        return {"ok": True, "state": "published", "published_id": old.get("id"), "version": changes["version"]}
    pub_id = new_id()
    rec = {**sub["payload"], "id": pub_id, "published": True, "version": 1,
           "submitted_by": sub["submitted_by"], "reviewed_by": user["email"],
           "last_reviewed": now_iso()}
    if sub["target"] == "rule": await db.rules.insert_one(rec)
    else: await db.components.insert_one(rec)
    await db.ingestion.update_one({"id": sub_id}, {"$set": {
        "state": "published", "reviewed_by": user["email"], "reviewed_at": now_iso(),
        "review_note": body.note, "published_id": pub_id}})
    return {"ok": True, "state": "published", "published_id": pub_id}


# ---------- Scenes ----------
async def _empty_scene(room_id: str, width: float = 3.615, depth: float = 2.5, ceiling_h: float = 2.7):
    """A blank utility room. Same standard three-zone layout (DIRTY /
    TRANSITION / CLEAN) but no equipment and no interior partitions.
    The user seeds equipment either by dragging from the palette or by
    tapping the `Standard` button to apply a named layout (HBN F74 / F79
    or NHP V2 6222)."""
    W, D = width, depth
    zones = {
        "dirty":      {"x": 0.0, "y": 0.0,  "w": W, "d": round(D * 0.42, 3)},
        "transition": {"x": 0.0, "y": round(D * 0.42, 3), "w": W, "d": round(D * 0.22, 3)},
        "clean":      {"x": 0.0, "y": round(D * 0.64, 3), "w": W, "d": round(D * 0.36, 3)},
    }
    return {
        "room_id": room_id,
        "width": W, "depth": D, "ceiling_h": ceiling_h,
        "zones": zones,
        "items": [],
        "partitions": [],
        "shape": {"type": "rectangle"},
        "version": 1,
        "updated_at": now_iso(),
        "standard_applied": None,
    }


async def _nhp_v2_scene(room_id: str, W: float = 3.615, D: float = 2.5, H: float = 2.7):
    """NHP RDS 6222 — Medium Inpatient Dirty Utility (V2).

    Layout follows the Adjacency-v3 NHP profile — no interior partitions
    (user feedback 2026-02-28). Dirty-side wet work on the NORTH wall,
    hand-hygiene column on the WEST wall near the entry, dry
    worktop/dispensers on the EAST wall, linen & commode on the SOUTH
    wall.  Every item is flush against a real wall; AABB matches the
    rotated visual.
    """
    # Three-band zone split (visual guide; no physical partition).
    zones = {
        "dirty":      {"x": 0.0, "y": 0.0,  "w": W, "d": round(D * 0.42, 3)},
        "transition": {"x": 0.0, "y": round(D * 0.42, 3), "w": W, "d": round(D * 0.22, 3)},
        "clean":      {"x": 0.0, "y": round(D * 0.64, 3), "w": W, "d": round(D * 0.36, 3)},
    }
    items = [
        # ─── NORTH wall (SOURCE / wet work) ───────────────────────────
        _wall_item("macerator",       "N", 0.05,            "dirty", W, D, h=1.4),
        _wall_item("prep_counter",    "N", 0.80,            "dirty", W, D, h=0.9),
        _wall_item("steel_tray",      "N", 0.90,            "dirty", W, D,
                   mount="floor", h=0.05, elev=0.9),
        _wall_item("sloping_storage", "N", 2.10,            "dirty", W, D,
                   mount="wall", h=0.30, elev=1.80),
        _wall_item("cabinet_coshh",   "N", 2.95,            "dirty", W, D,
                   mount="wall", h=0.90, elev=1.40, back_gap=0.02),
        _wall_item("urine_scale",     "N", 2.10,            "dirty", W, D,
                   mount="wall", h=0.15, elev=1.00, back_gap=0.02),
        # ─── EAST wall (electrical/data cluster, dry) ─────────────────
        _wall_item("connection_box_32a", "E", 0.30,         "dirty", W, D,
                   mount="wall", h=0.16, elev=1.40, back_gap=0.02),
        _wall_item("outlet_isolator", "E", 0.60,            "dirty", W, D,
                   mount="wall", h=0.15, elev=1.40, back_gap=0.02),
        _wall_item("cold_water_outlet", "E", 0.90,          "dirty", W, D,
                   mount="wall", h=0.10, elev=1.20, back_gap=0.02),
        _wall_item("tundish_drain",   "E", 1.15,            "dirty", W, D,
                   mount="wall", h=0.12, elev=0.30, back_gap=0.02),
        _wall_item("data_single",     "E", 1.45,            "dirty", W, D,
                   mount="wall", h=0.09, elev=1.05, back_gap=0.02),
        # ─── WEST wall (HAND HYGIENE + PPE column) ────────────────────
        # Basin ≥ 2 m from macerator (adjacency-v3 D-1 NHP delta).
        _wall_item("clinical_wash_basin", "W", 1.80,        "transition", W, D, h=0.9),
        _wall_item("soap_dispenser",  "W", 1.60,            "transition", W, D,
                   mount="wall", h=0.28, elev=1.35, back_gap=0.02),
        _wall_item("sanitiser_unit",  "W", 1.78,            "transition", W, D,
                   mount="wall", h=0.28, elev=1.35, back_gap=0.02),
        _wall_item("paper_towel",     "W", 1.95,            "transition", W, D,
                   mount="wall", h=0.30, elev=1.35, back_gap=0.02),
        _wall_item("wipes_dispenser", "W", 2.12,            "transition", W, D,
                   mount="wall", h=0.28, elev=1.35, back_gap=0.02),
        _wall_item("ppe_station",     "W", 1.00,            "transition", W, D,
                   mount="wall", h=1.00, elev=0.90, back_gap=0.02),
        # ─── SOUTH wall (CLEAN side) ──────────────────────────────────
        _wall_item("linen_trolley",   "S", 1.00,            "clean", W, D, h=1.0),
        _wall_item("linen_trolley",   "S", 1.55,            "clean", W, D, h=1.0),
        _wall_item("linen_trolley",   "S", 2.10,            "clean", W, D, h=1.0),
        _wall_item("commode_store",   "S", 2.65,            "clean", W, D, h=1.6),
        _wall_item("biohazard_bin",   "S", 0.60,            "clean", W, D, h=0.7),
        _wall_item("call_lamp",       "S", 0.20,            "clean", W, D,
                   mount="wall", h=0.20, elev=2.10, back_gap=0.02),
        _wall_item("socket_twin",     "S", 0.40,            "clean", W, D,
                   mount="wall", h=0.09, elev=1.05, back_gap=0.02),
        # Sliding entry door bottom-left (SW corner).
        _wall_item("entry_door",      "S", 0.02,            "clean", W, D, h=2.05),
        # ─── Ceiling ─────────────────────────────────────────────────
        _ceiling_item("exhaust_vent",   W - 0.80, 0.40,     "dirty",      W, D, h=0.15, elev=H - 0.15),
        _ceiling_item("ceiling_light",  0.90,     0.40,     "dirty",      W, D, h=0.10, elev=H - 0.10),
        _ceiling_item("ceiling_light",  W / 2,    D - 0.60, "clean",      W, D, h=0.10, elev=H - 0.10),
        _ceiling_item("emergency_light",0.80,     D - 0.30, "clean",      W, D, h=0.05, elev=H - 0.05),
        _ceiling_item("smoke_detector", W / 2,    D / 2,    "transition", W, D, h=0.05, elev=H - 0.05),
        _ceiling_item("presence_sensor",0.30,     D - 0.20, "clean",      W, D, h=0.05, elev=H - 0.05),
        _ceiling_item("wifi_ap",        W - 0.30, D - 0.20, "clean",      W, D, h=0.05, elev=H - 0.05),
    ]
    return {
        "room_id": room_id,
        "width": W, "depth": D, "ceiling_h": H,
        "zones": zones,
        "items": items,
        "partitions": [],   # No interior partitions — items hang on real walls.
        "shape": {"type": "rectangle"},
        "version": 1,
        "updated_at": now_iso(),
    }


# ── HBN 00-10 scene builders ──────────────────────────────────────────
# Based on the Adjacency-v3 spec. All items are placed against a real
# room wall (no mid-room partitions). Scenes scale to the user's chosen
# W/D — Apply standard never reshapes a room they already dimensioned.
async def _hbn_f74_scene(room_id: str, W: float, D: float, H: float):
    """HBN Figure 74 — bedpan dirty utility (ref: 3.24 × 3.487 m).

    Macerator + basin on the WEST wall (basin ~190 mm from macerator —
    "zones touch", the F74 topology per D-1). Worktop + bedpan
    washer-disposer and dispensers on the EAST wall. Linen trolleys
    and PPE on the SOUTH wall near the door.
    """
    # Scale factors so the layout fits the user's actual room size.
    sx = W / 3.240
    sy = D / 3.487
    def ax(v): return round(v * sx, 3)   # along the N/S walls (W-length)
    def ay(v): return round(v * sy, 3)   # along the E/W walls (D-length)
    zones = {
        "dirty":      {"x": 0.0, "y": 0.0, "w": W, "d": round(D * 0.42, 3)},
        "transition": {"x": 0.0, "y": round(D * 0.42, 3), "w": W, "d": round(D * 0.22, 3)},
        "clean":      {"x": 0.0, "y": round(D * 0.64, 3), "w": W, "d": round(D * 0.36, 3)},
    }
    items = [
        # ─── WEST wall — bedpan disposal path (SOURCE + hand hygiene) ─
        _wall_item("macerator",       "W", ay(0.30),  "dirty",      W, D, h=1.4),
        _wall_item("clinical_wash_basin", "W", ay(1.00), "transition", W, D, h=0.9),
        _wall_item("paper_towel",     "W", ay(1.50),  "transition", W, D,
                   mount="wall", h=0.30, elev=1.35, back_gap=0.02),
        _wall_item("ppe_station",     "W", ay(1.80),  "transition", W, D,
                   mount="wall", h=1.00, elev=0.90, back_gap=0.02),
        _wall_item("biohazard_bin",   "W", ay(2.60),  "clean",      W, D, h=0.7),
        # ─── NORTH wall — auxiliary storage ───────────────────────────
        _wall_item("biohazard_bin",   "N", ax(0.90),  "dirty",      W, D, h=0.7),
        _wall_item("sloping_storage", "N", ax(1.60),  "dirty",      W, D,
                   mount="wall", h=0.30, elev=1.80),
        # ─── EAST wall — worktop + dispensers + linen ────────────────
        _wall_item("prep_counter",    "E", ay(0.10),  "dirty",      W, D, h=0.9),
        _wall_item("dispenser_bottle","E", ay(1.00),  "transition", W, D,
                   mount="wall", h=0.30, elev=1.50, back_gap=0.02),
        _wall_item("dispenser_bowl",  "E", ay(1.30),  "transition", W, D,
                   mount="wall", h=0.30, elev=1.50, back_gap=0.02),
        _wall_item("dispenser_bedpan","E", ay(1.60),  "transition", W, D,
                   mount="wall", h=0.30, elev=1.50, back_gap=0.02),
        _wall_item("linen_trolley",   "E", ay(2.10),  "clean",      W, D, h=1.0),
        _wall_item("linen_trolley",   "E", ay(2.65),  "clean",      W, D, h=1.0),
        # ─── SOUTH wall — entry door ─────────────────────────────────
        _wall_item("entry_door",      "S", 0.02,  "clean",      W, D, h=2.05),
        # ─── Ceiling ─────────────────────────────────────────────────
        _ceiling_item("exhaust_vent",   W - 0.90, 0.50,     "dirty",      W, D, h=0.15, elev=H - 0.15),
        _ceiling_item("ceiling_light",  W / 2,    0.60,     "dirty",      W, D, h=0.10, elev=H - 0.10),
        _ceiling_item("ceiling_light",  W / 2,    D - 0.70, "clean",      W, D, h=0.10, elev=H - 0.10),
        _ceiling_item("smoke_detector", W / 2,    D / 2,    "transition", W, D, h=0.05, elev=H - 0.05),
    ]
    return {
        "room_id": room_id, "width": W, "depth": D, "ceiling_h": H,
        "zones": zones, "items": items, "partitions": [],
        "shape": {"type": "rectangle"}, "version": 1, "updated_at": now_iso(),
    }


async def _hbn_f79_scene(room_id: str, W: float, D: float, H: float):
    """HBN Figure 79 — general dirty utility (ref: 2.0 × 3.54 m).

    No macerator; disposal via a sink + hopper cluster on the WEST wall.
    Basin on the EAST wall adjacent to the worktop ("test-then-wash"
    topology). F79 does NOT ship with an interior partition — a single
    service duct runs along the WEST wall per invariant I-7.
    """
    sx = W / 2.000
    sy = D / 3.540
    def ax(v): return round(v * sx, 3)
    def ay(v): return round(v * sy, 3)
    zones = {
        "dirty":      {"x": 0.0, "y": 0.0, "w": W, "d": round(D * 0.42, 3)},
        "transition": {"x": 0.0, "y": round(D * 0.42, 3), "w": W, "d": round(D * 0.22, 3)},
        "clean":      {"x": 0.0, "y": round(D * 0.64, 3), "w": W, "d": round(D * 0.36, 3)},
    }
    items = [
        # ─── WEST wall — disposal cluster + biohazard bins ────────────
        _wall_item("prep_counter",    "W", ay(0.80),  "dirty",      W, D, h=0.9),
        _wall_item("biohazard_bin",   "W", ay(2.30),  "transition", W, D, h=0.7),
        _wall_item("biohazard_bin",   "W", ay(2.75),  "clean",      W, D, h=0.7),
        # ─── NORTH wall — short worktop (room is narrow) ──────────────
        _wall_item("prep_counter",    "N", ax(0.40),  "dirty",      W, D, h=0.9),
        # ─── EAST wall — basin + hygiene column + PPE ─────────────────
        _wall_item("clinical_wash_basin", "E", ay(0.70), "transition", W, D, h=0.9),
        _wall_item("paper_towel",     "E", ay(1.45),  "transition", W, D,
                   mount="wall", h=0.30, elev=1.35, back_gap=0.02),
        _wall_item("ppe_station",     "E", ay(0.10),  "clean",      W, D,
                   mount="wall", h=1.00, elev=0.90, back_gap=0.02),
        _wall_item("biohazard_bin",   "E", ay(1.80),  "transition", W, D, h=0.7),
        # ─── SOUTH wall — entry door ─────────────────────────────────
        _wall_item("entry_door",      "S", 0.02,  "clean",      W, D, h=2.05),
        # ─── Ceiling ─────────────────────────────────────────────────
        _ceiling_item("exhaust_vent",   W / 2, 0.50,     "dirty",      W, D, h=0.15, elev=H - 0.15),
        _ceiling_item("ceiling_light",  W / 2, 0.80,     "dirty",      W, D, h=0.10, elev=H - 0.10),
        _ceiling_item("ceiling_light",  W / 2, D - 0.80, "clean",      W, D, h=0.10, elev=H - 0.10),
        _ceiling_item("smoke_detector", W / 2, D / 2,    "transition", W, D, h=0.05, elev=H - 0.05),
    ]
    return {
        "room_id": room_id, "width": W, "depth": D, "ceiling_h": H,
        "zones": zones, "items": items, "partitions": [],
        "shape": {"type": "rectangle"}, "version": 1, "updated_at": now_iso(),
    }

def _seed_item(component_key, x, y, zone, mount="floor", h=0.9, elev=0.0, rot=0):
    # w/d filled at fetch-time from component library
    return {
        "id": new_id(),
        "component_key": component_key,
        "x": x, "y": y, "w": 0.5, "d": 0.5,
        "rotation": int(rot) % 360, "zone": zone,
        "mount_type": mount, "elevation_m": elev, "height_m": h,
    }

# ---------------------------------------------------------------------
# Component footprints by key — used by _wall_item so the AABB stored in
# the scene already matches the item's rotation (hydration later only
# fills missing w/d; it never swaps). This keeps the three "Standard"
# templates physically correct: items are flush against the real room
# walls, not floating mid-room and not clipping through.
# ---------------------------------------------------------------------
_FOOTPRINTS = {
    "macerator":           (0.66, 0.52),
    "prep_counter":        (1.20, 0.60),
    "steel_tray":          (0.60, 0.40),
    "linen_trolley":       (0.50, 0.50),
    "biohazard_bin":       (0.35, 0.35),
    "cabinet_coshh":       (0.60, 0.35),
    "splash_panel":        (1.20, 0.05),
    "clinical_wash_basin": (0.60, 0.45),
    "soap_dispenser":      (0.15, 0.10),
    "sanitiser_unit":      (0.15, 0.10),
    "paper_towel":         (0.20, 0.10),
    "wipes_dispenser":     (0.20, 0.10),
    "ppe_station":         (0.60, 0.15),
    "sloping_storage":     (1.20, 0.30),
    "urine_scale":         (0.40, 0.30),
    "commode_store":       (0.80, 0.60),
    "entry_door":          (0.90, 0.10),
    "shelf_wall":          (0.90, 0.30),
    "shelf_bracket":       (0.60, 0.30),
    "call_lamp":           (0.12, 0.12),
    "dispenser_bottle":    (0.20, 0.10),
    "dispenser_bowl":      (0.20, 0.10),
    "dispenser_bedpan":    (0.30, 0.10),
    "connection_box_32a":  (0.16, 0.08),
    "outlet_isolator":     (0.15, 0.05),
    "cold_water_outlet":   (0.10, 0.06),
    "tundish_drain":       (0.12, 0.06),
    "data_single":         (0.09, 0.05),
    "data_double":         (0.15, 0.05),
    "socket_single":       (0.09, 0.05),
    "socket_twin":         (0.15, 0.05),
    "pressure_stabiliser": (0.30, 0.10),
    # Ceiling items (position matters, rotation symmetric)
    "exhaust_vent":        (0.60, 0.60),
    "ceiling_light":       (0.60, 0.60),
    "emergency_light":     (0.40, 0.20),
    "smoke_detector":      (0.12, 0.12),
    "presence_sensor":     (0.10, 0.10),
    "wifi_ap":             (0.20, 0.20),
}


def _wall_item(key, wall, along_m, zone, W, D,
               mount="floor", h=0.9, elev=0.0,
               along_gap=0.0, back_gap=0.0, size=None, margin=0.05):
    """Place a wall-mounted or floor-standing item flush against a wall.

    - wall: "N" (top, y=0), "S" (bottom, y=D), "W" (left, x=0), "E" (right, x=W)
    - along_m: distance along the wall from the near-left corner
    - back_gap: optional offset AWAY from the wall (e.g. 0.02 for wall items
      that need a nominal clearance)
    - Uses `_FOOTPRINTS[key]` to compute an AABB that already accounts for
      the item's rotation — the stored (w, d) match the on-screen footprint
      so collision, validation and overlap tests behave correctly.
    """
    rot_map = {"N": 0, "S": 180, "W": 270, "E": 90}
    rot = rot_map[wall]
    w0, d0 = size or _FOOTPRINTS.get(key, (0.5, 0.5))
    if wall in ("W", "E"):
        aw, ad = d0, w0
        x = (back_gap if wall == "W" else max(0.0, W - aw - back_gap))
        # Clamp so the item never overflows the wall. 50 mm end-margin.
        y = max(margin, min(D - ad - margin, along_m))
    else:
        aw, ad = w0, d0
        x = max(margin, min(W - aw - margin, along_m))
        y = (back_gap if wall == "N" else max(0.0, D - ad - back_gap))
    return {
        "id": new_id(),
        "component_key": key,
        "x": round(x, 3), "y": round(y, 3),
        "w": round(aw, 3), "d": round(ad, 3),
        "rotation": rot, "zone": zone,
        "mount_type": mount, "elevation_m": elev, "height_m": h,
    }


def _ceiling_item(key, cx, cy, zone, W, D, h=0.1, elev=2.6, size=None):
    """Place a ceiling-mounted item centered at (cx, cy), clipped inside
    the room with a 50 mm margin."""
    w0, d0 = size or _FOOTPRINTS.get(key, (0.5, 0.5))
    x = max(0.05, min(W - w0 - 0.05, cx - w0 / 2))
    y = max(0.05, min(D - d0 - 0.05, cy - d0 / 2))
    return {
        "id": new_id(),
        "component_key": key,
        "x": round(x, 3), "y": round(y, 3),
        "w": round(w0, 3), "d": round(d0, 3),
        "rotation": 0, "zone": zone,
        "mount_type": "ceiling", "elevation_m": elev, "height_m": h,
    }


_REVIT_EX01 = _json.loads((Path(__file__).parent / "standards" / "revit_example_01.json").read_text())


def _zone_for_y(cy, D):
    return "dirty" if cy < D * 0.42 else ("transition" if cy < D * 0.64 else "clean")


async def _revit_ex01_scene(room_id: str, W: float, D: float, H: float):
    """Layout extracted from the Revit 2026 IFC export (dirty_utility_Example_01).
    Real component sizes are kept; positions are re-fitted to the target room
    by anchoring each item to its nearer wall corner in the source model."""
    src = _REVIT_EX01["room"]
    SW, SD = src["width"], src["depth"]
    zones = {
        "dirty":      {"x": 0.0, "y": 0.0,  "w": W, "d": round(D * 0.42, 3)},
        "transition": {"x": 0.0, "y": round(D * 0.42, 3), "w": W, "d": round(D * 0.22, 3)},
        "clean":      {"x": 0.0, "y": round(D * 0.64, 3), "w": W, "d": round(D * 0.36, 3)},
    }
    items = []
    for e in _REVIT_EX01["wall_items"]:
        src_len, new_len = (SW, W) if e["wall"] in ("N", "S") else (SD, D)
        along = e["along"]
        if along + e["len"] / 2 > src_len / 2:
            along = new_len - (src_len - along)
        it = _wall_item(e["key"], e["wall"], along, "dirty", W, D,
                        mount=e["mount"], h=e["h"], elev=e["elev"],
                        back_gap=e["back"], size=(e["len"], e["depth"]), margin=0.0)
        it["zone"] = _zone_for_y(it["y"] + it["d"] / 2, D)
        it["revit_family"] = e["revit"]
        items.append(it)
    for e in _REVIT_EX01["ceiling_items"]:
        cx, cy = e["cx"] * W / SW, e["cy"] * D / SD
        it = _ceiling_item(e["key"], cx, cy, _zone_for_y(cy, D), W, D,
                           h=e["h"], elev=H - e["h"], size=(e["w"], e["d"]))
        it["revit_family"] = e["revit"]
        items.append(it)
    fl = [i for i in items if i["mount_type"] == "floor"]
    clashes = sum(1 for n, a in enumerate(fl) for b in fl[n + 1:]
                  if a["x"] < b["x"] + b["w"] - 0.01 and b["x"] < a["x"] + a["w"] - 0.01
                  and a["y"] < b["y"] + b["d"] - 0.01 and b["y"] < a["y"] + a["d"] - 0.01)
    return {
        "room_id": room_id, "width": W, "depth": D, "ceiling_h": H,
        "zones": zones, "items": items, "partitions": [],
        "shape": {"type": "rectangle"}, "version": 1, "updated_at": now_iso(),
        "source": _REVIT_EX01["source"],
        "fit_warning": (f"Room is smaller than the Revit model ({SW} × {SD} m): "
                        f"{clashes} floor item overlap(s) to resolve.") if clashes else None,
    }


async def _hydrate_scene_items(scene):
    """Fill w/d/kind/material from component library defaults."""
    comps = {c["key"]: c for c in await db.components.find({}, {"_id": 0}).to_list(2000)}
    for it in scene.get("items", []):
        c = comps.get(it["component_key"])
        if not c: continue
        if not it.get("revit_family") and (it.get("w", 0) < 0.05 or it.get("d", 0) < 0.05 or (it.get("w") == 0.5 and it.get("d") == 0.5)):
            it["w"] = c["default_footprint"].get("w", 0.5)
            it["d"] = c["default_footprint"].get("d", 0.5)
        it["kind"] = c.get("kind", "cabinet")
        it["material"] = c.get("material", "laminate")
        it["code"] = c.get("code", "")
    return scene

@api.get("/rooms/{room_id}/scene")
async def get_scene(room_id: str, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene:
        # New rooms open EMPTY. Users seed equipment via the palette or
        # by tapping the "Standard" button in the top bar which lets
        # them choose HBN (bedpan/general) or NHP V2.
        scene = await _empty_scene(room_id)
        scene = await _hydrate_scene_items(scene)
        await db.scenes.insert_one({**scene})
        scene.pop("_id", None)
    else:
        # Idempotent hydration for scenes saved before latest schema
        scene = await _hydrate_scene_items(scene)
    # Audit: log opens only for utility rooms owned by another user (not
    # the owner themselves, so History doesn't spam owner self-opens).
    node = await db.hierarchy.find_one({"id": room_id},
                                       {"_id": 0, "owner_id": 1, "type": 1})
    if node and node.get("type") == "utility" and node.get("owner_id") \
       and node.get("owner_id") != user.get("id"):
        await _audit_log(room_id, user, "opened")
    return scene


# ---------------------------------------------------------------------
# Room password lock (soft, session-cached in the client).
# Stored as bcrypt hash in db.room_locks; keyed by room_id. When set,
# the frontend prompts once per room and caches a boolean in sessionStorage.
# The gate is at the UX layer only — REST endpoints stay authenticated but
# unlocked, so a bad actor with the auth cookie could still hit them.
# For an initial "invite-only sharing" feature this is enough.
# ---------------------------------------------------------------------

@api.get("/rooms/{room_id}/lock")
async def get_room_lock_status(room_id: str, user=Depends(_room_access)):
    doc = await db.room_locks.find_one({"room_id": room_id}, {"_id": 0})
    return {"locked": bool(doc), "set_by": (doc or {}).get("set_by")}

class RoomLockIn(BaseModel):
    password: str

@api.post("/rooms/{room_id}/lock")
async def set_room_lock(room_id: str, body: RoomLockIn, user=Depends(_room_access)):
    pw = (body.password or "").strip()
    if len(pw) < 4:
        raise HTTPException(400, "Password must be at least 4 characters.")
    ph = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
    await db.room_locks.update_one(
        {"room_id": room_id},
        {"$set": {"room_id": room_id, "password_hash": ph,
                  "set_by": user["email"], "set_at": now_iso()}},
        upsert=True,
    )
    return {"ok": True, "locked": True, "set_by": user["email"]}

@api.delete("/rooms/{room_id}/lock")
async def clear_room_lock(room_id: str, user=Depends(_room_access)):
    await db.room_locks.delete_one({"room_id": room_id})
    return {"ok": True, "locked": False}

@api.post("/rooms/{room_id}/lock/verify")
async def verify_room_lock(room_id: str, body: RoomLockIn, user=Depends(_room_access)):
    doc = await db.room_locks.find_one({"room_id": room_id})
    if not doc:
        return {"ok": True, "locked": False}
    ph = (doc.get("password_hash") or "").encode()
    if not ph or not bcrypt.checkpw((body.password or "").encode(), ph):
        raise HTTPException(401, "Wrong password.")
    return {"ok": True, "locked": True}


# ---------------------------------------------------------------------
# Team invites — Estate / Building / Room level. Emits a shareable
# token URL; recipients accept it to gain a role on that scope.
# Enforcement is at the UX layer for the pilot: the invite creates
# an `access_grants` record which the frontend can display alongside
# hierarchy nodes so owners see who has access.
# ---------------------------------------------------------------------

ALLOWED_INVITE_SCOPES = {"estate", "building", "room"}
ALLOWED_INVITE_ROLES  = {"architect", "ipc", "engineer", "clinician", "viewer"}

class InviteIn(BaseModel):
    scope: str                     # "estate" | "building" | "room"
    scope_id: Optional[str] = None # required for building / room
    role: Optional[str] = "viewer"
    ttl_hours: Optional[int] = 168 # 7 days default
    note: Optional[str] = None

class InviteAcceptIn(BaseModel):
    token: str

def _new_invite_token() -> str:
    # 24-char URL-safe token — enough entropy for a shareable link
    import secrets
    return secrets.token_urlsafe(18)

@api.post("/invites")
async def create_invite(body: InviteIn, user=Depends(get_current_user)):
    scope = (body.scope or "").lower().strip()
    role  = (body.role  or "viewer").lower().strip()
    if scope not in ALLOWED_INVITE_SCOPES:
        raise HTTPException(400, f"scope must be one of {sorted(ALLOWED_INVITE_SCOPES)}")
    if role not in ALLOWED_INVITE_ROLES:
        raise HTTPException(400, f"role must be one of {sorted(ALLOWED_INVITE_ROLES)}")
    if scope in ("building", "room") and not body.scope_id:
        raise HTTPException(400, "scope_id is required for building / room invites.")
    ttl_hours = max(1, min(int(body.ttl_hours or 168), 24 * 30))  # 1h .. 30 days
    expires_at = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    invite = {
        "id": new_id(),
        "token": _new_invite_token(),
        "scope": scope,
        "scope_id": body.scope_id,
        "role": role,
        "note": (body.note or None),
        "invited_by": user["email"],
        "invited_by_name": user.get("name"),
        "created_at": now_iso(),
        "expires_at": expires_at.isoformat(),
        "accepted_by": [],
    }
    await db.invites.insert_one({**invite})
    invite.pop("_id", None)
    if scope == "room" and body.scope_id:
        await _audit_log(body.scope_id, user, "invited",
                         {"role": role, "note": (body.note or None)})
    return invite

@api.get("/invites")
async def list_invites(scope: Optional[str] = None, scope_id: Optional[str] = None,
                       user=Depends(get_current_user)):
    q = {"invited_by": user["email"]}
    if scope: q["scope"] = scope
    if scope_id: q["scope_id"] = scope_id
    docs = await db.invites.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs

@api.delete("/invites/{invite_id}")
async def revoke_invite(invite_id: str, user=Depends(get_current_user)):
    r = await db.invites.delete_one({"id": invite_id, "invited_by": user["email"]})
    if r.deleted_count == 0:
        raise HTTPException(404, "Invite not found or not yours.")
    return {"ok": True}

@api.post("/invites/preview")
async def preview_invite(body: InviteAcceptIn):
    """Public: given a token, describe the invite (scope, role, inviter)
    without accepting it. Used by the accept UI to show the invitation
    before the recipient signs in / continues as guest."""
    doc = await db.invites.find_one({"token": body.token}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Invite not found or has expired.")
    # Auto-expire check
    try:
        if doc.get("expires_at") and datetime.fromisoformat(doc["expires_at"]) < datetime.now(timezone.utc):
            raise HTTPException(410, "Invite has expired.")
    except ValueError:
        pass
    # Hydrate scope name for a nicer prompt
    scope_name = None
    if doc.get("scope") in ("building", "room") and doc.get("scope_id"):
        n = await db.hierarchy.find_one({"id": doc["scope_id"]}, {"_id": 0, "name": 1})
        scope_name = (n or {}).get("name")
    return {
        "scope": doc["scope"], "scope_id": doc.get("scope_id"),
        "scope_name": scope_name,
        "role": doc["role"], "invited_by": doc.get("invited_by_name") or doc.get("invited_by"),
        "note": doc.get("note"),
    }

@api.post("/invites/accept")
async def accept_invite(body: InviteAcceptIn, user=Depends(get_current_user)):
    doc = await db.invites.find_one({"token": body.token})
    if not doc:
        raise HTTPException(404, "Invite not found or has expired.")
    try:
        if doc.get("expires_at") and datetime.fromisoformat(doc["expires_at"]) < datetime.now(timezone.utc):
            raise HTTPException(410, "Invite has expired.")
    except ValueError:
        pass
    # Record the grant (idempotent)
    grant_key = {"user_id": user["id"], "scope": doc["scope"],
                 "scope_id": doc.get("scope_id")}
    await db.access_grants.update_one(
        grant_key,
        {"$set": {**grant_key, "role": doc["role"],
                  "granted_by": doc.get("invited_by"),
                  "granted_at": now_iso(),
                  "invite_id": doc["id"]}},
        upsert=True,
    )
    await db.invites.update_one(
        {"id": doc["id"]},
        {"$addToSet": {"accepted_by": {"user_id": user["id"], "email": user["email"],
                                       "name": user.get("name"), "at": now_iso()}}},
    )
    # If the invite carries a personal note (Sharing panel supports this),
    # deliver it as a user_note to the accepter so they see it on next visit.
    if doc.get("note") and doc.get("scope") == "room" and doc.get("scope_id"):
        room = await db.hierarchy.find_one({"id": doc["scope_id"]},
                                           {"_id": 0, "name": 1})
        inviter = {
            "id": None, "email": doc.get("invited_by"),
            "name": doc.get("invited_by_name") or doc.get("invited_by"),
        }
        await _create_user_note(
            recipient_user_id=user["id"], from_user=inviter,
            room_id=doc["scope_id"], room_name=(room or {}).get("name"),
            action="invited", note=(doc.get("note") or "")[:240],
        )
    return {"ok": True, "scope": doc["scope"], "scope_id": doc.get("scope_id"),
            "role": doc["role"]}

@api.get("/access-grants")
async def list_my_grants(user=Depends(get_current_user)):
    docs = await db.access_grants.find({"user_id": user["id"]}, {"_id": 0}).to_list(500)
    return docs

@api.put("/rooms/{room_id}/scene")
async def put_scene(room_id: str, body: SceneIn, user=Depends(_room_access)):
    items = []
    for it in body.items:
        d = it.model_dump()
        d["id"] = d.get("id") or new_id()
        items.append(d)
    existing = await db.scenes.find_one({"room_id": room_id})
    version = (existing.get("version", 0) if existing else 0) + 1
    last_edited_by = {
        "email":       user.get("email"),
        "name":        user.get("name") or user.get("email"),
        "avatar_url":  user.get("avatar_url"),
        "role":        user.get("role"),
    }
    doc = {"room_id": room_id, "width": body.width, "depth": body.depth,
           "zones": body.zones or (existing["zones"] if existing else {}),
           "items": items, "version": version, "updated_at": now_iso(),
           "last_edited_by": last_edited_by,
           "last_edited_at": now_iso(),
           "partitions": body.partitions if body.partitions is not None else (existing or {}).get("partitions", []),
           "shape": body.shape if body.shape is not None else (existing or {}).get("shape", {"type": "rectangle"}),
           "ceiling_h": body.ceiling_h if body.ceiling_h is not None else (existing or {}).get("ceiling_h", 2.7)}
    await db.scenes.update_one({"room_id": room_id}, {"$set": doc}, upsert=True)
    await db.changelog.insert_one({"id": new_id(), "room_id": room_id,
        "author": user["email"], "role": user["role"], "timestamp": now_iso(),
        "delta_summary": f"scene v{version} saved ({len(items)} items)", "version": version})
    await _audit_log(room_id, user, "edited",
                     {"version": version, "items": len(items)})
    doc.pop("_id", None)
    return await _hydrate_scene_items(doc)


@api.get("/rooms/last-edits")
async def rooms_last_edits(user=Depends(get_current_user)):
    """Return a compact map of `{room_id: {name, email, avatar_url, at}}`
    for every persisted scene, so the Dashboard can render a
    "Last edited by …" pill on each room card without N round-trips."""
    out = {}
    async for s in db.scenes.find(
        {"last_edited_by": {"$exists": True}},
        {"_id": 0, "room_id": 1, "last_edited_by": 1, "last_edited_at": 1, "updated_at": 1, "version": 1},
    ):
        out[s["room_id"]] = {
            "by": s.get("last_edited_by") or {},
            "at": s.get("last_edited_at") or s.get("updated_at"),
            "version": s.get("version", 1),
        }
    return out

@api.get("/rooms/{room_id}/changelog")
async def get_changelog(room_id: str, user=Depends(_room_access)):
    return await db.changelog.find({"room_id": room_id}, {"_id": 0}).sort("timestamp", -1).to_list(500)

@api.post("/rooms/{room_id}/reset")
async def reset_scene(room_id: str, user=Depends(_room_access)):
    """Reset the room back to a completely empty scene (default). Users
    then re-populate via the palette OR the `Standard` button."""
    await db.scenes.delete_one({"room_id": room_id})
    scene = await _empty_scene(room_id)
    scene = await _hydrate_scene_items(scene)
    await db.scenes.insert_one({**scene})
    scene.pop("_id", None)
    return scene


@api.get("/adjacency/v3")
async def get_adjacency_v3():
    """Return the full v3 adjacency + placement spec bundle (roles,
    invariants, profile deltas, editable parameters, 29 relations).
    Public — no PII, this is the design methodology reference the UI
    and future validator work read from. Sourced from
    `backend/adjacency_v3.json` (see the tracked
    `dirty_utility_adjacency_logic_v3.md` upstream)."""
    p = ROOT_DIR / "adjacency_v3.json"
    if not p.exists():
        raise HTTPException(500, "adjacency v3 bundle missing")
    return _json.loads(p.read_text())


@api.post("/rooms/{room_id}/apply-standard")
async def apply_standard(room_id: str, body: dict, user=Depends(_room_access)):
    """Replace the current scene with a standards-compliant layout.

    Body: `{"standard": "hbn_f74" | "hbn_f79" | "nhp_v2"}`

    - `nhp_v2`   → the NHP RDS 6222 medium inpatient dirty utility. This
                   is what shipped as the previous `_default_scene` — 3.615 ×
                   2.5 m, macerator on the north-east wall, basin on the
                   IPS partition, dry work on the west wall, three linen
                   trolleys on the south wall.
    - `hbn_f74`  → HBN 00-10 Fig 74 bedpan dirty utility (3.24 × 3.487 m).
                   Basin + macerator on the west wall, worktop + bedpan
                   washer on the east wall, disposal skips on the south.
    - `hbn_f79`  → HBN 00-10 Fig 79 general dirty utility (2.0 × 3.54 m).
                   Long narrow layout, worktop north, basin east.
    """
    std = (body or {}).get("standard", "").lower()
    if std not in {"hbn_f74", "hbn_f79", "nhp_v2", "revit_ex01"}:
        raise HTTPException(400, "standard must be one of hbn_f74 / hbn_f79 / nhp_v2 / revit_ex01")

    # Look up the room's declared dimensions so the standard scales to
    # whatever the user's room already is — otherwise picking HBN F79
    # would silently reshape a 3.6 m × 2.5 m room.
    room = await db.rooms.find_one({"id": room_id}, {"_id": 0, "width_m": 1, "depth_m": 1, "ceiling_h_m": 1})
    cur = await db.scenes.find_one({"room_id": room_id}, {"_id": 0, "width": 1, "depth": 1, "ceiling_h": 1}) or {}
    W = float((room or {}).get("width_m") or cur.get("width") or 3.615)
    D = float((room or {}).get("depth_m") or cur.get("depth") or 2.5)
    H = float((room or {}).get("ceiling_h_m") or cur.get("ceiling_h") or 2.7)

    if   std == "revit_ex01": scene = await _revit_ex01_scene(room_id, W, D, H)
    elif std == "nhp_v2":  scene = await _nhp_v2_scene(room_id, W, D, H)
    elif std == "hbn_f74": scene = await _hbn_f74_scene(room_id, W, D, H)
    else:                  scene = await _hbn_f79_scene(room_id, W, D, H)

    scene["standard_applied"] = std
    scene = await _hydrate_scene_items(scene)
    await db.scenes.replace_one({"room_id": room_id}, scene, upsert=True)
    await db.changelog.insert_one({
        "id": new_id(), "room_id": room_id, "author": user["email"], "role": user.get("role", ""),
        "timestamp": now_iso(),
        "delta_summary": f"applied {std.upper()} standard layout ({len(scene.get('items', []))} items)",
        "version": scene.get("version", 1),
    })
    scene.pop("_id", None)
    return scene

# ---------- Wall / partition geometry helpers ------------------------------
def _wall_candidates(scene):
    """Enumerate every valid mount surface in the scene as a list of
    (name, kind, x1, y1, x2, y2, expected_rot) tuples. `kind` is either
    `wall` (room boundary), `partition` (user-drawn interior) or
    `zone_edge` (transition-band partition inferred from zones).
    """
    W = scene.get("width", 3.0); D = scene.get("depth", 3.0)
    out = [
        ("top",    "wall", 0, 0, W, 0, 0),      # working face points +Y
        ("bottom", "wall", 0, D, W, D, 180),    # working face points -Y
        ("left",   "wall", 0, 0, 0, D, 270),    # working face points +X
        ("right",  "wall", W, 0, W, D, 90),     # working face points -X
    ]
    # Transition-band edges (traditional IPS panel line between zones).
    for zk, zv in (scene.get("zones") or {}).items():
        out.append((f"{zk} partition (top)",    "zone_edge", 0, zv["y"],           W, zv["y"],           0))
        out.append((f"{zk} partition (bottom)", "zone_edge", 0, zv["y"]+zv["d"],   W, zv["y"]+zv["d"],   180))
    # User-drawn interior partitions.
    for p in (scene.get("partitions") or []):
        # A partition is a horizontal or vertical segment. Compute rotation
        # for the side that opens onto the larger clear frontage — for a
        # canonical horizontal partition we default to "face +Y", vertical
        # partition to "face +X". The snap-to-wall picks the correct side.
        x1, y1, x2, y2 = float(p["x1"]), float(p["y1"]), float(p["x2"]), float(p["y2"])
        pid = p.get("id", "partition")
        # Two-sided partition — emit both faces so the snap picks the closer.
        if abs(y2 - y1) < 0.05:   # horizontal
            out.append((f"partition {pid} (south face)", "partition", min(x1,x2), y1, max(x1,x2), y1, 0))
            out.append((f"partition {pid} (north face)", "partition", min(x1,x2), y1, max(x1,x2), y1, 180))
        elif abs(x2 - x1) < 0.05: # vertical
            out.append((f"partition {pid} (east face)",  "partition", x1, min(y1,y2), x1, max(y1,y2), 270))
            out.append((f"partition {pid} (west face)",  "partition", x1, min(y1,y2), x1, max(y1,y2), 90))
        # Non-axis-aligned partitions are ignored for orientation math.
    return out

def _dist_item_to_segment(it, seg):
    """Perpendicular distance from an item's nearest edge to a wall/partition
    segment, plus whether the item's projection lands on the segment. Returns
    (distance, on_segment_bool)."""
    _, _, x1, y1, x2, y2, _ = seg
    cx = it["x"] + it["w"] / 2
    cy = it["y"] + it["d"] / 2
    if abs(y2 - y1) < 0.05:      # horizontal segment
        # Item's north edge or south edge — whichever is closer.
        d = min(abs(it["y"] - y1), abs(it["y"] + it["d"] - y1))
        on_seg = (cx >= min(x1, x2) - 0.05) and (cx <= max(x1, x2) + 0.05)
    elif abs(x2 - x1) < 0.05:    # vertical segment
        d = min(abs(it["x"] - x1), abs(it["x"] + it["w"] - x1))
        on_seg = (cy >= min(y1, y2) - 0.05) and (cy <= max(y1, y2) + 0.05)
    else:
        return (999.0, False)
    return (d, on_seg)

def _nearest_wall_for_item(it, scene):
    """Return the (name, kind, expected_rot, distance, segment) of the wall
    or partition an item should sit against. Considers only surfaces the
    item's centre projects onto (so a wall shelf pushed to the far end of
    the room doesn't snap onto a wall it doesn't span).

    Ties are broken by preferring surfaces that belong to the item's own
    `zone` — a wall item in the transition zone sitting on the y=1.05 line
    should hang on the *transition* partition (facing south into the
    transition band), not the dirty partition (facing north)."""
    best = None
    item_zone = it.get("zone")
    for seg in _wall_candidates(scene):
        d, on_seg = _dist_item_to_segment(it, seg)
        if not on_seg:
            continue
        name = seg[0]
        # A tiny bias so a same-zone partition wins a distance tie against
        # any other edge on the same line.
        zone_bias = 0.0
        if item_zone and item_zone in name:
            zone_bias = -0.001
        keyed = d + zone_bias
        if best is None or keyed < best[0]:
            best = (keyed, d, seg)
    if best is None:
        return None
    _, d, (name, kind, x1, y1, x2, y2, rot) = best
    return {"name": name, "kind": kind, "expected_rot": rot, "distance": d,
            "seg": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}}

def _snap_item_to_wall(it, scene, placement=None):
    """Mutate `it` so it sits flush against the closest valid mount surface
    and its working face points into the room. Corner-aware: if the item
    is within 30 cm of *two* adjacent room walls, prefers the wall giving
    the larger clear frontage (item's own long side runs along that wall).

    `placement` — if provided, refines which surfaces count:
      * `against_wall`   → only room walls (partitions rejected — a heavy
                           floor unit like a macerator should sit on a
                           real wall, not a mid-room panel);
      * `wall_mounted`   → room walls, transition-band edges, and
                           user-drawn partitions all count."""
    W = scene.get("width", 3.0); D = scene.get("depth", 3.0)
    # Corner detection first — take the two nearest room walls.
    d_north = it["y"]
    d_south = D - (it["y"] + it["d"])
    d_west  = it["x"]
    d_east  = W - (it["x"] + it["w"])
    walls = sorted([("top", d_north, 0), ("bottom", d_south, 180),
                    ("left", d_west, 270), ("right", d_east, 90)],
                   key=lambda x: x[1])
    if walls[1][1] < 0.30 and walls[0][1] < 0.30:
        # Corner. Prefer the wall aligned to the item's longer side so the
        # working face has the wider clear frontage.
        w, d = it.get("w", 0.5), it.get("d", 0.5)
        long_axis_is_x = w >= d
        preferred = [nm for nm, _, _ in walls[:2] if (nm in ("top", "bottom")) == long_axis_is_x]
        chosen = preferred[0] if preferred else walls[0][0]
        target = next(x for x in walls if x[0] == chosen)
        name, _, rot = target
    else:
        # No corner. For `against_wall` floor units, restrict to real room
        # walls; for wall-mounted items, allow every mount surface.
        if placement == "against_wall":
            name, _, rot = walls[0]
        else:
            near = _nearest_wall_for_item(it, scene)
            if near is None:
                name, _, rot = walls[0]
            else:
                name, rot = near["name"], near["expected_rot"]
    # Apply the snap.
    if   name == "top":    it["y"] = 0.0
    elif name == "bottom": it["y"] = D - it["d"]
    elif name == "left":   it["x"] = 0.0
    elif name == "right":  it["x"] = W - it["w"]
    else:
        # Partition or zone edge — snap so the item's near edge lands on the segment.
        near = _nearest_wall_for_item(it, scene)
        if near:
            seg = near["seg"]
            if abs(seg["y2"] - seg["y1"]) < 0.05:  # horizontal
                py = seg["y1"]
                if abs(it["y"] - py) <= abs(it["y"] + it["d"] - py):
                    it["y"] = py
                else:
                    it["y"] = py - it["d"]
            elif abs(seg["x2"] - seg["x1"]) < 0.05:  # vertical
                px = seg["x1"]
                if abs(it["x"] - px) <= abs(it["x"] + it["w"] - px):
                    it["x"] = px
                else:
                    it["x"] = px - it["w"]
    it["rotation"] = int(rot) % 360
    return it

@api.post("/rooms/{room_id}/items/{item_id}/snap-to-wall")
async def snap_item_to_wall(room_id: str, item_id: str, user=Depends(_room_access)):
    """One-click auto-fix for ORIENT-* flags. Pulls the item flush to the
    closest valid mount surface (room wall, transition-band partition or a
    user-drawn interior partition) and rotates the working face inward."""
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene:
        raise HTTPException(404, "Scene not found")
    item = next((it for it in scene.get("items", []) if it.get("id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not found")
    # Look up placement so `against_wall` items don't get snapped to a
    # mid-room partition when they should be on a real wall.
    comp = await db.components.find_one({"key": item["component_key"]}, {"_id": 0})
    placement = (comp or {}).get("placement")
    before = {"x": item["x"], "y": item["y"], "rotation": item.get("rotation", 0)}
    _snap_item_to_wall(item, scene, placement=placement)
    version = scene.get("version", 0) + 1
    await db.scenes.update_one(
        {"room_id": room_id},
        {"$set": {"items": scene["items"], "version": version, "updated_at": now_iso()}},
    )
    await db.changelog.insert_one({"id": new_id(), "room_id": room_id,
        "author": user["email"], "role": user["role"], "timestamp": now_iso(),
        "delta_summary": f"Snap-to-wall on {item.get('component_key')} "
                         f"({before['x']:.2f},{before['y']:.2f},{before['rotation']}°) → "
                         f"({item['x']:.2f},{item['y']:.2f},{item['rotation']}°)",
        "version": version})
    return {"ok": True, "item": item, "before": before}

@api.post("/rooms/{room_id}/orient/preview")
async def orient_preview(room_id: str, user=Depends(_room_access)):
    """Compute what a full Snap-to-wall sweep would do WITHOUT persisting.
    Returns a list of diffs `[{item_id, component_key, before:{x,y,rotation},
    after:{x,y,rotation}}]` so the UI can render a side-by-side preview and
    let the user confirm before touching the scene."""
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found")
    comps = { c["key"]: c async for c in db.components.find({}, {"_id": 0}) }
    diffs = []
    for it in scene.get("items", []):
        placement = (comps.get(it["component_key"]) or {}).get("placement")
        if placement not in ("wall_mounted", "against_wall"):
            continue
        near = _nearest_wall_for_item(it, scene)
        if near is None:
            continue
        tol = 0.05 if placement == "wall_mounted" else 0.10
        rotation_ok = int(it.get("rotation", 0)) % 90 == 0 and int(it.get("rotation", 0)) % 360 == near["expected_rot"]
        distance_ok = near["distance"] <= tol
        if rotation_ok and distance_ok:
            continue
        candidate = {**it}
        _snap_item_to_wall(candidate, scene, placement=placement)
        # Only include if position OR rotation actually changed.
        if abs(candidate["x"] - it["x"]) > 1e-4 or abs(candidate["y"] - it["y"]) > 1e-4 \
                or int(candidate["rotation"]) != int(it.get("rotation", 0)):
            # Derive the wall from where the item ACTUALLY landed after the snap
            # so the diff label agrees with what apply will do.
            W, D = scene.get("width", 3.0), scene.get("depth", 3.0)
            wall_lbl = (
                "top wall"    if candidate["y"] < 0.02 else
                "bottom wall" if candidate["y"] + candidate["d"] > D - 0.02 else
                "left wall"   if candidate["x"] < 0.02 else
                "right wall"  if candidate["x"] + candidate["w"] > W - 0.02 else
                near["name"]
            )
            diffs.append({
                "item_id": it["id"],
                "component_key": it["component_key"],
                "component_name": (comps.get(it["component_key"]) or {}).get("name", it["component_key"]),
                "wall": wall_lbl,
                "before": {"x": round(it["x"], 3), "y": round(it["y"], 3), "rotation": int(it.get("rotation", 0))},
                "after":  {"x": round(candidate["x"], 3), "y": round(candidate["y"], 3), "rotation": int(candidate["rotation"])},
            })
    return {"diffs": diffs}

@api.post("/rooms/{room_id}/orient/apply")
async def orient_apply(room_id: str, body: Dict[str, Any] = Body(default={}),
                       user=Depends(_room_access)):
    """Apply the sweep. `body.item_ids` (optional) restricts the fix to a
    specific subset — omit to apply to every orient-violating item."""
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found")
    comps = { c["key"]: c async for c in db.components.find({}, {"_id": 0}) }
    filter_ids = set(body.get("item_ids") or [])
    n = 0
    for it in scene.get("items", []):
        if filter_ids and it["id"] not in filter_ids:
            continue
        placement = (comps.get(it["component_key"]) or {}).get("placement")
        if placement not in ("wall_mounted", "against_wall"):
            continue
        near = _nearest_wall_for_item(it, scene)
        if near is None:
            continue
        before_pos = (it["x"], it["y"], it.get("rotation", 0))
        _snap_item_to_wall(it, scene, placement=placement)
        after_pos = (it["x"], it["y"], it["rotation"])
        if before_pos != after_pos:
            n += 1
    version = scene.get("version", 0) + 1
    await db.scenes.update_one({"room_id": room_id},
        {"$set": {"items": scene["items"], "version": version, "updated_at": now_iso()}})
    await db.changelog.insert_one({"id": new_id(), "room_id": room_id,
        "author": user["email"], "role": user["role"], "timestamp": now_iso(),
        "delta_summary": f"Auto-fix orientation — snapped {n} component(s) to walls",
        "version": version})
    return {"ok": True, "snapped": n}






# ---------- Validation Engine ----------
def _rects_overlap_2d(a, b, tol=0.001):
    return (a["x"] + a["w"] - tol > b["x"] and b["x"] + b["w"] - tol > a["x"]
        and a["y"] + a["d"] - tol > b["y"] and b["y"] + b["d"] - tol > a["y"])

def _vertical_overlap(a, b, tol=0.005):
    a1 = a.get("elevation_m", 0); a2 = a1 + a.get("height_m", 0.9)
    b1 = b.get("elevation_m", 0); b2 = b1 + b.get("height_m", 0.9)
    return a2 - tol > b1 and b2 - tol > a1

# ---------- Polygon (rect-minus-notch) helpers -----------------------------
def _room_notch(scene):
    """Return the cutout rect {x,y,w,d} for L/T/U shapes, or None for rect."""
    shape = scene.get("shape") or {}
    if shape.get("type") in (None, "rectangle"): return None
    notch = shape.get("notch")
    if not notch: return None
    try:
        return {"x": float(notch["x"]), "y": float(notch["y"]),
                "w": float(notch["w"]), "d": float(notch["d"])}
    except (KeyError, TypeError, ValueError):
        return None

def _point_in_room(px, py, scene):
    """True if (px,py) is inside the room polygon (rect minus notch)."""
    W, D = scene.get("width", 3.0), scene.get("depth", 3.0)
    if px < 0 or py < 0 or px > W or py > D: return False
    n = _room_notch(scene)
    if not n: return True
    return not (n["x"] <= px <= n["x"] + n["w"] and n["y"] <= py <= n["y"] + n["d"])

def _rect_overlaps_notch(item, scene, tol=0.001):
    """True if the item footprint overlaps the cutout rect."""
    n = _room_notch(scene)
    if not n: return False
    return _rects_overlap_2d(
        {"x": item["x"], "y": item["y"], "w": item["w"], "d": item["d"]},
        n, tol=tol)

def _room_polygon(scene):
    """Return the room boundary as an ordered list of (x,y) vertices.

    Rectangle → 4 corners.  L/T/U → 6+ vertices tracing around the notch.
    The polygon is used by the A* pathfinder and the walls generator.
    """
    W, D = scene.get("width", 3.0), scene.get("depth", 3.0)
    n = _room_notch(scene)
    if not n:
        return [(0, 0), (W, 0), (W, D), (0, D)]
    nx, ny, nw, nd = n["x"], n["y"], n["w"], n["d"]
    nx2, ny2 = nx + nw, ny + nd
    # Clamp notch inside room
    nx = max(0.0, min(nx, W)); ny = max(0.0, min(ny, D))
    nx2 = max(0.0, min(nx2, W)); ny2 = max(0.0, min(ny2, D))
    # Determine which edge the notch touches. Only one edge is expected.
    on_top    = ny <= 1e-6
    on_bottom = ny2 >= D - 1e-6
    on_left   = nx <= 1e-6
    on_right  = nx2 >= W - 1e-6
    if on_top and on_right:  # far corner — L-shape variant used by UI default
        return [(0, 0), (nx, 0), (nx, ny2), (W, ny2), (W, D), (0, D)]
    if on_top and on_left:
        return [(nx2, 0), (W, 0), (W, D), (0, D), (0, ny2), (nx2, ny2)]
    if on_bottom and on_right:
        return [(0, 0), (W, 0), (W, ny), (nx, ny), (nx, D), (0, D)]
    if on_bottom and on_left:
        return [(0, 0), (W, 0), (W, D), (nx2, D), (nx2, ny), (0, ny)]
    if on_top:  # notch cuts the top edge (T-shape)
        return [(0, 0), (nx, 0), (nx, ny2), (nx2, ny2), (nx2, 0),
                (W, 0), (W, D), (0, D)]
    if on_bottom:  # notch cuts the bottom edge
        return [(0, 0), (W, 0), (W, D), (nx2, D), (nx2, ny),
                (nx, ny), (nx, D), (0, D)]
    if on_left:
        return [(0, 0), (W, 0), (W, D), (0, D), (0, ny2),
                (nx2, ny2), (nx2, ny), (0, ny)]
    if on_right:
        return [(0, 0), (W, 0), (W, ny), (nx, ny), (nx, ny2),
                (W, ny2), (W, D), (0, D)]
    # Interior island cutout — return outer + hole. For simplicity trace as
    # a keyhole polygon (outer + zero-width bridge to inner hole).
    return [(0, 0), (W, 0), (W, D), (0, D), (0, ny), (nx, ny),
            (nx, ny2), (nx2, ny2), (nx2, ny), (0, ny)]

@api.post("/rooms/{room_id}/validate")
async def validate_room(room_id: str, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404)
    components = {c["key"]: c for c in await db.components.find({"published": True}, {"_id": 0}).to_list(2000)}

    # Only enabled rules apply to this room (global + room-pinned).
    active_rules = await db.rules.find({
        "published": True, "enabled": {"$ne": False},
        "kind": {"$ne": "interpretation"},
        "$or": [{"scope": "global"}, {"scope": {"$exists": False}}, {"room_id": room_id}],
    }, {"_id": 0}).to_list(2000)
    active_rule_ids = {r["rule_id"] for r in active_rules}
    def rule_active(rid):
        # For REQ-<CODE>, allow all component-required checks; otherwise gate.
        if rid.startswith("REQ-"): return True
        return rid in active_rule_ids

    flags = []; checked = []

    def add_check(rid, label): checked.append({"rule": rid, "label": label})
    def add_flag(rid, tier, kind, severity, message, source, location=None, fix=None):
        if not rule_active(rid): return
        flags.append({"rule_id": rid, "tier": tier, "kind": kind, "severity": severity,
                      "message": message, "source": source,
                      "location": location or {}, "fix": fix or ""})

    zones = scene.get("zones", {})
    W, D = scene.get("width", 3.0), scene.get("depth", 3.0)

    # === ZONE OVERLAP (V.2.0 hard rule) ===
    add_check("ZONE-OVERLAP", "Zones must not overlap")
    zk = list(zones.keys())
    for i in range(len(zk)):
        for j in range(i+1, len(zk)):
            a, b = zones[zk[i]], zones[zk[j]]
            if _rects_overlap_2d(
                {"x": a["x"], "y": a["y"], "w": a["w"], "d": a["d"]},
                {"x": b["x"], "y": b["y"], "w": b["w"], "d": b["d"]}):
                add_flag("ZONE-OVERLAP", "v2", "FAIL", "high",
                    f"Zones '{zk[i]}' and '{zk[j]}' overlap in plan. Each zone must occupy a distinct footprint.",
                    "V.2.0 spatial integrity rule", {"zone": zk[i]},
                    fix=f"Move or shrink the {zk[i]} or {zk[j]} zone so their footprints do not overlap.")

    # === UNIDIRECTIONAL FLOW (baseline) ===
    if "dirty" in zones and "transition" in zones and "clean" in zones:
        add_check("SPZ-FLOW", "Unidirectional dirty→transition→clean adjacency")
        dy, ty, cy = zones["dirty"]["y"], zones["transition"]["y"], zones["clean"]["y"]
        if not (dy < ty < cy or dy > ty > cy):
            add_flag("SPZ-FLOW", "baseline", "FAIL", "high",
                "Zones not arranged in unidirectional flow order.",
                "RDS 6222 · NHS HBN 00-09",
                fix="Re-order the zones so Dirty → Transition → Clean run in one direction (top-to-bottom or bottom-to-top) — no zig-zag.")

    # === MIN SEPARATION 1.2–1.5m (enhanced) ===
    if "dirty" in zones and "clean" in zones:
        add_check("SPZ-02", "Min 1.2–1.5m separation dirty↔clean (single-room)")
        gap = abs(zones["clean"]["y"] - (zones["dirty"]["y"] + zones["dirty"]["d"]))
        if gap < 1.2:
            add_flag("SPZ-02", "enhanced", "ADVISORY", "medium",
                f"Only {gap:.2f}m between soiled and clean set-down zones (AusHFG recommends 1.2–1.5m).",
                "AusHFG Part D §5.8",
                fix="Increase the vertical gap between the Dirty and Clean zones to at least 1.2 m (open the Room boundary editor and re-space the zones).")

    # === TURNING CIRCLE 1.5m (enhanced) ===
    if "dirty" in zones:
        add_check("SPZ-TURN", "1.5m clear turning circle in dirty zone")
        z = zones["dirty"]
        if z["w"] < 1.5 or z["d"] < 1.5:
            add_flag("SPZ-TURN", "enhanced", "ADVISORY", "medium",
                "Dirty zone is smaller than 1.5m×1.5m; bariatric commode maneuvering may contaminate walls.",
                "Perkins&Will BEIPI principles",
                fix="Enlarge the Dirty zone to at least 1.5 m × 1.5 m to accommodate a clear 1.5 m turning circle.")

    # === REQUIRED COMPONENTS (baseline) ===
    # Data-driven: read required list from utility node metadata; fall back to
    # the Inpatient-Dirty-Utility default so existing rooms keep validating.
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    node_required = (node or {}).get("metadata", {}).get("required_components") or []
    if node_required:
        # metadata format: [{"key": "macerator", "zone": "dirty"}, ...]
        required = [(r["key"], r.get("zone", "dirty"),
                     components.get(r["key"], {}).get("code") or r["key"].upper())
                    for r in node_required]
    else:
        required = [("macerator","dirty","DSU901"),
                    ("clinical_wash_basin","transition","A-BAS908"),
                    ("prep_counter","dirty","WKT992")]
    present = {i["component_key"] for i in scene.get("items", [])}
    for key, zone_hint, code in required:
        add_check(f"REQ-{code}", f"Required: {components.get(key,{}).get('name', key)}")
        if key not in present:
            add_flag(f"REQ-{code}", "baseline", "FAIL", "high",
                f'{components.get(key,{}).get("name", key)} ({code}) missing from Inpatient Dirty Utility (Medium).',
                "RDS 6222 · Equipment schedule", {"zone": zone_hint},
                fix=f"Drag the '{components.get(key,{}).get('name', key)}' component from the Palette into the {zone_hint} zone.")

    # === HAND-WASH POSITION (v2) ===
    add_check("PLUMB-01", "Sensor-operated non-touch hand-wash basin")
    add_check("PLUMB-05", "Hand-wash basin remote from macerator")
    basin = next((i for i in scene.get("items", []) if i["component_key"] == "clinical_wash_basin"), None)
    macer = next((i for i in scene.get("items", []) if i["component_key"] == "macerator"), None)
    if basin and macer:
        dx = (basin["x"] + basin["w"]/2) - (macer["x"] + macer["w"]/2)
        dy = (basin["y"] + basin["d"]/2) - (macer["y"] + macer["d"]/2)
        dist = (dx*dx + dy*dy) ** 0.5
        if dist < 1.0:
            add_flag("PLUMB-05", "v2", "ADVISORY", "medium",
                f"Hand-wash basin only {dist:.2f}m from macerator. WHO WASH FIT recommends remote positioning (>1.0m) to avoid aerosol/splash cross-contamination.",
                "WHO WASH FIT 2022",
                {"item_id": basin.get("id")},
                fix="Move the wash-hand basin at least 1.0 m away from the macerator to avoid aerosol / splash cross-contamination.")

    # === ZONE-AFFINITY (baseline) — skip ceiling & wall items (position by service, not by content) ===
    add_check("ZONE-AFFINITY", "Floor components in matching zone")
    for it in scene.get("items", []):
        if it.get("mount_type") in ("ceiling", "wall"): continue
        c = components.get(it["component_key"])
        if not c: continue
        if c["zone_affinity"] != it["zone"]:
            add_flag("ZONE-AFFINITY", "baseline", "FAIL", "medium",
                f'{c["name"]} belongs in {c["zone_affinity"]} zone, placed in {it["zone"]}.',
                "Component library affinity", {"item_id": it.get("id")},
                fix=f"Move '{c['name']}' into the {c['zone_affinity']} zone (or reassign its zone via the Properties panel).")

    # === OUT-OF-BOUNDS (v2) ===
    add_check("GEOM-BOUNDS", "Components within room footprint")
    for it in scene.get("items", []):
        if (it["x"] < -0.01 or it["y"] < -0.01
            or it["x"] + it["w"] > W + 0.01 or it["y"] + it["d"] > D + 0.01):
            add_flag("GEOM-BOUNDS", "v2", "FAIL", "high",
                f'{it["component_key"]} extends outside room bounds.',
                "V.2.0 geometry", {"item_id": it.get("id")},
                fix="Drag the component back inside the room boundary, or enlarge the room via the Room boundary editor.")

    # === OUT-OF-ROOM (polygon-aware, L/T/U shapes) ===
    # BASELINE-FAIL when the item centre is inside the cutout (the item is
    # entirely in dead space). V2-WARNING when only the footprint straddles
    # the cutout (part of the item is outside the usable polygon).
    notch = _room_notch(scene)
    if notch:
        add_check("GEOM-POLY", "Components within L/T/U polygon (not in cutout)")
        for it in scene.get("items", []):
            # ceiling/wall items are positioned by service, exclude from polygon test
            if it.get("mount_type") in ("ceiling", "wall"): continue
            cx = it["x"] + it["w"] / 2
            cy = it["y"] + it["d"] / 2
            centre_out = not _point_in_room(cx, cy, scene)
            straddles = _rect_overlaps_notch(it, scene) and not centre_out
            if centre_out:
                add_flag("GEOM-POLY", "baseline", "FAIL", "high",
                    f'{it["component_key"]} is placed inside the room cutout (outside the usable polygon).',
                    "V.2.0 polygon geometry", {"item_id": it.get("id")},
                    fix="Move the component into the usable L/T/U room area — its centre is currently inside the cutout ‘OUTSIDE’ region.")
            elif straddles:
                add_flag("GEOM-POLY", "v2", "ADVISORY", "medium",
                    f'{it["component_key"]} straddles the room cutout — part of its footprint is outside the usable polygon.',
                    "V.2.0 polygon geometry", {"item_id": it.get("id")},
                    fix="Slide the component fully inside the usable polygon so no part of its footprint sits over the cutout.")

    # === 3D COLLISION (v2) — floor/wall/ceiling aware; ceiling items same layer allowed if not overlapping ===
    add_check("GEOM-COLLIDE", "No 3D collisions between components")
    items = scene.get("items", [])
    for i in range(len(items)):
        for j in range(i+1, len(items)):
            a, b = items[i], items[j]
            # Doors count as portals — skip pairwise check with anything they abut
            if a["component_key"] == "entry_door" or b["component_key"] == "entry_door": continue
            if _rects_overlap_2d(a, b) and _vertical_overlap(a, b):
                ca = components.get(a["component_key"], {}).get("name", a["component_key"])
                cb = components.get(b["component_key"], {}).get("name", b["component_key"])
                add_flag("GEOM-COLLIDE", "v2", "FAIL", "medium",
                    f'{ca} and {cb} collide in 3D space (footprint + elevation overlap).',
                    "V.2.0 collision detection",
                    {"item_id": a.get("id"), "item_id_other": b.get("id")},
                    fix=f"Move '{ca}' or '{cb}' so their footprints (and elevations) no longer overlap in 3D space.")

    # === ORIENTATION — wall-mounted items must be within 5 cm of a wall,
    # against-wall floor items must be within 10 cm and rotated toward the
    # interior. Rotations must be multiples of 90°. Only fires when the
    # component library supplies a `placement` tag (backwards-compat safe).
    #
    # Valid mount surfaces = the four room walls + interior partition edges
    # (transition-band lines + user-drawn partitions). See
    # `_wall_candidates` for the full catalogue; the validator reuses the
    # same helper the snap-to-wall endpoint uses.
    add_check("ORIENT-WALL-MOUNT", "Wall-mounted components flush against a wall")
    add_check("ORIENT-BACK-WALL",  "Against-wall components tucked into a wall")
    add_check("ORIENT-ROTATION",   "Rotations are multiples of 90°")
    for it in scene.get("items", []):
        c = components.get(it["component_key"]) or {}
        placement = c.get("placement")
        if not placement or placement in ("free_floor", "ceiling_mounted", "on_counter"):
            continue
        # Reuse the same wall/partition catalogue the snap-to-wall endpoint
        # uses, so validation and auto-fix agree on what counts as a wall.
        near = _nearest_wall_for_item(it, scene)
        if near is None:
            # No wall segment the item projects onto — treat as fully unmoored.
            wall_d = 999.0; expected_rot = 0; wall_name = "any wall"
        else:
            wall_d = near["distance"]; expected_rot = near["expected_rot"]
            wall_name = near["name"]
        tol = 0.05 if placement == "wall_mounted" else 0.10
        actual_rot = int(it.get("rotation", 0)) % 360
        # ROTATION QUANTISATION
        if actual_rot % 90 != 0:
            add_flag("ORIENT-ROTATION", "v2", "FAIL", "medium",
                f"{c.get('name', it['component_key'])} rotation is {actual_rot}° — must be a multiple of 90°.",
                "HealthcareCanvas orientation model", {"item_id": it.get("id")},
                fix="Rotate the component to a multiple of 90° (0, 90, 180 or 270).")
        # DISTANCE FROM WALL
        if wall_d > tol:
            rid = "ORIENT-WALL-MOUNT" if placement == "wall_mounted" else "ORIENT-BACK-WALL"
            severity = "high" if placement == "wall_mounted" else "medium"
            kind = "FAIL" if placement == "wall_mounted" else "ADVISORY"
            add_flag(rid, "v2", kind, severity,
                f"{c.get('name', it['component_key'])} is {wall_d:.2f} m from the nearest wall/partition — "
                f"{'wall-mounted' if placement == 'wall_mounted' else 'against-wall'} components should sit flush "
                f"({'≤5 cm' if placement == 'wall_mounted' else '≤10 cm'}).",
                "HealthcareCanvas orientation model", {"item_id": it.get("id")},
                fix=f"Push the component against the {wall_name} (or the nearest wall). "
                    f"Then check its rotation faces inward from that wall.")
        # ROTATION MATCHES WALL
        elif actual_rot != expected_rot and actual_rot % 90 == 0:
            add_flag("ORIENT-BACK-WALL" if placement != "wall_mounted" else "ORIENT-WALL-MOUNT",
                "v2", "ADVISORY", "medium",
                f"{c.get('name', it['component_key'])} sits against the {wall_name} "
                f"but is rotated {actual_rot}°. Working face should point into the room "
                f"(expected rotation: {expected_rot}°).",
                "HealthcareCanvas orientation model", {"item_id": it.get("id")},
                fix=f"Rotate the component to {expected_rot}° so its working face points into the room, "
                    f"not into the {wall_name}.")

    # === VENTILATION advisory (needs metadata) ===
    add_check("VENT-02", "Ventilation: 6 ACH (baseline) vs 10 ACH (enhanced)")
    add_flag("VENT-02", "enhanced", "ADVISORY", "low",
        "Design ACH not captured in the model. NHS baseline is 6 ACH extract-only; ASHRAE 170 recommends 10 ACH.",
        "ASHRAE 170-2021 Table 7.1", {"zone": "layout"},
        fix="Capture the design ACH in the room metadata. Aim for ≥6 ACH extract-only (NHS baseline); ≥10 ACH for enhanced (ASHRAE 170).")

    # === ACOUSTICS conditional (context) ===
    add_check("ACOU-01", "STC 50+ if adjacent to a patient room")
    add_flag("ACOU-01", "enhanced", "CONTEXT", "low",
        "Does this room share a partition wall with a patient room? If yes, STC 50+ is required (macerators run 65–80 dB).",
        "NHS HTM 08-01", {"zone": "layout"},
        fix="Confirm partition adjacency. If a patient room is adjacent, specify an STC 50+ wall assembly.")

    # === REVIEW items (open from source doc) ===
    add_check("REVIEW-OPEN", "Open items carried from source doc")
    for msg in [
        "Slipper pan decontamination method — pending decontamination-strategy group.",
        "Wipe-down commode flow to clean store — pending Trust IPC strategy.",
        "Ceiling type — under development.",
    ]:
        add_flag("REVIEW-OPEN", "review", "REVIEW", "low", msg, "Source doc P08")

    # === INTERPRETATIONS — advisory reminders that everyone should be aware of.
    # These never FAIL a validation; they surface as low-severity "INTERPRETATION"
    # flags so the human reviewer keeps them in mind.
    interps = await db.rules.find({
        "published": True, "enabled": {"$ne": False},
        "kind": "interpretation",
        "$or": [{"scope": "global"}, {"scope": {"$exists": False}}, {"room_id": room_id}],
    }, {"_id": 0}).to_list(200)
    if interps:
        add_check("INTERPRETATIONS", f"{len(interps)} rule(s) of interpretation applied")
    for it in interps:
        flags.append({
            "rule_id": it["rule_id"], "tier": "context",
            "kind": "INTERPRETATION", "severity": "low",
            "message": it["statement"], "source": it.get("source",""),
            "location": {}, "fix": "",
        })

    # ══════════════════════════════════════════════════════════════════════
    # v3 ADJACENCY PASS — role-based relations sourced from adjacency_v3.json
    # (see dirty_utility_adjacency_logic_v3.md). Every finding here carries
    # a `tier` of "stated" (verbatim from HBN / NHP RDS), "invariant" (holds
    # across every observed layout), or "inferred" (methodological
    # derivation). This is the P0 rewrite the user asked for so IPC leads
    # can see which findings carry NHS Baseline weight.
    # ══════════════════════════════════════════════════════════════════════
    try:
        v3_bundle = _json.loads((ROOT_DIR / "adjacency_v3.json").read_text())
    except Exception:
        v3_bundle = None

    if v3_bundle:
        # component_key → v3 ROLE mapping. Kept intentionally small — one row
        # per role that has an enforceable relation. Unknown keys default to
        # None and are simply skipped by the relation checks.
        ROLE_MAP = {
            # SOURCE — soil / infectious workstations
            "macerator":      "SOURCE",
            "bedpan_washer":  "SOURCE",
            "slop_hopper":    "SOURCE",
            "sluice":         "SOURCE",
            # Hand hygiene cluster
            "clinical_wash_basin": "HYG_BASIN",
            "paper_towel":         "HYG_TOWEL",
            "alcohol_gel":         "HYG_GEL",
            # PPE dispensers
            "ppe_station":         "PPE",
            "glove_dispenser":     "PPE",
            "apron_dispenser":     "PPE",
            "dispenser_bedpan":    "PPE",
            "dispenser_bowl":      "PPE",
            "dispenser_bottle":    "PPE",
            # Receptacles
            "biohazard_bin":       "RCP_PAPER",
            "waste_bin":           "RCP_PAPER",
            "linen_trolley":       "RCP_LINEN",
            "linen_bag":           "RCP_LINEN",
            # Dry work
            "prep_counter":        "DRY_WORK",
            "worktop":             "DRY_WORK",
            "sloping_storage":     "DRY_WORK",
            "shelf":               "DRY_WORK",
            # Air + door
            "exhaust_vent":        "EXTRACT",
            "entry_door":          "DOOR",
            "staff_door":          "DOOR",
        }

        def _role_of(it):
            return ROLE_MAP.get(it.get("component_key"))

        def _center(it):
            return (float(it.get("x", 0)) + float(it.get("w", 0)) / 2.0,
                    float(it.get("y", 0)) + float(it.get("d", 0)) / 2.0)

        def _dist_mm(a, b):
            ax, ay = _center(a); bx, by = _center(b)
            return int(round(((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 * 1000))

        # Group scene items by role for the relation loop.
        items_by_role = {}
        for it in scene.get("items", []):
            r = _role_of(it)
            if r: items_by_role.setdefault(r, []).append(it)

        # Only ADJ-15 is scoped to a single profile (NHP V2 basin ↔ macerator ≥ 2 m).
        profile = (scene.get("standard_applied") or "").lower()

        add_check("V3-ADJACENCY", f"v3 role-based adjacency ({len(v3_bundle.get('relations', []))} relations)")

        for rel in v3_bundle.get("relations", []):
            rid   = rel.get("id", "ADJ-??")
            kind  = rel.get("kind", "")
            tier  = rel.get("tier", "inferred")     # stated / invariant / inferred
            driver = rel.get("driver", [])
            roles = rel.get("roles", []) or []
            thr   = rel.get("threshold_mm")

            # ADJ-15 fires only against the NHP V2 profile.
            if rel.get("profile") == "NHP_V2 only" and profile != "nhp_v2":
                continue

            # Only pair-relations with a threshold are automatically evaluated
            # in this pass. Topology / maintenance-zone / service-wall rules
            # are surfaced as INFORMATION in the future validator refactor.
            if len(roles) != 2 or not isinstance(thr, (int, float)):
                continue

            role_a, role_b = roles[0], roles[1]
            list_a = items_by_role.get(role_a, [])
            list_b = items_by_role.get(role_b, [])
            if not list_a or not list_b:
                continue

            for a in list_a:
                for b in list_b:
                    if a.get("id") == b.get("id"):
                        continue
                    d = _dist_mm(a, b)
                    violated = False
                    if kind in ("near", "touching", "near-centre"):
                        violated = d > thr
                        why = f"only {d/1000:.2f} m apart — should be ≤ {thr} mm"
                    elif kind == "far":
                        violated = d < thr
                        why = f"only {d/1000:.2f} m apart — must be ≥ {thr/1000:.2f} m"
                    else:
                        continue

                    if violated:
                        source_txt = rel.get("source") or f"Adjacency v3 · {rid}"
                        add_flag(
                            rid, tier,
                            "FAIL" if tier == "stated" else "ADVISORY",
                            "high" if tier == "stated" else "medium",
                            f"{role_a} ↔ {role_b}: {why}. ({rel.get('note','')})".strip(),
                            source_txt,
                            {"item_id": a.get("id")},
                            fix=f"Adjust position so the {role_a} and {role_b} pair meets the v3 threshold ({rid}).",
                        )
                        # Enrich the flag with v3 driver metadata so the UI can
                        # colour-code by driver (INF / WF / ERG / MAINT / ACC …).
                        if flags and flags[-1]["rule_id"] == rid:
                            flags[-1]["driver"] = driver
                            flags[-1]["evidence_tier"] = tier
                        break  # one violation per pair-set is enough

    # Classify pass = no baseline FAIL and no v2 FAIL
    hard_fail = any(f["kind"] == "FAIL" for f in flags)
    passed = not hard_fail

    # Counts by tier
    counts = {"baseline_fail": 0, "enhanced_advisory": 0, "v2_fail": 0,
              "context": 0, "review": 0, "interpretation": 0, "derogated": 0,
              # v3 tiers — evidence hierarchy per adjacency_v3.json
              "stated_fail": 0, "invariant_advisory": 0, "inferred_advisory": 0}
    for f in flags:
        if f.get("derogated"):
            counts["derogated"] += 1
            continue  # derogated flags don't count as failures
        if f["tier"] == "baseline" and f["kind"] == "FAIL": counts["baseline_fail"] += 1
        if f["tier"] == "enhanced" and f["kind"] == "ADVISORY": counts["enhanced_advisory"] += 1
        if f["tier"] == "v2" and f["kind"] == "FAIL": counts["v2_fail"] += 1
        if f["kind"] == "CONTEXT": counts["context"] += 1
        if f["kind"] == "REVIEW": counts["review"] += 1
        if f["kind"] == "INTERPRETATION": counts["interpretation"] += 1
        if f["tier"] == "stated" and f["kind"] == "FAIL": counts["stated_fail"] += 1
        if f["tier"] == "invariant" and f["kind"] == "ADVISORY": counts["invariant_advisory"] += 1
        if f["tier"] == "inferred" and f["kind"] == "ADVISORY": counts["inferred_advisory"] += 1

    # Enrich each flag with source_url / source_page from the seed rule (so the
    # UI can deep-link the citation) and a stable statement (canonical wording).
    rules_by_id = {r["rule_id"]: r for r in await db.rules.find(
        {}, {"_id": 0, "rule_id": 1, "source_url": 1, "source_page": 1, "statement": 1}
    ).to_list(500)}
    # Derogations that override specific rules for this room (approved only).
    approved_derogs = await db.derogations.find({
        "room_id": room_id, "status": "approved",
    }, {"_id": 0}).to_list(500)
    derog_by_rule = {}
    for d in approved_derogs:
        derog_by_rule.setdefault(d["rule_id"], []).append(d)
    for f in flags:
        base = f["rule_id"].split("-", 1)[0] if f["rule_id"].startswith("REQ-") else f["rule_id"]
        rule = rules_by_id.get(f["rule_id"]) or rules_by_id.get(base)
        if rule:
            f["source_url"] = rule.get("source_url")
            f["source_page"] = rule.get("source_page")
            f["rule_statement"] = rule.get("statement")
        # Mark this flag as derogated if there's an approved derogation
        # scoped either to any item under this rule, or to this specific item.
        item_id = f.get("location", {}).get("item_id")
        matching = [d for d in derog_by_rule.get(f["rule_id"], [])
                    if not d.get("item_id") or d.get("item_id") == item_id]
        if matching:
            f["derogated"] = True
            f["derogation"] = {
                "justification": matching[0].get("justification"),
                "approved_by": matching[0].get("approved_by"),
                "approved_at": matching[0].get("approved_at"),
                "expires_at": matching[0].get("expires_at"),
            }

    result = {"room_id": room_id, "scene_version": scene.get("version"),
              "checked": checked, "flags": flags, "passed": passed,
              "counts": counts, "timestamp": now_iso(),
              "flow_paths": _compute_flow_paths(scene, components)}
    await db.validations.insert_one({**result, "id": new_id()})
    return result


# ---------- A* Flow Pathfinder ----------
# Grid-based A* that routes flow lines around walls, item footprints, and the
# L/T/U polygon cutout. Returns polylines in metres.
_A_STAR_CELL = 0.10          # 10 cm grid resolution
_A_STAR_CLEAR = 0.05         # 5 cm clearance buffer (tight rooms are common)

def _build_grid(scene, components):
    """Rasterise the room into a 0.1 m occupancy grid.
    Occupied cells = outside polygon OR inside item footprint (+clearance).
    Doors and clinical-wash-basin are treated as *sources/sinks*, not obstacles
    (path endpoints will fall on their centres).
    """
    W = float(scene.get("width", 3.0)); D = float(scene.get("depth", 3.0))
    nx = int(round(W / _A_STAR_CELL)); ny = int(round(D / _A_STAR_CELL))
    grid = [[0] * ny for _ in range(nx)]
    n = _room_notch(scene)
    for ix in range(nx):
        for iy in range(ny):
            cx = (ix + 0.5) * _A_STAR_CELL
            cy = (iy + 0.5) * _A_STAR_CELL
            if not _point_in_room(cx, cy, scene):
                grid[ix][iy] = 1
    # Add item footprints as obstacles (skip ceiling/wall items — they don't
    # block floor routing). Uses a small physical-clearance buffer.
    # The four flow endpoints (door/basin/macerator/bin) do NOT block their
    # own cells so the router can start/end inside them. Wall-mounted items
    # (already skipped above) are the only intentional pass-throughs — every
    # floor-standing piece of furniture (trolleys, commodes, worktops) is a
    # genuine obstacle so the arrows have to route around them.
    ENDPOINT_KEYS = {"entry_door", "clinical_wash_basin", "macerator",
                     "biohazard_bin"}
    PASS_THROUGH  = set()  # nothing on the floor is passable
    for it in scene.get("items", []):
        if it.get("mount_type") in ("ceiling", "wall"): continue
        key = it.get("component_key")
        if key in ENDPOINT_KEYS: continue    # start/end anchor — never block
        if key in PASS_THROUGH: continue     # movable — router may cross
        buf = _A_STAR_CLEAR
        x0 = it["x"] - buf; y0 = it["y"] - buf
        x1 = it["x"] + it["w"] + buf; y1 = it["y"] + it["d"] + buf
        ix0 = max(0, int(x0 / _A_STAR_CELL)); iy0 = max(0, int(y0 / _A_STAR_CELL))
        ix1 = min(nx, int(x1 / _A_STAR_CELL) + 1); iy1 = min(ny, int(y1 / _A_STAR_CELL) + 1)
        for ix in range(ix0, ix1):
            for iy in range(iy0, iy1):
                grid[ix][iy] = 1
    return grid, nx, ny, W, D

def _astar(grid, nx, ny, start, goal):
    """Returns a list of (cx,cy) grid indices from start → goal, or None."""
    import heapq
    if not (0 <= start[0] < nx and 0 <= start[1] < ny): return None
    if not (0 <= goal[0]  < nx and 0 <= goal[1]  < ny): return None
    # Clear a small 4-cell radius (≈40 cm) around start and goal so the path
    # can escape into open space when an endpoint sits inside another item's
    # clearance buffer (e.g. door near shelving trolleys).
    saved = {}
    R = 4
    for centre in (start, goal):
        for dx in range(-R, R + 1):
            for dy in range(-R, R + 1):
                p = (centre[0] + dx, centre[1] + dy)
                if 0 <= p[0] < nx and 0 <= p[1] < ny and grid[p[0]][p[1]]:
                    saved[p] = grid[p[0]][p[1]]; grid[p[0]][p[1]] = 0
    open_heap = [(0.0, start)]
    came = {}
    gscore = {start: 0.0}
    def h(a): return ((a[0]-goal[0])**2 + (a[1]-goal[1])**2) ** 0.5
    # 8-connected grid, diagonals cost sqrt(2)
    NBR = [(1,0,1.0),(-1,0,1.0),(0,1,1.0),(0,-1,1.0),
           (1,1,1.4142),(1,-1,1.4142),(-1,1,1.4142),(-1,-1,1.4142)]
    found = False
    while open_heap:
        _, cur = heapq.heappop(open_heap)
        if cur == goal: found = True; break
        for dx, dy, cost in NBR:
            nb = (cur[0]+dx, cur[1]+dy)
            if not (0 <= nb[0] < nx and 0 <= nb[1] < ny): continue
            if grid[nb[0]][nb[1]]: continue
            # Diagonal move: don't clip walls at corners
            if dx and dy and (grid[cur[0]+dx][cur[1]] or grid[cur[0]][cur[1]+dy]):
                continue
            tg = gscore[cur] + cost
            if tg < gscore.get(nb, 1e18):
                gscore[nb] = tg
                came[nb] = cur
                heapq.heappush(open_heap, (tg + h(nb), nb))
    for p, v in saved.items(): grid[p[0]][p[1]] = v
    if not found: return None
    path = [goal]
    while path[-1] != start:
        path.append(came[path[-1]])
    path.reverse()
    return path

def _simplify_path(points, tol=0.05):
    """Ramer–Douglas–Peucker simplification for a smoother polyline."""
    if len(points) < 3: return points[:]
    def perp(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        denom = (dx*dx + dy*dy) ** 0.5 or 1
        return abs(dy*x - dx*y + x2*y1 - y2*x1) / denom
    def rec(pts):
        if len(pts) < 3: return pts[:]
        first, last = pts[0], pts[-1]
        idx, dmax = 0, 0
        for i in range(1, len(pts) - 1):
            d = perp(pts[i], first, last)
            if d > dmax: idx, dmax = i, d
        if dmax > tol:
            left = rec(pts[:idx+1]); right = rec(pts[idx:])
            return left[:-1] + right
        return [first, last]
    return rec(points)

def _find_item(scene, keys, floor_only=False):
    for k in keys:
        for it in scene.get("items", []):
            if floor_only and it.get("mount_type") in ("ceiling", "wall"): continue
            if it.get("component_key") == k: return it
    return None

def _item_centre(it):
    return (it["x"] + it["w"] / 2, it["y"] + it["d"] / 2)

def _door_anchor(door, scene):
    """Return a point ~30 cm into the room from the door's inside edge.
    The A* router treats this as the person/soiled flow's endpoint so
    arrows visibly start at the doorway threshold rather than at the
    door's centre (which sits inside the wall band) and route from there.
    """
    if not door: return None
    W = float(scene.get("width", 3.0)); D = float(scene.get("depth", 3.0))
    cx, cy = _item_centre(door)
    OFFSET = 0.30
    # Determine which wall the door is on by proximity — the nearest edge
    # sits within a wall-thickness of ~0.15 m.
    dl, dr = cx, W - cx
    dt, db = cy, D - cy
    m = min(dl, dr, dt, db)
    if m == dl: return (cx + OFFSET, cy)
    if m == dr: return (cx - OFFSET, cy)
    if m == dt: return (cx, cy + OFFSET)
    return           (cx, cy - OFFSET)

def _to_grid(pt, nx=None, ny=None):
    ix = int(pt[0] / _A_STAR_CELL); iy = int(pt[1] / _A_STAR_CELL)
    if nx is not None: ix = max(0, min(nx - 1, ix))
    if ny is not None: iy = max(0, min(ny - 1, iy))
    return (ix, iy)

def _compute_flow_paths(scene, components):
    """Return routed polylines per flow type: soiled / clean_supply / person / waste.
    Each is a list of {x,y} points (metres) or an empty list if unroutable.
    """
    if not scene.get("items"): return {}
    try:
        grid, nx, ny, W, D = _build_grid(scene, components)
    except Exception:
        return {}
    door   = _find_item(scene, ["entry_door"])
    macer  = _find_item(scene, ["macerator"])
    basin  = _find_item(scene, ["clinical_wash_basin"])
    binx   = _find_item(scene, ["biohazard_bin"])
    # Clean supply target: prefer a floor item; fall back to the mid-clean-zone
    # if all shelving is wall-mounted (endpoints must be on the floor plane).
    shelf  = _find_item(scene, ["linen_trolley", "commode_store"], floor_only=True)

    def route(a, b):
        if not a or not b: return []
        # Use the door anchor (inside edge) instead of the door's own centre.
        pa = _door_anchor(a, scene) if a is door else _item_centre(a)
        pb = _door_anchor(b, scene) if b is door else _item_centre(b)
        s = _to_grid(pa, nx, ny)
        g = _to_grid(pb, nx, ny)
        p = _astar(grid, nx, ny, s, g)
        if not p: return []
        pts = [((i + 0.5) * _A_STAR_CELL, (j + 0.5) * _A_STAR_CELL) for i, j in p]
        pts = _simplify_path(pts, tol=0.08)
        return [{"x": round(x, 3), "y": round(y, 3)} for x, y in pts]

    return {
        # soiled: macerator → door (through transition)
        "soiled":       route(macer, door),
        # clean supply: door → clean-zone shelf/trolley
        "clean_supply": route(door, shelf),
        # person: door → wash basin (hand hygiene first)
        "person":       route(door, basin),
        # waste: biohazard bin → door
        "waste":        route(binx, door),
    }


# ---------- Renders ----------
@api.post("/rooms/{room_id}/renders")
async def publish_render(room_id: str, background: BackgroundTasks, user=Depends(_room_access)):
    v = await db.validations.find_one({"room_id": room_id}, sort=[("timestamp", -1)])
    # NOTE: no longer blocking on baseline hard-fails — user can render at any
    # validation state. The validation snapshot (if present) is attached to the
    # render so the UI can display a "draft render — N open flags" banner.
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    v_snap = {k: v[k] for k in ("checked","flags","passed","counts","timestamp") if v and k in v}
    doc = {"id": new_id(), "room_id": room_id, "scene_version": scene.get("version"),
           "scene_snapshot": scene,
           "validation_snapshot": v_snap,
           "published_by": user["email"], "published_at": now_iso()}
    await db.renders.insert_one(doc); doc.pop("_id", None)
    background.add_task(_generate_enhanced_render_bg, room_id, user["email"])
    return doc

@api.get("/rooms/{room_id}/renders")
async def list_renders(room_id: str, user=Depends(_room_access)):
    return await db.renders.find({"room_id": room_id}, {"_id": 0}).sort("published_at", -1).to_list(50)


# ---------- Room Data Sheet PDF export ----------
@api.get("/rooms/{room_id}/data-sheet.pdf")
async def export_room_data_sheet(room_id: str, user=Depends(_room_access)):
    """GET variant — text-only Room Data Sheet PDF (no plan / iso snapshots)."""
    return await _build_room_data_sheet(room_id, user, plan_png_b64=None, iso_png_b64=None)

@api.post("/rooms/{room_id}/data-sheet.pdf")
async def export_room_data_sheet_with_plans(room_id: str,
                                            body: Dict[str, Any] = Body(default={}),
                                            user=Depends(_room_access)):
    """POST variant — the client captures a PNG of the 2D plan and 3D
    isometric and posts them as base64. Both are embedded in the PDF with
    proper callouts (item labels + component IDs). Falls back to the
    text-only booklet when snapshots are missing."""
    return await _build_room_data_sheet(
        room_id, user,
        plan_png_b64=body.get("plan_png_b64"),
        iso_png_b64=body.get("iso_png_b64"),
    )

def _item_title_html(it, c):
    from xml.sax.saxutils import escape
    name = it.get("label") if it.get("component_key") == "generic_ifc" else c.get("name", it["component_key"])
    out = escape(name or it["component_key"])
    if it.get("revit_family"):
        out += f'<br/><font size="6" color="#7C3AED">Revit: {escape(it["revit_family"])}</font>'
    return out


async def _build_room_data_sheet(room_id: str, user, plan_png_b64=None, iso_png_b64=None):
    """Compose a Room Data Sheet PDF for the given room.
    Includes: cover, dimensions, zones, components (with materials), applied
    rules + citations, latest validation snapshot, and a "reference documents"
    section listing (never embedding) the PDFs linked to this room."""
    node = await db.hierarchy.find_one({"id": room_id, "type": "utility"}, {"_id": 0})
    if not node: raise HTTPException(404, "Room not found")
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found")
    all_components = {c["key"]: c for c in await db.components.find({"published": True}, {"_id": 0}).to_list(2000)}
    rules = await db.rules.find({
        "published": True, "enabled": {"$ne": False},
        "$or": [{"scope": "global"}, {"scope": {"$exists": False}}, {"room_id": room_id}],
    }, {"_id": 0}).to_list(500)
    val = await db.validations.find_one({"room_id": room_id}, sort=[("timestamp", -1)])
    attachments = await db.pdf_uploads.find({"linked_rooms": room_id}, {"_id": 0}).to_list(50)

    # Build PDF with ReportLab
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                    TableStyle, PageBreak, KeepTogether)
    import io
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
        leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=18*mm,
        title=f"Room Data Sheet — {node['name']}", author=BRAND, creator=BRAND, producer=BRAND, subject=BRAND)
    ss = getSampleStyleSheet()
    st_eyebrow = ParagraphStyle("eb", parent=ss["Normal"], fontSize=8, leading=10,
        textColor=colors.HexColor("#86868B"), spaceAfter=4, textTransform="uppercase")
    st_h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontSize=22, leading=26,
        textColor=colors.HexColor("#1D1D1F"), spaceAfter=6, spaceBefore=0)
    st_h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontSize=13, leading=16,
        textColor=colors.HexColor("#1D1D1F"), spaceAfter=6, spaceBefore=14)
    st_body = ParagraphStyle("body", parent=ss["Normal"], fontSize=9, leading=12,
        textColor=colors.HexColor("#1D1D1F"))
    st_mono = ParagraphStyle("mono", parent=ss["Normal"], fontName="Courier",
        fontSize=8, leading=10, textColor=colors.HexColor("#86868B"))

    story = []
    # ── COVER ─────────────────────────────────────────────
    story.append(Paragraph("Room Data Sheet · Pilot", st_eyebrow))
    story.append(Paragraph(node["name"], st_h1))
    story.append(Paragraph(f"{scene['width']:.2f} m × {scene['depth']:.2f} m · "
                           f"ceiling {scene.get('ceiling_h', 2.7)} m · "
                           f"{(scene['width']*scene['depth']):.1f} m² floor area", st_body))
    story.append(Spacer(1, 4*mm))
    meta = node.get("metadata", {})
    story.append(Paragraph(
        f"Type: {meta.get('kind','—').replace('_',' ').title()} · "
        f"Size: {meta.get('size','—').title()} · "
        f"Acuity: {meta.get('acuity','—')} · "
        f"Risk: {node.get('risk_rating','—')}", st_mono))
    story.append(Paragraph(f"Generated: {now_iso()} · By: {user.get('email','—')}", st_mono))

    # ── PLANS & CALLOUTS ─────────────────────────────────
    # Embed the client-captured 2D plan + 3D isometric on their own page,
    # followed by a numbered callout table so every drop-pin in the plans
    # maps to a real component code and location.
    if plan_png_b64 or iso_png_b64:
        from reportlab.platypus import Image as RLImage
        import base64
        story.append(PageBreak())
        story.append(Paragraph("Plans", st_h2))
        story.append(Paragraph(
            "Snapshots of the 2D plan and the 3D isometric captured at export time. "
            "The numbered callouts below index every placed component to its position, "
            "wall/partition anchor and mount type — cross-refer to the Components table on the following pages.",
            st_body))
        story.append(Spacer(1, 3*mm))
        def _decode(b64):
            if not b64: return None
            if b64.startswith("data:"):
                b64 = b64.split(",", 1)[1]
            try:
                return io.BytesIO(base64.b64decode(b64))
            except Exception:
                return None
        plan_bio = _decode(plan_png_b64)
        iso_bio  = _decode(iso_png_b64)
        if plan_bio:
            story.append(Paragraph("2D plan", st_mono))
            img = RLImage(plan_bio, width=170*mm, height=100*mm, kind="proportional")
            story.append(img)
            story.append(Spacer(1, 4*mm))
        if iso_bio:
            story.append(Paragraph("3D isometric", st_mono))
            img = RLImage(iso_bio, width=170*mm, height=110*mm, kind="proportional")
            story.append(img)
            story.append(Spacer(1, 4*mm))
        # Numbered callout table — one row per item so the plans can be
        # annotated / cross-referenced back to spec.
        story.append(Paragraph("Callouts", st_mono))
        cotable = [["#", "Component", "Code", "x, y (m)", "Rot", "Mount"]]
        for i, it in enumerate(scene.get("items", []), start=1):
            c = all_components.get(it["component_key"], {})
            cotable.append([
                str(i),
                Paragraph(_item_title_html(it, c), st_body),
                c.get("code", "—"),
                f"{it['x']:.2f}, {it['y']:.2f}",
                f"{int(it.get('rotation', 0))}°",
                it.get("mount_type", "floor").title(),
            ])
        tco = Table(cotable, colWidths=[10*mm, 65*mm, 20*mm, 25*mm, 15*mm, 20*mm], repeatRows=1)
        tco.setStyle(TableStyle([
            ("FONT",(0,0),(-1,0),"Helvetica-Bold",7),
            ("FONT",(0,1),(-1,-1),"Helvetica",7),
            ("TEXTCOLOR",(0,0),(-1,0),colors.HexColor("#86868B")),
            ("LINEBELOW",(0,0),(-1,0),0.4,colors.HexColor("#D2D2D7")),
            ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, colors.HexColor("#F7F7F9")]),
            ("VALIGN",(0,0),(-1,-1),"TOP"),
            ("BOTTOMPADDING",(0,0),(-1,-1),3),
        ]))
        story.append(tco)
        story.append(PageBreak())

    # ── ZONES ─────────────────────────────────────────────
    story.append(Paragraph("Zones", st_h2))
    ztable = [["Zone", "x, y (m)", "w × d (m)"]]
    for k, z in (scene.get("zones") or {}).items():
        ztable.append([k.title(), f"{z['x']:.2f}, {z['y']:.2f}",
                       f"{z['w']:.2f} × {z['d']:.2f}"])
    t = Table(ztable, colWidths=[45*mm, 45*mm, 45*mm])
    t.setStyle(TableStyle([
        ("FONT",(0,0),(-1,0),"Helvetica-Bold",8),
        ("FONT",(0,1),(-1,-1),"Helvetica",8),
        ("TEXTCOLOR",(0,0),(-1,0),colors.HexColor("#86868B")),
        ("LINEBELOW",(0,0),(-1,0),0.5,colors.HexColor("#D2D2D7")),
        ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, colors.HexColor("#F7F7F9")]),
        ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("BOTTOMPADDING",(0,0),(-1,-1),4),
    ]))
    story.append(t)

    # ── COMPONENTS ────────────────────────────────────────
    story.append(Paragraph("Components", st_h2))
    ctable = [["Code", "Name", "Zone", "Mount", "Footprint (m)", "Materials"]]
    for it in scene.get("items", []):
        c = all_components.get(it["component_key"], {})
        mats = "; ".join(c.get("materials", []) or [])
        ctable.append([
            c.get("code","—"),
            Paragraph(_item_title_html(it, c), st_body),
            it["zone"].title(),
            it.get("mount_type","floor").title(),
            f"{it['w']:.2f} × {it['d']:.2f}",
            Paragraph(mats or "—", st_body),
        ])
    t = Table(ctable, colWidths=[18*mm, 45*mm, 20*mm, 18*mm, 25*mm, None], repeatRows=1)
    t.setStyle(TableStyle([
        ("FONT",(0,0),(-1,0),"Helvetica-Bold",8),
        ("FONT",(0,1),(-1,-1),"Helvetica",8),
        ("TEXTCOLOR",(0,0),(-1,0),colors.HexColor("#86868B")),
        ("LINEBELOW",(0,0),(-1,0),0.5,colors.HexColor("#D2D2D7")),
        ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, colors.HexColor("#F7F7F9")]),
        ("VALIGN",(0,0),(-1,-1),"TOP"),
        ("BOTTOMPADDING",(0,0),(-1,-1),4),
        ("TOPPADDING",(0,0),(-1,-1),3),
    ]))
    story.append(t)

    # ── ROOM NETWORK & TRAVEL SCORES ──────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Room network &amp; travel scores", st_h2))
    lay = await db.network_layouts.find_one({"room_id": room_id}, {"_id": 0, "svg": 1, "svg_updated_at": 1, "updated_by": 1})
    drawing = None
    if lay and lay.get("svg"):
        try:
            drawing = _network_drawing(lay["svg"], 170*mm, 115*mm)
        except Exception as e:
            logging.warning(f"network snapshot render failed: {e}")
    if drawing:
        story.append(Paragraph(
            "The team's saved network arrangement: bubbles are fittings (size = number of links), green lines are "
            "adjacency rules met, red dashed lines are rule gaps, coloured curves are travel paths.", st_body))
        story.append(Spacer(1, 3*mm))
        story.append(drawing)
        _sat = (lay.get("svg_updated_at") or "")[:16].replace("T", " ")
        story.append(Paragraph(f"Arrangement saved {_sat or '—'} UTC"
                               f"{' · last moved by ' + lay['updated_by'] if lay.get('updated_by') else ''}", st_mono))
    else:
        story.append(Paragraph("No network picture yet — open Analysis → Network view in the room once to include it.", st_mono))
    try:
        comps_n = {c["key"]: c for c in await db.components.find({}, {"_id": 0, "key": 1, "name": 1}).to_list(2000)}
        rels = _json.loads(Path(__file__).parent.joinpath("adjacency_v3.json").read_text()).get("relations", [])
        sa = await asyncio.to_thread(_sa.analyse_room, scene, rels, _item_name(comps_n))
    except Exception as e:
        logging.warning(f"spatial analysis for PDF failed: {e}")
        sa = None
    if sa:
        sm = sa.get("summary") or {}
        story.append(Spacer(1, 3*mm))
        story.append(Paragraph(
            f"Overall task score: <b>{sm.get('task_score') if sm.get('task_score') is not None else '—'}</b> "
            f"({sm.get('task_band', 'n/a')}) · Adjacency rules checked: {sm.get('rule_edges', 0)} · "
            f"Rule gaps: {sm.get('rule_fails', 0)}", st_body))
        story.append(Spacer(1, 2*mm))
        ttable = [["Task", "Distance", "Time", "Score", "Notes"]]
        for tk in sa.get("tasks", []):
            ok = tk.get("status") == "ok"
            notes = []
            if ok and tk.get("crosses_clean"): notes.append("crosses clean zone")
            if not ok: notes.append("missing " + (tk.get("missing") or "item").lower() if tk.get("status") == "missing" else "blocked")
            ttable.append([Paragraph(tk.get("label", tk.get("id", "")), st_body),
                           f"{tk['length_m']} m" if ok else "—",
                           f"{round(tk['seconds'])} s" if ok else "—",
                           f"{tk['score']} · {tk.get('band', '')}" if ok else "—",
                           Paragraph(", ".join(notes) or "—", st_body)])
        t = Table(ttable, colWidths=[62*mm, 20*mm, 16*mm, 30*mm, None], repeatRows=1)
        t.setStyle(TableStyle([
            ("FONT",(0,0),(-1,0),"Helvetica-Bold",8),
            ("FONT",(0,1),(-1,-1),"Helvetica",8),
            ("TEXTCOLOR",(0,0),(-1,0),colors.HexColor("#86868B")),
            ("LINEBELOW",(0,0),(-1,0),0.5,colors.HexColor("#D2D2D7")),
            ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, colors.HexColor("#F7F7F9")]),
            ("VALIGN",(0,0),(-1,-1),"TOP"),
            ("BOTTOMPADDING",(0,0),(-1,-1),3),
        ]))
        story.append(t)

    # ── APPLIED RULES ─────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Applied rules", st_h2))
    story.append(Paragraph(
        f"{len(rules)} enabled rule(s) apply to this room. "
        f"Rules pinned to other rooms and disabled rules are excluded.", st_body))
    story.append(Spacer(1, 3*mm))
    rtable = [["Rule ID", "Statement", "Source", "Page"]]
    for r in rules:
        rtable.append([
            r.get("rule_id","—"),
            Paragraph(r.get("statement",""), st_body),
            Paragraph(r.get("source",""), st_body),
            str(r.get("source_page") or "—"),
        ])
    t = Table(rtable, colWidths=[24*mm, None, 45*mm, 14*mm], repeatRows=1)
    t.setStyle(TableStyle([
        ("FONT",(0,0),(-1,0),"Helvetica-Bold",8),
        ("FONT",(0,1),(-1,-1),"Helvetica",8),
        ("TEXTCOLOR",(0,0),(-1,0),colors.HexColor("#86868B")),
        ("LINEBELOW",(0,0),(-1,0),0.5,colors.HexColor("#D2D2D7")),
        ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, colors.HexColor("#F7F7F9")]),
        ("VALIGN",(0,0),(-1,-1),"TOP"),
        ("BOTTOMPADDING",(0,0),(-1,-1),4),
        ("TOPPADDING",(0,0),(-1,-1),3),
    ]))
    story.append(t)

    # ── VALIDATION SNAPSHOT ───────────────────────────────
    story.append(Paragraph("Validation snapshot", st_h2))
    if val:
        ct = val.get("counts", {})
        story.append(Paragraph(
            f"Baseline fail: {ct.get('baseline_fail',0)} · "
            f"V.2.0 fail: {ct.get('v2_fail',0)} · "
            f"Advisory: {ct.get('enhanced_advisory',0)} · "
            f"Context: {ct.get('context',0)} · "
            f"Review: {ct.get('review',0)} · "
            f"Interpretations: {ct.get('interpretation',0)}",
            st_body))
        story.append(Paragraph(f"Snapshot timestamp: {val.get('timestamp','—')}", st_mono))
    else:
        story.append(Paragraph("No validation snapshot available. Run validation before export.", st_mono))

    # ── REFERENCE DOCUMENTS (listed, NEVER embedded — often confidential) ──
    story.append(Paragraph("Reference documents", st_h2))
    story.append(Paragraph(
        "Reference source PDFs are for in-app viewing only and are not embedded "
        "in this export. Access is controlled by the platform.",
        st_body))
    if attachments:
        atable = [["File", "Uploaded by", "Uploaded at"]]
        for a in attachments:
            atable.append([
                Paragraph(a.get("original_filename","—"), st_body),
                a.get("uploaded_by","—"),
                a.get("uploaded_at","—"),
            ])
        t = Table(atable, colWidths=[None, 45*mm, 45*mm], repeatRows=1)
        t.setStyle(TableStyle([
            ("FONT",(0,0),(-1,0),"Helvetica-Bold",8),
            ("FONT",(0,1),(-1,-1),"Helvetica",8),
            ("TEXTCOLOR",(0,0),(-1,0),colors.HexColor("#86868B")),
            ("LINEBELOW",(0,0),(-1,0),0.5,colors.HexColor("#D2D2D7")),
            ("VALIGN",(0,0),(-1,-1),"TOP"),
        ]))
        story.append(t)
    else:
        story.append(Paragraph("No reference documents attached to this room.", st_mono))

    # ── Footer note (human-in-the-loop) ─────────────────
    story.append(Spacer(1, 6*mm))
    story.append(Paragraph(
        "This data sheet is a computer-generated summary of the current model. "
        "The Compliance Assistant is advisory — final adoption of any rule, "
        "configuration or fix requires human review and sign-off.",
        st_mono))

    doc.build(story, onFirstPage=_brand_footer, onLaterPages=_brand_footer)
    buf.seek(0)
    from fastapi.responses import StreamingResponse
    from urllib.parse import quote
    return StreamingResponse(buf, media_type="application/pdf",
        headers=_brand_disposition(node["name"], "data-sheet", "pdf"))


# ---------- Room attachments (link PDFs to a room) ----------
class AttachIn(BaseModel):
    pdf_id: str

@api.post("/rooms/{room_id}/attachments")
async def attach_pdf(room_id: str, body: AttachIn, user=Depends(_room_access)):
    """Link a previously-uploaded PDF (from ingestion) to this room.
    Reference PDFs are viewable in-app only; they are never re-downloaded or
    embedded in exports."""
    pdf = await db.pdf_uploads.find_one({"id": body.pdf_id})
    if not pdf: raise HTTPException(404, "PDF not found")
    await db.pdf_uploads.update_one({"id": body.pdf_id},
        {"$addToSet": {"linked_rooms": room_id}})
    return {"ok": True, "pdf_id": body.pdf_id, "room_id": room_id}

@api.get("/rooms/{room_id}/attachments")
async def list_room_attachments(room_id: str, user=Depends(_room_access)):
    docs = await db.pdf_uploads.find({"linked_rooms": room_id}, {"_id": 0}).to_list(100)
    return docs


# ---------- Health ----------
@api.get("/")
async def root(): return {"service": "HealthcareCanvas Co-Design Platform", "ok": True, "seed_version": SEED_VERSION}


# ---------- AI photorealistic render (Nano Banana) ----------
AI_RENDER_TEMPLATE = """An immaculate, technical 3D isometric cutaway diagram of a modular healthcare Inpatient Dirty Utility Room. The entire scene is presented in a clean, high-fidelity architectural visualization and educational diagram style, with precise 3D models and soft, clinical lighting.

Overall Composition: two connected modules forming a single, split-function layout — a CLEAN preparation zone on the left and a SOILED / decontamination zone on the right, sharing a central pass-through hatch. Precise axonometric projection with a fixed isometric angle, viewed from the front-right. The entire structure is a single complex element against a clean pure-white background.

LEFT MODULE — CLEAN ZONE
Aesthetic: pure white walls and a light mint-green epoxy floor (#A2D9B0) with a continuous white coved skirting.
Contents:
- Left wall: a grey sliding door with a vision panel and horizontal chrome handle. To its right, a full hand-hygiene station consisting of a ceramic wall-hung sink with a hands-free sensor tap, a large wall-mounted paper-towel dispenser, a soap/sanitizer dispenser cluster, and four specific wall-mounted gloved-hand PPE dispensers arranged in a row.
- Back wall: a long stainless-steel worktop bench with an integrated inset counter sink and hands-free tap. Below the bench sits two pedal-operated bins — one yellow biohazard bin with a distinct black biohazard symbol on its front face, and one white recycling bin with a green recycling symbol.
- Above the worktop: three wall-mounted wire-mesh shelving units organized with folded white and pale-green clinical linens and supply boxes.
- Right shared wall: a stainless-framed pass-through hatch with a clear glass window.

RIGHT MODULE — SOILED / DECONTAMINATION ZONE
Aesthetic: sage-green painted walls (#C7D8B9) and a coral / peach epoxy floor (#E89689) with a continuous white coved skirting.
Contents:
- Left shared wall: the other side of the pass-through hatch.
- Back wall: a complex stainless-steel decontamination sink array — one large double-basin sink and two single-basin pre-rinse sinks — all with powerful deck-mounted chrome mixer taps. Above the sinks, one high horizontal window with white frame. To the far right of the array, a wall-mounted pre-rinse hose unit with a chrome spray gun on a coiled hose. A wall-mounted paper-towel dispenser and soap dispenser sit on the wall above the sink complex.
- Floor left of the sinks: a large pinkish-beige pedal-operated biohazard bin with a distinct black biohazard symbol on its front face.
- Floor right side: a dedicated stainless floor drain with a metal grate.

STYLE
Clean, detailed 3D render, technical and educational, low-poly-inspired precision. Every piece of equipment (sinks, bins, dispensers, shelves, taps) is accurately modelled and placed. Bright, soft, even illumination with subtle soft shadows underneath objects. All materials — epoxy floor, painted wall, stainless steel, ABS plastic, wire mesh — are clearly rendered. The view is pristine and accurate to a real healthcare facility design. No text or labels of any kind. Pure white background."""

def _build_scene_prompt(scene, components):
    """Compose an AI image prompt from the current scene contents."""
    W, D = scene.get("width", 3.0), scene.get("depth", 3.0)
    CEIL = scene.get("ceiling_h", 2.7)
    comp_map = {c["key"]: c for c in components}

    # Group items by zone + mount_type
    zone_items = {"dirty": [], "transition": [], "clean": []}
    for it in scene.get("items", []):
        c = comp_map.get(it["component_key"], {})
        zone_items.setdefault(it.get("zone", "transition"), []).append({
            "name": c.get("name", it["component_key"]).split(" (")[0],
            "code": c.get("code", ""),
            "kind": c.get("kind", ""),
            "material": c.get("material", "laminate"),
            "mount": it.get("mount_type", "floor"),
            "elev": it.get("elevation_m", 0.0),
        })

    def describe_group(items):
        floor = [i for i in items if i["mount"] == "floor"]
        wall = [i for i in items if i["mount"] == "wall"]
        ceil = [i for i in items if i["mount"] == "ceiling"]
        parts = []
        if floor:
            parts.append("Floor-standing: " + ", ".join(f"{i['name']}" for i in floor))
        if wall:
            parts.append("Wall-mounted: " + ", ".join(f"{i['name']}" for i in wall))
        if ceil:
            parts.append("Ceiling-mounted: " + ", ".join(f"{i['name']}" for i in ceil))
        return ". ".join(parts) if parts else "empty"

    prompt = f"""An immaculate, technical 3D isometric cutaway diagram of a SINGLE modular healthcare Inpatient Dirty Utility Room, {W:.1f} m wide × {D:.1f} m deep × {CEIL:.1f} m ceiling. High-fidelity architectural visualization, educational diagram style, precise 3D models, soft clinical lighting.

Composition: one integrated room split into THREE parallel workflow zones running from BACK to FRONT — DIRTY (soiled arrivals, at the back), TRANSITION (hand-hygiene + PPE, middle strip), CLEAN (near the front door). Precise axonometric projection at a fixed isometric angle viewed from the front-right, matching a technical architectural cutaway. Pure white background. NO text or labels of any kind.

Room shell:
- Pure white walls, coved white skirting, light warm-grey epoxy floor.
- OPEN "L" wall configuration — only the back wall and the left wall are shown; front and right walls removed so the interior is fully visible from the isometric viewpoint.

Zone floor colors (as painted epoxy):
- DIRTY zone (back strip, along the back wall): coral / peach epoxy floor (#E89689).
- TRANSITION zone (middle strip): warm cream epoxy floor (#E5D5B0).
- CLEAN zone (front strip, near entry door): mint green epoxy floor (#A2D9B0).

DIRTY zone contents. {describe_group(zone_items['dirty'])}.
TRANSITION zone contents. {describe_group(zone_items['transition'])}.
CLEAN zone contents. {describe_group(zone_items['clean'])}.

Rendering style:
- Every item is accurately modeled from stainless-steel, ceramic-white, or ABS-plastic materials as appropriate: stainless macerator with black control panel and lid, stainless worktop with legs, ceramic wall-hung basin with hands-free sensor tap, cylindrical foot-operated bin (yellow with a distinct black biohazard symbol where applicable), waist-height mobile linen trolley on 4 castors with a hoop and inner bag, wall-mounted PPE dispensers arranged vertically, wall-mounted soap/sanitiser/paper-towel dispensers, tall cleaned-commode store cabinet, sliding entry door with a vision panel and chrome handle, recessed LED ceiling panel emitting soft light, ceiling extract grille with visible louvres.
- Wall-mounted items are physically attached to walls at correct heights (dispensers at ~1.35 m, wall shelves at ~1.60 m). Ceiling items are recessed at ~2.55–2.60 m.
- Bright, soft, even illumination; subtle soft shadows under each object.
- Materials — epoxy floor, painted wall, stainless steel, ABS plastic, ceramic — clearly rendered.
- Clean, low-poly-inspired precision; educational diagram feel; no text, no labels."""
    return prompt


@api.post("/rooms/{room_id}/render-ai")
async def render_ai(room_id: str, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene:
        raise HTTPException(404, "Scene not found")
    components = await db.components.find({"published": True}, {"_id": 0}).to_list(2000)
    llm.require_key()

    prompt = _build_scene_prompt(scene, components)
    try:
        text, images = await llm.generate_image(prompt, system=RENDER_SYSTEM)
    except Exception as e:
        raise HTTPException(500, f"Image generation failed: {e}")

    if not images:
        raise HTTPException(500, "No image returned by model")

    image_bytes = images[0]
    filename = f"ai-{room_id[:8]}-v{scene.get('version',0)}-{new_id()[:8]}.png"
    put_upload(RENDERS_DIR / filename, image_bytes, "image/png")

    doc = {
        "id": new_id(), "room_id": room_id,
        "type": "enhanced",
        "url": f"/api/ai-renders/{filename}",
        "generated_by": user["email"],
        "generated_at": now_iso(),
        "scene_version": scene.get("version"),
        "prompt": prompt,
        "prompt_preview": prompt[:1500],
    }
    await db.ai_renders.insert_one(doc); doc.pop("_id", None)
    return doc


async def _generate_enhanced_render_bg(room_id: str, user_email: str):
    """Fire-and-forget background enhanced-render generation invoked after publish."""
    try:
        scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
        if not scene: return
        components = await db.components.find({"published": True}, {"_id": 0}).to_list(2000)
        if not llm.is_configured(): return
        # Skip if already have a render for this version
        existing = await db.ai_renders.find_one({"room_id": room_id, "scene_version": scene.get("version")})
        if existing: return
        prompt = _build_scene_prompt(scene, components)
        _, images = await llm.generate_image(prompt, system=RENDER_SYSTEM)
        if not images: return
        image_bytes = images[0]
        filename = f"ai-{room_id[:8]}-v{scene.get('version',0)}-{new_id()[:8]}.png"
        put_upload(RENDERS_DIR / filename, image_bytes, "image/png")
        await db.ai_renders.insert_one({
            "id": new_id(), "room_id": room_id, "type": "enhanced",
            "url": f"/api/ai-renders/{filename}",
            "generated_by": user_email, "generated_at": now_iso(),
            "scene_version": scene.get("version"),
            "prompt": prompt, "prompt_preview": prompt[:1500],
            "auto": True,
        })
        logging.info(f"Background enhanced render created for room {room_id} v{scene.get('version')}")
    except Exception as e:
        logging.warning(f"BG enhanced render failed: {e}")

@api.get("/ai-renders/{filename}")
async def serve_ai_render(filename: str):
    # Public, like the other image endpoints: <img> tags can't send tokens.
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.png", filename):
        raise HTTPException(404, "Not found")
    path = RENDERS_DIR / filename
    if not ensure_local(path):
        raise HTTPException(404, "Not found")
    from fastapi.responses import FileResponse
    return FileResponse(str(path), media_type="image/png")

@api.get("/rooms/{room_id}/ai-renders")
async def list_ai_renders(room_id: str, user=Depends(_room_access)):
    return await db.ai_renders.find({"room_id": room_id}, {"_id": 0}).sort("generated_at", -1).to_list(50)


# ---------- Clear Logs ----------
@api.delete("/rooms/{room_id}/changelog")
async def clear_changelog(room_id: str, user=Depends(_room_access)):
    r = await db.changelog.delete_many({"room_id": room_id})
    return {"ok": True, "cleared": r.deleted_count}

@api.delete("/rooms/{room_id}/renders")
async def clear_renders(room_id: str, user=Depends(_room_access)):
    # Delete AI-render files from disk
    ai = await db.ai_renders.find({"room_id": room_id}, {"_id": 0, "url": 1}).to_list(500)
    for r in ai:
        fname = (r.get("url") or "").split("/")[-1]
        if fname:
            delete_upload(RENDERS_DIR / fname)
    n1 = (await db.renders.delete_many({"room_id": room_id})).deleted_count
    n2 = (await db.ai_renders.delete_many({"room_id": room_id})).deleted_count
    return {"ok": True, "cleared_renders": n1, "cleared_ai_renders": n2}


# ---------- Room Type Creation ----------
class RoomCreateIn(BaseModel):
    name: str
    kind: str = "inpatient_dirty_utility"  # e.g. clean_utility, isolation
    code: Optional[str] = None
    size: Optional[str] = "medium"
    width: float = 3.0
    depth: float = 3.0
    ceiling_h: float = 2.7
    risk_rating: Optional[Literal["low","medium","high"]] = "medium"
    parent_id: Optional[str] = None  # defaults to any existing 'room' parent

@api.post("/rooms")
async def create_room(body: RoomCreateIn, user=Depends(get_current_user)):
    parent_id = body.parent_id
    if not parent_id:
        parent = await db.hierarchy.find_one({"type": "room"})
        if not parent:
            raise HTTPException(400, "No parent room found. Provide parent_id.")
        parent_id = parent["id"]
    util = {
        "id": new_id(), "parent_id": parent_id, "type": "utility",
        "name": body.name,
        "metadata": {"kind": body.kind, "size": body.size or "custom",
                     "code": body.code or "CUSTOM", "brief_area_m2": round(body.width*body.depth,1)},
        "risk_rating": body.risk_rating or "medium",
        "created_at": now_iso(), "contributors": [],
        # Ownership + tenancy — required so this room is only visible to
        # its creator and anyone they explicitly invite via /invites.
        "owner_id": user["id"],
        "owner_email": user.get("email"),
        "owner_org": (user.get("organization") or "").strip() or None,
        "visible_to_org": False,
    }
    await db.hierarchy.insert_one(util)
    # Seed a blank scene: default 3-zone split, no items
    zones = {
        "dirty":      {"x": 0.0, "y": 0.0,       "w": body.width, "d": body.depth * 0.4},
        "transition": {"x": 0.0, "y": body.depth * 0.4, "w": body.width, "d": body.depth * 0.2},
        "clean":      {"x": 0.0, "y": body.depth * 0.6, "w": body.width, "d": body.depth * 0.4},
    }
    scene = {"room_id": util["id"], "width": body.width, "depth": body.depth,
             "ceiling_h": body.ceiling_h, "zones": zones, "items": [],
             "version": 1, "updated_at": now_iso()}
    await db.scenes.insert_one({**scene})
    return {"room": {k: v for k, v in util.items() if k != "_id"},
            "scene_room_id": util["id"]}


@api.delete("/rooms/{room_id}")
async def delete_room(room_id: str, user=Depends(_room_access)):
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    if not node:
        raise HTTPException(404, "Room not found")
    if node.get("type") != "utility":
        raise HTTPException(400, "Only utility rooms can be deleted through this endpoint")
    # Delete scene, validations, changelog, renders (files too), ai_renders (files too),
    # ai_recommendations, ai_chat_messages, and the hierarchy node itself.
    ai = await db.ai_renders.find({"room_id": room_id}, {"_id": 0, "url": 1}).to_list(500)
    for r in ai:
        fname = (r.get("url") or "").split("/")[-1]
        if fname:
            delete_upload(RENDERS_DIR / fname)
    counts = {
        "scene": (await db.scenes.delete_many({"room_id": room_id})).deleted_count,
        "validations": (await db.validations.delete_many({"room_id": room_id})).deleted_count,
        "changelog": (await db.changelog.delete_many({"room_id": room_id})).deleted_count,
        "renders": (await db.renders.delete_many({"room_id": room_id})).deleted_count,
        "ai_renders": (await db.ai_renders.delete_many({"room_id": room_id})).deleted_count,
        "ai_recommendations": (await db.ai_recommendations.delete_many({"room_id": room_id})).deleted_count,
        "ai_chat_messages": (await db.ai_chat_messages.delete_many({"room_id": room_id})).deleted_count,
        "network_layouts": (await db.network_layouts.delete_many({"room_id": room_id})).deleted_count,
        "hierarchy": (await db.hierarchy.delete_one({"id": room_id})).deleted_count,
    }
    imp_id = ((node.get("metadata") or {}).get("ifc_source") or {}).get("import_id")
    if imp_id and not await db.hierarchy.find_one({"metadata.ifc_source.import_id": imp_id}):
        imp = await db.ifc_imports.find_one_and_delete({"id": imp_id})
        if imp:
            delete_upload(imp["path"])
    return {"ok": True, "id": room_id, "deleted": counts}


# ---------------------------------------------------------------------
# Sharing panel — list current invited/granted collaborators, revoke
# individual access, toggle org-wide visibility, clone Representation
# rooms, and read the 30-day audit trail. Owner (or admin) only.
# ---------------------------------------------------------------------

@api.get("/rooms/{room_id}/shares")
async def list_room_shares(room_id: str, user=Depends(get_current_user)):
    """Return the room's collaborators + pending invites.
    Owner (or admin) only."""
    node = await _require_room_owner(room_id, user)
    grants = await db.access_grants.find(
        {"scope": "room", "scope_id": room_id}, {"_id": 0},
    ).to_list(500)
    # Hydrate user info for each grant
    accepted = []
    for g in grants:
        u = await db.users.find_one({"id": g["user_id"]},
                                    {"_id": 0, "id": 1, "email": 1, "name": 1,
                                     "avatar_url": 1, "organization": 1, "role": 1})
        if not u: continue
        accepted.append({
            "user_id": u["id"], "email": u.get("email"), "name": u.get("name"),
            "avatar_url": u.get("avatar_url"), "organization": u.get("organization"),
            "system_role": u.get("role"),
            "role": g.get("role"), "granted_at": g.get("granted_at"),
        })
    pending = await db.invites.find(
        {"scope": "room", "scope_id": room_id, "invited_by": user["email"]},
        {"_id": 0},
    ).sort("created_at", -1).to_list(500)
    # Split pending vs accepted-but-still-holding-invite-doc
    accepted_uids = {a["user_id"] for a in accepted}
    pending_out = []
    for inv in pending:
        # Consider "pending" if nobody has accepted, OR if some have accepted
        # but at least one recipient hasn't yet — we surface it either way.
        pending_out.append({
            "invite_id": inv["id"], "token": inv["token"], "role": inv["role"],
            "note": inv.get("note"),
            "invited_by": inv.get("invited_by"), "created_at": inv.get("created_at"),
            "expires_at": inv.get("expires_at"),
            "accepted_by": inv.get("accepted_by", []),
        })
    return {
        "room_id": room_id,
        "owner": {
            "id": node.get("owner_id"), "email": node.get("owner_email"),
            "organization": node.get("owner_org"),
        },
        "visible_to_org": bool(node.get("visible_to_org")),
        "owner_org": node.get("owner_org"),
        "accepted": accepted,
        "pending": pending_out,
    }


@api.delete("/rooms/{room_id}/shares/{grantee_user_id}")
async def revoke_room_share(room_id: str, grantee_user_id: str,
                            note: Optional[str] = None,
                            user=Depends(get_current_user)):
    """Revoke a user's access to this room. Owner / admin only.
    Optional `?note=` (≤240 chars) delivers a one-liner to the revoked
    peer via `user_notes` (surfaced by the top-bar bell on next visit)."""
    node = await _require_room_owner(room_id, user)
    r = await db.access_grants.delete_one({
        "scope": "room", "scope_id": room_id, "user_id": grantee_user_id,
    })
    await db.invites.update_many(
        {"scope": "room", "scope_id": room_id},
        {"$pull": {"accepted_by": {"user_id": grantee_user_id}}},
    )
    await _audit_log(room_id, user, "revoked",
                     {"grantee_user_id": grantee_user_id, "note": (note or None)})
    if note and note.strip():
        await _create_user_note(
            recipient_user_id=grantee_user_id, from_user=user,
            room_id=room_id, room_name=node.get("name"),
            action="revoked", note=note.strip()[:240],
        )
    return {"ok": True, "revoked": r.deleted_count}


class RoomVisibilityIn(BaseModel):
    visible_to_org: bool


@api.patch("/rooms/{room_id}/visibility")
async def set_room_visibility(room_id: str, body: RoomVisibilityIn,
                              user=Depends(get_current_user)):
    """Toggle org-wide read-only visibility. Owner / admin only.
    When enabled, any user whose profile `organization` matches this room's
    `owner_org` can see the room and read its scene (writes still require an
    explicit invite / access grant)."""
    node = await _require_room_owner(room_id, user)
    my_org = (user.get("organization") or "").strip() or None
    # Snapshot owner_org onto the room in case owner's profile changes later
    await db.hierarchy.update_one(
        {"id": room_id},
        {"$set": {"visible_to_org": bool(body.visible_to_org),
                  "owner_org": my_org or node.get("owner_org")}},
    )
    await _audit_log(room_id, user, "visibility",
                     {"visible_to_org": bool(body.visible_to_org),
                      "owner_org": my_org})
    return {"ok": True, "visible_to_org": bool(body.visible_to_org),
            "owner_org": my_org}


class RoomRenameIn(BaseModel):
    name: str


@api.patch("/rooms/{room_id}/name")
async def rename_room(room_id: str, body: RoomRenameIn, user=Depends(_room_access)):
    name = body.name.strip()[:120]
    if not name:
        raise HTTPException(400, "Name is required")
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0, "type": 1})
    if not node or node.get("type") != "utility":
        raise HTTPException(404, "Room not found")
    await db.hierarchy.update_one({"id": room_id}, {"$set": {"name": name}})
    await _audit_log(room_id, user, "renamed", {"name": name})
    return {"id": room_id, "name": name}


class NetworkLayoutIn(BaseModel):
    pins: Dict[str, Dict[str, float]] = {}


@api.get("/rooms/{room_id}/network-layout")
async def get_network_layout(room_id: str, user=Depends(_room_access)):
    doc = await db.network_layouts.find_one({"room_id": room_id}, {"_id": 0})
    return doc or {"room_id": room_id, "pins": {}}


@api.put("/rooms/{room_id}/network-layout")
async def put_network_layout(room_id: str, body: NetworkLayoutIn, user=Depends(_room_access)):
    pins = {k: {"px": round(float(v.get("px", 0)), 1), "py": round(float(v.get("py", 0)), 1)}
            for k, v in list(body.pins.items())[:500]}
    doc = {"room_id": room_id, "pins": pins, "updated_at": now_iso(),
           "updated_by": user.get("name") or user.get("email")}
    await db.network_layouts.update_one({"room_id": room_id}, {"$set": doc}, upsert=True)
    return doc


class NetworkSnapshotIn(BaseModel):
    svg: str


@api.put("/rooms/{room_id}/network-layout/snapshot")
async def put_network_snapshot(room_id: str, body: NetworkSnapshotIn, user=Depends(_room_access)):
    if len(body.svg) > 600_000 or not body.svg.lstrip().startswith("<svg"):
        raise HTTPException(400, "Invalid network snapshot")
    await db.network_layouts.update_one({"room_id": room_id},
        {"$set": {"svg": body.svg, "svg_updated_at": now_iso()}}, upsert=True)
    return {"ok": True}


def _network_drawing(svg_text: str, max_w: float, max_h: float):
    """Turn the stored network SVG into a ReportLab drawing scaled to fit."""
    import io
    import re
    from svglib.svglib import svg2rlg
    clean = re.sub(r"<script.*?</script>", "", svg_text, flags=re.S | re.I)
    # svglib paints text strokes over the fill — draw each haloed label twice:
    # a halo-coloured copy underneath, then the plain text on top.
    def _halo(m):
        tag, body = m.group(1), m.group(2)
        sc = re.search(r'\sstroke="([^"]*)"', tag)
        plain = re.sub(r'\s(?:stroke|stroke-width|paint-order)="[^"]*"', "", tag)
        if not sc:
            return m.group(0)
        under = re.sub(r'\sfill="[^"]*"', f' fill="{sc.group(1)}"', re.sub(r'\spaint-order="[^"]*"', "", tag))
        return f"{under}{body}</text>{plain}{body}</text>"
    clean = re.sub(r"(<text\b[^>]*>)(.*?)</text>", _halo, clean, flags=re.S)
    d = svg2rlg(io.BytesIO(clean.encode("utf-8")))
    if not d or not d.width:
        return None
    s = min(max_w / d.width, max_h / d.height, 1.0)
    d.width, d.height = d.width * s, d.height * s
    d.scale(s, s)
    return d


class RoomCloneIn(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[str] = None


@api.post("/rooms/{room_id}/clone")
async def clone_room(room_id: str, body: RoomCloneIn,
                     user=Depends(get_current_user)):
    """Create a private copy of the given room owned by the caller.
    Works on Representation rooms (source is read-only) and on rooms the
    caller can already access. Copies the scene (zones, items, walls,
    partitions, shape, ceiling); does NOT copy invites, grants, or audit."""
    # Clone reads the source. Require read access (not write) so
    # Representation rooms and org-visible peers can also be cloned.
    await _enforce_room_access(user, room_id, write=False)
    src_node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    if not src_node or src_node.get("type") != "utility":
        raise HTTPException(404, "Source room not found")
    parent_id = src_node.get("parent_id")
    if body.parent_id == "__root__":
        parent_id = None
    elif body.parent_id:
        target = await db.hierarchy.find_one({"id": body.parent_id}, {"_id": 0})
        if not target or target.get("type") in ("utility", "component") or (
                target.get("owner_id") and target["owner_id"] != user.get("id")
                and not target.get("published") and user.get("role") != "admin"):
            raise HTTPException(400, "Choose a valid estate, building, floor, ward or room")
        parent_id = target["id"]
    util = await _clone_room_for(user, src_node, body.name, parent_id=parent_id)
    return {"room": util, "scene_room_id": util["id"]}


_KEEP = object()


async def _clone_room_for(user, src_node, name=None, extra_meta=None, parent_id=_KEEP):
    room_id = src_node["id"]
    src_scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0}) or {}
    new_room_id = new_id()
    now = now_iso()
    new_name = (name or "").strip() or f"{src_node.get('name', 'Room')} (copy)"
    util = {
        "id": new_room_id,
        "parent_id": parent_id if parent_id is not _KEEP else src_node.get("parent_id"),
        "type": "utility",
        "name": new_name,
        "metadata": {**{k: v for k, v in (src_node.get("metadata") or {}).items() if k != "template_key"},
                     "cloned_from": room_id,
                     "cloned_from_name": src_node.get("name"), **(extra_meta or {})},
        "risk_rating": src_node.get("risk_rating") or "medium",
        "created_at": now, "contributors": [],
        "owner_id": user["id"],
        "owner_email": user.get("email"),
        "owner_org": (user.get("organization") or "").strip() or None,
        "visible_to_org": False,
    }
    await db.hierarchy.insert_one(util)
    if src_scene:
        new_scene = {k: v for k, v in src_scene.items() if k != "_id"}
        new_scene["room_id"] = new_room_id
        new_scene["version"] = 1
        new_scene["updated_at"] = now
        new_scene.pop("last_edited_by", None)
        new_scene.pop("last_edited_at", None)
        # Deep-ish copy the items so mutating the new scene does not touch source
        import copy
        new_scene["items"] = copy.deepcopy(src_scene.get("items") or [])
        id_map = {}
        for it in new_scene["items"]:
            nid = new_id()
            id_map[it.get("id")] = nid
            it["id"] = nid
        new_scene["zones"] = copy.deepcopy(src_scene.get("zones") or {})
        new_scene["partitions"] = copy.deepcopy(src_scene.get("partitions") or [])
        new_scene["shape"] = copy.deepcopy(src_scene.get("shape") or {"type": "rectangle"})
        await db.scenes.insert_one(new_scene)
        lay = await db.network_layouts.find_one({"room_id": room_id}, {"_id": 0, "pins": 1})
        if lay and lay.get("pins"):
            pins = {id_map[k]: v for k, v in lay["pins"].items() if k in id_map}
            await db.network_layouts.insert_one({"room_id": new_room_id, "pins": pins, "updated_at": now,
                                                 "updated_by": user.get("name") or user.get("email")})
    await _audit_log(new_room_id, user, "cloned", {"source_room_id": room_id})
    return {k: v for k, v in util.items() if k != "_id"}


async def _ensure_sample_room(user):
    """Give each user one editable 'Dirty Utility' room built from the Revit IFC standard."""
    uid = user.get("id")
    src = await db.hierarchy.find_one({"metadata.template_key": "revit_ex01", "is_seed": True}, {"_id": 0})
    if not uid or not src:
        return
    r = await db.users.update_one({"$or": [{"id": uid}, {"user_id": uid}], "sample_room_seeded": {"$ne": True}},
                                  {"$set": {"sample_room_seeded": True}})
    if not r.modified_count:
        return
    try:
        await _clone_room_for(user, src, "Dirty Utility", {"sample_room": True})
    except Exception:
        await db.users.update_one({"$or": [{"id": uid}, {"user_id": uid}]}, {"$unset": {"sample_room_seeded": ""}})
        raise


@api.get("/rooms/{room_id}/audit")
async def get_room_audit(room_id: str, limit: int = 200,
                         user=Depends(get_current_user)):
    """Return the last N audit events (max 500) within the 30-day window.
    Owner / admin only."""
    await _require_room_owner(room_id, user)
    limit = max(1, min(int(limit or 200), 500))
    docs = await db.audit_events.find(
        {"room_id": room_id},
        {"_id": 0},
    ).sort("ts", -1).to_list(limit)
    # Serialize ts (datetime) as ISO to keep the wire clean
    for d in docs:
        ts = d.pop("ts", None)
        if isinstance(ts, datetime):
            d["ts"] = ts.isoformat()
        elif ts is not None:
            d["ts"] = str(ts)
        else:
            d["ts"] = d.get("ts_iso")
    return {"room_id": room_id, "events": docs}


# ---------------------------------------------------------------------
# User notes — one-liners a room owner attaches to revoke/invite/approve
# /deny actions. Delivered to a single recipient (recipient_user_id) and
# surfaced in the top-bar notifications bell on the recipient's next visit.
# ---------------------------------------------------------------------

@api.get("/user-notes")
async def list_user_notes(unseen: bool = False, limit: int = 50,
                          user=Depends(get_current_user)):
    q = {"recipient_user_id": user["id"]}
    if unseen: q["seen"] = False
    docs = await db.user_notes.find(q, {"_id": 0}).sort("ts", -1).to_list(min(int(limit or 50), 200))
    for d in docs:
        ts = d.pop("ts", None)
        if isinstance(ts, datetime): d["ts"] = ts.isoformat()
        elif ts is not None: d["ts"] = str(ts)
        else: d["ts"] = d.get("created_at")
    return {"notes": docs, "unseen_count": sum(1 for d in docs if not d.get("seen"))}


class NoteAckIn(BaseModel):
    ids: Optional[List[str]] = None


@api.post("/user-notes/ack")
async def ack_user_notes(body: NoteAckIn, user=Depends(get_current_user)):
    """Mark notes as seen. If `ids` is omitted, marks ALL of this user's
    unseen notes as seen (used when the bell dropdown is opened)."""
    q = {"recipient_user_id": user["id"], "seen": False}
    if body.ids:
        q["id"] = {"$in": body.ids}
    r = await db.user_notes.update_many(q, {"$set": {"seen": True, "seen_at": now_iso()}})
    return {"ok": True, "marked": r.modified_count}


# ---------------------------------------------------------------------
# Access requests — a non-owner peeks at a room URL and requests access.
# Rate-limited to 1 pending per (user, room). Owner sees pending requests
# in the Sharing Panel + the top-bar bell.
# ---------------------------------------------------------------------

class AccessRequestIn(BaseModel):
    note: Optional[str] = None


@api.get("/rooms/{room_id}/access-preview")
async def access_preview(room_id: str, user=Depends(get_current_user)):
    """Public-to-authenticated preview so the "Request access" page can
    render a room name + owner name without granting read access to the
    scene."""
    node = await db.hierarchy.find_one({"id": room_id},
        {"_id": 0, "name": 1, "type": 1, "owner_email": 1, "owner_org": 1,
         "is_legacy": 1, "owner_id": 1})
    if not node or node.get("type") != "utility":
        raise HTTPException(404, "Room not found")
    # Do I already have access?
    has_access = True
    try:
        await _enforce_room_access(user, room_id, write=False)
    except HTTPException:
        has_access = False
    # Do I already have a pending request?
    pending = await db.access_requests.find_one({
        "room_id": room_id, "requester_id": user["id"], "status": "pending",
    })
    return {
        "room_id": room_id, "name": node.get("name"),
        "owner_email": node.get("owner_email"),
        "owner_org": node.get("owner_org"),
        "has_access": has_access,
        "pending_request": bool(pending),
    }


@api.post("/rooms/{room_id}/access-request")
async def request_room_access(room_id: str, body: AccessRequestIn,
                              user=Depends(get_current_user)):
    """Ask the room owner for access. Rate-limited: 1 pending per (user,room).
    Owner sees it in Sharing Panel → Requests + the bell."""
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    if not node or node.get("type") != "utility":
        raise HTTPException(404, "Room not found")
    if not node.get("owner_id") or node.get("owner_id") == "legacy":
        raise HTTPException(400, "This room has no owner to notify.")
    if node.get("owner_id") == user["id"]:
        raise HTTPException(400, "You already own this room.")
    # Already granted?
    grant = await db.access_grants.find_one({
        "user_id": user["id"], "scope": "room", "scope_id": room_id,
    })
    if grant:
        raise HTTPException(400, "You already have access to this room.")
    # 1 pending request per user per room
    existing = await db.access_requests.find_one({
        "room_id": room_id, "requester_id": user["id"], "status": "pending",
    })
    if existing:
        raise HTTPException(409, "You already have a pending request for this room.")
    req = {
        "id": new_id(),
        "room_id": room_id,
        "room_name": node.get("name"),
        "owner_id": node.get("owner_id"),
        "requester_id": user["id"],
        "requester_email": user.get("email"),
        "requester_name": user.get("name"),
        "requester_org": (user.get("organization") or None),
        "note": (body.note or "")[:240] or None,
        "status": "pending",
        "created_at": now_iso(),
        "ts": datetime.now(timezone.utc),
    }
    await db.access_requests.insert_one(req)
    return {"ok": True, "request_id": req["id"], "status": "pending"}


@api.get("/rooms/{room_id}/access-requests")
async def list_room_access_requests(room_id: str, status: str = "pending",
                                    user=Depends(get_current_user)):
    """Owner / admin only. Returns pending (or any status) access requests
    for this room."""
    await _require_room_owner(room_id, user)
    q = {"room_id": room_id}
    if status: q["status"] = status
    docs = await db.access_requests.find(q, {"_id": 0}).sort("ts", -1).to_list(200)
    for d in docs:
        ts = d.pop("ts", None)
        if isinstance(ts, datetime): d["ts"] = ts.isoformat()
        elif ts is not None: d["ts"] = str(ts)
    return {"room_id": room_id, "requests": docs}


class AccessResolveIn(BaseModel):
    role: Optional[str] = "architect"   # ignored on deny
    note: Optional[str] = None


@api.post("/rooms/{room_id}/access-requests/{req_id}/approve")
async def approve_access_request(room_id: str, req_id: str,
                                 body: AccessResolveIn,
                                 user=Depends(get_current_user)):
    node = await _require_room_owner(room_id, user)
    req = await db.access_requests.find_one({"id": req_id, "room_id": room_id})
    if not req:
        raise HTTPException(404, "Request not found.")
    if req.get("status") != "pending":
        raise HTTPException(409, f"Request already {req['status']}.")
    role = (body.role or "architect").lower().strip()
    if role not in ALLOWED_INVITE_ROLES:
        role = "architect"
    grant_key = {"user_id": req["requester_id"], "scope": "room", "scope_id": room_id}
    await db.access_grants.update_one(
        grant_key,
        {"$set": {**grant_key, "role": role,
                  "granted_by": user["email"], "granted_at": now_iso(),
                  "request_id": req_id}},
        upsert=True,
    )
    await db.access_requests.update_one(
        {"id": req_id},
        {"$set": {"status": "approved", "resolved_at": now_iso(),
                  "resolved_by": user["email"], "resolve_note": (body.note or None)}},
    )
    await _audit_log(room_id, user, "invited",
                     {"role": role, "via": "access_request",
                      "grantee_user_id": req["requester_id"]})
    if body.note and body.note.strip():
        await _create_user_note(
            recipient_user_id=req["requester_id"], from_user=user,
            room_id=room_id, room_name=node.get("name"),
            action="approved", note=body.note.strip()[:240],
        )
    else:
        # Still notify — plain approval message
        await _create_user_note(
            recipient_user_id=req["requester_id"], from_user=user,
            room_id=room_id, room_name=node.get("name"),
            action="approved",
            note=f"Access approved as {role}. You can open the room now.",
        )
    return {"ok": True, "status": "approved", "role": role}


@api.post("/rooms/{room_id}/access-requests/{req_id}/deny")
async def deny_access_request(room_id: str, req_id: str,
                              body: AccessResolveIn,
                              user=Depends(get_current_user)):
    node = await _require_room_owner(room_id, user)
    req = await db.access_requests.find_one({"id": req_id, "room_id": room_id})
    if not req:
        raise HTTPException(404, "Request not found.")
    if req.get("status") != "pending":
        raise HTTPException(409, f"Request already {req['status']}.")
    await db.access_requests.update_one(
        {"id": req_id},
        {"$set": {"status": "denied", "resolved_at": now_iso(),
                  "resolved_by": user["email"], "resolve_note": (body.note or None)}},
    )
    if body.note and body.note.strip():
        await _create_user_note(
            recipient_user_id=req["requester_id"], from_user=user,
            room_id=room_id, room_name=node.get("name"),
            action="denied", note=body.note.strip()[:240],
        )
    return {"ok": True, "status": "denied"}


@api.get("/my/access-requests-count")
async def my_open_requests_count(user=Depends(get_current_user)):
    """Total pending access requests across all rooms I own. Used by the
    top-bar bell to draw a badge."""
    n = await db.access_requests.count_documents({
        "owner_id": user["id"], "status": "pending",
    })
    return {"count": n}


# ---------------------------------------------------------------------
# Template gallery — a focused view on Representation (seed) rooms with
# a scene summary so the Templates page can render meaningful cards.
# ---------------------------------------------------------------------

@api.get("/templates")
async def list_templates(user=Depends(get_current_user)):
    """List all Representation utility rooms + light scene summaries."""
    nodes = await db.hierarchy.find(
        {"type": "utility",
         "$or": [{"is_seed": True}, {"owner_id": {"$exists": False}},
                 {"owner_id": None}]},
        {"_id": 0},
    ).to_list(500)
    # Filter out legacy
    nodes = [n for n in nodes if not n.get("is_legacy") and n.get("owner_id") != "legacy"]
    out = []
    for n in nodes:
        scene = await db.scenes.find_one({"room_id": n["id"]},
            {"_id": 0, "width": 1, "depth": 1, "items": 1}) or {}
        w, d = scene.get("width"), scene.get("depth")
        items = scene.get("items") or []
        out.append({
            "id": n["id"], "name": n["name"],
            "kind": (n.get("metadata") or {}).get("kind"),
            "code": (n.get("metadata") or {}).get("code"),
            "size": (n.get("metadata") or {}).get("size"),
            "risk_rating": n.get("risk_rating"),
            "width_m": w, "depth_m": d,
            "area_m2": (round(w * d, 1) if w and d else None),
            "items_count": len(items),
            "zones_count": len((await db.scenes.find_one(
                {"room_id": n["id"]}, {"_id": 0, "zones": 1}) or {}).get("zones") or {}),
        })
    return {"templates": sorted(out, key=lambda x: x["name"])}


# ---------- AI-Authored Rooms ----------
@api.post("/rooms/{room_id}/ai/generate")
async def ai_generate_scene(room_id: str,
                            body: Dict[str, Any] = Body(...),
                            user=Depends(_room_access)):
    """Accept a plain-English brief ("dirty utility for a 6-bed ward, needs
    a macerator, no urine scale") and generate a compliant scene from
    scratch via Gemini. The server:
      1. Sends the brief + a compact component catalogue to Gemini.
      2. Expects a strict JSON layout: `{width, depth, ceiling_h, zones,
         partitions, items:[{component_key,x,y,rotation,zone,mount_type}]}`.
      3. Hydrates footprints from the library.
      4. Snap-corrects every against-wall / wall-mounted item so the
         result is orientation-compliant by construction.
      5. Persists as the scene and returns it. Requires ownership."""
    brief = (body.get("brief") or "").strip()
    if not brief:
        raise HTTPException(400, "brief is required")
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0}) or {}
    W = float(body.get("width")  or scene.get("width", 3.6))
    D = float(body.get("depth")  or scene.get("depth", 2.5))
    llm.require_key()

    # Compact component catalogue — every published key, its name, its
    # placement class, its default footprint and default zone affinity.
    components = await db.components.find({"published": True}, {"_id": 0}).to_list(2000)
    catalogue = [
        {"key": c["key"], "name": c.get("name"), "kind": c.get("kind"),
         "placement": c.get("placement"),
         "mount_type": c.get("mount_type", "floor"),
         "zone": c.get("zone_affinity"),
         "w": c.get("default_footprint", {}).get("w", 0.5),
         "d": c.get("default_footprint", {}).get("d", 0.5)}
        for c in components
    ]
    gen_system = (
            "You are a healthcare facility layout designer. Given a "
            "plain-English brief and a component catalogue, output ONE "
            "JSON object with keys: width (m), depth (m), ceiling_h (m), "
            "zones (map {dirty|transition|clean → {x,y,w,d}}), partitions "
            "(list of {x1,y1,x2,y2} — one on the transition/dirty line is "
            "standard), and items (list of {component_key, x, y, rotation "
            "(0/90/180/270), zone, mount_type}). x/y are metres from the "
            "top-left corner of the room. Only use `component_key` values "
            "from the catalogue. Do NOT include markdown or prose. Output "
            "must be valid JSON. Aim for a working NHS/HBN-compliant "
            "layout for a Dirty Utility Room unless the brief says otherwise."
        )
    prompt = (
        f"Room dimensions: {W:.2f}m × {D:.2f}m.\n"
        f"Brief: {brief}\n\n"
        f"Component catalogue (JSON):\n{_json.dumps(catalogue)[:60000]}\n\n"
        "Respond with a single JSON object as specified in the system message."
    )
    try:
        reply = await llm.generate_text(prompt, system=gen_system, model="text")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"AI generation failed: {e}")
    # Strip fences if the model added them.
    text = (reply or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"): text = text[4:]
        text = text.strip()
    try:
        plan = _json.loads(text)
    except Exception:
        raise HTTPException(502, f"AI returned invalid JSON: {text[:200]}")

    # Hydrate footprints + snap orient-critical items.
    comp_by_key = {c["key"]: c for c in components}
    new_items = []
    for raw in plan.get("items", []):
        key = raw.get("component_key")
        c = comp_by_key.get(key)
        if not c:
            continue
        fp = c.get("default_footprint", {})
        it = {
            "id": new_id(),
            "component_key": key,
            "x": float(raw.get("x", 0)),
            "y": float(raw.get("y", 0)),
            "w": fp.get("w", 0.5), "d": fp.get("d", 0.5),
            "rotation": int(raw.get("rotation", 0)) % 360,
            "zone": raw.get("zone") or c.get("zone_affinity", "transition"),
            "mount_type": raw.get("mount_type") or c.get("mount_type", "floor"),
            "elevation_m": c.get("elevation_m", 0),
            "height_m": fp.get("h", 0.9),
        }
        new_items.append(it)
    ai_scene = {
        "room_id": room_id,
        "width": float(plan.get("width", W)),
        "depth": float(plan.get("depth", D)),
        "ceiling_h": float(plan.get("ceiling_h", 2.7)),
        "zones": plan.get("zones") or scene.get("zones") or {},
        "partitions": plan.get("partitions") or [],
        "items": new_items,
        "shape": scene.get("shape") or {"type": "rectangle"},
    }
    # Snap every wall / against-wall item so the AI's rough positions
    # end up flush and correctly rotated.
    for it in ai_scene["items"]:
        placement = comp_by_key.get(it["component_key"], {}).get("placement")
        if placement in ("wall_mounted", "against_wall"):
            _snap_item_to_wall(it, ai_scene, placement=placement)

    # Persist.
    version = (scene.get("version", 0) if scene else 0) + 1
    ai_scene["version"] = version
    ai_scene["updated_at"] = now_iso()
    await db.scenes.update_one({"room_id": room_id}, {"$set": ai_scene}, upsert=True)
    await db.changelog.insert_one({"id": new_id(), "room_id": room_id,
        "author": user["email"], "role": user["role"], "timestamp": now_iso(),
        "delta_summary": f"AI-generated scene from brief: “{brief[:80]}” — "
                         f"{len(new_items)} components, {len(ai_scene['partitions'])} partition(s)",
        "version": version})
    return {"ok": True, "scene": ai_scene, "brief": brief}



# ---------- AI Co-Designer ----------
def _build_scene_summary(scene, components, validation=None):
    """Compact textual summary of a scene for the LLM."""
    comp_map = {c["key"]: c for c in components}
    W, D = scene.get("width", 3.0), scene.get("depth", 3.0)
    lines = [f"Room {W:.1f}m × {D:.1f}m × {scene.get('ceiling_h', 2.7):.1f}m ceiling."]
    zones = scene.get("zones", {})
    if zones:
        lines.append("Zones:")
        for k, z in zones.items():
            lines.append(f"  - {k}: x={z['x']:.2f}, y={z['y']:.2f}, w={z['w']:.2f}, d={z['d']:.2f}")
    lines.append(f"Items ({len(scene.get('items', []))}):")
    for it in scene.get("items", []):
        c = comp_map.get(it["component_key"], {})
        lines.append(
            f"  - {c.get('name', it['component_key'])} [{it['component_key']}] "
            f"@ ({it['x']:.2f},{it['y']:.2f}) {it['w']:.2f}×{it['d']:.2f} "
            f"zone={it.get('zone')} mount={it.get('mount_type','floor')} "
            f"elev={it.get('elevation_m',0):.2f} h={it.get('height_m',0.9):.2f}"
        )
    if validation:
        lines.append(f"\nValidation: passed={validation.get('passed')}")
        for f in validation.get("flags", [])[:20]:
            lines.append(f"  - {f['rule_id']} [{f['tier']}/{f['kind']}]: {f['message']}")
    return "\n".join(lines)


AI_RECS_SYSTEM = (
    "You are a senior healthcare-facility architect and infection-prevention lead advising on "
    "the co-design of an Inpatient Dirty Utility Room. You have deep knowledge of NHS HBN 00-09, "
    "HTM 04-01, ASHRAE 170, WHO WASH FIT and Perkins&Will best-practice. Recommendations must be "
    "concise, specific to the given scene, and actionable."
)

@api.post("/rooms/{room_id}/ai/recommendations")
async def ai_recommendations(room_id: str, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found")
    components = await db.components.find({"published": True}, {"_id": 0}).to_list(2000)
    validation = await db.validations.find_one({"room_id": room_id}, {"_id": 0}, sort=[("timestamp", -1)])
    llm.require_key()

    summary = _build_scene_summary(scene, components, validation)
    available_keys = ", ".join(sorted({c["key"] for c in components}))
    prompt = f"""Analyse the following room and produce structured recommendations. Return ONLY a JSON object (no prose, no code fences) matching this schema exactly:

{{
  "layout_suggestions": [
    {{ "title": "short title", "detail": "actionable change (1-2 sentences)", "impact": "low|medium|high" }}
  ],
  "compliance_fixes": [
    {{ "rule_id": "as in validation", "title": "short title", "detail": "specific move/add/remove that resolves the flag", "impact": "low|medium|high" }}
  ],
  "missing_components": [
    {{ "component_key": "one of the available keys", "reason": "why it should be added", "suggested_zone": "clean|transition|dirty" }}
  ]
}}

Return between 2-4 items per array. Prefer concrete moves (e.g. "shift macerator to x=0.2, y=0.1 to increase basin separation to 1.3m") over generic advice. Use these available component keys for missing_components: {available_keys}.

=== SCENE ===
{summary}
"""
    try:
        resp = await llm.generate_text(prompt, system=AI_RECS_SYSTEM)
    except Exception as e:
        raise HTTPException(500, f"AI recommendations failed: {e}")

    text = resp if isinstance(resp, str) else str(resp)
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
    match = re.search(r"\{[\s\S]*\}", text)
    if not match: raise HTTPException(500, f"Could not parse AI response: {text[:400]}")
    try:
        data = _json.loads(match.group(0))
    except Exception as e:
        raise HTTPException(500, f"JSON parse error: {e}")
    data.setdefault("layout_suggestions", [])
    data.setdefault("compliance_fixes", [])
    data.setdefault("missing_components", [])
    doc = {"id": new_id(), "room_id": room_id, "scene_version": scene.get("version"),
           "generated_at": now_iso(), "generated_by": user["email"], **data}
    await db.ai_recommendations.insert_one({**doc})
    doc.pop("_id", None)
    return doc


class AiChatIn(BaseModel):
    session_id: str
    message: str

AI_CHAT_SYSTEM = (
    "You are the on-call co-designer for a healthcare Inpatient Dirty Utility Room project. "
    "Answer questions from architects and infection-prevention leads. You can reason about the "
    "current room's items, zones, dimensions and validation flags. Be concise (max ~120 words per "
    "reply), cite standards when relevant (NHS HBN 00-09, HTM 04-01, ASHRAE 170, WHO WASH FIT), "
    "and prefer concrete actions. If asked to modify the room, describe the change; do not invent "
    "an item that doesn't exist in the component library."
)

@api.post("/rooms/{room_id}/ai/chat")
async def ai_chat(room_id: str, body: AiChatIn, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found")
    components = await db.components.find({"published": True}, {"_id": 0}).to_list(2000)
    validation = await db.validations.find_one({"room_id": room_id}, {"_id": 0}, sort=[("timestamp", -1)])
    llm.require_key()

    # Persist user message
    ts = now_iso()
    await db.ai_chat_messages.insert_one({
        "id": new_id(), "room_id": room_id, "session_id": body.session_id,
        "role": "user", "content": body.message, "timestamp": ts,
    })

    # Load prior history for continuity
    prior = await db.ai_chat_messages.find(
        {"room_id": room_id, "session_id": body.session_id}, {"_id": 0}
    ).sort("timestamp", 1).to_list(200)

    scene_context = _build_scene_summary(scene, components, validation)

    # Inline recent turns (excluding the just-inserted one) as transcript
    history = prior[:-1][-10:]  # last 10 turns before current
    transcript = "\n".join(
        f"{'USER' if m['role']=='user' else 'ASSISTANT'}: {m['content']}" for m in history
    )
    system = AI_CHAT_SYSTEM + "\n\nCURRENT ROOM CONTEXT:\n" + scene_context
    if transcript:
        system += "\n\nPRIOR CONVERSATION (for continuity):\n" + transcript

    try:
        reply = await llm.generate_text(body.message, system=system)
    except Exception as e:
        # Roll back the just-inserted user message so history stays clean
        await db.ai_chat_messages.delete_one({"room_id": room_id, "session_id": body.session_id, "timestamp": ts, "role": "user"})
        raise HTTPException(500, f"AI chat failed: {e}")

    reply_text = reply if isinstance(reply, str) else str(reply)
    await db.ai_chat_messages.insert_one({
        "id": new_id(), "room_id": room_id, "session_id": body.session_id,
        "role": "assistant", "content": reply_text, "timestamp": now_iso(),
    })
    return {"reply": reply_text, "session_id": body.session_id}

@api.get("/rooms/{room_id}/ai/chat/{session_id}")
async def ai_chat_history(room_id: str, session_id: str, user=Depends(_room_access)):
    msgs = await db.ai_chat_messages.find(
        {"room_id": room_id, "session_id": session_id}, {"_id": 0}
    ).sort("timestamp", 1).to_list(500)
    return msgs

@api.delete("/rooms/{room_id}/ai/chat/{session_id}")
async def ai_chat_clear(room_id: str, session_id: str, user=Depends(_room_access)):
    r = await db.ai_chat_messages.delete_many({"room_id": room_id, "session_id": session_id})
    return {"ok": True, "cleared": r.deleted_count}


AI_AUTOFIX_SYSTEM = (
    "You are a healthcare-facility architect refactoring the layout of an "
    "Inpatient Dirty Utility Room to make it compliant with NHS HBN 00-09, "
    "HTM 04-01, ASHRAE 170 and WHO WASH FIT. Prefer minimum-move layouts."
)

@api.post("/rooms/{room_id}/ai/autofix/jobs")
async def start_autofix_job(room_id: str, deep: bool = False, user=Depends(_room_access)):
    """Run the (slow) compliance assistant in the background so the proxy never times out."""
    job_id = new_id()
    await db.ai_jobs.insert_one({"id": job_id, "room_id": room_id, "user_id": user.get("id"),
                                 "status": "running", "created_at": now_iso()})

    async def _run():
        try:
            res = await ai_autofix(room_id, deep, user)
            upd = {"status": "done", "result": res}
        except HTTPException as e:
            upd = {"status": "error", "detail": e.detail}
        except Exception as e:
            logging.exception("autofix job failed")
            upd = {"status": "error", "detail": f"Compliance Assistant failed: {e}"}
        await db.ai_jobs.update_one({"id": job_id}, {"$set": {**upd, "finished_at": now_iso()}})

    task = asyncio.create_task(_run())
    _AI_TASKS.add(task)
    task.add_done_callback(_AI_TASKS.discard)
    return {"job_id": job_id, "status": "running"}


_AI_TASKS: set = set()


@api.get("/ai/jobs/{job_id}")
async def get_ai_job(job_id: str, user=Depends(get_current_user)):
    job = await db.ai_jobs.find_one({"id": job_id, "user_id": user.get("id")}, {"_id": 0})
    if not job:
        raise HTTPException(404, "Job not found")
    # A job orphaned by a backend restart would otherwise stay "running" forever.
    if job["status"] == "running":
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(job["created_at"])).total_seconds()
        if age > 240:
            job.update(status="error", detail="Compliance Assistant was interrupted — please run it again")
            await db.ai_jobs.update_one({"id": job_id}, {"$set": {"status": "error", "detail": job["detail"]}})
    return job


@api.post("/rooms/{room_id}/ai/autofix")
async def ai_autofix(room_id: str, deep: bool = False, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found")
    components = await db.components.find({"published": True}, {"_id": 0}).to_list(2000)
    validation = await db.validations.find_one({"room_id": room_id}, {"_id": 0}, sort=[("timestamp", -1)])
    llm.require_key()

    comp_by_key = {c["key"]: c for c in components}
    # Resolve required list from utility metadata (data-driven), same as validator
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    node_required = (node or {}).get("metadata", {}).get("required_components") or [
        {"key": "macerator", "zone": "dirty"},
        {"key": "clinical_wash_basin", "zone": "transition"},
        {"key": "prep_counter", "zone": "dirty"},
    ]
    present_keys = {i["component_key"] for i in scene.get("items", [])}
    missing = [r for r in node_required if r["key"] not in present_keys] if deep else []

    summary = _build_scene_summary(scene, components, validation)
    items_now = [
        {"id": it["id"], "component_key": it["component_key"], "zone": it.get("zone"),
         "mount_type": it.get("mount_type", "floor"),
         "x": round(it["x"], 3), "y": round(it["y"], 3),
         "w": it["w"], "d": it["d"],
         "rotation": it.get("rotation", 0),
         "elevation_m": it.get("elevation_m", 0),
         "height_m": it.get("height_m", 0.9)}
        for it in scene.get("items", [])
    ]
    W, D = scene.get("width", 3.0), scene.get("depth", 3.0)

    deep_block = ""
    if missing:
        deep_block = f"""
=== MISSING REQUIRED COMPONENTS (also add these) ===
{_json.dumps(missing)}

For each missing item, produce an "adds" entry with a good (x, y, rotation, zone) inside the correct zone. Use the component's default footprint (w,d,h) — you don't need to specify size.
"""

    prompt = f"""Analyse the room and produce a compliant layout. Rules to respect:
1. Every item's (x, y) must fit inside [0, {W:.2f}] × [0, {D:.2f}] with (x+w) and (y+d) also inside the room.
2. Floor items must sit inside their zone rect (see summary below).
3. Hand-wash basin must be at least 1.0 m (edge-to-edge) from any macerator.
4. Doors keep their positions.
5. Prefer subtle moves.

Return ONLY a JSON object matching this schema — no prose, no code fences:
{{
  "moves": [
    {{ "id": "<existing item id>", "x": number, "y": number, "rotation": number|null, "zone": "clean"|"transition"|"dirty"|null, "reason": "short (<=60 chars)" }}
  ],
  "adds": [
    {{ "component_key": "<from available list>", "x": number, "y": number, "rotation": number, "zone": "clean"|"transition"|"dirty", "reason": "short (<=60 chars)" }}
  ],
  "notes": "one-line summary"
}}
{deep_block}
=== SCENE ===
{summary}

=== EXISTING ITEMS (use these ids exactly for moves) ===
{_json.dumps(items_now)}
"""
    try:
        resp = await llm.generate_text(prompt, system=AI_AUTOFIX_SYSTEM)
    except Exception as e:
        raise HTTPException(500, f"AI autofix failed: {e}")
    text = resp if isinstance(resp, str) else str(resp)
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
    match = re.search(r"\{[\s\S]*\}", text)
    if not match: raise HTTPException(500, f"Could not parse AI autofix: {text[:400]}")
    try:
        data = _json.loads(match.group(0))
    except Exception as e:
        raise HTTPException(500, f"JSON parse error: {e}")

    # Apply moves defensively
    id_set = {it["id"] for it in scene["items"]}
    id_to_wd = {it["id"]: (it["w"], it["d"]) for it in scene["items"]}
    clean_moves = []
    for m in data.get("moves", []):
        if m.get("id") not in id_set: continue
        w, d = id_to_wd[m["id"]]
        move = {"id": m["id"]}
        if "x" in m and isinstance(m["x"], (int, float)):
            move["x"] = max(0.0, min(W - w, float(m["x"])))
        if "y" in m and isinstance(m["y"], (int, float)):
            move["y"] = max(0.0, min(D - d, float(m["y"])))
        if m.get("rotation") is not None and isinstance(m["rotation"], (int, float)):
            move["rotation"] = int(m["rotation"]) % 360
        if m.get("zone") in ("clean", "transition", "dirty"):
            move["zone"] = m["zone"]
        if m.get("reason"): move["reason"] = str(m["reason"])[:80]
        if len(move) > 1: clean_moves.append(move)

    # Validate adds (only when deep)
    clean_adds = []
    if deep:
        for a in data.get("adds", []):
            key = a.get("component_key")
            comp = comp_by_key.get(key)
            if not comp: continue
            fp = comp.get("default_footprint", {"w": 0.5, "d": 0.5, "h": 0.9})
            w, d, h = fp.get("w", 0.5), fp.get("d", 0.5), fp.get("h", 0.9)
            x = max(0.0, min(W - w, float(a.get("x", 0.5))))
            y = max(0.0, min(D - d, float(a.get("y", 0.5))))
            zone = a.get("zone") if a.get("zone") in ("clean","transition","dirty") else (comp.get("zone_affinity") or "transition")
            clean_adds.append({
                "component_key": key,
                "x": round(x, 3), "y": round(y, 3),
                "w": w, "d": d,
                "rotation": int(a.get("rotation", 0)) % 360,
                "zone": zone,
                "mount_type": comp.get("mount_type", "floor"),
                "elevation_m": comp.get("elevation_m", 0),
                "height_m": h,
                "kind": comp.get("kind"),
                "material": comp.get("material"),
                "code": comp.get("code"),
                "reason": (a.get("reason") or "")[:80],
            })

    return {
        "moves": clean_moves,
        "adds": clean_adds,
        "notes": (data.get("notes") or "")[:200],
        "scene_version": scene.get("version"),
    }


# ---------- PDF Ingestion ----------
@api.post("/ingestion/pdf-extract")
async def pdf_extract(file: UploadFile = File(...), user=Depends(get_current_user)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files supported")
    contents = await file.read()
    if len(contents) > 25 * 1024 * 1024:
        raise HTTPException(400, "PDF too large (max 25 MB)")

    # Persist the PDF so extracted rules can deep-link back into it.
    pdf_id = new_id()
    persisted_path = str(PDF_DIR / f"{pdf_id}.pdf")
    put_upload(Path(persisted_path), contents, "application/pdf")
    # Register in DB so the file can be served + audited.
    await db.pdf_uploads.insert_one({
        "id": pdf_id,
        "original_filename": file.filename,
        "size_bytes": len(contents),
        "uploaded_by": user["email"],
        "uploaded_at": now_iso(),
    })
    # Public URL any authenticated user can hit (respects the same cookie/JWT auth as the rest of /api).
    source_url = f"/api/ingestion/pdfs/{pdf_id}"

    try:
        llm.require_key()
        prompt = (
            "You are extracting candidate design rules from an architectural or "
            "healthcare standards document (e.g. NHS HBN, HTM, ASHRAE, FGI, WHO).\n\n"
            "Return ONLY a JSON array (no prose, no code fences). Each item must "
            "match this schema exactly:\n"
            '{ "rule_id": "SHORT-CODE-###", '
            '  "category": "Spatial workflow" | "Ventilation" | "Materiality & finishes" | '
            '"Plumbing & bioburden" | "Acoustics & vibration" | "Lighting & electrical safety", '
            '  "statement": "concise, actionable rule", '
            '  "source": "exact document reference", '
            '  "source_page": integer page number where this rule appears, '
            '  "region": "UK|USA|EU|AU|INT", '
            '  "tier": "baseline|enhanced|v2", '
            '  "status": "current_nhs_baseline|under_review|international_comparator", '
            '  "severity_if_violated": "low|medium|high", '
            '  "numeric_value": number or null, "numeric_unit": string or null }\n\n'
            "Extract up to 15 substantive rules. Skip narrative. Prefer quantifiable rules. "
            "The `source_page` field is mandatory — use the page number the rule is "
            "extracted from so the reviewer can cite it exactly. "
            "If a source cannot be attributed, skip it (no source, no publish)."
        )
        response = await llm.generate_text(
            prompt, system="You extract structured design rules from standards documents.",
            model="pdf", pdf_bytes=contents)
        text = response if isinstance(response, str) else str(response)
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
        match = re.search(r"\[[\s\S]*\]", text)
        if not match: raise HTTPException(500, f"Could not parse candidate rules: {text[:400]}")
        try: candidates = _json.loads(match.group(0))
        except Exception as e: raise HTTPException(500, f"JSON parse error: {e}")
        # Attach the persisted-PDF URL to every candidate so approved rules become
        # deep-linkable in the Knowledge Base without any extra plumbing.
        for c in candidates:
            c["_preview_id"] = new_id()
            c["source_url"] = source_url
            c["source_pdf_id"] = pdf_id
            # Normalise source_page to int if the model gave us a string.
            if isinstance(c.get("source_page"), str) and c["source_page"].isdigit():
                c["source_page"] = int(c["source_page"])
        return {"source_file": file.filename, "extracted_at": now_iso(),
                "extracted_by": user["email"],
                "source_pdf_id": pdf_id, "source_url": source_url,
                "candidates": candidates}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Extraction failed: {e}")


@api.get("/ingestion/pdfs/{pdf_id}")
async def serve_ingested_pdf(pdf_id: str, user=Depends(get_current_user)):
    """Stream a previously-uploaded ingestion PDF back to the browser.
    Used so extracted rules can deep-link into `#page=N` fragments in the KB."""
    from fastapi.responses import FileResponse
    from urllib.parse import quote
    doc = await db.pdf_uploads.find_one({"id": pdf_id})
    if not doc:
        raise HTTPException(404, "PDF not found")
    path = str(PDF_DIR / f"{pdf_id}.pdf")
    if not ensure_local(path):
        raise HTTPException(404, "PDF file missing on disk")
    filename = doc.get("original_filename") or f"{pdf_id}.pdf"
    return FileResponse(
        path=path, media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}"}
    )


# ============ SEED DATA ============
async def seed_users():
    users_seed = [
        (os.environ.get("ADMIN_EMAIL","admin@his.dev"), os.environ.get("ADMIN_PASSWORD","admin123"), "Admin", "admin"),
        ("architect@his.dev","demo1234","Ada Architect","architect"),
        ("ipc@his.dev","demo1234","Ivan IPC","ipc_lead"),
        ("reviewer@his.dev","demo1234","Rae Reviewer","reviewer"),
        ("contributor@his.dev","demo1234","Coco Contributor","contributor"),
    ]
    for email, pwd, name, role in users_seed:
        existing = await db.users.find_one({"email": email})
        if not existing:
            await db.users.insert_one({"id": new_id(), "email": email, "name": name, "role": role,
                                       "password_hash": hash_password(pwd), "created_at": now_iso()})
        elif not existing.get("password_hash") or not verify_password(pwd, existing["password_hash"]):
            await db.users.update_one({"email": email},
                {"$set": {"password_hash": hash_password(pwd), "role": role}})

async def seed_hierarchy():
    # Wipe only seed / representational / legacy nodes. Preserve any
    # user-owned rooms (those with `owner_id` set) across re-seeds so a
    # SEED_VERSION bump does not delete customer data.
    await db.hierarchy.delete_many({"owner_id": {"$in": [None, ""]}})
    await db.hierarchy.delete_many({"owner_id": {"$exists": False}})
    now = now_iso()
    def n(pid, typ, name, meta=None, risk=None, readonly=True):
        return {"id": new_id(), "parent_id": pid, "type": typ, "name": name,
                "metadata": meta or {}, "risk_rating": risk,
                "read_only": readonly,
                "is_seed": True,  # every node from this function is representation
                "created_at": now, "contributors": []}
    docs = []

    estate = n(None, "estate", "NHS Regional Estate")
    docs.append(estate)

    # ---- Hospital 1: Central Hospital ----
    bldg1 = n(estate["id"], "building", "Central Hospital, Block A", {"floors": 6})
    docs.append(bldg1)
    # Zone: Critical Care (floor 3)
    zone_cc = n(bldg1["id"], "zone", "Critical Care", {"floor": 3})
    docs.append(zone_cc)
    ward_icu = n(zone_cc["id"], "ward", "ICU North", {"beds": 12})
    docs.append(ward_icu)
    ward_hdu = n(zone_cc["id"], "ward", "HDU South", {"beds": 8})
    docs.append(ward_hdu)
    room_ss = n(ward_icu["id"], "room", "Support Suite 3B", {})
    docs.append(room_ss)
    # THE editable utility room (nested under the Support Suite)
    util = n(room_ss["id"], "utility", "Inpatient Dirty Utility Room",
             {"kind": "inpatient_dirty_utility", "size": "medium", "acuity": "ICU"},
             risk="high", readonly=False)   # <-- only clickable node
    docs.append(util)
    # Sibling rooms (read-only stubs so the tree looks realistic)
    docs.append(n(ward_icu["id"], "room", "Clean Utility (ICU North)", {}, "medium"))
    docs.append(n(ward_icu["id"], "room", "Equipment Store", {}, "low"))
    docs.append(n(ward_hdu["id"], "room", "Dirty Utility (HDU)", {}, "high"))
    docs.append(n(ward_hdu["id"], "room", "Clean Utility (HDU)", {}, "medium"))

    # Zone: Surgical (floor 4)
    zone_sx = n(bldg1["id"], "zone", "Surgical", {"floor": 4})
    docs.append(zone_sx)
    ward_or = n(zone_sx["id"], "ward", "Theatres 4A", {"theatres": 4})
    docs.append(ward_or)
    docs.append(n(ward_or["id"], "room", "Scrub Room 1", {}, "medium"))
    docs.append(n(ward_or["id"], "room", "Anaesthetic Bay", {}, "medium"))
    docs.append(n(ward_or["id"], "room", "Prep Room", {}, "medium"))

    # ---- Hospital 2: Community Hospital ----
    bldg2 = n(estate["id"], "building", "Community Hospital, West Wing", {"floors": 3})
    docs.append(bldg2)
    zone_inpat = n(bldg2["id"], "zone", "Inpatient Wards", {"floor": 1})
    docs.append(zone_inpat)
    ward_gen = n(zone_inpat["id"], "ward", "General Ward 1G", {"beds": 24})
    docs.append(ward_gen)
    docs.append(n(ward_gen["id"], "room", "Sluice Room", {}, "high"))
    docs.append(n(ward_gen["id"], "room", "Linen Store", {}, "low"))
    docs.append(n(ward_gen["id"], "room", "Staff Base", {}, "low"))

    await db.hierarchy.insert_many(docs)
    return util["id"]

async def seed_components():
    from seed_data import get_components
    await db.components.delete_many({})
    C = list({c["key"]: c for c in reversed(get_components())}.values())[::-1]
    # Enrich each component with a `materials` list — Apple-style hover callouts.
    # Derived from the seed `material` code + `mount_type` + `kind`.
    MATERIALS_BY_MATERIAL = {
        "stainless":      ["Stainless steel 304", "Welded seams (thermowelded)", "Non-porous · easy-clean"],
        "ceramic":        ["Fireclay ceramic", "No plug / no overflow", "TMV to 41 °C"],
        "plastic_white":  ["Antimicrobial ABS plastic", "IPX4 splash-rated", "Sensor / non-touch"],
        "plastic_yellow": ["Antimicrobial ABS plastic", "Foot-operated lid (hands-free)", "Colour-coded (clinical waste)"],
        "laminate":       ["Solid-grade laminate (SGL)", "Sealed edges", "PU-coated for wipe-down"],
        "glass":          ["Toughened safety glass 6mm", "Non-porous", "Wipe-clean"],
        "metal_grille":   ["Powder-coated aluminium", "Removable for cleaning"],
        "led":            ["LED · 4000 K · CRI ≥ 80", "≥ 300 lux at 1 m", "IP54 fixture"],
        "door":           ["Solid-core with PU laminate", "Hands-free / sensor entry", "Kick-plate + finger-guard"],
    }
    MOUNT_HINTS = {
        "floor":   ["Non-slip vinyl underfoot (R10-R11)"],
        "wall":    ["Wall-mounted · IPS panel behind"],
        "ceiling": ["Ceiling-fixed · flush finish"],
    }
    for c in C:
        c["id"] = new_id(); c["published"] = True; c["version"] = 1
        c["rule_ids"] = c.get("rule_ids", [])
        mat_list = list(MATERIALS_BY_MATERIAL.get(c.get("material"), []))
        # Add a mount-context hint so hover explains WHERE it lives.
        mat_list.extend(MOUNT_HINTS.get(c.get("mount_type"), []))
        # Kind-specific extras
        if c.get("kind") == "macerator":
            mat_list.append("Stainless 304 with vibration isolation")
        if c.get("kind") == "bin":
            mat_list.append("Colour-coded UN3291 clinical waste")
        if c.get("kind") == "trolley":
            mat_list.append("Antimicrobial castors · brake x 2")
        c["materials"] = mat_list
    await db.components.insert_many(C)

async def seed_rules():
    from seed_data import get_rules
    await db.rules.delete_many({})
    R = get_rules()
    for r in R:
        r["id"] = new_id(); r["published"] = True; r["version"] = 1
        r["last_reviewed"] = now_iso()
        r.setdefault("applies_to_zone", [])
        r.setdefault("applies_to_components", [])
        r.setdefault("comparator_standards", [])
        # New: enable/disable, scope, kind (rule|interpretation), is_custom
        r.setdefault("enabled", True)
        r.setdefault("scope", "global")
        r.setdefault("room_id", None)
        r.setdefault("kind", "rule")
        r.setdefault("is_custom", False)
    await db.rules.insert_many(R)

async def seed_interpretations():
    """Interpretation notes are user-authored per session — no baseline
    seed. Any legacy sample interpretations previously seeded are removed."""
    await db.rules.delete_many({"kind": "interpretation"})
    # No baseline interpretations. Users author their own per session and
    # can export/import them via /api/knowledge/{export,import}.


async def maybe_seed():
    """Re-seed structural data if SEED_VERSION changed. Always seed users idempotently."""
    await seed_users()
    await migrate_legacy_rooms()
    settings = await db.settings.find_one({"key": "seed_version"})
    current = settings.get("value") if settings else 0
    if current != SEED_VERSION:
        util_id = await seed_hierarchy()
        await seed_components()
        await seed_rules()
        await seed_interpretations()
        # Rebuild default scene for the utility room
        await db.scenes.delete_many({})
        await db.settings.update_one({"key": "seed_version"},
            {"$set": {"value": SEED_VERSION, "updated_at": now_iso()}}, upsert=True)
        logging.info(f"Seeded v{SEED_VERSION}; utility_id={util_id}")


REVIT_TEMPLATE_REV = 3


async def seed_revit_template():
    """Idempotently ensure the Revit Example 01 template room + scene exist."""
    node = await db.hierarchy.find_one({"metadata.template_key": "revit_ex01", "is_seed": True}, {"_id": 0})
    if not node:
        parent = await db.hierarchy.find_one({"is_seed": True, "type": "room", "name": "Support Suite 3B"}, {"_id": 0, "id": 1})
        node = {"id": new_id(), "parent_id": (parent or {}).get("id"), "type": "utility",
                "name": _REVIT_EX01["name"],
                "metadata": {"kind": "inpatient_dirty_utility", "size": "medium", "code": "RDS 6222",
                             "template_key": "revit_ex01", "source": "Revit 2026 IFC export"},
                "risk_rating": "high", "read_only": False, "is_seed": True,
                "created_at": now_iso(), "contributors": []}
        await db.hierarchy.insert_one({**node})
    scene = await db.scenes.find_one({"room_id": node["id"]}, {"_id": 0, "template_rev": 1})
    if not scene or scene.get("template_rev") != REVIT_TEMPLATE_REV:
        r = _REVIT_EX01["room"]
        sc = await _revit_ex01_scene(node["id"], r["width"], r["depth"], r["ceiling_h"])
        sc["standard_applied"] = "revit_ex01"
        sc["template_rev"] = REVIT_TEMPLATE_REV
        sc = await _hydrate_scene_items(sc)
        await db.scenes.replace_one({"room_id": node["id"]}, sc, upsert=True)


async def migrate_legacy_rooms():
    """One-time migration for rooms created before ownership was enforced.
    Any utility node with no `owner_id` and no `is_seed` marker is a
    pre-fix user room. Tag it `owner_id="legacy"` + `is_legacy=True` so
    it (a) survives seed wipes and (b) is hidden from non-admins by the
    hierarchy filter."""
    cursor = db.hierarchy.find(
        {"type": "utility",
         "owner_id": {"$exists": False},
         "is_seed": {"$ne": True}},
        {"_id": 0, "id": 1, "read_only": 1},
    )
    updated = 0
    async for doc in cursor:
        # The old seed script set `read_only` (True/False) on every node.
        # If that field is absent, it was created by POST /rooms and is a
        # real user room that predates ownership.
        if "read_only" in doc:
            # Legacy seed node — will be wiped and re-seeded below.
            continue
        await db.hierarchy.update_one(
            {"id": doc["id"]},
            {"$set": {"owner_id": "legacy", "is_legacy": True,
                      "legacy_migrated_at": now_iso()}},
        )
        updated += 1
    if updated:
        logging.info(f"Migrated {updated} pre-ownership rooms to legacy bucket")


@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True)
    await db.hierarchy.create_index("parent_id")
    await db.rules.create_index("rule_id")
    await db.scenes.create_index("room_id", unique=True)
    await db.changelog.create_index("room_id")
    # Audit events: 30-day TTL on the BSON date field `ts`
    await db.audit_events.create_index("room_id")
    await db.audit_events.create_index("ts", expireAfterSeconds=30 * 24 * 60 * 60)
    await maybe_seed()
    await _dedupe_components()
    await _ensure_generic_component()
    await seed_revit_template()
    await seed_bundled_families()


# ---------------------------------------------------------------------
# Bundled Revit families — 27 admin-uploaded `.rfa` files that ship
# alongside the code so they persist across redeploys. On startup we
# read backend/seed_families/seed_families.json and upsert each
# entry into `db.ifc_families`, marking them `is_system: True` so the
# UI can distinguish default catalogue from per-user uploads.
# ---------------------------------------------------------------------
async def seed_bundled_families():
    seed_dir = ROOT_DIR / "seed_families"
    idx = seed_dir / "seed_families.json"
    if not idx.exists():
        return
    try:
        docs = _json.loads(idx.read_text())
    except Exception as e:
        logging.warning(f"seed_bundled_families: cannot parse {idx}: {e}")
        return
    inserted, refreshed, skipped = 0, 0, 0
    for d in docs:
        fam_id = d.get("id")
        if not fam_id: continue
        # Resolve `path` — the seed JSON stores a bare filename; we look
        # for it inside the bundled seed_families dir. If also present in
        # the runtime FAMILIES_DIR that wins (the user may have re-uploaded).
        seed_file = seed_dir / d.get("path", "")
        runtime_file = FAMILIES_DIR / seed_file.name
        chosen = runtime_file if runtime_file.exists() else seed_file
        if not chosen.exists():
            logging.warning(f"seed_bundled_families: missing file for {fam_id}: {seed_file}")
            skipped += 1
            continue
        existing = await db.ifc_families.find_one({"id": fam_id}, {"_id": 0, "id": 1})
        doc = {**d, "path": str(chosen), "is_system": True, "seed_source": "bundled"}
        if existing:
            # Never trample user re-classifications; just make sure the
            # `path` still resolves to a real file on this pod.
            await db.ifc_families.update_one(
                {"id": fam_id},
                {"$set": {"path": str(chosen), "is_system": True}},
            )
            refreshed += 1
        else:
            await db.ifc_families.insert_one(doc)
            inserted += 1
    if inserted or refreshed or skipped:
        logging.info(
            f"seed_bundled_families: inserted={inserted} refreshed={refreshed} skipped={skipped}"
        )


@app.on_event("shutdown")
async def on_shutdown(): client.close()


# ---------- Notification-count endpoint ----------
@api.get("/notifications/pending-review-count")
async def pending_review_count(user=Depends(get_current_user)):
    """Cheap poll target for the TopBar bell — scoped exactly like GET /ingestion."""
    q = {"state": "pending_review"}
    if user.get("role") not in ("reviewer", "admin"):
        q["submitted_by"] = user["email"]
    n = await db.ingestion.count_documents(q)
    return {"count": n}


@api.get("/rooms/{room_id}/presence")
async def rest_presence(room_id: str, user=Depends(_room_access)):
    """REST fallback for non-WS clients — snapshot of who's currently in the room."""
    return {"peers": presence.peers(room_id)}


# ---------- Room Data Sheet: Excel export ----------
@api.get("/rooms/{room_id}/data-sheet.xlsx")
async def export_room_data_sheet_xlsx(room_id: str, user=Depends(_room_access)):
    """Excel counterpart of the PDF data sheet — Zones · Components · Rules · Decisions · Derogations."""
    node = await db.hierarchy.find_one({"id": room_id, "type": "utility"}, {"_id": 0})
    if not node: raise HTTPException(404, "Room not found")
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found")
    all_components = {c["key"]: c for c in await db.components.find({"published": True}, {"_id": 0}).to_list(2000)}
    rules = await db.rules.find({
        "published": True, "enabled": {"$ne": False},
        "$or": [{"scope": "global"}, {"scope": {"$exists": False}}, {"room_id": room_id}],
    }, {"_id": 0}).to_list(500)
    val = await db.validations.find_one({"room_id": room_id}, sort=[("timestamp", -1)])
    decisions = await db.decisions.find({"room_id": room_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    derogations = await db.derogations.find({"room_id": room_id}, {"_id": 0}).sort("created_at", -1).to_list(200)

    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    import io
    wb = Workbook()
    HEADER = Font(bold=True, color="86868B", size=9)
    BODY = Font(size=9)
    header_fill = PatternFill("solid", fgColor="F5F5F7")
    wrap = Alignment(wrap_text=True, vertical="top")

    def sheet(name, rows, widths=None):
        ws = wb.create_sheet(name) if wb.sheetnames != ["Sheet"] else wb.active
        if ws.title == "Sheet": ws.title = name
        for r_i, row in enumerate(rows, 1):
            for c_i, v in enumerate(row, 1):
                cell = ws.cell(row=r_i, column=c_i, value=v)
                cell.font = HEADER if r_i == 1 else BODY
                cell.alignment = wrap
                if r_i == 1: cell.fill = header_fill
        for i, w in enumerate(widths or [], 1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = "A2"
        return ws

    # Cover / meta
    ws = sheet("Overview", [
        ["Field", "Value"],
        ["Room", node["name"]],
        ["Type", (node.get("metadata",{}) or {}).get("kind","").replace("_"," ").title()],
        ["Size", (node.get("metadata",{}) or {}).get("size","")],
        ["Acuity", (node.get("metadata",{}) or {}).get("acuity","")],
        ["Risk", node.get("risk_rating","")],
        ["Width (m)",  scene["width"]],
        ["Depth (m)",  scene["depth"]],
        ["Ceiling (m)", scene.get("ceiling_h", 2.7)],
        ["Floor area (m²)", round(scene["width"]*scene["depth"], 2)],
        ["Generated", now_iso()],
        ["Exported by", user.get("email","")],
    ], widths=[22, 60])

    # Zones
    zrows = [["Zone", "x (m)", "y (m)", "w (m)", "d (m)"]]
    for k, z in (scene.get("zones") or {}).items():
        zrows.append([k.title(), z["x"], z["y"], z["w"], z["d"]])
    sheet("Zones", zrows, widths=[14, 10, 10, 10, 10])

    # Components
    crows = [["Code","Name","Revit family","Category","Zone","Mount","w (m)","d (m)","h (m)","Rotation","Materials"]]
    for it in scene.get("items", []):
        c = all_components.get(it["component_key"], {})
        crows.append([
            c.get("code","—"),
            it.get("label") if it["component_key"] == GENERIC_KEY else c.get("name", it["component_key"]),
            it.get("revit_family") or "",
            c.get("category",""), it["zone"], it.get("mount_type","floor"),
            it["w"], it["d"], it.get("height_m", c.get("default_footprint",{}).get("h","")),
            it.get("rotation", 0),
            "; ".join(c.get("materials", []) or []),
        ])
    sheet("Components", crows, widths=[10, 30, 40, 22, 10, 10, 8, 8, 8, 10, 60])

    # Rules
    rrows = [["Rule ID","Category","Tier","Statement","Source","Page","Severity","Enabled","Scope"]]
    for r in rules:
        rrows.append([
            r.get("rule_id",""), r.get("category",""), r.get("tier",""),
            r.get("statement",""), r.get("source",""), r.get("source_page",""),
            r.get("severity_if_violated",""), "yes" if r.get("enabled", True) else "no",
            r.get("scope","global"),
        ])
    sheet("Rules applied", rrows, widths=[16, 20, 10, 60, 30, 8, 10, 10, 10])

    # Validation snapshot
    if val:
        srows = [["Metric","Count"]]
        for k, v in (val.get("counts") or {}).items():
            srows.append([k.replace("_"," ").title(), v])
        sheet("Validation", srows, widths=[24, 12])

    # Decisions
    drows = [["When","Author","Kind","Title","Note"]]
    for d in decisions:
        drows.append([d.get("created_at",""), d.get("author",""),
                      d.get("kind","note"), d.get("title",""), d.get("note","")])
    sheet("Decision log", drows, widths=[22, 30, 12, 30, 60])

    # Derogations
    xrows = [["When","Rule","Requested by","Status","Approved by","Justification"]]
    for dg in derogations:
        xrows.append([dg.get("created_at",""), dg.get("rule_id",""),
                      dg.get("requested_by",""), dg.get("status",""),
                      dg.get("approved_by",""), dg.get("justification","")])
    sheet("Derogations", xrows, widths=[22, 16, 30, 12, 30, 60])

    # Footer sheet with disclaimer
    sheet("Notes", [
        ["Notes"],
        ["This export is a computer-generated summary of the current model."],
        ["The Compliance Assistant is advisory. Any rule, configuration or fix requires human review before adoption."],
        ["Reference PDFs are for in-app viewing only and are NOT embedded in this export."],
    ], widths=[100])

    buf = io.BytesIO()
    _brand_workbook(wb, f"Room Data Sheet — {node['name']}")
    wb.save(buf); buf.seek(0)
    from fastapi.responses import StreamingResponse
    return StreamingResponse(buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=_brand_disposition(node["name"], "data-sheet", "xlsx"))


# ---------- Decision log ----------
class DecisionIn(BaseModel):
    title: str
    note: Optional[str] = ""
    kind: Optional[str] = "decision"   # decision | note | derogation | render | edit
    tags: Optional[List[str]] = None
    item_id: Optional[str] = None
    rule_id: Optional[str] = None

@api.post("/rooms/{room_id}/decisions")
async def create_decision(room_id: str, body: DecisionIn, user=Depends(_room_access)):
    doc = {
        "id": new_id(),
        "room_id": room_id,
        "author": user.get("email"),
        "author_role": user.get("role"),
        "created_at": now_iso(),
        "title": body.title.strip(),
        "note": (body.note or "").strip(),
        "kind": body.kind or "decision",
        "tags": body.tags or [],
        "item_id": body.item_id,
        "rule_id": body.rule_id,
    }
    if not doc["title"]:
        raise HTTPException(400, "Title required")
    await db.decisions.insert_one(doc); doc.pop("_id", None)
    return doc

@api.get("/rooms/{room_id}/decisions")
async def list_decisions(room_id: str,
                         q: Optional[str] = None,
                         author: Optional[str] = None,
                         kind: Optional[str] = None,
                         since: Optional[str] = None,
                         until: Optional[str] = None,
                         user=Depends(_room_access)):
    query = {"room_id": room_id}
    if author: query["author"] = {"$regex": author, "$options": "i"}
    if kind: query["kind"] = kind
    if since or until:
        rng = {}
        if since: rng["$gte"] = since
        if until: rng["$lte"] = until
        query["created_at"] = rng
    if q:
        query["$or"] = [
            {"title": {"$regex": q, "$options": "i"}},
            {"note":  {"$regex": q, "$options": "i"}},
        ]
    docs = await db.decisions.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs

@api.delete("/rooms/{room_id}/decisions/{decision_id}")
async def delete_decision(room_id: str, decision_id: str, user=Depends(_room_access)):
    d = await db.decisions.find_one({"id": decision_id, "room_id": room_id})
    if not d: raise HTTPException(404)
    if d.get("author") != user.get("email") and user.get("role") not in ("reviewer", "admin"):
        raise HTTPException(403, "Only the author or a reviewer can delete this decision")
    await db.decisions.delete_one({"id": decision_id, "room_id": room_id})
    return {"ok": True}


# ---------- Derogations ----------
# Two-step: any user requests with a justification; a reviewer/admin approves.
class DerogationIn(BaseModel):
    rule_id: str
    justification: str
    item_id: Optional[str] = None
    expires_at: Optional[str] = None

@api.post("/rooms/{room_id}/derogations")
async def request_derogation(room_id: str, body: DerogationIn, user=Depends(_room_access)):
    if not body.justification or len(body.justification.strip()) < 8:
        raise HTTPException(400, "Justification (≥ 8 chars) required")
    doc = {
        "id": new_id(),
        "room_id": room_id,
        "rule_id": body.rule_id,
        "item_id": body.item_id,
        "justification": body.justification.strip(),
        "requested_by": user.get("email"),
        "status": "pending",  # pending | approved | rejected
        "created_at": now_iso(),
        "approved_by": None, "approved_at": None,
        "expires_at": body.expires_at,
    }
    await db.derogations.insert_one(doc); doc.pop("_id", None)
    # Auto-log to decision log
    await db.decisions.insert_one({
        "id": new_id(), "room_id": room_id, "author": user.get("email"),
        "author_role": user.get("role"), "created_at": now_iso(),
        "kind": "derogation", "title": f"Derogation requested · {body.rule_id}",
        "note": body.justification.strip(), "tags": ["derogation","pending"],
        "rule_id": body.rule_id, "item_id": body.item_id,
    })
    return doc

class DerogationReviewIn(BaseModel):
    status: str  # "approved" | "rejected"
    reviewer_note: Optional[str] = ""

@api.patch("/rooms/{room_id}/derogations/{derogation_id}")
async def review_derogation(room_id: str, derogation_id: str,
                            body: DerogationReviewIn, user=Depends(_room_access)):
    if user.get("role") not in ("reviewer", "admin"):
        raise HTTPException(403, "Only reviewers / admins can approve or reject derogations")
    if body.status not in ("approved", "rejected"):
        raise HTTPException(400, "status must be 'approved' or 'rejected'")
    d = await db.derogations.find_one({"id": derogation_id, "room_id": room_id})
    if not d: raise HTTPException(404)
    await db.derogations.update_one({"id": derogation_id}, {"$set": {
        "status": body.status,
        "approved_by": user.get("email"),
        "approved_at": now_iso(),
        "reviewer_note": (body.reviewer_note or "").strip(),
    }})
    await db.decisions.insert_one({
        "id": new_id(), "room_id": room_id, "author": user.get("email"),
        "author_role": user.get("role"), "created_at": now_iso(),
        "kind": "derogation",
        "title": f"Derogation {body.status} · {d['rule_id']}",
        "note": (body.reviewer_note or "").strip() or d.get("justification",""),
        "tags": ["derogation", body.status],
        "rule_id": d["rule_id"], "item_id": d.get("item_id"),
    })
    return {"ok": True, "status": body.status}

@api.get("/rooms/{room_id}/derogations")
async def list_derogations(room_id: str, user=Depends(_room_access)):
    return await db.derogations.find({"room_id": room_id}, {"_id": 0}).sort("created_at", -1).to_list(200)


# ---------- E-signature (HMAC-SHA256) --------------------------------------
# The derogation report can be cryptographically signed by a reviewer so an
# auditor can later verify (via /estate/report/verify) that the file was
# generated at a specific time by a specific reviewer and hasn't been tampered
# with. We use HMAC-SHA256 keyed on SIGNING_SECRET.
import hmac, hashlib

_SIGNING_SECRET = os.environ.get("SIGNING_SECRET", "").encode()

def _sign_payload(payload: dict) -> dict:
    """Return { token, signed_at, signed_by } from a serialisable payload."""
    canonical = _json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    digest = hmac.new(_SIGNING_SECRET, canonical, hashlib.sha256).digest()
    token = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return token

def _verify_token(payload: dict, token: str) -> bool:
    expected = _sign_payload(payload)
    return hmac.compare_digest(expected, token)

def _payload_hash(rows: list) -> str:
    """Deterministic short hash of the report rows (id + status + approved_at)."""
    body = _json.dumps(
        [{"id": r["id"], "status": r["status"], "approved_at": r.get("approved_at")} for r in rows],
        sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(body).hexdigest()[:16]

@api.post("/estate/derogation-report/sign")
async def sign_derogation_report(
    hospital: Optional[str] = None, ward: Optional[str] = None,
    status: Optional[str] = None, user=Depends(get_current_user),
):
    """Reviewer signs the current view of the report — persists a signature
    record so future exports can embed 'signed by X at T'."""
    rows = await _build_derogation_report()
    if hospital: rows = [r for r in rows if r["hospital"] == hospital]
    if ward:     rows = [r for r in rows if r["ward"] == ward]
    if status:   rows = [r for r in rows if r["status"] == status]
    signed_at = now_iso()
    body_hash = _payload_hash(rows)
    payload = {
        "kind": "derogation_report",
        "signed_by": user.get("email"),
        "signed_at": signed_at,
        "row_count": len(rows),
        "body_hash": body_hash,
        "filter": {"hospital": hospital or "", "ward": ward or "", "status": status or ""},
    }
    token = _sign_payload(payload)
    record = {
        "id": new_id(), **payload, "token": token, "user_id": user.get("id"),
    }
    await db.report_signatures.insert_one({**record, "_created": signed_at})
    record.pop("_id", None)
    return record

@api.get("/estate/derogation-report/signatures")
async def list_signatures(user=Depends(get_current_user)):
    docs = await db.report_signatures.find({"kind": "derogation_report"}, {"_id": 0}) \
        .sort("signed_at", -1).to_list(200)
    return docs

@api.post("/estate/derogation-report/verify")
async def verify_signature(body: dict, user=Depends(get_current_user)):
    """Given a token + the filter that was used, verify the signature is valid
    against the current data. Returns { valid, signed_by, signed_at,
    row_count, body_hash_now, body_hash_signed, tampered }.
    """
    token = body.get("token", "")
    doc = await db.report_signatures.find_one({"token": token}, {"_id": 0})
    if not doc:
        return {"valid": False, "reason": "Signature not found."}
    # Recompute current rows for this filter
    hospital = doc["filter"].get("hospital") or None
    ward = doc["filter"].get("ward") or None
    status = doc["filter"].get("status") or None
    rows = await _build_derogation_report()
    if hospital: rows = [r for r in rows if r["hospital"] == hospital]
    if ward:     rows = [r for r in rows if r["ward"] == ward]
    if status:   rows = [r for r in rows if r["status"] == status]
    now_hash = _payload_hash(rows)
    payload = {k: doc[k] for k in ("kind", "signed_by", "signed_at", "row_count",
                                    "body_hash", "filter")}
    sig_ok = _verify_token(payload, token)
    return {
        "valid": sig_ok,
        "signed_by": doc.get("signed_by"),
        "signed_at": doc.get("signed_at"),
        "row_count_signed": doc.get("row_count"),
        "body_hash_signed": doc.get("body_hash"),
        "body_hash_now": now_hash,
        "tampered": sig_ok and now_hash != doc.get("body_hash"),
    }


# ---------- Global Derogation Report (estate-wide) ----------
# Aggregate every derogation across every room, walk the hierarchy up to the
# owning building (hospital) + ward so auditors can see one document per
# hospital / ward / room.  Includes approved, pending and rejected records.
async def _build_derogation_report():
    all_nodes = await db.hierarchy.find({}, {"_id": 0}).to_list(5000)
    by_id = {n["id"]: n for n in all_nodes}
    def ancestors(node):
        chain = []
        cur = node
        seen = set()
        while cur and cur["id"] not in seen:
            seen.add(cur["id"])
            chain.append(cur)
            cur = by_id.get(cur.get("parent_id"))
        return chain
    def find_ancestor_type(node, t):
        for n in ancestors(node):
            if n.get("type") == t: return n
        return None

    rules = await db.rules.find({}, {"_id": 0}).to_list(5000)
    rules_by_id = {r["rule_id"]: r for r in rules}
    derogs = await db.derogations.find({}, {"_id": 0}).sort("created_at", -1).to_list(5000)

    rows = []
    for d in derogs:
        room = by_id.get(d["room_id"])
        if not room: continue
        rule = rules_by_id.get(d["rule_id"]) or {}
        hospital = find_ancestor_type(room, "building")
        ward     = find_ancestor_type(room, "ward")
        rows.append({
            "id": d["id"],
            "room_id": room["id"], "room": room.get("name") or room["id"],
            "room_type": room.get("type"),
            "ward":     ward.get("name") if ward else "—",
            "hospital": hospital.get("name") if hospital else "—",
            "rule_id": d["rule_id"],
            "rule_statement": rule.get("statement", ""),
            "rule_tier":     rule.get("tier", ""),
            "rule_severity": rule.get("severity_if_violated", ""),
            "justification": d.get("justification", ""),
            "requested_by":  d.get("requested_by", ""),
            "created_at":    d.get("created_at", ""),
            "status":        d.get("status", ""),
            "approved_by":   d.get("approved_by"),
            "approved_at":   d.get("approved_at"),
            "reviewer_note": d.get("reviewer_note", ""),
            "item_id":       d.get("item_id"),
        })
    return rows

@api.get("/estate/derogation-report")
async def estate_derogation_report(
    hospital: Optional[str] = None,
    ward: Optional[str] = None,
    status: Optional[str] = None,     # approved | pending | rejected
    user=Depends(get_current_user),
):
    rows = await _build_derogation_report()
    if hospital: rows = [r for r in rows if r["hospital"] == hospital]
    if ward:     rows = [r for r in rows if r["ward"] == ward]
    if status:   rows = [r for r in rows if r["status"] == status]
    counts = {
        "total":    len(rows),
        "approved": sum(1 for r in rows if r["status"] == "approved"),
        "pending":  sum(1 for r in rows if r["status"] == "pending"),
        "rejected": sum(1 for r in rows if r["status"] == "rejected"),
    }
    # Facets so the UI can populate filter menus even before it renders rows.
    all_rows = rows if (hospital or ward or status) else rows
    facets = {
        "hospitals": sorted({r["hospital"] for r in all_rows if r["hospital"] != "—"}),
        "wards":     sorted({r["ward"]     for r in all_rows if r["ward"]     != "—"}),
    }
    return {"rows": rows, "counts": counts, "facets": facets,
            "generated_at": now_iso()}

@api.get("/estate/derogation-report.pdf")
async def estate_derogation_report_pdf(
    hospital: Optional[str] = None, ward: Optional[str] = None,
    status: Optional[str] = None, signature_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from io import BytesIO
    rows = await _build_derogation_report()
    if hospital: rows = [r for r in rows if r["hospital"] == hospital]
    if ward:     rows = [r for r in rows if r["ward"] == ward]
    if status:   rows = [r for r in rows if r["status"] == status]
    # Fetch signature block if requested
    signature = None
    if signature_id:
        signature = await db.report_signatures.find_one({"id": signature_id}, {"_id": 0})
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A3),
        leftMargin=18*mm, rightMargin=18*mm, topMargin=16*mm, bottomMargin=16*mm,
        title="Global Derogation Report", author=BRAND, creator=BRAND, producer=BRAND, subject=BRAND)
    styles = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=8, leading=10)
    small = ParagraphStyle("s", parent=styles["BodyText"], fontSize=7, leading=8.5, textColor=colors.HexColor("#6E6E73"))
    story = []
    story.append(Paragraph("<b>Global Derogation Report</b>", styles["Title"]))
    filt = " · ".join([x for x in [
        f"Hospital: {hospital}" if hospital else None,
        f"Ward: {ward}" if ward else None,
        f"Status: {status}" if status else None,
    ] if x]) or "All hospitals · all wards · all statuses"
    story.append(Paragraph(filt, small))
    story.append(Paragraph(f"Generated {now_iso()} · {len(rows)} record(s)", small))
    story.append(Spacer(1, 8))
    # Group by hospital → ward
    from collections import defaultdict
    grouped = defaultdict(lambda: defaultdict(list))
    for r in rows: grouped[r["hospital"]][r["ward"]].append(r)
    for hosp in sorted(grouped.keys()):
        story.append(Paragraph(f"<b>{hosp}</b>", styles["Heading2"]))
        for w in sorted(grouped[hosp].keys()):
            story.append(Paragraph(f"<b>{w}</b>", styles["Heading4"]))
            data = [["Room", "Rule", "Tier", "Status", "Justification", "Requested by", "Approver", "Approved at"]]
            for r in grouped[hosp][w]:
                data.append([
                    Paragraph(r["room"], body),
                    Paragraph(f'<b>{r["rule_id"]}</b><br/><font size=6>{r["rule_statement"][:120]}</font>', body),
                    r["rule_tier"] or "—",
                    r["status"].upper(),
                    Paragraph(r["justification"][:220], body),
                    r["requested_by"] or "—",
                    r["approved_by"] or "—",
                    (r["approved_at"] or "")[:19].replace("T", " "),
                ])
            tbl = Table(data, colWidths=[30*mm, 45*mm, 15*mm, 20*mm, 90*mm, 45*mm, 45*mm, 30*mm], repeatRows=1)
            tbl.setStyle(TableStyle([
                ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#F1F1F3")),
                ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
                ("FONTSIZE", (0,0), (-1,-1), 8),
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("GRID", (0,0), (-1,-1), 0.25, colors.HexColor("#D2D2D7")),
                ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#FAFAFB")]),
            ]))
            story.append(tbl); story.append(Spacer(1, 8))
        story.append(PageBreak())
    if not grouped:
        story.append(Paragraph("<i>No derogation records match the current filter.</i>", body))
    # Signature block (footer)
    if signature:
        story.append(Spacer(1, 14))
        sig_style = ParagraphStyle("sig", parent=styles["BodyText"], fontSize=8, leading=11,
                                    textColor=colors.HexColor("#1D1D1F"))
        story.append(Paragraph(
            f'<b>Digitally signed</b> · {signature["signed_by"]} · '
            f'{signature["signed_at"][:19].replace("T"," ")} UTC', sig_style))
        story.append(Paragraph(
            f'<font face="Courier" size=7 color="#6E6E73">'
            f'Signature: {signature["token"]}<br/>Body-hash: {signature["body_hash"]}'
            f'</font>', sig_style))
        story.append(Paragraph(
            '<font size=7 color="#6E6E73">Verify via '
            'POST /api/estate/derogation-report/verify with the signature token '
            'above. HMAC-SHA256, keyed on the server signing secret.</font>',
            sig_style))
    doc.build(story, onFirstPage=_brand_footer, onLaterPages=_brand_footer)
    return Response(content=buf.getvalue(), media_type="application/pdf",
        headers=_brand_disposition("Estate", "derogation-report", "pdf"))

@api.get("/estate/derogation-report.xlsx")
async def estate_derogation_report_xlsx(
    hospital: Optional[str] = None, ward: Optional[str] = None,
    status: Optional[str] = None, signature_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from io import BytesIO
    rows = await _build_derogation_report()
    if hospital: rows = [r for r in rows if r["hospital"] == hospital]
    if ward:     rows = [r for r in rows if r["ward"] == ward]
    if status:   rows = [r for r in rows if r["status"] == status]
    signature = None
    if signature_id:
        signature = await db.report_signatures.find_one({"id": signature_id}, {"_id": 0})
    wb = Workbook()
    ws = wb.active; ws.title = "Derogations"
    headers = ["Hospital", "Ward", "Room", "Rule ID", "Rule statement", "Tier",
               "Severity", "Status", "Justification", "Requested by",
               "Created at", "Approver", "Approved at", "Reviewer note"]
    ws.append(headers)
    header_font = Font(bold=True, color="1D1D1F")
    header_fill = PatternFill("solid", fgColor="F1F1F3")
    for i, _ in enumerate(headers, start=1):
        c = ws.cell(row=1, column=i)
        c.font = header_font; c.fill = header_fill
        c.alignment = Alignment(vertical="top", wrap_text=True)
    for r in rows:
        ws.append([
            r["hospital"], r["ward"], r["room"], r["rule_id"], r["rule_statement"],
            r["rule_tier"], r["rule_severity"], r["status"], r["justification"],
            r["requested_by"], r["created_at"], r["approved_by"] or "",
            r["approved_at"] or "", r["reviewer_note"] or "",
        ])
    widths = [26, 22, 30, 16, 60, 12, 12, 12, 60, 26, 20, 26, 20, 40]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[chr(64 + i)].width = w
    ws.freeze_panes = "A2"
    # Signature footer sheet if requested
    if signature:
        sigs = wb.create_sheet("Signature")
        sig_rows = [
            ("Field", "Value"),
            ("Signed by",    signature.get("signed_by") or ""),
            ("Signed at",    signature.get("signed_at") or ""),
            ("Row count",    str(signature.get("row_count") or 0)),
            ("Body hash",    signature.get("body_hash") or ""),
            ("Signature",    signature.get("token") or ""),
            ("Filter — hospital", (signature.get("filter") or {}).get("hospital", "")),
            ("Filter — ward",     (signature.get("filter") or {}).get("ward", "")),
            ("Filter — status",   (signature.get("filter") or {}).get("status", "")),
            ("Verify via", "POST /api/estate/derogation-report/verify (HMAC-SHA256)"),
        ]
        for r in sig_rows: sigs.append(r)
        sigs.column_dimensions["A"].width = 22
        sigs.column_dimensions["B"].width = 80
        sigs.cell(row=1, column=1).font = Font(bold=True, color="1D1D1F")
        sigs.cell(row=1, column=1).fill = PatternFill("solid", fgColor="F1F1F3")
        sigs.cell(row=1, column=2).font = Font(bold=True, color="1D1D1F")
        sigs.cell(row=1, column=2).fill = PatternFill("solid", fgColor="F1F1F3")
    buf = BytesIO(); _brand_workbook(wb, "Global Derogation Report"); wb.save(buf)
    return Response(content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=_brand_disposition("Estate", "derogation-report", "xlsx"))


# ---------- IFC Family Library + Round-trip -------------------------------
from ifc_families import (
    ingest_ifc, extract_meshes, save_upload,
    export_scene_to_ifc, import_ifc_to_items, FAMILIES_DIR,
)
from rfa_metadata import parse_rfa

@api.post("/families/upload")
async def upload_family(file: UploadFile = File(...), user=Depends(get_current_user)):
    """Ingest a Revit family — either an .ifc (open, full geometry) or a
    .rfa (binary, metadata + placeholder box only). We auto-classify each
    element against our seed component library.
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty upload.")
    fn = (file.filename or "").lower()
    is_rfa = fn.endswith(".rfa")
    is_ifc = fn.endswith(".ifc")
    if not (is_rfa or is_ifc):
        raise HTTPException(400, "Only .ifc or .rfa files are supported.")
    saved = save_upload(raw, file.filename)

    doc: Dict[str, Any] = {
        "id": new_id(),
        "filename": file.filename,
        "sha256": saved["sha256"],
        "size": saved["size"],
        "path": saved["path"],
        "uploaded_by": user.get("email"),
        "uploaded_at": now_iso(),
        "file_kind": "rfa" if is_rfa else "ifc",
    }

    if is_ifc:
        try:
            parsed = ingest_ifc(saved["path"])
        except Exception as e:
            raise HTTPException(400, f"Could not parse IFC: {e}")
        doc.update({
            "schema": parsed["schema"],
            "total_elements": parsed["total_elements"],
            "elements": parsed["elements"],
        })
    else:
        try:
            meta = parse_rfa(saved["path"])
        except Exception as e:
            raise HTTPException(400, f"Could not parse RFA: {e}")
        # Persist thumbnail bytes to disk next to the RFA (if extractable)
        thumb_url = None
        thumb_bytes = meta.pop("thumbnail_bytes", None)
        if thumb_bytes:
            put_upload(Path(saved["path"] + ".preview.png"), thumb_bytes, "image/png")
            thumb_url = f"/api/families/{doc['id']}/thumbnail"
        dims = meta.get("dimensions") or {}
        element = {
            "guid": doc["id"],   # rfa has a single "family"; use the doc id
            "name": meta.get("family_name") or file.filename,
            "family_title_full": meta.get("family_title_full"),
            "ifc_type": "RFA",
            "predefined_type": meta.get("ifc_predefined_type", ""),
            "dimensions": dims,
            "component_key_suggested": meta.get("component_key_suggested"),
            "confidence": meta.get("confidence", 0.0),
            "classifier_debug": meta.get("classifier_debug", {}),
            "properties": {
                "Identity": {
                    "family_title_full": meta.get("family_title_full"),
                    "category":          meta.get("category"),
                    "description":       meta.get("description"),
                    "manufacturer":      meta.get("manufacturer"),
                    "revit_product":     meta.get("revit_product"),
                },
                "Uniclass 2015": meta.get("uniclass", {}),
                "Dimensions": {"size_text": meta.get("size_text"), **dims},
                "Standards":  {"standard": meta.get("standard"),
                               "ifc_predefined_type": meta.get("ifc_predefined_type")},
                "Warranty":   {"duration_unit": meta.get("warranty_duration_unit"),
                               "replacement_cost": meta.get("replacement_cost")},
            },
            "thumbnail_url": thumb_url,
        }
        doc.update({
            "schema": "RFA (Revit binary)",
            "total_elements": 1,
            "elements": [element],
            "rfa_meta": meta,     # full metadata (thumbnail bytes already removed)
        })

    await db.ifc_families.insert_one({**doc})
    doc.pop("_id", None)
    return doc

@api.get("/families/{fam_id}/thumbnail")
@api.get("/families/{fam_id}/thumbnail")
async def family_thumbnail(fam_id: str):
    # Public — HTML <img> tags can't send Authorization headers, and
    # thumbnails are just low-risk preview PNGs of Revit families that
    # the user already uploaded. Keeping this open lets the Component
    # Library, Room Editor and comparison views render previews without
    # a token dance. If we ever need to gate this, switch to a signed
    # URL that carries a short-lived token in the query string.
    doc = await db.ifc_families.find_one({"id": fam_id}, {"path": 1, "_id": 0})
    if not doc: raise HTTPException(404, "Family not found.")
    png_path = Path(doc["path"] + ".preview.png")
    if not ensure_local(png_path): raise HTTPException(404, "No thumbnail available.")
    return Response(
        content=png_path.read_bytes(),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )

@api.get("/families")
async def list_families(user=Depends(get_current_user)):
    docs = await db.ifc_families.find({}, {"_id": 0}).sort("uploaded_at", -1).to_list(500)
    # Keep full element data — the family library page renders per-element
    # properties for .rfa files. IFC .properties can be verbose but for now
    # we tolerate it (rooms rarely have >20 families).
    return docs

@api.get("/components/library")
async def component_library(user=Depends(get_current_user)):
    """Unified component view: every seed component + latest uploaded Revit
    family override per component_key.
    """
    seed = await db.components.find({}, {"_id": 0}).to_list(500)
    seed_keys = {c["key"] for c in seed}
    families = await db.ifc_families.find({}, {"_id": 0}).sort("uploaded_at", -1).to_list(500)
    override_by_key: Dict[str, Any] = {}
    orphans: List[Any] = []
    for fam in families:
        el = (fam.get("elements") or [{}])[0]
        key = el.get("component_key_suggested")
        if not key or key not in seed_keys:
            # No classifier match OR classifier suggested a key that doesn't
            # exist in the seed catalog — either way, surface it so the user
            # can rebind manually instead of silently dropping it.
            orphans.append({
                "family_id": fam["id"], "filename": fam["filename"],
                "name": el.get("name"),
                "suggested_key_unknown": key,   # None or the missing key
                "reason": "no_classifier_match" if not key else "key_not_in_seed",
                "thumbnail_url": el.get("thumbnail_url"),
            })
            continue
        if key not in override_by_key:
            override_by_key[key] = {"family": fam, "element": el}
    merged = []
    for c in seed:
        ov = override_by_key.get(c["key"])
        merged.append({
            **c,
            "has_override": bool(ov),
            "override": (None if not ov else {
                "family_id":      ov["family"]["id"],
                "filename":       ov["family"]["filename"],
                "file_kind":      ov["family"].get("file_kind", "ifc"),
                "revit_title":    ov["element"].get("family_title_full")
                                  or ov["element"].get("name"),
                "category":       (ov["element"].get("properties") or {}).get("Identity", {}).get("category"),
                "description":    (ov["element"].get("properties") or {}).get("Identity", {}).get("description"),
                "uniclass":       (ov["element"].get("properties") or {}).get("Uniclass 2015"),
                "size_text":      (ov["element"].get("properties") or {}).get("Dimensions", {}).get("size_text"),
                "ifc_predefined": ov["element"].get("predefined_type"),
                "thumbnail_url":  ov["element"].get("thumbnail_url"),
                "confidence":     ov["element"].get("confidence"),
                "uploaded_at":    ov["family"]["uploaded_at"],
                "uploaded_by":    ov["family"].get("uploaded_by"),
            }),
        })
    return {"components": merged, "orphans": orphans,
            "override_count": len(override_by_key), "seed_count": len(seed)}

@api.get("/families/{fam_id}")
async def get_family(fam_id: str, user=Depends(get_current_user)):
    doc = await db.ifc_families.find_one({"id": fam_id}, {"_id": 0})
    if not doc: raise HTTPException(404, "Family not found.")
    return doc

@api.get("/families/{fam_id}/mesh")
async def family_mesh(fam_id: str, user=Depends(get_current_user)):
    """Return simplified mesh JSON for browser 3D preview. For .rfa files
    (proprietary binary geometry) we synthesise a bounding-box mesh from the
    declared dimensions since real Revit geometry isn't parseable without APS.
    """
    doc = await db.ifc_families.find_one({"id": fam_id}, {"path": 1, "file_kind": 1, "rfa_meta": 1, "elements": 1, "_id": 0})
    if not doc: raise HTTPException(404, "Family not found.")
    if doc.get("file_kind") == "rfa":
        dims = (doc.get("rfa_meta") or {}).get("dimensions") or {}
        w = dims.get("w") or 0.2
        d = dims.get("d") or 0.2
        h = dims.get("h") or 0.2
        # Unit box, centred on origin.
        v = [
            -w/2, 0,    -d/2,    w/2, 0,    -d/2,    w/2, h, -d/2,   -w/2, h, -d/2,
            -w/2, 0,     d/2,    w/2, 0,     d/2,    w/2, h,  d/2,   -w/2, h,  d/2,
        ]
        # 12 tris (2 per face × 6 faces)
        f = [0,1,2, 0,2,3,   4,6,5, 4,7,6,   0,4,5, 0,5,1,
             2,6,7, 2,7,3,   1,5,6, 1,6,2,   0,3,7, 0,7,4]
        el = doc.get("elements", [{}])[0]
        return {"meshes": [{
            "guid": el.get("guid", fam_id),
            "name": el.get("name", "RFA placeholder"),
            "ifc_type": "RFA",
            "vertices": v, "faces": f,
            "is_placeholder": True,
        }]}
    if not ensure_local(doc["path"]): raise HTTPException(404, "Family file missing.")
    return {"meshes": extract_meshes(doc["path"])}

@api.patch("/families/{fam_id}")
async def update_family_binding(fam_id: str, body: dict, user=Depends(get_current_user)):
    """Update an uploaded family without re-uploading it. Supports:
      - `component_key`  → re-classify (rebind to a different seed component)
      - `name`           → rename the family's display title
      - `guid`           → target a specific element (defaults to the only
                           element for RFAs). Optional.
    Returns the updated family doc.
    """
    doc = await db.ifc_families.find_one({"id": fam_id}, {"_id": 0})
    if not doc: raise HTTPException(404, "Family not found.")
    elements = doc.get("elements", []) or []
    guid = body.get("guid")
    # RFAs carry exactly one element whose guid == doc.id
    if not guid and len(elements) == 1:
        guid = elements[0].get("guid")
    new_key  = body.get("component_key")
    new_name = body.get("name")
    if not new_key and not new_name:
        raise HTTPException(400, "Pass at least one of: component_key, name.")
    touched = False
    for e in elements:
        if e.get("guid") == guid:
            if new_key:
                e["component_key_suggested"] = new_key
                e["confidence"] = 1.0
                e["classifier_debug"] = {"reason": "manual"}
            if new_name:
                e["name"] = new_name
            touched = True
    if not touched:
        raise HTTPException(404, f"Element {guid} not found in family.")
    await db.ifc_families.update_one({"id": fam_id}, {"$set": {"elements": elements}})
    return {"ok": True, "family_id": fam_id, "guid": guid,
            "component_key": new_key, "name": new_name}

@api.post("/families/rebind")
async def rebind_families_bulk(body: dict, user=Depends(get_current_user)):
    """Bulk-rebind: rebind multiple families to the same component key
    in one call. Body: `{"family_ids": [...], "component_key": "..."}`.
    Returns per-family success/failure so the UI can flag partial results.
    """
    ids = body.get("family_ids") or []
    key = body.get("component_key")
    if not ids or not key:
        raise HTTPException(400, "family_ids and component_key are required.")
    seed_keys = {c["key"] for c in await db.components.find({}, {"key": 1, "_id": 0}).to_list(500)}
    if key not in seed_keys:
        raise HTTPException(400, f"Unknown component_key: {key}")
    results = []
    for fid in ids:
        doc = await db.ifc_families.find_one({"id": fid}, {"_id": 0})
        if not doc:
            results.append({"family_id": fid, "ok": False, "error": "not_found"})
            continue
        elements = doc.get("elements") or []
        for e in elements:
            e["component_key_suggested"] = key
            e["confidence"] = 1.0
            e["classifier_debug"] = {"reason": "manual_bulk"}
        await db.ifc_families.update_one({"id": fid}, {"$set": {"elements": elements}})
        results.append({"family_id": fid, "ok": True})
    return {"ok": True, "component_key": key,
            "rebound": sum(1 for r in results if r["ok"]),
            "failed":  sum(1 for r in results if not r["ok"]),
            "results": results}

@api.delete("/families/{fam_id}")
async def delete_family(fam_id: str, force: bool = False, user=Depends(get_current_user)):
    """Delete a family. By default only the DB row is removed and the
    uploaded `.rfa` / `.ifc` file is preserved on disk (safe delete).
    Pass `?force=true` to also unlink the file — irreversible.

    System-seeded families (`is_system: true`, bundled with the code)
    can be removed from the DB (they'll come back on the next boot) but
    their physical files under `backend/seed_families/` are always
    protected from `force=true` unlinks so a redeploy always restores
    the default catalogue.
    """
    doc = await db.ifc_families.find_one({"id": fam_id}, {"_id": 0})
    if not doc: raise HTTPException(404, "Family not found.")
    file_removed = False
    is_system = bool(doc.get("is_system"))
    if force and not is_system:
        try:
            delete_upload(doc["path"])
            # Also remove any thumbnail sidecar we wrote next to the .rfa
            delete_upload(doc["path"] + ".preview.png")
            file_removed = True
        except Exception: pass
    await db.ifc_families.delete_one({"id": fam_id})
    return {"ok": True, "file_removed": file_removed, "force": force,
            "is_system": is_system}

@api.delete("/families")
async def delete_families_bulk(force: bool = False, user=Depends(get_current_user)):
    """Bulk-delete every uploaded family. Refuses without `?force=true`
    to prevent accidental sweeps that would wipe uploaded .rfa files.
    Even with `force=true` this endpoint keeps the physical files on disk
    unless `force=true` is combined with `purge=true` via query string.
    """
    if not force:
        raise HTTPException(400, "Bulk delete disabled. Pass ?force=true to confirm.")
    docs = await db.ifc_families.find({}, {"_id": 0}).to_list(2000)
    n = (await db.ifc_families.delete_many({})).deleted_count
    return {"ok": True, "deleted": n, "files_preserved": len(docs)}

@api.get("/rooms/{room_id}/export.ifc")
async def export_room_ifc(room_id: str, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found.")
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    if node and node.get("name"): scene["name"] = node["name"]
    comps = await db.components.find({}, {"_id": 0}).to_list(500)
    by_key = {c["key"]: c for c in comps}
    data = export_scene_to_ifc(scene, by_key, project_name=f"{BRAND} - {scene.get('name') or 'Room'}", brand=BRAND)
    return Response(content=data, media_type="application/ifc",
                    headers=_brand_disposition(scene.get("name") or "Room", "", "ifc"))

@api.post("/rooms/{room_id}/import.ifc")
async def import_room_ifc(room_id: str, file: UploadFile = File(...),
                          user=Depends(_room_access)):
    raw = await file.read()
    if not raw: raise HTTPException(400, "Empty upload.")
    saved = save_upload(raw, file.filename)
    comps = await db.components.find({}, {"_id": 0}).to_list(500)
    by_key = {c["key"]: c for c in comps}
    parsed = import_ifc_to_items(saved["path"], by_key)
    # Hydrate items with fresh ids + preserve current scene dimensions if the
    # IFC didn't carry an IfcSpace
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene: raise HTTPException(404, "Scene not found.")
    new_items = []
    for it in parsed["items"]:
        # Fill in missing fields from the component library
        c = by_key.get(it["component_key"]) or {}
        new_items.append({
            "id": new_id(),
            **it,
            "mount_type": it.get("mount_type") or c.get("mount_type") or "floor",
        })
    upd = {"items": new_items, "version": (scene.get("version") or 1) + 1,
           "updated_at": now_iso()}
    if parsed.get("width"):     upd["width"]     = round(parsed["width"], 3)
    if parsed.get("depth"):     upd["depth"]     = round(parsed["depth"], 3)
    if parsed.get("ceiling_h"): upd["ceiling_h"] = round(parsed["ceiling_h"], 3)
    await db.scenes.update_one({"room_id": room_id}, {"$set": upd})
    return {"ok": True, "imported": parsed["count"], "scene_version": upd["version"]}


# ---------- IFC room import (new room from any Revit IFC export) ----------
from ifc_room_import import parse_ifc_rooms, GENERIC_KEY
from object_storage import read_upload  # noqa: E402

IFC_MAX_BYTES = 150 * 1024 * 1024


async def _dedupe_components():
    seen = set()
    async for c in db.components.find({}, {"_id": 1, "key": 1}).sort("_id", 1):
        if c.get("key") in seen:
            await db.components.delete_one({"_id": c["_id"]})
        seen.add(c.get("key"))
    info = await db.components.index_information()
    if "key_1" in info and not info["key_1"].get("unique"):
        await db.components.drop_index("key_1")
    await db.components.create_index("key", unique=True, name="key_unique")


async def _cleanup_ifc_imports():
    """Drop parsed imports older than 24 h that never became a room."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    used = set(await db.hierarchy.distinct("metadata.ifc_source.import_id"))
    async for imp in db.ifc_imports.find({"created_at": {"$lt": cutoff}}, {"_id": 0, "id": 1, "path": 1}):
        if imp["id"] in used:
            continue
        delete_upload(imp["path"])
        await db.ifc_imports.delete_one({"id": imp["id"]})


async def _ensure_generic_component():
    await db.components.update_one({"key": GENERIC_KEY}, {"$setOnInsert": {
        "id": new_id(), "key": GENERIC_KEY, "kind": "cabinet", "name": "Imported IFC element",
        "code": "IFC", "icon": "box", "material": "laminate", "mount_type": "floor",
        "zone_affinity": "transition", "default_footprint": {"w": 0.5, "d": 0.5, "h": 0.9},
        "published": True, "version": 1, "rule_ids": [],
        "materials": ["Geometry from IFC import · true size"],
    }}, upsert=True)


@api.post("/ifc-import")
async def ifc_import_parse(file: UploadFile = File(...), user=Depends(get_current_user)):
    if not (file.filename or "").lower().endswith(".ifc"):
        raise HTTPException(400, "Please upload a .ifc file (Revit: File → Export → IFC).")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty upload.")
    if len(raw) > IFC_MAX_BYTES:
        raise HTTPException(413, "IFC file is larger than 150 MB.")
    if not raw[:64].lstrip().startswith(b"ISO-10303-21"):
        raise HTTPException(400, "This file is not a valid IFC (STEP) export.")
    await _cleanup_ifc_imports()
    saved = save_upload(raw, file.filename)
    comps = {c["key"]: c for c in await db.components.find({}, {"_id": 0}).to_list(2000)}
    try:
        parsed = await asyncio.to_thread(parse_ifc_rooms, saved["path"], comps,
                                         await _family_overrides(user))
    except Exception as e:
        logging.exception("IFC parse failed")
        raise HTTPException(422, f"Could not read this IFC file: {str(e)[:160]}")
    if not parsed["spaces"]:
        raise HTTPException(422, "No rooms found. In Revit, export with 'Export rooms/spaces' "
                                 "(IfcSpace) switched on and try again.")
    doc = {"id": new_id(), "owner_id": user["id"], "filename": file.filename,
           "path": saved["path"], "size": saved["size"], "created_at": now_iso(), **parsed}
    await db.ifc_imports.insert_one({**doc})
    return {"id": doc["id"], "filename": doc["filename"], "schema": parsed["schema"],
            "project": parsed["project"], "authoring_tool": parsed["authoring_tool"],
            "spaces": [{k: v for k, v in s.items() if k != "items"} for s in parsed["spaces"]]}


class IfcImportCreateIn(BaseModel):
    space_guid: str
    name: Optional[str] = None


def _zones_for(W, D):
    return {
        "dirty":      {"x": 0.0, "y": 0.0, "w": W, "d": round(D * 0.42, 3)},
        "transition": {"x": 0.0, "y": round(D * 0.42, 3), "w": W, "d": round(D * 0.22, 3)},
        "clean":      {"x": 0.0, "y": round(D * 0.64, 3), "w": W, "d": round(D * 0.36, 3)},
    }


def _ifc_source_meta(imp, sp):
    return {"import_id": imp["id"], "filename": imp["filename"],
            "space_name": sp["name"], "space_guid": sp["guid"],
            "project": imp.get("project"), "authoring_tool": imp.get("authoring_tool"),
            "poly_world": sp.get("poly_world"), "z0": sp.get("z0")}


async def _create_ifc_room(imp, sp, parent_id, user, name=None, extra=None):
    W, D, H = sp["width"], sp["depth"], sp["ceiling_h"]
    util = {
        "id": new_id(), "parent_id": parent_id, "type": "utility",
        "name": (name or "").strip() or sp["name"],
        "metadata": {"kind": "inpatient_dirty_utility", "size": "custom", "code": "IFC",
                     "brief_area_m2": round(W * D, 1), "ifc_source": _ifc_source_meta(imp, sp)},
        "risk_rating": "medium", "created_at": now_iso(), "contributors": [],
        "owner_id": user["id"], "owner_email": user.get("email"),
        "owner_org": (user.get("organization") or "").strip() or None,
        "visible_to_org": False, **(extra or {}),
    }
    await db.hierarchy.insert_one({**util})
    scene = {
        "room_id": util["id"], "width": W, "depth": D, "ceiling_h": H, "zones": _zones_for(W, D),
        "items": [{**it, "id": new_id()} for it in sp["items"]], "partitions": [],
        "shape": {"type": "rectangle"}, "version": 1, "updated_at": now_iso(), "standard_applied": None,
    }
    scene = await _hydrate_scene_items(scene)
    await db.scenes.insert_one({**scene})
    await _audit_log(util["id"], user, "imported",
                     {"filename": imp["filename"], "space": sp["name"], "items": len(scene["items"])})
    return util


async def _my_import(import_id, user):
    imp = await db.ifc_imports.find_one({"id": import_id, "owner_id": user["id"]}, {"_id": 0})
    if not imp:
        raise HTTPException(404, "Import not found.")
    return imp


@api.post("/ifc-import/{import_id}/create")
async def ifc_import_create(import_id: str, body: IfcImportCreateIn, user=Depends(get_current_user)):
    imp = await _my_import(import_id, user)
    sp = next((s for s in imp["spaces"] if s["guid"] == body.space_guid), None)
    if not sp:
        raise HTTPException(404, "Room not found in this IFC.")
    await _ensure_generic_component()
    parent = await db.hierarchy.find_one({"type": "room"}, {"_id": 0, "id": 1})
    util = await _create_ifc_room(imp, sp, (parent or {}).get("id"), user, body.name)
    return {"room": util, "scene_room_id": util["id"], "items": len(sp["items"]),
            "generic_count": sp.get("generic_count", 0)}


class IfcFloorIn(BaseModel):
    storey: Optional[str] = None
    building_name: Optional[str] = None


@api.post("/ifc-import/{import_id}/create-floor")
async def ifc_import_create_floor(import_id: str, body: IfcFloorIn, user=Depends(get_current_user)):
    imp = await _my_import(import_id, user)
    spaces = [sp for sp in imp["spaces"] if (sp.get("storey") or "Level") == (body.storey or "Level")]
    if not spaces:
        raise HTTPException(404, "No rooms on that floor.")
    await _ensure_generic_component()
    estate = await db.hierarchy.find_one({"type": "estate"}, {"_id": 0, "id": 1})
    owner = {"owner_id": user["id"], "owner_email": user.get("email"),
             "owner_org": (user.get("organization") or "").strip() or None,
             "publish_status": "private", "created_at": now_iso(), "contributors": []}
    bname = (body.building_name or "").strip() or spaces[0].get("building") \
        or f"{imp.get('project') or 'Imported'} building"
    building = {"id": new_id(), "parent_id": (estate or {}).get("id"), "type": "building",
                "name": bname, "metadata": {"source": "ifc", "filename": imp["filename"]}, **owner}
    floor = {"id": new_id(), "parent_id": building["id"], "type": "zone", "name": body.storey or "Level",
             "metadata": {"floor": body.storey or "Level", "elevation": spaces[0].get("storey_elevation"),
                          "import_id": imp["id"],
                          "source": "ifc"}, **owner}
    await db.hierarchy.insert_many([{**building}, {**floor}])
    rooms = [await _create_ifc_room(imp, sp, floor["id"], user, extra={"publish_status": "private"})
             for sp in spaces]
    return {"building": building, "floor": floor,
            "rooms": [{"id": r["id"], "name": r["name"]} for r in rooms]}


@api.get("/rooms/{room_id}/ifc-source")
async def download_ifc_source(room_id: str, user=Depends(_room_access)):
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0, "metadata": 1})
    src = ((node or {}).get("metadata") or {}).get("ifc_source")
    imp = src and await db.ifc_imports.find_one({"id": src["import_id"]}, {"_id": 0, "path": 1})
    data = imp and read_upload(Path(imp["path"]))
    if not data:
        raise HTTPException(404, "No original IFC stored for this room.")
    nm = await db.hierarchy.find_one({"id": room_id}, {"_id": 0, "name": 1})
    return Response(content=data, media_type="application/octet-stream",
                    headers=_brand_disposition((nm or {}).get("name", "Room"), "original", "ifc"))


# ---------- Org-wide family → component mappings ----------
def _mapping_scope(user):
    org = (user.get("organization") or "").strip().lower()
    return f"org:{org}" if org else f"user:{user['id']}"


async def _family_overrides(user):
    docs = await db.ifc_mappings.find({"scope": _mapping_scope(user)},
                                      {"_id": 0, "family": 1, "component_key": 1}).to_list(5000)
    return {d["family"]: d["component_key"] for d in docs}


class IfcMappingIn(BaseModel):
    family: str
    component_key: str


@api.post("/ifc-mappings")
async def upsert_ifc_mapping(body: IfcMappingIn, user=Depends(get_current_user)):
    fam = body.family.strip()
    if not fam or body.component_key == GENERIC_KEY:
        raise HTTPException(400, "Pick a library component.")
    if not await db.components.find_one({"key": body.component_key}, {"_id": 1}):
        raise HTTPException(404, "Component not found.")
    scope = _mapping_scope(user)
    await db.ifc_mappings.update_one({"scope": scope, "family": fam}, {"$set": {
        "scope": scope, "family": fam, "component_key": body.component_key,
        "created_by": user.get("email"), "updated_at": now_iso()}}, upsert=True)
    return {"ok": True, "scope": scope}


@api.get("/ifc-mappings")
async def list_ifc_mappings(user=Depends(get_current_user)):
    return await db.ifc_mappings.find({"scope": _mapping_scope(user)}, {"_id": 0}).to_list(5000)


@api.delete("/ifc-mappings")
async def delete_ifc_mapping(family: str, user=Depends(get_current_user)):
    r = await db.ifc_mappings.delete_one({"scope": _mapping_scope(user), "family": family})
    return {"ok": True, "deleted": r.deleted_count}


# ---------- Re-import: diff a newer IFC against the room ----------
_DIFF_FIELDS = ("x", "y", "w", "d", "rotation", "elevation_m", "height_m")


class IfcDiffIn(BaseModel):
    import_id: str
    space_guid: Optional[str] = None
    accept: Optional[List[str]] = None


async def _ifc_diff(room_id, body, user):
    imp = await _my_import(body.import_id, user)
    node = await db.hierarchy.find_one({"id": room_id}, {"_id": 0})
    src = ((node or {}).get("metadata") or {}).get("ifc_source") or {}
    spaces = imp["spaces"]
    sp = next((x for x in spaces if x["guid"] == body.space_guid), None) \
        or next((x for x in spaces if x["guid"] == src.get("space_guid")), None) \
        or next((x for x in spaces if x["name"] == src.get("space_name")), None) \
        or (spaces[0] if len(spaces) == 1 else None)
    if not sp:
        raise HTTPException(409, "Pick which room in the new IFC matches this one.")
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0}) or {}
    cur = {it["ifc_guid"]: it for it in scene.get("items", []) if it.get("ifc_guid")}
    new = {it["ifc_guid"]: it for it in sp["items"]}
    pick = lambda it: {k: it.get(k) for k in _DIFF_FIELDS}
    changes = []
    for dim in ("width", "depth", "ceiling_h"):
        if abs(float(scene.get(dim) or 0) - float(sp[dim])) > 0.005:
            changes.append({"id": f"room:{dim}", "type": "room", "label": f"Room {dim.replace('_h', ' height')}",
                            "before": scene.get(dim), "after": sp[dim]})
    unchanged = 0
    for g, it in new.items():
        if g not in cur:
            changes.append({"id": f"a:{g}", "type": "added", "label": it.get("label"),
                            "component_key": it["component_key"], "after": pick(it)})
            continue
        b = cur[g]
        moved = b["component_key"] != it["component_key"] or \
            int(b.get("rotation") or 0) % 360 != int(it.get("rotation") or 0) % 360 or any(
            abs(float(b.get(k) or 0) - float(it.get(k) or 0)) > 0.02 for k in _DIFF_FIELDS if k != "rotation")
        if moved:
            changes.append({"id": f"m:{g}", "type": "moved", "label": it.get("label") or b.get("label"),
                            "component_key": it["component_key"], "item_id": b["id"],
                            "component_from": b["component_key"] if b["component_key"] != it["component_key"] else None,
                            "before": pick(b), "after": pick(it)})
        else:
            unchanged += 1
    for g, b in cur.items():
        if g not in new:
            changes.append({"id": f"r:{g}", "type": "removed", "label": b.get("label"),
                            "component_key": b["component_key"], "item_id": b["id"], "before": pick(b)})
    return imp, sp, scene, new, changes, unchanged


@api.post("/rooms/{room_id}/ifc-diff")
async def ifc_diff(room_id: str, body: IfcDiffIn, user=Depends(_room_access)):
    imp, sp, scene, _, changes, unchanged = await _ifc_diff(room_id, body, user)
    return {"import_id": imp["id"], "filename": imp["filename"], "space_guid": sp["guid"],
            "space_name": sp["name"], "changes": changes, "unchanged": unchanged,
            "manual_items": sum(1 for it in scene.get("items", []) if not it.get("ifc_guid")),
            "new_size": {"width": sp["width"], "depth": sp["depth"]},
            "current_size": {"width": scene.get("width"), "depth": scene.get("depth")}}


@api.post("/rooms/{room_id}/ifc-diff/apply")
async def ifc_diff_apply(room_id: str, body: IfcDiffIn, user=Depends(_room_access)):
    imp, sp, scene, new, changes, _ = await _ifc_diff(room_id, body, user)
    accept = set(body.accept or [])
    items = list(scene.get("items", []))
    applied = 0
    for ch in changes:
        if ch["id"] not in accept:
            continue
        applied += 1
        if ch["type"] == "room":
            scene[ch["id"].split(":")[1]] = ch["after"]
        elif ch["type"] == "moved":
            g = ch["id"][2:]
            for it in items:
                if it.get("ifc_guid") == g:
                    it.update({k: new[g][k] for k in _DIFF_FIELDS})
                    it["component_key"] = new[g]["component_key"]
                    it["zone"] = new[g]["zone"]; it["mount_type"] = new[g]["mount_type"]
        elif ch["type"] == "added":
            items.append({**new[ch["id"][2:]], "id": new_id()})
        elif ch["type"] == "removed":
            items = [it for it in items if it.get("ifc_guid") != ch["id"][2:]]
    if any(c["id"].startswith("room:") and c["id"] in accept for c in changes):
        scene["zones"] = _zones_for(scene["width"], scene["depth"])
    scene.update({"items": items, "version": (scene.get("version") or 1) + 1,
                  "updated_at": now_iso(), "last_edited_at": now_iso()})
    await _ensure_generic_component()
    scene = await _hydrate_scene_items(scene)
    await db.scenes.replace_one({"room_id": room_id}, scene, upsert=True)
    await db.hierarchy.update_one({"id": room_id},
                                  {"$set": {"metadata.ifc_source": _ifc_source_meta(imp, sp)}})
    await db.changelog.insert_one({"id": new_id(), "room_id": room_id, "author": user["email"],
        "role": user.get("role", ""), "timestamp": now_iso(), "version": scene["version"],
        "delta_summary": f"re-imported {imp['filename']}: applied {applied} of {len(changes)} change(s)"})
    await _audit_log(room_id, user, "reimported", {"filename": imp["filename"], "applied": applied})
    scene.pop("_id", None)
    return scene


# ---------- Publishing imported buildings (admin approval) ----------
def _is_approver(user):
    emails = {e.strip().lower() for e in (os.environ.get("PUBLISH_APPROVER_EMAILS") or "").split(",") if e.strip()}
    return user.get("role") == "admin" or (user.get("email") or "").lower() in emails


async def _subtree_ids(root_id):
    ids, frontier = [root_id], [root_id]
    while frontier:
        kids = await db.hierarchy.find({"parent_id": {"$in": frontier}}, {"_id": 0, "id": 1}).to_list(5000)
        frontier = [k["id"] for k in kids]
        ids += frontier
    return ids


async def _set_publish(root_id, status):
    ids = await _subtree_ids(root_id)
    await db.hierarchy.update_many({"id": {"$in": ids}},
                                   {"$set": {"publish_status": status, "published": status == "public"}})


async def _approver_user_ids():
    emails = [e.strip().lower() for e in (os.environ.get("PUBLISH_APPROVER_EMAILS") or "").split(",") if e.strip()]
    docs = await db.users.find({"$or": [{"role": "admin"}, {"email": {"$in": emails}}]},
                               {"_id": 0, "id": 1}).to_list(100)
    return [d["id"] for d in docs]


class PublishNoteIn(BaseModel):
    note: Optional[str] = None


@api.post("/hierarchy/{node_id}/publish-request")
async def request_publish(node_id: str, body: PublishNoteIn, user=Depends(get_current_user)):
    node = await db.hierarchy.find_one({"id": node_id}, {"_id": 0})
    if not node or node.get("owner_id") != user["id"] or node.get("type") != "building":
        raise HTTPException(403, "Only the owner of an imported building can publish it.")
    if node.get("publish_status") in ("pending", "public"):
        raise HTTPException(400, f"Already {node['publish_status']}.")
    req = {"id": new_id(), "node_id": node_id, "node_name": node["name"], "status": "pending",
           "requested_by": user["id"], "requested_by_email": user.get("email"),
           "requested_by_name": user.get("name"), "note": (body.note or "")[:240] or None,
           "created_at": now_iso()}
    await db.publish_requests.insert_one({**req})
    await _set_publish(node_id, "pending")
    for uid in await _approver_user_ids():
        await _create_user_note(uid, user, node_id, node["name"], "publish_requested",
                                body.note or f"{user.get('email')} asked to make '{node['name']}' public.")
    return req


@api.get("/publish-requests")
async def list_publish_requests(user=Depends(get_current_user)):
    q = {"status": "pending"} if _is_approver(user) else {"requested_by": user["id"]}
    docs = await db.publish_requests.find(q, {"_id": 0}).sort("created_at", -1).to_list(200)
    return {"is_approver": _is_approver(user), "requests": docs}


@api.post("/publish-requests/{req_id}/{decision}")
async def decide_publish(req_id: str, decision: Literal["approve", "deny"], body: PublishNoteIn,
                         user=Depends(get_current_user)):
    if not _is_approver(user):
        raise HTTPException(403, "Only the platform approver can decide publish requests.")
    req = await db.publish_requests.find_one({"id": req_id, "status": "pending"}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found or already decided.")
    status = "approved" if decision == "approve" else "denied"
    await db.publish_requests.update_one({"id": req_id}, {"$set": {
        "status": status, "decided_by": user.get("email"), "decided_at": now_iso(),
        "decision_note": (body.note or "")[:240] or None}})
    await _set_publish(req["node_id"], "public" if status == "approved" else "private")
    await _create_user_note(req["requested_by"], user, req["node_id"], req["node_name"],
                            status, body.note or f"'{req['node_name']}' publish request {status}.")
    return {"ok": True, "status": status}


@api.post("/hierarchy/{node_id}/unpublish")
async def unpublish(node_id: str, user=Depends(get_current_user)):
    node = await db.hierarchy.find_one({"id": node_id}, {"_id": 0})
    if not node or (node.get("owner_id") != user["id"] and not _is_approver(user)):
        raise HTTPException(403, "Only the owner can make this private.")
    await _set_publish(node_id, "private")
    await db.publish_requests.update_many({"node_id": node_id, "status": "pending"},
                                          {"$set": {"status": "withdrawn", "decided_at": now_iso()}})
    return {"ok": True}


# ---------- Layout comparison against a reference standard ----------
_REF_BUILDERS = {"hbn_f74": lambda *a: _hbn_f74_scene(*a), "hbn_f79": lambda *a: _hbn_f79_scene(*a),
                 "nhp_v2": lambda *a: _nhp_v2_scene(*a), "revit_ex01": lambda *a: _revit_ex01_scene(*a)}


@api.get("/rooms/{room_id}/compare")
async def compare_layout(room_id: str, standard: str, user=Depends(_room_access)):
    if standard not in _REF_BUILDERS:
        raise HTTPException(400, f"standard must be one of {sorted(_REF_BUILDERS)}")
    cur = await db.scenes.find_one({"room_id": room_id}, {"_id": 0}) or {}
    W, D, H = cur.get("width") or 3.615, cur.get("depth") or 2.5, cur.get("ceiling_h") or 2.7
    ref = await _hydrate_scene_items(await _REF_BUILDERS[standard](room_id, W, D, H))
    cur = await _hydrate_scene_items(cur)
    centre = lambda it: (it["x"] + it["w"] / 2, it["y"] + it["d"] / 2)
    pairs, used = [], set()
    cands = sorted(
        ((math.dist(centre(a), centre(b)), a["id"], b["id"])
         for a in cur.get("items", []) for b in ref["items"] if a["component_key"] == b["component_key"]))
    matched_cur = set()
    by_cur = {a["id"]: a for a in cur.get("items", [])}
    by_ref = {b["id"]: b for b in ref["items"]}
    for dist, ca, rb in cands:
        if ca in matched_cur or rb in used:
            continue
        matched_cur.add(ca); used.add(rb)
        same_rot = int(by_cur[ca].get("rotation") or 0) % 360 == int(by_ref[rb].get("rotation") or 0) % 360
        pairs.append({"current_id": ca, "reference_id": rb, "component_key": by_cur[ca]["component_key"],
                      "distance": round(dist, 3),
                      "status": "same" if dist <= 0.30 and same_rot else "moved"})
    only_cur = [i for i in by_cur if i not in matched_cur]
    only_ref = [i for i in by_ref if i not in used]
    return {
        "standard": standard,
        "current": {"width": W, "depth": D, "items": cur.get("items", [])},
        "reference": {"width": W, "depth": D, "items": ref["items"]},
        "pairs": pairs, "only_current": only_cur, "only_reference": only_ref,
        "summary": {"same": sum(p["status"] == "same" for p in pairs),
                    "moved": sum(p["status"] == "moved" for p in pairs),
                    "only_current": len(only_cur), "only_reference": len(only_ref)},
    }


# ---------- Spatial analysis (VGA space syntax, travel paths, network) ----------
import spatial_analysis as _sa


def _item_name(components):
    return lambda it: it.get("label") if it.get("component_key") == GENERIC_KEY \
        else (components.get(it["component_key"], {}).get("name") or it["component_key"].replace("_", " "))


@api.get("/rooms/{room_id}/spatial")
async def room_spatial(room_id: str, user=Depends(_room_access)):
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene:
        raise HTTPException(404)
    comps = {c["key"]: c for c in await db.components.find({}, {"_id": 0, "key": 1, "name": 1}).to_list(2000)}
    rels = _json.loads(Path(__file__).parent.joinpath("adjacency_v3.json").read_text()).get("relations", [])
    out = await asyncio.to_thread(_sa.analyse_room, scene, rels, _item_name(comps))
    out["scene_version"] = scene.get("version")
    return out


@api.get("/rooms/{room_id}/spatial/route")
async def room_spatial_route(room_id: str, ax: float, ay: float, bx: float, by: float, flow: str = "staff",
                             user=Depends(_room_access)):
    if flow not in _sa.FLOW:
        raise HTTPException(400, f"flow must be one of {list(_sa.FLOW)}")
    scene = await db.scenes.find_one({"room_id": room_id}, {"_id": 0})
    if not scene:
        raise HTTPException(404)
    r = await asyncio.to_thread(_sa.custom_route, scene, (ax, ay), (bx, by), flow)
    if not r:
        raise HTTPException(422, "No walkable path between those points.")
    return r


@api.get("/hierarchy/{node_id}/spatial")
async def floor_spatial(node_id: str, source: Optional[str] = None, flow: str = "staff",
                        user=Depends(get_current_user)):
    node = await get_node(node_id, user)
    if node.get("type") != "zone":
        raise HTTPException(400, "Floor analysis works on an imported floor.")
    if flow not in _sa.FLOW:
        raise HTTPException(400, f"flow must be one of {list(_sa.FLOW)}")
    kids = await db.hierarchy.find({"parent_id": node_id, "type": "utility"}, {"_id": 0}).to_list(500)
    rooms = []
    for k in kids:
        src = (k.get("metadata") or {}).get("ifc_source") or {}
        if not src.get("poly_world"):
            continue
        try:
            await _enforce_room_access(user, k["id"], write=False)
        except HTTPException:
            continue
        rooms.append({"id": k["id"], "name": k["name"], "poly": src["poly_world"], "z0": src.get("z0") or 0})
    if not rooms:
        raise HTTPException(422, "This floor has no room positions. Re-import it from IFC to enable floor analysis.")
    imp = await db.ifc_imports.find_one({"id": (node.get("metadata") or {}).get("import_id")}, {"_id": 0, "doors": 1}) or {}
    z = min(r["z0"] for r in rooms)
    doors = [d for d in imp.get("doors", []) if z - 0.5 <= d.get("z0", 0) <= z + 2.5]
    out = await asyncio.to_thread(_sa.analyse_floor, rooms, doors, source, flow)
    out["rooms"] = [{"id": r["id"], "name": r["name"], "poly": r["poly"]} for r in rooms]
    out["floor"] = {"id": node["id"], "name": node["name"]}
    if not out.get("vga"):
        out["vga_note"] = "Floor is too large for a full visibility graph; network and routes are still exact."
    return out


# ---------- Rules map: sources → rules → roles/components → live plans ----------
@api.get("/rules-map")
async def rules_map(user=Depends(get_current_user)):
    rules = list({r["rule_id"]: r for r in reversed(
        await db.rules.find({"published": True}, {"_id": 0}).to_list(2000))}.values())[::-1]
    v3 = _json.loads(Path(__file__).parent.joinpath("adjacency_v3.json").read_text())
    role_intent = {r["role"]: r.get("intent") for r in v3.get("roles", [])}
    role_keys: Dict[str, List[str]] = {}
    for k, r in _sa.ROLE.items():
        role_keys.setdefault(r, []).append(k)
    comps = {c["key"]: c for c in await db.components.find({}, {"_id": 0, "key": 1, "name": 1, "rule_ids": 1}).to_list(2000)}
    nodes_rules = []
    for r in rules:
        targets = list(r.get("applies_to_components") or [])
        targets += [k for k, c in comps.items() if r["rule_id"] in (c.get("rule_ids") or [])]
        nodes_rules.append({
            "id": r["rule_id"], "statement": r.get("statement"), "category": r.get("category"),
            "source": r.get("source") or "Unsourced", "source_url": r.get("source_url"),
            "source_page": r.get("source_page"), "tier": r.get("tier"), "severity": r.get("severity_if_violated"),
            "status": r.get("status"), "version": r.get("version", 1), "enabled": r.get("enabled", True),
            "last_reviewed": r.get("last_reviewed"), "reviewed_by": r.get("reviewed_by"),
            "kind": "rule", "targets": sorted(set(targets)), "roles": []})
    for rel in v3.get("relations", []):
        roles = [x for role in rel.get("roles", []) for x in role.split("|") if x.isupper()]
        nodes_rules.append({
            "id": f"V3:{rel['id']}", "code": rel["id"], "statement": f"{' ↔ '.join(rel.get('roles', []))}: {rel.get('kind')}"
                                          + (f" ({rel['threshold_mm']} mm)" if rel.get("threshold_mm") else "")
                                          + (f" — {rel['note']}" if rel.get("note") else ""),
            "category": "Adjacency", "source": rel.get("source") or "Adjacency logic v3", "tier": rel.get("tier"),
            "severity": "high" if rel.get("tier") == "stated" else "medium", "status": "adjacency_v3",
            "version": 3, "enabled": True, "kind": "relation", "roles": roles,
            "targets": sorted({k for ro in roles for k in role_keys.get(ro, [])})})
    # Live plans: latest validation for every room this user can open.
    visible = [n for n in await list_hierarchy(user) if n.get("type") == "utility"]
    room_names = {n["id"]: n["name"] for n in visible}
    latest = await db.validations.aggregate([
        {"$match": {"room_id": {"$in": list(room_names)}}}, {"$sort": {"timestamp": -1}},
        {"$group": {"_id": "$room_id", "doc": {"$first": "$$ROOT"}}}]).to_list(1000)
    applied: Dict[str, List[dict]] = {}
    for row in latest:
        v = row["doc"]
        checked = {c["rule"] for c in v.get("checked", [])}
        failed: Dict[str, List[str]] = {}
        for f in v.get("flags", []):
            if f.get("derogated"):
                continue
            key = f"V3:{f['rule_id']}" if f.get("evidence_tier") else f["rule_id"]
            failed.setdefault(key, []).append((f.get("location") or {}).get("item_id"))
        for r in nodes_rules:
            rid = r["id"]
            ran = rid in checked or rid in failed or (r["kind"] == "relation" and "V3-ADJACENCY" in checked)
            if not ran:
                continue
            applied.setdefault(rid, []).append({
                "room_id": v["room_id"], "room_name": room_names.get(v["room_id"]),
                "status": "fail" if rid in failed else "pass", "item_ids": [i for i in failed.get(rid, []) if i],
                "validated_at": v.get("timestamp")})
    pending = await db.ingestion.find({"state": "pending_review", "target": "rule",
                                       "payload.supersedes_rule_id": {"$exists": True}},
                                      {"_id": 0, "payload.supersedes_rule_id": 1}).to_list(1000)
    pend: Dict[str, int] = {}
    for p in pending:
        k = p["payload"]["supersedes_rule_id"]; pend[k] = pend.get(k, 0) + 1
    for r in nodes_rules:
        r["plans"] = applied.get(r["id"], [])
        r["pending_proposals"] = pend.get(r["id"], 0)
    sources: Dict[str, int] = {}
    for r in nodes_rules:
        sources[r["source"]] = sources.get(r["source"], 0) + 1
    return {
        "sources": [{"id": s, "count": c} for s, c in sorted(sources.items(), key=lambda x: -x[1])],
        "rules": nodes_rules,
        "roles": [{"id": ro, "intent": role_intent.get(ro), "components": role_keys.get(ro, [])} for ro in role_intent],
        "components": {k: c.get("name") for k, c in comps.items()},
        "rooms_validated": len(latest), "can_approve": user.get("role") in ("reviewer", "admin"),
    }


app.include_router(api)


# ---------- WebSocket presence ----------
# Simple in-memory registry: room_id -> { conn_id: {ws, user, seen_at, cursor} }
# Broadcasts a `presence` payload on join/leave/update so every editor sees
# who's live in the room. Cookie-authenticated the same way REST is.

class _PresenceRegistry:
    def __init__(self):
        self.rooms: dict[str, dict[str, dict]] = {}
    def add(self, room_id, conn_id, ws, user):
        self.rooms.setdefault(room_id, {})[conn_id] = {
            "ws": ws, "user": user, "seen_at": now_iso(),
            "cursor": None, "view": "plan",
        }
    def remove(self, room_id, conn_id):
        room = self.rooms.get(room_id)
        if room and conn_id in room:
            del room[conn_id]
            if not room: self.rooms.pop(room_id, None)
    def peers(self, room_id):
        return [
            {
                "id": p["user"].get("id"),
                "email": p["user"].get("email"),
                "name": p["user"].get("name") or p["user"].get("email"),
                "role": p["user"].get("role"),
                "organization": p["user"].get("organization"),
                "discipline":   p["user"].get("discipline"),
                "bio":          p["user"].get("bio"),
                "avatar_url":   p["user"].get("avatar_url"),
                "seen_at": p["seen_at"],
                "cursor": p["cursor"],
                "view": p["view"],
                "conn_id": cid,
            }
            for cid, p in (self.rooms.get(room_id) or {}).items()
        ]
    async def broadcast(self, room_id, payload, exclude_conn=None):
        for cid, p in list((self.rooms.get(room_id) or {}).items()):
            if exclude_conn and cid == exclude_conn: continue
            try: await p["ws"].send_json(payload)
            except Exception: pass

    # ─── Estate-wide roll-up ────────────────────────────────────────────
    # Aggregates every non-estate presence room into a compact
    # {room_id: [tiny peer dict]} map so Dashboard cards can render
    # "who's inside right now" avatar chips without polling.
    def estate_summary(self):
        out = {}
        for room_id, peers_by_conn in self.rooms.items():
            if room_id == "estate" or not peers_by_conn:
                continue
            # De-dupe by user email so two tabs from the same user show once.
            seen_emails = set()
            occupants = []
            for _, p in peers_by_conn.items():
                u = p.get("user") or {}
                email = u.get("email")
                if not email or email in seen_emails:
                    continue
                seen_emails.add(email)
                occupants.append({
                    "id":         u.get("id"),
                    "email":      email,
                    "name":       u.get("name") or email,
                    "avatar_url": u.get("avatar_url"),
                    "role":       u.get("role"),
                })
            if occupants:
                out[room_id] = occupants
        return out

    async def broadcast_estate_summary(self):
        payload = {"type": "rooms_update", "rooms": self.estate_summary()}
        for cid, p in list((self.rooms.get("estate") or {}).items()):
            try: await p["ws"].send_json(payload)
            except Exception: pass


presence = _PresenceRegistry()


async def _ws_user_from_cookies(ws: WebSocket):
    """Extract & verify the access_token cookie set by set_auth_cookies(),
    OR a token passed via the `?token=` query string (fallback for browsers
    that don't attach cookies to WebSocket handshakes when the page origin
    differs from the WS origin behind edge routers)."""
    token = ws.cookies.get("access_token") or ws.query_params.get("token")
    if not token: return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        if payload.get("type") != "access": return None
        user = await db.users.find_one({"id": payload["sub"]})
        if not user: return None
        user.pop("_id", None); user.pop("password_hash", None)
        return user
    except Exception:
        return None


@app.websocket("/api/ws/rooms/{room_id}/presence")
async def presence_ws(ws: WebSocket, room_id: str):
    user = await _ws_user_from_cookies(ws)
    if not user:
        await ws.close(code=4401); return
    # The "estate" room is a dashboard-wide presence channel — no per-room
    # access check. All other room WS connections must pass the same
    # ownership / grant / admin gate as the HTTP endpoints.
    if room_id != "estate":
        try:
            await _enforce_room_access(user, room_id, write=False)
        except HTTPException:
            await ws.close(code=4403); return
    await ws.accept()
    conn_id = new_id()
    presence.add(room_id, conn_id, ws, user)
    # Any room-level join affects the estate roll-up — tell Dashboard clients.
    if room_id != "estate":
        try: await presence.broadcast_estate_summary()
        except Exception: pass
    try:
        hello_payload = {"type": "hello", "conn_id": conn_id,
                         "peers": [p for p in presence.peers(room_id) if p["conn_id"] != conn_id]}
        # Estate viewers get the current occupancy map bundled with the hello
        # so their cards can render chips before any join event fires.
        if room_id == "estate":
            hello_payload["rooms"] = presence.estate_summary()
        await ws.send_json(hello_payload)
        await presence.broadcast(room_id, {
            "type": "join",
            "peer": next((p for p in presence.peers(room_id) if p["conn_id"] == conn_id), None),
        }, exclude_conn=conn_id)
        while True:
            msg = await ws.receive_json()
            t = (msg or {}).get("type")
            entry = (presence.rooms.get(room_id) or {}).get(conn_id)
            if not entry: break
            entry["seen_at"] = now_iso()
            if t == "cursor":
                entry["cursor"] = msg.get("cursor")
                await presence.broadcast(room_id, {
                    "type": "cursor", "conn_id": conn_id, "cursor": entry["cursor"],
                }, exclude_conn=conn_id)
            elif t == "view":
                entry["view"] = msg.get("view", "plan")
                await presence.broadcast(room_id, {
                    "type": "view", "conn_id": conn_id, "view": entry["view"],
                }, exclude_conn=conn_id)
            elif t == "scene_op":
                # Broadcast a full-scene snapshot (or targeted op) to peers
                # in the same room. Last-write-wins — the originating client
                # is responsible for persisting via PUT /rooms/{id}/scene;
                # peers apply the snapshot locally so what they see
                # matches instantly.
                await presence.broadcast(room_id, {
                    "type": "scene_op",
                    "conn_id": conn_id,
                    "op": msg.get("op"),
                    "scene": msg.get("scene"),
                    "author": {
                        "email": user.get("email"),
                        "name":  user.get("name") or user.get("email"),
                        "avatar_url": user.get("avatar_url"),
                    },
                    "ts": now_iso(),
                }, exclude_conn=conn_id)
            elif t == "ping":
                await ws.send_json({"type": "pong", "at": now_iso()})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        presence.remove(room_id, conn_id)
        await presence.broadcast(room_id, {"type": "leave", "conn_id": conn_id})
        if room_id != "estate":
            try: await presence.broadcast_estate_summary()
            except Exception: pass
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS","*").split(","),
    allow_methods=["*"], allow_headers=["*"],
)
logging.basicConfig(level=logging.INFO)
