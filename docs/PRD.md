# CareCanvas · Perkins & Will Healthcare Co-Design Platform — PRD

> **2026-02-09 — Rebrand:** The tool was renamed from **HIS** to
> **CareCanvas**. Wordmark, ToS title, page `<title>`, backend service
> name, PDF author string, and the Quick Tour copy were all migrated.
> "Healthcare Infection Society" (HIS) remains in the landing footer
> as a real-world partner org — the code identifier `HIS` is only kept
> for backwards-compat localStorage keys (`his:tour_seen`,
> `his:tos_accepted_version`) so returning users don't get gated again.

## Problem statement (original)
Full-stack platform for the BEIPI / HIS / Perkins & Will collaboration.
Converts a curated repository of clinical & architectural standards into
(a) a navigable digital twin of a healthcare building
(b) a live co-design space where architects and IPC leads jointly edit a
    room's layout, with the system checking it against NHS baseline and
    international comparators before publishing a polished diagram.
Pilot module: **Dirty Utility Rooms**.

Governing principles: one model, many views · rules are data, not code ·
nothing silently authoritative · the system must learn (ingestion pipeline).

## User personas
- **Architect / Designer** — full edit rights over geometry & placement.
- **IPC Lead / Clinician** — annotates/flags/approves flows and adjacency.
- **Reviewer** — approves/rejects new rules & components; read+comment on rooms.
- **Contributor** — submits new rules/components via ingestion.
- **Admin** — full override.

## Architecture (MVP delivered 2026-02-15)
- **Backend** FastAPI + Motor/MongoDB. Single `server.py` (to be split later).
  Collections: users, hierarchy, rules, components, scenes, changelog,
  ingestion, validations, renders.
- **Auth** JWT (httpOnly cookies), bcrypt, roles gate write actions.
- **Frontend** React 19 + CRACO + Tailwind + shadcn/ui + framer-motion.
  Three.js via @react-three/fiber 9 + @react-three/drei 10.
- **Validation engine** decoupled service consuming scene + rules; returns
  flags with rule_id, severity, message, source citation.

## What's been implemented (2026-02-15)
- [x] Auth (register/login/logout/me/refresh) with role-based gating.
- [x] Hierarchy tree (Estate → Building → Zone → Ward → Room → Utility)
      with breadcrumb navigation and click-to-zoom.
- [x] Rules table seeded with 13 NHS baseline / under-review / ASHRAE
      comparator rows covering all 6 categories from §5.3.
- [x] Component library seeded with 15 dirty-utility components.
- [x] Scene graph + change-log (append-only event log per room).
- [x] Ingestion pipeline: intake form, staged review, publish (no source → 400).
- [x] Low-fi 2D grid plan (SVG) + 3D isometric (react-three-fiber) synchronized
      to same scene graph, zone flood-color convention (clean/transition/dirty).
- [x] Validation engine with 6 categories of checks including missing-required,
      zone-affinity, unidirectional flow, minimum separation, turning circle,
      out-of-bounds.
- [x] High-fidelity render gated on validation pass, versioned per room, with
      "checked against" metadata attached.
- [x] Reference/citation panel (hover tooltip) for every value; NHS vs comparator
      status pills.
- [x] Visual system: Manrope + IBM Plex Sans + JetBrains Mono, functional zone
      palette, glass panels, motion via framer-motion.
- [x] End-to-end tests: 28/28 backend passing, all frontend flows verified.

## Backlog

### P1 (next iteration)
- Split server.py into routes/, models/, seed/, validation_engine.py modules.
- Drive `required` components list from utility-node metadata instead of
  hard-coded set — unlocks new room types with no code changes.
- Role gate PUT /api/rooms/{id}/scene (architect/ipc_lead/admin) and
  POST /api/rooms/{id}/renders.
- Pydantic-validate ingestion payloads at approval time before insert.

### P1 (co-design & realtime)
- Multi-user live cursors / presence indicators on the scene.
- Optimistic conflict resolution via version compare on PUT scene.
- IPC-lead annotation layer (comments attached to items + flow paths).

### P2 (rendering & flows)
- Bring real flow-path routing (A* on grid) for clean/soiled/person/waste vectors.
- Per-flow-type SVG stroke-dasharray convention with legend in render output.
- PDF export of high-fidelity render with citations page.

### P2 (knowledge base)
- Bulk PDF ingestion → candidate rule extraction via Claude Sonnet 4.5.
- Rule diffing / superseded_by traversal UI.
- Region switcher (UK / USA / AU) to show comparator as primary.

### P3 (scale)
- Additional room types (clean utility, isolation, prep, med room) added as
  data through §3 pipeline only.
- Estate-level heatmap of rooms by validation state.
- SSO / SAML for enterprise deployments.

## Next tasks
1. Split server.py into modular files (routes, models, engines).
2. Role-gate scene writes and render publishing.
3. Add live multi-user presence + conflict handling on scene.
4. Extend palette drag-drop with rotate/resize handles.
5. Wire the "under_review" rule flagging into the reference panel more prominently.

