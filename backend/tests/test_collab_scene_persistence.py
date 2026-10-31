"""
Backend tests for iteration 28 — HealthcareCanvas live-collab & persistence.

Covers:
  1. POST /api/auth/guest — dual guest sessions (different guest_ids).
  2. GET  /api/rooms/last-edits — 401 unauth, 200 auth, returns dict.
  3. PUT  /api/rooms/{id}/scene — persists last_edited_by + last_edited_at,
     and the last-edits map surfaces it.
  4. GET  /api/rooms/{id}/scene — round-trip includes last_edited_by.
  5. WebSocket /api/ws/rooms/{id}/presence — scene_op broadcast to peers.
  6. Estate rooms_update broadcast — joining a real room populates the estate
     summary map that dashboard clients subscribe to.
"""

import asyncio
import json
import os
import uuid

import pytest
import requests
import websockets

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
WS_BASE = BASE_URL.replace("https:", "wss:").replace("http:", "ws:")

# Known utility room from seeded hierarchy (see /api/hierarchy).
ROOM_ID = "25367492-efae-4afc-951b-f51185e26cde"  # "Sluice Room"


def _guest_token(gid_suffix: str) -> dict:
    r = requests.post(
        f"{BASE_URL}/api/auth/guest",
        json={"guest_id": f"iter28-{gid_suffix}-{uuid.uuid4().hex[:6]}",
              "label": f"Iter28 {gid_suffix}"},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("token")
    return body


# --------------------------------------------------------------------------- #
# 1. Guest auth
# --------------------------------------------------------------------------- #
def test_guest_auth_two_distinct_users():
    a = _guest_token("A")
    b = _guest_token("B")
    assert a["email"] != b["email"], "guest_id must produce distinct user rows"
    assert a["token"] != b["token"]


# --------------------------------------------------------------------------- #
# 2. /rooms/last-edits auth gating
# --------------------------------------------------------------------------- #
def test_last_edits_requires_auth():
    r = requests.get(f"{BASE_URL}/api/rooms/last-edits", timeout=10)
    assert r.status_code == 401


def test_last_edits_returns_dict_for_auth():
    tok = _guest_token("last-edits")["token"]
    r = requests.get(
        f"{BASE_URL}/api/rooms/last-edits",
        headers={"Authorization": f"Bearer {tok}"},
        timeout=10,
    )
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, dict)


# --------------------------------------------------------------------------- #
# 3. PUT scene persists last_edited_by
# --------------------------------------------------------------------------- #
def test_put_scene_records_last_edited_by_and_surfaces_in_map():
    session = _guest_token("saver")
    tok = session["token"]
    email = session["email"]
    hdr = {"Authorization": f"Bearer {tok}"}

    scene = {
        "room_id": ROOM_ID,
        "width": 4.0,
        "depth": 3.0,
        "items": [{"id": "TEST_item1", "component_key": "cabinet-generic",
                   "zone": "clean", "kind": "cabinet",
                   "x": 1.0, "y": 1.0, "w": 0.5, "d": 0.5, "rot": 0}],
        "partitions": [],
    }
    put = requests.put(f"{BASE_URL}/api/rooms/{ROOM_ID}/scene",
                       json=scene, headers=hdr, timeout=15)
    assert put.status_code == 200, put.text
    body = put.json()
    lb = body.get("last_edited_by") or {}
    assert lb.get("email") == email, f"last_edited_by.email mismatch: {lb}"
    assert body.get("last_edited_at")

    # GET scene should carry the same field
    got = requests.get(f"{BASE_URL}/api/rooms/{ROOM_ID}/scene",
                       headers=hdr, timeout=10).json()
    assert (got.get("last_edited_by") or {}).get("email") == email

    # last-edits map must surface this room with correct author email
    m = requests.get(f"{BASE_URL}/api/rooms/last-edits",
                     headers=hdr, timeout=10).json()
    assert ROOM_ID in m, f"expected room {ROOM_ID} in last-edits map, got keys={list(m)[:8]}"
    entry = m[ROOM_ID]
    assert (entry.get("by") or {}).get("email") == email
    assert entry.get("at")


# --------------------------------------------------------------------------- #
# 4. WebSocket scene_op broadcast & estate summary
# --------------------------------------------------------------------------- #
async def _open_ws(token: str, room_id: str):
    url = f"{WS_BASE}/api/ws/rooms/{room_id}/presence?token={token}"
    ws = await websockets.connect(url, open_timeout=10, ping_interval=None)
    hello_raw = await asyncio.wait_for(ws.recv(), timeout=10)
    hello = json.loads(hello_raw)
    assert hello.get("type") == "hello"
    return ws, hello


@pytest.mark.asyncio
async def test_scene_op_broadcast_to_peer_in_same_room():
    tok_a = _guest_token("scene-op-A")["token"]
    tok_b = _guest_token("scene-op-B")["token"]

    ws_a, hello_a = await _open_ws(tok_a, ROOM_ID)
    ws_b, hello_b = await _open_ws(tok_b, ROOM_ID)

    try:
        # A join message should reach the OTHER peer (B was second so A gets B's join)
        # Drain any pending join frames on A.
        try:
            await asyncio.wait_for(ws_a.recv(), timeout=2)
        except asyncio.TimeoutError:
            pass

        payload = {"type": "scene_op",
                   "op": {"kind": "move", "id": "TEST_item1"},
                   "scene": {"items": [{"id": "TEST_item1", "x": 2.5, "y": 1.7, "rot": 90}]}}
        await ws_a.send(json.dumps(payload))

        # B should receive it
        got = None
        for _ in range(6):
            raw = await asyncio.wait_for(ws_b.recv(), timeout=3)
            m = json.loads(raw)
            if m.get("type") == "scene_op":
                got = m
                break
        assert got is not None, "peer B did not receive scene_op broadcast"
        assert got["op"]["kind"] == "move"
        assert got["scene"]["items"][0]["x"] == 2.5
        assert got.get("author", {}).get("email")
    finally:
        await ws_a.close()
        await ws_b.close()


@pytest.mark.asyncio
async def test_estate_rooms_update_on_room_join_and_leave():
    tok_dashboard = _guest_token("estate-viewer")["token"]
    tok_worker = _guest_token("room-joiner")["token"]

    # Dashboard viewer subscribes to the estate presence channel
    ws_estate, hello_estate = await _open_ws(tok_dashboard, "estate")
    initial_rooms = hello_estate.get("rooms", {})
    assert isinstance(initial_rooms, dict)

    ws_room, _ = await _open_ws(tok_worker, ROOM_ID)
    try:
        # Wait for rooms_update showing the joiner inside ROOM_ID
        joined = None
        for _ in range(10):
            try:
                raw = await asyncio.wait_for(ws_estate.recv(), timeout=3)
            except asyncio.TimeoutError:
                break
            m = json.loads(raw)
            if m.get("type") == "rooms_update":
                if ROOM_ID in (m.get("rooms") or {}):
                    joined = m
                    break
        assert joined is not None, "estate viewer never received a rooms_update for the joined room"
        occ = joined["rooms"][ROOM_ID]
        assert isinstance(occ, list) and len(occ) >= 1
        assert occ[0].get("email")
    finally:
        await ws_room.close()

    # After the room WS closes, estate should get an update where ROOM_ID is gone
    departed = False
    for _ in range(10):
        try:
            raw = await asyncio.wait_for(ws_estate.recv(), timeout=3)
        except asyncio.TimeoutError:
            break
        m = json.loads(raw)
        if m.get("type") == "rooms_update":
            if ROOM_ID not in (m.get("rooms") or {}):
                departed = True
                break
    await ws_estate.close()
    assert departed, "room did not disappear from estate summary after peer left"
