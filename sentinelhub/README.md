# SentinelHub — Distributed VMS & Unified Command Platform

A working reference implementation of the architecture: a **.NET 9** backend on **PostgreSQL + PostGIS + TimescaleDB**, and a **React 19** dark-mode command-center console. It lives in this folder and is independent of the DeskCharm app in the repo root.

```
sentinelhub/
├── db/init/            001 schema · 002 demo seed · 003 TimescaleDB hypertables (Timescale servers only)
├── backend/            .NET 9: Sentinel.Core (RBAC engine) · Sentinel.Api (REST + SignalR) · tests
├── frontend/           React 19 + Vite + MapLibre + zustand (runs standalone on a built-in simulator)
└── docker-compose.yml  Postgres (PostGIS + Timescale) + API
```

## Run it

**Frontend only (no backend needed)** — uses an in-browser simulator with the same RBAC rules and data shapes:

```bash
cd frontend && npm install && npm run dev      # http://localhost:5173
```

**Full stack**

```bash
docker compose up --build                      # db on :5432, API on :8080
cd frontend && npm install && VITE_API_URL=/ npm run dev
```

Without Docker: create a PostgreSQL 15+ database with PostGIS, run `db/init/001_schema.sql` and `002_seed.sql` (and `003_timescale.sql` if TimescaleDB is installed), then `dotnet run --project backend/src/Sentinel.Api`.

Demo users (password `Sentinel!2026`, MFA code `246810`): `admin`, `agencyadmin`, `siteadmin`, `supervisor`, `operator`, `investigator`, `exec`, `auditor`. Sign in as `operator` and note camera `PORTGATE-cam007` is missing everywhere: a device-level **deny** overrides the inherited site grant.

## What is implemented

| Area | Implementation |
|---|---|
| RBAC | `Sentinel.Core/Rbac/PolicyEngine.cs`: grants on an `ltree` resource tree, inheritance, deny-overrides, expiry, MFA step-up. Grants and the role→permission matrix live in PostgreSQL (`iam.*`). The engine also yields an allow/deny **scope** that is pushed into SQL (`node_path <@ ANY(...)`), so lists, GeoJSON and map tiles are filtered row by row. |
| API | Minimal APIs + JWT: auth, RBAC console/simulator, sites, health, devices, ZTP certificate issue (CSR → X.509, dev CA), firmware campaigns, events/ack, GIS (GeoJSON, KNN nearest cameras, FOV containment, `ST_AsMVT` vector tiles), telemetry, per-stream media tokens, hash-chained audit log. |
| Realtime | SignalR hub `/hubs/live`; connections join one group per site they may view, so RBAC is enforced at subscription time. |
| Ingest stand-in | `EdgeSimulator` writes radar tracks, IoT readings and events (geofence breach via `ST_Intersects`, camera offline) as an Edge gateway would. `FirmwareWorker` advances canary → wave 2 → full rollouts. |
| Data | PostGIS geometry (camera FOV polygons, geofences, tracks), TimescaleDB hypertables + compression + retention + 1-minute continuous aggregate (plain-view fallback without Timescale). |
| Frontend | Executive overview, 2×2/3×3/4×4 live wall with alarm follow, MapLibre GIS map (FOV, geofences, tracks + trails, alarm rings, click-to-find nearest cameras), device inventory + firmware campaigns, role × permission matrix, policy-decision simulator, audit log. Glassmorphism on panels only (never over video); `prefers-reduced-transparency/motion` respected. |

## What is deliberately not here yet

| Item | Status |
|---|---|
| Real media path (ONVIF/RTSP ingest, recording, multicast, WebRTC, transcoding) | Video tiles are **simulated canvases**. RBAC is real: `POST /api/streams/{id}/token` issues a 60 s signed token only if `video.live` is allowed. The media plane (GStreamer/FFmpeg workers, multicast origin, NVENC AV1 tiers) is the next build. |
| Federation (Edge ↔ Main), Patroni HA, NATS JetStream store-and-forward | Single database and process here. Schema and services are site-aware (`site_id`, ltree paths) so they can split per Edge. |
| AD / SAML / OIDC | Local PBKDF2 users + a demo MFA code. The JWT/claims layer is where an external IdP plugs in. |
| Production PKI | `DevCa` is an in-memory dev CA. Swap for step-ca / ADCS / Vault PKI with per-Edge sub-CAs. |
| Login throttling, TOTP/WebAuthn, secrets management | Not implemented. Change `Auth:SigningKey` and remove demo accounts before any real deployment. |

## Verification status

| Check | Result |
|---|---|
| `db/init/001` + `002` on PostgreSQL 16 + PostGIS | Applied cleanly. The RBAC scope predicates, MVT tiles, KNN, FOV containment, geofence breach and telemetry queries used by the API were executed against it. |
| `003_timescale.sql` | **Not run** (no TimescaleDB server available when this was written). |
| Frontend `tsc`, `vite build`, vitest (5 RBAC tests) | Pass. All five views exercised in headless Chromium with no console errors. |
| Backend C# (`dotnet build`, xUnit tests, Docker image) | **Not compiled or run**: no .NET SDK was available in the authoring environment. Run `dotnet test backend/Sentinel.slnx` first and expect to fix small compile issues. |
