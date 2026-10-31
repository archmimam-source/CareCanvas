# Bundled Revit families (system defaults)

These 27 `.rfa` files and their PNG preview sidecars are the **default
Revit catalogue** for the HIS Dirty Utility pilot. They ship inside the
backend repo so every fresh deployment (including production redeploys)
automatically hydrates them into the `ifc_families` MongoDB collection
on startup — no manual re-upload required.

## How the seed works

- `seed_families.json` — one document per family (the exact record we
  previously stored in `db.ifc_families`). The `path` field is a bare
  filename that is resolved against this directory at load time.
- `*.rfa`  — the original binary Revit families uploaded by the admin
  during the pilot (batches 1–6, 27 items total).
- `*.rfa.preview.png` — the thumbnail extracted from each `.rfa` by
  `rfa_metadata.py` at upload time.

`server.py::seed_bundled_families()` runs during the FastAPI
`startup` event. It:

1. Reads `seed_families.json`.
2. For every entry, upserts the doc into `db.ifc_families` with
   `is_system: True` and a resolved absolute `path` that points either
   to this directory (default) or to `FAMILIES_DIR` (if the user
   re-uploaded the same file, that wins).
3. Existing user-set fields (`elements[*].component_key_suggested`,
   `name`, etc.) are preserved — the seeder never trampoline them,
   only refreshes the `path`.

## Adding more system defaults

1. Upload the `.rfa` via the UI (or `POST /api/families/upload`).
2. Re-run the export helper below to bundle the new file into this
   directory:

   ```bash
   set -a; . /app/backend/.env; set +a
   python3 - <<'PY'
   # (see the export block in the PRD entry dated 2026-02-08 (g))
   PY
   ```

3. Commit the new `.rfa`, `.preview.png` and the updated
   `seed_families.json`. They will now persist across redeploys.

## Guarantees

- `DELETE /api/families/{id}?force=true` **cannot** unlink a system
  family's physical file. The DB row may be removed but the next
  startup will re-insert it from this dir.
- User-uploaded families (uploaded via the running app, not bundled
  here) live in `FAMILIES_DIR` (`/app/uploads/families/`) and follow
  the normal upload / delete rules.
