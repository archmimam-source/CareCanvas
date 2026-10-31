"""Static seed data for HIS Co-Design (components + rules).
Kept here so server.py stays focused on routes and engines.
"""

def get_components():
    C = [
      # FLOOR (dirty)
      {"key":"macerator","kind":"macerator","name":"Macerator (DSU901)","zone_affinity":"dirty",
       "default_footprint":{"w":0.66,"d":0.52,"h":1.4},
       "mount_type":"floor","elevation_m":0.0,"height_m":1.4,
       "code":"DSU901","icon":"recycle","material":"stainless",
       "description":"Disposal unit for pulp bedpans/urine bottles. Doubles as slop hopper in the Medium configuration."},
      {"key":"prep_counter","kind":"counter","name":"Stainless Worktop (WKT992)","zone_affinity":"dirty",
       "default_footprint":{"w":1.2,"d":0.6,"h":0.9},
       "mount_type":"floor","elevation_m":0.0,"height_m":0.9,
       "code":"WKT992","icon":"square","material":"stainless",
       "description":"Heavy-duty stainless worktop, 600 depth."},
      {"key":"steel_tray","kind":"tray","name":"Sit-on Splash Panel (SPL901)","zone_affinity":"dirty",
       "default_footprint":{"w":0.6,"d":0.4,"h":0.05},
       "mount_type":"floor","elevation_m":0.9,"height_m":0.05,
       "code":"SPL901","icon":"layout-grid","material":"glass",
       "description":"Glazed splash panel on worktop."},
      {"key":"linen_trolley","kind":"trolley","name":"Contaminated Linen Trolley (TRO235)","zone_affinity":"dirty",
       "default_footprint":{"w":0.5,"d":0.5,"h":1.0},
       "mount_type":"floor","elevation_m":0.0,"height_m":1.0,
       "code":"TRO235","icon":"boxes","material":"stainless",
       "description":"Single ring, stainless steel."},
      {"key":"biohazard_bin","kind":"bin","name":"Foot-op Sack Holder (HOL004)","zone_affinity":"dirty",
       "default_footprint":{"w":0.35,"d":0.35,"h":0.7},
       "mount_type":"floor","elevation_m":0.0,"height_m":0.7,
       "code":"HOL004","icon":"trash-2","material":"plastic_yellow",
       "description":"Freestanding, foot-operated lid."},
      # WALL (dirty)
      {"key":"cabinet_coshh","kind":"cabinet","name":"COSHH Cabinet (CUP911)","zone_affinity":"dirty",
       "default_footprint":{"w":0.6,"d":0.35,"h":0.9},
       "mount_type":"wall","elevation_m":1.4,"height_m":0.9,
       "code":"CUP911","icon":"package","material":"laminate",
       "description":"Single door, wall-mounted COSHH cabinet."},
      {"key":"splash_panel","kind":"panel","name":"IPS Sanitary Back-Panel (PAN923)","zone_affinity":"dirty",
       "default_footprint":{"w":1.2,"d":0.05,"h":0.6},
       "mount_type":"wall","elevation_m":0.9,"height_m":0.6,
       "code":"PAN923","icon":"minus","material":"laminate",
       "description":"IPS-type solid grade laminate back-panel."},
      # FLOOR (transition)
      {"key":"clinical_wash_basin","kind":"basin","name":"Clinical Wash-Hand Basin (A-BAS908)","zone_affinity":"transition",
       "default_footprint":{"w":0.6,"d":0.45,"h":0.9},
       "mount_type":"floor","elevation_m":0.0,"height_m":0.9,
       "code":"A-BAS908","icon":"droplets","material":"ceramic",
       "description":"Sensor-operated non-touch tap, no plug/overflow, rear-offset drain, TMV to 41°C."},
      # WALL (transition)
      {"key":"soap_dispenser","kind":"dispenser","name":"Soap Dispenser (DIS930)","zone_affinity":"transition",
       "default_footprint":{"w":0.15,"d":0.1,"h":0.28},
       "mount_type":"wall","elevation_m":1.35,"height_m":0.28,
       "code":"DIS930","icon":"sparkles","material":"plastic_white",
       "description":"1L, non-touch, wall mounted."},
      {"key":"sanitiser_unit","kind":"dispenser","name":"Sanitiser Dispenser (DIS926)","zone_affinity":"transition",
       "default_footprint":{"w":0.15,"d":0.1,"h":0.28},
       "mount_type":"wall","elevation_m":1.35,"height_m":0.28,
       "code":"DIS926","icon":"sparkles","material":"plastic_white",
       "description":"Non-touch alcogel dispenser."},
      {"key":"paper_towel","kind":"dispenser","name":"Paper Towel Dispenser (DIS913)","zone_affinity":"transition",
       "default_footprint":{"w":0.2,"d":0.1,"h":0.3},
       "mount_type":"wall","elevation_m":1.35,"height_m":0.3,
       "code":"DIS913","icon":"file-text","material":"plastic_white",
       "description":"Wall-mounted paper towel dispenser."},
      {"key":"ppe_station","kind":"ppe","name":"PPE Station (DIS438)","zone_affinity":"transition",
       "default_footprint":{"w":0.6,"d":0.15,"h":1.0},
       "mount_type":"wall","elevation_m":0.9,"height_m":1.0,
       "code":"DIS438","icon":"shield","material":"plastic_white",
       "description":"Disposable gloves + apron dispenser. Position remote from water sources."},
      # FLOOR (clean)
      {"key":"commode_store","kind":"cabinet_tall","name":"Cleaned Commode Store","zone_affinity":"clean",
       "default_footprint":{"w":0.8,"d":0.6,"h":1.6},
       "mount_type":"floor","elevation_m":0.0,"height_m":1.6,
       "code":"—","icon":"package","material":"laminate",
       "description":"Storage bay for cleaned commodes."},
      {"key":"entry_door","kind":"door","name":"Sliding Entry Door (5A_860)","zone_affinity":"clean",
       "default_footprint":{"w":0.9,"d":0.1,"h":2.05},
       "mount_type":"floor","elevation_m":0.0,"height_m":2.05,
       "code":"SWC901","icon":"door-open","material":"door",
       "description":"Solid over-wall sliding, hands-free open via staff card."},
      # WALL (clean)
      {"key":"shelf_wall","kind":"shelf","name":"Wall Shelf (SHE996)","zone_affinity":"clean",
       "default_footprint":{"w":0.9,"d":0.3,"h":0.05},
       "mount_type":"wall","elevation_m":1.6,"height_m":0.05,
       "code":"SHE996","icon":"minus","material":"stainless",
       "description":"Wall-mounted shelf, length as shown."},
      # CEILING
      {"key":"exhaust_vent","kind":"vent","name":"Extract Air Grille (EXT901)","zone_affinity":"dirty",
       "default_footprint":{"w":0.6,"d":0.6,"h":0.15},
       "mount_type":"ceiling","elevation_m":2.55,"height_m":0.15,
       "code":"EXT901","icon":"fan","material":"metal_grille",
       "description":"Ceiling extract 600x600, negative pressure to corridor."},
      {"key":"ceiling_light","kind":"light","name":"Recessed LED Panel (LIG909)","zone_affinity":"clean",
       "default_footprint":{"w":0.6,"d":0.6,"h":0.1},
       "mount_type":"ceiling","elevation_m":2.60,"height_m":0.10,
       "code":"LIG909","icon":"lightbulb","material":"led",
       "description":"600×600 recessed LED, 500–1000 lux at work surfaces."},
      # ---- Extended RDS 6222 equipment list ----
      # ELECTRICAL / DATA (wall)
      {"key":"socket_single","kind":"socket","name":"Single 13A Socket (OUT005)","zone_affinity":"transition",
       "default_footprint":{"w":0.09,"d":0.05,"h":0.09},
       "mount_type":"wall","elevation_m":1.05,"height_m":0.09,
       "code":"OUT005","icon":"plug","material":"plastic_white",
       "description":"Single switched 13A plug socket."},
      {"key":"socket_twin","kind":"socket","name":"Twin 13A Socket (OUT010)","zone_affinity":"transition",
       "default_footprint":{"w":0.15,"d":0.05,"h":0.09},
       "mount_type":"wall","elevation_m":1.05,"height_m":0.09,
       "code":"OUT010","icon":"plug","material":"plastic_white",
       "description":"Twin switched 13A plug socket."},
      {"key":"outlet_isolator","kind":"socket","name":"Isolator Outlet (OUT079)","zone_affinity":"dirty",
       "default_footprint":{"w":0.12,"d":0.06,"h":0.15},
       "mount_type":"wall","elevation_m":1.40,"height_m":0.15,
       "code":"OUT079","icon":"power","material":"plastic_white",
       "description":"Local equipment isolator to manufacturer spec."},
      {"key":"data_single","kind":"socket","name":"Data Outlet (OUT121)","zone_affinity":"transition",
       "default_footprint":{"w":0.09,"d":0.05,"h":0.09},
       "mount_type":"wall","elevation_m":1.05,"height_m":0.09,
       "code":"OUT121","icon":"network","material":"plastic_white",
       "description":"Single data outlet."},
      {"key":"data_double","kind":"socket","name":"Data/Voice Outlet (OUT131)","zone_affinity":"transition",
       "default_footprint":{"w":0.15,"d":0.05,"h":0.09},
       "mount_type":"wall","elevation_m":1.05,"height_m":0.09,
       "code":"OUT131","icon":"network","material":"plastic_white",
       "description":"Double data/voice outlet."},
      {"key":"connection_box_32a","kind":"socket","name":"32A Connection Box (OUT931)","zone_affinity":"dirty",
       "default_footprint":{"w":0.16,"d":0.08,"h":0.16},
       "mount_type":"wall","elevation_m":1.40,"height_m":0.16,
       "code":"OUT931","icon":"power","material":"plastic_white",
       "description":"32A single-phase power supply box."},
      # PLUMBING (wall)
      {"key":"cold_water_outlet","kind":"socket","name":"Cold Water Outlet (OUT301)","zone_affinity":"dirty",
       "default_footprint":{"w":0.10,"d":0.06,"h":0.10},
       "mount_type":"wall","elevation_m":1.20,"height_m":0.10,
       "code":"OUT301","icon":"droplet","material":"metal_grille",
       "description":"Cold water outlet for equipment."},
      {"key":"tundish_drain","kind":"socket","name":"Tundish Drain (OUT347)","zone_affinity":"dirty",
       "default_footprint":{"w":0.12,"d":0.06,"h":0.12},
       "mount_type":"wall","elevation_m":0.30,"height_m":0.12,
       "code":"OUT347","icon":"droplet","material":"metal_grille",
       "description":"Tundish drain point."},
      # DISPENSERS / SHELVING (wall)
      {"key":"wipes_dispenser","kind":"dispenser","name":"Wipes Dispenser (DIS064)","zone_affinity":"transition",
       "default_footprint":{"w":0.20,"d":0.10,"h":0.28},
       "mount_type":"wall","elevation_m":1.35,"height_m":0.28,
       "code":"DIS064","icon":"file-text","material":"plastic_white",
       "description":"Door-mounted wipes dispenser."},
      {"key":"shelf_bracket","kind":"shelf","name":"Shelving Bracket (BRA903)","zone_affinity":"clean",
       "default_footprint":{"w":0.05,"d":0.30,"h":0.05},
       "mount_type":"wall","elevation_m":1.60,"height_m":0.05,
       "code":"BRA903","icon":"minus","material":"stainless",
       "description":"Wall-mounted shelving bracket."},
      {"key":"sloping_storage","kind":"cabinet","name":"Sloping-top Storage (SMS010)","zone_affinity":"clean",
       "default_footprint":{"w":0.40,"d":0.30,"h":0.30},
       "mount_type":"wall","elevation_m":1.80,"height_m":0.30,
       "code":"SMS010","icon":"boxes","material":"laminate",
       "description":"Modular high-level sloping-top storage, 400 facing."},
      # SAFETY / DETECTION (ceiling)
      {"key":"smoke_detector","kind":"vent","name":"Smoke Detector (DET003)","zone_affinity":"clean",
       "default_footprint":{"w":0.12,"d":0.12,"h":0.05},
       "mount_type":"ceiling","elevation_m":2.65,"height_m":0.05,
       "code":"DET003","icon":"shield","material":"plastic_white",
       "description":"Ceiling-mounted smoke detector."},
      {"key":"presence_sensor","kind":"vent","name":"Presence Sensor (PIR910)","zone_affinity":"clean",
       "default_footprint":{"w":0.10,"d":0.10,"h":0.05},
       "mount_type":"ceiling","elevation_m":2.65,"height_m":0.05,
       "code":"PIR910","icon":"eye","material":"plastic_white",
       "description":"PIR presence detector for lighting/occupancy."},
      {"key":"emergency_light","kind":"light","name":"Emergency Luminaire (LIG959)","zone_affinity":"clean",
       "default_footprint":{"w":0.30,"d":0.10,"h":0.05},
       "mount_type":"ceiling","elevation_m":2.65,"height_m":0.05,
       "code":"LIG959","icon":"lightbulb","material":"led",
       "description":"Emergency mains/battery luminaire."},
      {"key":"wifi_ap","kind":"vent","name":"Wireless Access Point (WAP904)","zone_affinity":"clean",
       "default_footprint":{"w":0.20,"d":0.20,"h":0.05},
       "mount_type":"ceiling","elevation_m":2.65,"height_m":0.05,
       "code":"WAP904","icon":"wifi","material":"plastic_white",
       "description":"Ceiling-mounted Wi-Fi access point."},
      # OTHER WALL EQUIPMENT
      {"key":"call_lamp","kind":"panel","name":"Call Lamp & Sounder (CAL920)","zone_affinity":"clean",
       "default_footprint":{"w":0.15,"d":0.08,"h":0.20},
       "mount_type":"wall","elevation_m":2.10,"height_m":0.20,
       "code":"CAL920","icon":"bell","material":"plastic_white",
       "description":"Audible + visual staff/emergency/cardiac call unit."},
      {"key":"pressure_stabiliser","kind":"panel","name":"Fire-rated Pressure Stabiliser (APS902)","zone_affinity":"transition",
       "default_footprint":{"w":0.35,"d":0.10,"h":0.50},
       "mount_type":"wall","elevation_m":1.90,"height_m":0.50,
       "code":"APS902","icon":"wind","material":"metal_grille",
       "description":"MFSD 350H 500W fire-rated pressure stabiliser."},
      {"key":"urine_scale","kind":"cabinet","name":"Urine Weighing Scale (SCA900)","zone_affinity":"dirty",
       "default_footprint":{"w":0.30,"d":0.30,"h":0.15},
       "mount_type":"wall","elevation_m":1.00,"height_m":0.15,
       "code":"SCA900","icon":"scale","material":"stainless",
       "description":"Stainless steel urine weighing scale."},
      {"key":"sanitary_ips","kind":"cabinet","name":"Sanitary IPS Panel (PAN923)","zone_affinity":"transition",
       "default_footprint":{"w":1.20,"d":0.20,"h":2.10},
       "mount_type":"wall","elevation_m":0.00,"height_m":2.10,
       "code":"PAN923","icon":"panel","material":"laminate",
       "description":"Integrated plumbing system duct panel behind sanitaryware."},
      {"key":"door_open_button","kind":"socket","name":"Touchless Door Button (SWC901)","zone_affinity":"transition",
       "default_footprint":{"w":0.12,"d":0.03,"h":0.12},
       "mount_type":"wall","elevation_m":1.05,"height_m":0.12,
       "code":"SWC901","icon":"radio","material":"stainless",
       "description":"Wall-mounted touchless (IR) push button that triggers assisted door opening."},
      {"key":"paper_towel_dispenser","kind":"dispenser","name":"Paper Towel Dispenser (DIS913)","zone_affinity":"transition",
       "default_footprint":{"w":0.28,"d":0.13,"h":0.36},
       "mount_type":"wall","elevation_m":1.10,"height_m":0.36,
       "code":"DIS913","icon":"paper","material":"plastic_white",
       "description":"Wall-mounted paper hand-towel dispenser."},
      {"key":"wipes_dispenser","kind":"dispenser","name":"Wipes Dispenser (DIS064)","zone_affinity":"transition",
       "default_footprint":{"w":0.22,"d":0.16,"h":0.30},
       "mount_type":"wall","elevation_m":1.10,"height_m":0.30,
       "code":"DIS064","icon":"wipes","material":"plastic_white",
       "description":"Wall-mounted clinical wipes dispenser."},
      {"key":"nurse_call_lamp","kind":"socket","name":"Nurse Call Lamp & Sounder (CAL920)","zone_affinity":"transition",
       "default_footprint":{"w":0.08,"d":0.05,"h":0.16},
       "mount_type":"ceiling","elevation_m":2.60,"height_m":0.16,
       "code":"CAL920","icon":"bell","material":"plastic_white",
       "description":"Corridor call lamp with audible sounder for nurse call system."},
    ]
    return _apply_orientation(C)


# ---------- Per-component orientation & face-accessory metadata -----------
# Declarative description of the accessories that hang off each face of a
# component. Consumed by the 3D renderer (Room3DGeometry.jsx) to place
# hardware on the correct face and by external CAD/audit tools that ingest
# GET /api/components. The 3D catalog already renders the visual detail; this
# structure gives the rest of the system a *data* view of "what lives on
# which face" so we can generate spec sheets / procurement lists directly.
#
# Faces: front | back | left | right | top | bottom
# Each accessory: { key, kind, label, position_hint? }
#
# When a kind isn't listed the component has no explicit face metadata (its
# 3D block is rendered as-is).
_ORIENTATION = {
    "macerator": {
        "front":  [
            {"key": "lcd_panel",   "kind": "display",   "label": "LCD control panel"},
            {"key": "led_ready",   "kind": "indicator", "label": "Ready LED",   "position_hint": "top-left"},
            {"key": "led_cycle",   "kind": "indicator", "label": "Cycle LED",   "position_hint": "top-center"},
            {"key": "led_fault",   "kind": "indicator", "label": "Fault LED",   "position_hint": "top-right"},
            {"key": "foot_pedal",  "kind": "actuator",  "label": "Hands-free open pedal", "position_hint": "bottom"},
        ],
        "top":    [{"key": "exhaust_vent", "kind": "vent",  "label": "Exhaust vent grille"},
                   {"key": "lid_handle",   "kind": "handle","label": "Loading-lid handle"}],
        "back":   [{"key": "water_inlet",  "kind": "pipe",  "label": "15 mm cold-water inlet"},
                   {"key": "drain_outlet", "kind": "pipe",  "label": "50 mm drain outlet"}],
        "bottom": [{"key": "plinth", "kind": "structure",   "label": "Stainless plinth 50 mm"}],
    },
    "basin": {
        "front":  [{"key": "brand_plate", "kind": "label", "label": "Manufacturer plate"}],
        "top":    [
            {"key": "sensor_tap", "kind": "spout",     "label": "Sensor tap (non-touch)"},
            {"key": "sensor_eye", "kind": "sensor",    "label": "IR sensor",       "position_hint": "spout-under"},
            {"key": "drain",      "kind": "outlet",    "label": "Rear-offset drain"},
        ],
        "back":   [
            {"key": "supply_pipe", "kind": "pipe",     "label": "Hot/cold supply", "position_hint": "top"},
            {"key": "waste_pipe",  "kind": "pipe",     "label": "Waste stub",      "position_hint": "bottom"},
        ],
    },
    "cabinet": {
        "front":  [{"key": "door_handle", "kind": "handle", "label": "Door handle"},
                   {"key": "hinges",       "kind": "hinge",  "label": "Concealed hinges"}],
        "bottom": [{"key": "plinth",       "kind": "structure","label": "MDF plinth"}],
    },
    "cabinet_tall": {
        "front":  [{"key": "door_handle_top",    "kind": "handle", "label": "Top door handle"},
                   {"key": "door_handle_bottom", "kind": "handle", "label": "Bottom door handle"},
                   {"key": "hinges",             "kind": "hinge",  "label": "Concealed hinges (×4)"}],
        "bottom": [{"key": "adjustable_feet",    "kind": "structure","label": "M8 adjustable feet"}],
    },
    "bin": {
        "front":  [{"key": "foot_pedal", "kind": "actuator", "label": "Foot pedal (hands-free)"}],
        "top":    [{"key": "sack_ring",  "kind": "structure","label": "Yellow sack retention ring"},
                   {"key": "lid_hinge",  "kind": "hinge",    "label": "Lid hinge",   "position_hint": "rear"}],
    },
    "dispenser": {
        "front":  [
            {"key": "reservoir_window", "kind": "display",  "label": "Fill-level window"},
            {"key": "brand_plate",      "kind": "label",    "label": "Brand plate"},
            {"key": "ir_sensor",        "kind": "sensor",   "label": "IR proximity sensor", "position_hint": "bottom"},
            {"key": "spout",            "kind": "spout",    "label": "Dispensing spout",    "position_hint": "bottom"},
            {"key": "drip_cup",         "kind": "tray",     "label": "Drip cup",            "position_hint": "bottom"},
        ],
        "back":   [{"key": "mount_plate", "kind": "structure", "label": "Wall mount plate"}],
    },
    "ppe": {
        "front":  [{"key": "row_gloves_l", "kind": "tray", "label": "Large gloves",  "position_hint": "top"},
                   {"key": "row_gloves_m", "kind": "tray", "label": "Medium gloves", "position_hint": "upper-mid"},
                   {"key": "row_gloves_s", "kind": "tray", "label": "Small gloves",  "position_hint": "lower-mid"},
                   {"key": "row_apron",    "kind": "tray", "label": "Aprons",        "position_hint": "bottom"},
                   {"key": "header_label", "kind": "label","label": "PPE Station header"}],
    },
    "door": {
        "front":  [
            {"key": "vision_panel", "kind": "display", "label": "Vision panel"},
            {"key": "pull_rail",    "kind": "handle",  "label": "Pull rail"},
            {"key": "card_reader",  "kind": "sensor",  "label": "Staff-card reader"},
            {"key": "kick_plate",   "kind": "structure","label": "Stainless kick plate", "position_hint": "bottom"},
        ],
        "top":    [{"key": "slide_rail", "kind": "structure", "label": "Sliding track"}],
    },
    "vent": {
        "bottom": [{"key": "grille",  "kind": "structure", "label": "Louvre grille (extract face)"}],
        "top":    [{"key": "duct_boss","kind": "pipe",     "label": "Duct connection", "position_hint": "for-ceiling-mount"}],
    },
    "light": {
        "bottom": [{"key": "lens",       "kind": "display", "label": "LED lens (500-1000 lux)"}],
        "top":    [{"key": "driver_box", "kind": "structure","label": "LED driver housing"}],
    },
    "trolley": {
        "front":  [{"key": "brake_pedal", "kind": "actuator","label": "Caster brake pedal", "position_hint": "bottom"}],
        "back":   [{"key": "push_handle", "kind": "handle",  "label": "Push handle",         "position_hint": "top"}],
        "bottom": [{"key": "casters",     "kind": "structure","label": "4× braked casters"}],
    },
    "socket": {
        "front":  [{"key": "plug_face", "kind": "display", "label": "Socket face"}],
        "back":   [{"key": "back_box",  "kind": "structure","label": "35 mm back-box"}],
    },
}

def _apply_orientation(components):
    """Enrich each component with:
       - `orientation`  : per-face accessory metadata (existing)
       - `placement`    : where in a room this component is expected to live
                          (`against_wall`, `wall_mounted`, `ceiling_mounted`,
                          `free_floor`, `on_counter`). Drives orientation
                          validation and the 3D auto-orient logic.
       - `working_face` : which face of the local footprint is the front
                          (defaults to `+y` — the +Y edge of the footprint
                          is the side that must face into the room).
    """
    # Placement by component key. Kind-only would over-generalise (e.g. a
    # `panel` kind can be both a wall_mounted splash panel AND a free-standing
    # IPS duct), so we key off `key` first, with a `kind` fallback.
    KEY_PLACEMENT = {
        # Floor items that MUST be tucked flush against a wall.
        "macerator":            "against_wall",
        "prep_counter":         "against_wall",
        "clinical_wash_basin":  "against_wall",
        "commode_store":        "against_wall",
        "biohazard_bin":        "against_wall",
        # Doors sit inside a wall opening (treat as wall-mounted).
        "entry_door":           "wall_mounted",
        # Free-standing floor items (trolleys are pushed around).
        "linen_trolley":        "free_floor",
        # Trays that sit on top of a counter.
        "steel_tray":           "on_counter",
    }
    KIND_PLACEMENT = {
        "wall":       "wall_mounted",       # if mount_type is wall
        "ceiling":    "ceiling_mounted",    # if mount_type is ceiling
        "floor":      "free_floor",         # default fallback
    }
    for c in components:
        o = _ORIENTATION.get(c.get("kind"))
        if o: c["orientation"] = o
        # Placement — key wins, then derive from mount_type.
        placement = KEY_PLACEMENT.get(c["key"])
        if not placement:
            placement = KIND_PLACEMENT.get(c.get("mount_type"), "free_floor")
        c["placement"] = placement
        # Working face (the side that must face into the room). Default to
        # `+y` — items are authored so their +Y footprint edge is the front.
        # Ceiling items have no meaningful working face.
        if placement != "ceiling_mounted":
            c["working_face"] = c.get("working_face", "+y")
    return components


def get_rules():
    # Public standard document URLs (verified user-provided).
    HBN_00_03  = "https://www.england.nhs.uk/wp-content/uploads/2021/05/HBN_00-03_Final.pdf"
    HBN_00_09  = "https://www.england.nhs.uk/wp-content/uploads/2021/05/HBN_00-09_Final.pdf"
    HBN_04_01  = "https://www.england.nhs.uk/wp-content/uploads/2009/12/HBN_04-01_Final.pdf"
    HBN_11_01  = "https://www.england.nhs.uk/wp-content/uploads/2021/05/HBN_11-01_Final.pdf"
    HTM_04_01  = "https://www.england.nhs.uk/wp-content/uploads/2021/05/DH_HTM_0401_PART_A_acc.pdf"
    HTM_08_01  = "https://www.england.nhs.uk/wp-content/uploads/2021/05/HTM_08-01.pdf"
    CDC_ENV    = "https://www.cdc.gov/infection-control/media/pdfs/guideline-environmental-h.pdf"
    WHO_WASH   = "https://iris.who.int/server/api/core/bitstreams/e992081c-6d92-4511-b091-ce2059820ae7/content"
    ASHRAE_170 = "https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20errata/standards/170_2017_a_20200901.pdf"
    AUS_HFG_D  = "https://healthfacilityguidelines.com.au/sites/default/files/Part%20D%20-%20Infection%20Prevention%20and%20Control%20%28Complete%29.pdf"
    FGI_2022   = "https://fgiguidelines.org/guidelines/2022-fgi-guidelines-for-design-and-construction-now-available/"

    R = [
      # ── Spatial / workflow
      dict(rule_id="SPZ-FLOW", tier="baseline", category="Spatial workflow",
           statement="Design must physically enforce unidirectional Dirty→Clean workflow (poka-yoke).",
           source="RDS 6222 · NHS HBN 00-09",
           source_url=HBN_00_09, source_page=42,
           region="UK", severity_if_violated="high",
           status="current_nhs_baseline"),
      dict(rule_id="SPZ-01", tier="enhanced", category="Spatial workflow",
           statement="Two-room segregation recommended for ICU/ITU/high-acuity (Soiled + Clean Workrooms).",
           source="FGI Guidelines for Design and Construction of Hospitals (2022) §2.1-2.8.8.4/5",
           source_url=FGI_2022, source_page=None,
           region="USA", severity_if_violated="medium", status="international_comparator"),
      dict(rule_id="SPZ-02", tier="enhanced", category="Spatial workflow",
           statement="Single-room configuration: 1200–1500mm minimum separation between soiled and clean zones.",
           source="AusHFG Part D §5.8",
           source_url=AUS_HFG_D, source_page=None,
           region="AU",
           numeric_value=1200, numeric_unit="mm",
           severity_if_violated="medium", status="international_comparator"),
      dict(rule_id="SPZ-TURN", tier="enhanced", category="Spatial workflow",
           statement="Clear 1500mm turning circle in dirty zone for bariatric commode maneuvering.",
           source="Perkins&Will BEIPI principles",
           source_url=None, source_page=None,
           numeric_value=1500, numeric_unit="mm",
           severity_if_violated="medium", status="international_comparator", region="INT"),
      dict(rule_id="SPZ-03", tier="enhanced", category="Spatial workflow",
           statement="Pass-through hatch at 900–1000mm counter height; mechanically interlocked doors for ICU.",
           source="Perkins&Will · FGI ICU addendum",
           source_url=FGI_2022, source_page=None,
           numeric_value=950, numeric_unit="mm",
           severity_if_violated="medium", status="international_comparator", region="INT"),
      dict(rule_id="ZONE-OVERLAP", tier="v2", category="Spatial workflow",
           statement="V.2.0: zones must occupy distinct footprints — no overlap in plan.",
           source="V.2.0 spatial integrity rule",
           source_url=None, source_page=None,
           severity_if_violated="high",
           status="current_nhs_baseline", region="INT"),

      # ── Ventilation
      dict(rule_id="VENT-01", tier="baseline", category="Ventilation",
           statement="Minimum 6 ACH extract-only; negative pressure relative to corridor.",
           source="RDS 6222 · NHS HTM 04-01",
           source_url=HTM_04_01, source_page=60,
           numeric_value=6, numeric_unit="ACH",
           severity_if_violated="high", status="current_nhs_baseline", region="UK"),
      dict(rule_id="VENT-02", tier="enhanced", category="Ventilation",
           statement="ASHRAE 170: 10 ACH total, continuous negative pressure, zero recirculation, direct outdoor exhaust.",
           source="ANSI/ASHRAE/ASHE Standard 170-2021, Table 7.1",
           source_url=ASHRAE_170, source_page=None,
           numeric_value=10, numeric_unit="ACH",
           severity_if_violated="medium", status="international_comparator", region="USA"),

      # ── Plumbing
      dict(rule_id="PLUMB-01", tier="baseline", category="Plumbing & bioburden",
           statement="Clinical wash-hand basin: sensor-operated hands-free tap, TMV to 41°C, no plug/overflow, rear-offset drain.",
           source="RDS 6222 · NHS HTM 04-01",
           source_url=HTM_04_01, source_page=54,
           severity_if_violated="high",
           status="current_nhs_baseline", region="UK"),
      dict(rule_id="PLUMB-05", tier="v2", category="Plumbing & bioburden",
           statement="Hand-wash basin located remote from macerator (>1.0m) to avoid aerosol/splash cross-contamination.",
           source="WHO WASH FIT 2022",
           source_url=WHO_WASH, source_page=45,
           numeric_value=1.0, numeric_unit="m",
           severity_if_violated="medium", status="international_comparator", region="INT"),
      dict(rule_id="PLUMB-CONFLICT-01", tier="context", category="Plumbing & bioburden",
           statement="Dedicated slop hopper vs macerator-only: RDS 6222 uses macerator-only (ensuite WC upstream); P&W generic guidance recommends dedicated sluice sink. Human decision required.",
           source="RDS 6222 vs Perkins&Will note",
           source_url=None, source_page=None,
           severity_if_violated="medium", status="under_review", region="UK"),

      # ── Materials
      dict(rule_id="FIN-01", tier="enhanced", category="Materiality & finishes",
           statement="Welded PVC/FRP cladding behind sinks and macerators (baseline permits paint alone).",
           source="CDC Environmental Infection Control Guidelines (2003/2019) Part II §G/H",
           source_url=CDC_ENV, source_page=140,
           severity_if_violated="medium", status="international_comparator", region="USA"),
      dict(rule_id="FIN-02", tier="enhanced", category="Materiality & finishes",
           statement="Thermoformed coved skirting ≥ 150mm; heavy-duty PU-coated sheet vinyl with thermowelded seams.",
           source="Perkins&Will · CDC guidelines",
           source_url=CDC_ENV, source_page=142,
           numeric_value=150, numeric_unit="mm",
           severity_if_violated="medium", status="international_comparator", region="INT"),

      # ── Electrical / Lighting
      dict(rule_id="ELEC-01", tier="baseline", category="Lighting & electrical safety",
           statement="≥ 300 lux, CRI ≥ 80, IP54 fixtures, standby generator coverage, dedicated macerator isolator.",
           source="RDS 6222 · NHS HBN 11-01",
           source_url=HBN_11_01, source_page=None,
           numeric_value=300, numeric_unit="lux",
           severity_if_violated="high", status="current_nhs_baseline", region="UK"),
      dict(rule_id="ELEC-02", tier="enhanced", category="Lighting & electrical safety",
           statement="500–1000 lux at work surfaces, CRI ≥ 90, IP65 in wet zones for residue detection during cleaning.",
           source="Perkins&Will · CIBSE LG2",
           source_url=None, source_page=None,
           numeric_value=500, numeric_unit="lux",
           severity_if_violated="medium", status="international_comparator", region="INT"),

      # ── Acoustics
      dict(rule_id="ACOU-01", tier="enhanced", category="Acoustics & vibration",
           statement="If sharing partition with a patient room: STC 50+ (macerators run 65–80 dB).",
           source="NHS HTM 08-01",
           source_url=HTM_08_01, source_page=24,
           numeric_value=50, numeric_unit="STC",
           severity_if_violated="medium", status="under_review", region="UK"),

      # ── Doors
      dict(rule_id="DOOR-01", tier="baseline", category="Spatial workflow",
           statement="Hands-free / non-touch door entry required; automatic open via staff card.",
           source="RDS 6222 · NHS HBN 00-03",
           source_url=HBN_00_03, source_page=None,
           severity_if_violated="high", status="current_nhs_baseline", region="UK"),

      # ── Inpatient adjacency
      dict(rule_id="ADJ-01", tier="baseline", category="Spatial workflow",
           statement="Dirty utility should be located within the ward staff base cluster; travel distance from bed spaces ≤ 12 m.",
           source="RDS 6222 · NHS HBN 04-01",
           source_url=HBN_04_01, source_page=None,
           numeric_value=12, numeric_unit="m",
           severity_if_violated="medium", status="current_nhs_baseline", region="UK"),

      # ── V.2.0 collision / geometry
      dict(rule_id="GEOM-BOUNDS", tier="v2", category="Spatial workflow",
           statement="V.2.0: no component may extend outside the room footprint.",
           source="V.2.0 geometry",
           source_url=None, source_page=None,
           severity_if_violated="high", status="current_nhs_baseline", region="INT"),
      dict(rule_id="GEOM-COLLIDE", tier="v2", category="Spatial workflow",
           statement="V.2.0: no two components may occupy the same 3D volume (floor / wall / ceiling aware).",
           source="V.2.0 collision detection",
           source_url=None, source_page=None,
           severity_if_violated="medium", status="current_nhs_baseline", region="INT"),
      dict(rule_id="GEOM-POLY", tier="baseline", category="Spatial workflow",
           statement="Components must lie fully inside the usable room polygon (L / T / U shapes exclude the cutout).",
           source="V.2.0 polygon geometry",
           source_url=None, source_page=None,
           severity_if_violated="high", status="current_nhs_baseline", region="INT"),

      # ── V.2.0 orientation
      dict(rule_id="ORIENT-WALL-MOUNT", tier="v2", category="Spatial workflow",
           statement="Wall-mounted components (dispensers, panels, sockets, shelves) must sit within 5 cm of a wall with their working face pointing into the room.",
           source="HealthcareCanvas orientation model",
           source_url=None, source_page=None,
           severity_if_violated="high", status="current_nhs_baseline", region="INT"),
      dict(rule_id="ORIENT-BACK-WALL", tier="v2", category="Spatial workflow",
           statement="Against-wall components (macerator, worktop, wash basin, commode store, biohazard bin) must be flush against a wall (≤10 cm) and rotated so the working face points into the room.",
           source="HealthcareCanvas orientation model",
           source_url=None, source_page=None,
           severity_if_violated="medium", status="current_nhs_baseline", region="INT"),
      dict(rule_id="ORIENT-ROTATION", tier="v2", category="Spatial workflow",
           statement="Component rotations must be a multiple of 90° (0 / 90 / 180 / 270). Off-axis rotations are treated as author error.",
           source="HealthcareCanvas orientation model",
           source_url=None, source_page=None,
           severity_if_violated="medium", status="current_nhs_baseline", region="INT"),

      # ── Open review items
      dict(rule_id="REVIEW-OPEN", tier="review", category="Spatial workflow",
           statement="Open design items from RDS 6222 P08: slipper-pan decontamination, commode wipe-down flow, ceiling type, CCTV.",
           source="RDS 6222 P08",
           source_url=None, source_page=None,
           severity_if_violated="low", status="under_review", region="UK"),
    ]
    return R
