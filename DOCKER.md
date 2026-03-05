# Project Nexus Docker Deployment

## 1) Prepare env files
- Edit `backend/.env` and set real values:
  - `ADMIN_PATH_KEY`
  - `ADMIN_TOKEN_SHA256` (or `ADMIN_TOKEN`)
  - `ADMIN_SESSION_SECRET`
  - `CORS_WHITELIST=http://localhost:38173`
- Edit root `.env` and set:
  - `VITE_ADMIN_PATH_KEY` (must equal backend `ADMIN_PATH_KEY`)
- Ensure runtime data files exist:
  - `backend/nodes.json`
  - `backend/redeem_codes.json` (can start with `[]`)

## 2) Start
```bash
docker compose up -d --build
```

## 3) Access
- Frontend: `http://localhost:38173`
- Admin: `http://localhost:38173/<ADMIN_PATH_KEY>`
- Backend direct (optional): `http://localhost:38081`

## 4) Stop
```bash
docker compose down
```
