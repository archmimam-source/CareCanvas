# CareCanvas

Healthcare co-design platform by Perkins&Will. Architects and infection-prevention leads edit a room together while the system checks it against NHS baselines and international comparators. Pilot module: Dirty Utility Rooms.

Product scope and architecture: [`docs/PRD.md`](docs/PRD.md).

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, CRACO, Tailwind, shadcn/ui, Three.js (react-three-fiber) |
| Backend | FastAPI, Motor (MongoDB), WebSockets for live presence |
| AI | Google Gemini via the `google-genai` SDK (`backend/llm.py`) |
| Files | Stored in MongoDB (GridFS), cached on local disk under `DATA_DIR` (`backend/object_storage.py`) |
| Hosting | Render free tier (API + static site) and MongoDB Atlas free tier, defined in `render.yaml` |

## Run locally

Prerequisites: Python 3.13, Node 22, Yarn 1, and MongoDB on `localhost:27017`.

```bash
# Backend
cd backend
cp .env.example .env            # set JWT_SECRET, SIGNING_SECRET, GEMINI_API_KEY
pip install -r requirements.txt
uvicorn server:app --reload --port 8001

# Frontend (second terminal)
cd frontend
cp .env.example .env
yarn install
yarn start                      # http://localhost:3000
```

The first start seeds components, rules, the bundled Revit families and demo accounts (`architect@his.dev` / `demo1234`; admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

## Deploy to Render

1. Create a MongoDB Atlas cluster and copy its connection string. Under Network Access, add the API service's outbound IP addresses (shown in its Render dashboard), or `0.0.0.0/0` to start.
2. Get a Gemini API key at https://aistudio.google.com/apikey.
3. In Render: **New → Blueprint**, select this repo. Render reads `render.yaml` and creates two services:
   - `carecanvas-api`: FastAPI backend (free instance)
   - `carecanvas`: static frontend (free)
4. Fill in the prompted values: `MONGO_URL`, `GEMINI_API_KEY`, `ADMIN_EMAIL`, `PUBLISH_APPROVER_EMAILS`, `SIGNING_SECRET`. Leave `CORS_ORIGINS` and `REACT_APP_BACKEND_URL` blank for now.
5. After the first deploy, copy each service's URL from its dashboard page and set:
   - `CORS_ORIGINS` on `carecanvas-api` = the frontend URL
   - `REACT_APP_BACKEND_URL` on `carecanvas` = the API URL

   Then redeploy both (the frontend bakes the API URL in at build time).

### Free-tier behaviour

- The API sleeps after about 15 minutes without traffic; the next visit wakes it, which can take up to a minute.
- Free instances have no persistent disk, so uploaded files are stored in MongoDB and re-cached locally after each restart.
- Atlas's free cluster holds 512 MB, shared by data and uploaded files. Large IFC/Revit uploads use it fastest; upgrade the cluster if it fills.

## Configuration

Backend (`backend/.env` locally, Render dashboard in production):

| Variable | Purpose |
|---|---|
| `MONGO_URL`, `DB_NAME` | MongoDB connection |
| `JWT_SECRET` | Signs login tokens |
| `SIGNING_SECRET` | HMAC key for report e-signatures; changing it invalidates existing signatures |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Admin account created on first start |
| `PUBLISH_APPROVER_EMAILS` | Comma-separated emails allowed to approve publishing |
| `GEMINI_API_KEY` | Enables AI render, room generation, recommendations, chat, auto-fix and PDF rule extraction |
| `GEMINI_MODEL_TEXT`, `_FAST`, `_PDF`, `_IMAGE` | Optional model overrides (defaults in `backend/llm.py`) |
| `DATA_DIR` | Local cache folder for uploaded files (default `<repo>/uploads`); durable copies live in MongoDB |

Frontend: `REACT_APP_BACKEND_URL`, the API base URL without a trailing slash.

## Tests

The backend suite runs against a live API:

```bash
cd backend
REACT_APP_BACKEND_URL=http://localhost:8001 pytest tests
```
