<div align="center">
  <img src="./frontend/logo.svg" alt="Paqq Logo" width="620" />

  # Paqq

  **A playful, self-hostable package tracker fork with USPS + UniUni + UPS + Amazon import support and background polling.**

  Website: **https://doprdele.github.io/paqq/**
</div>

> Paqq is a maintained fork focused on self-hosted tracking with scraper-first carrier support.
>
> "I am a strong defender of vibe coding, because, most likely, vibe coding produces better results than you can."

## What Paqq Adds

- Paqq-first naming and branding across the stack
- **UniUni** support end-to-end
- **YunExpress** support via YunExpress's own tracking backend (no third-party
  API key or quota), with WAF bypass through a real Chromium page
- **USPS + UniUni + UPS scraping** via Playwright/CDP + stealth hardening
- **Source health monitoring**: detects when a carrier source stops working
  (systemic failures, not one-off not-found packages) and surfaces it via
  `GET /api/health/sources`, an Apprise alert, and a frontend banner
- **Upstream auto-sync** workflow that merges upstream, verifies it builds and
  passes tests, then auto-merges the update
- **Amazon order import scraper** with username/password + optional TOTP
- **Asynchronous package add flow**:
  - package is saved immediately
  - modal closes immediately
  - tracking fetch runs in background with loading state
- **Tabbed settings modal**:
  - Notifications tab with Apprise URL management + test-notification action
  - API keys/credentials tab to store carrier credentials in backend settings (instead of env vars)
- **Persistent backend scheduler** for self-hosted mode:
  - watched targets are persisted
  - polling continues until delivery
  - delivered targets stop automatic rechecks
- Fork attribution, notice files, and branding policy for redistribution

## Feature Summary

### Carriers

- Mondial Relay
- Asendia
- Colissimo
- Chronopost
- La Poste
- DHL
- FedEx
- UPS
- USPS
- UniUni
- YunExpress
- Amazon (import flow)

### Tracking UX

- Detailed status/events timeline
- Share/import tracking links
- Dark/light mode
- PWA support
- Local package persistence in browser
- Background fetch + retry for newly added packages

## Architecture

- `frontend/`: static web app (nginx in self-hosted stack)
- `backend/`: API + scheduler
  - Node adapter (`src/node.ts`)
  - Runtime-agnostic fetch adapter (`src/fetch-adapter.ts`) for edge/serverless wrappers
- `usps-scraper/`: Playwright-based scraper service for USPS/UniUni/UPS + Amazon import

## Self-Hosted: Quick Start (Docker Compose)

### Prerequisites

- Docker + Docker Compose

### Start

```bash
git clone https://github.com/doprdele/paqq.git
cd paqq
docker compose up -d --build
```

### Endpoints

- Frontend: `http://localhost:8080`
- Backend API: `http://localhost:8787`
- Scraper service: `http://localhost:8790`

### Default flow in compose

- Frontend calls backend (`/api/*`)
- Backend calls scraper for USPS/UniUni/UPS/Amazon import
- Scheduler runs in backend and persists state to `/app/data/tracking-scheduler-state.json`

## Self-Hosted: Configuration

### Frontend runtime config

- `PAQQ_API_BASE_URL`

### Backend scheduler env

- `PAQQ_TRACKING_SCHEDULER_ENABLED` (default `true`)
- `PAQQ_TRACKING_SCHEDULER_INTERVAL_MS` (default `14400000`)
- `PAQQ_TRACKING_SCHEDULER_RUN_ON_START` (default `true`)
- `PAQQ_TRACKING_SCHEDULER_STATE_FILE` (default `/app/data/tracking-scheduler-state.json`)
- `PAQQ_SETTINGS_FILE` (default `/app/data/paqq-settings.json`)
- `PAQQ_APPRISE_PYTHON_BIN` (default `python3`)
- `PAQQ_APPRISE_TIMEOUT_MS` (default `20000`)

### Source health env

The backend tracks per-source health from scheduler results. A source is marked
`down` only when multiple distinct tracking numbers fail consecutively with no
recent success, so a single bad/not-found package does not trip an alert. When a
source flips to `down` (or recovers) an Apprise notification is sent if
notifications are enabled.

- `PAQQ_SOURCE_HEALTH_ENABLED` (default `true`)
- `PAQQ_SOURCE_HEALTH_MIN_FAILURES` (consecutive failures per tracking number to count as failing, default `3`)
- `PAQQ_SOURCE_HEALTH_MIN_DISTINCT` (distinct failing tracking numbers required for `down`, default `2`)
- `PAQQ_SOURCE_HEALTH_STATE_FILE` (default `/app/data/source-health-state.json`)

### Scraper/Carrier env

- `PAQQ_SCRAPER_STATE_DIR` (persistent browser state directory, default auto-detected)
- `PAQQ_SCRAPER_PERSIST_SESSION_STATE` (default `true`)
- `AMAZON_PERSIST_SESSION_STATE` (carrier override, optional)
- `UPS_PERSIST_SESSION_STATE` (carrier override, optional)
- `USPS_PERSIST_SESSION_STATE` (carrier override, optional)
- `UNIUNI_PERSIST_SESSION_STATE` (carrier override, optional)
- `YUNEXPRESS_PERSIST_SESSION_STATE` (carrier override, optional)

- `USPS_SCRAPER_URL` (backend -> scraper URL, default `http://127.0.0.1:8790`)
- `USPS_SCRAPER_TOKEN` (optional)
- `USPS_SCRAPER_TIMEOUT_MS` (default `300000`)
- `USPS_SCRAPE_MAX_ATTEMPTS` (scraper retries, default `10`)
- `USPS_CDP_WS_ENDPOINT` (optional CDP endpoint)

- `UNIUNI_SCRAPER_URL` (backend -> scraper URL, default `http://127.0.0.1:8790`)
- `UNIUNI_SCRAPER_TOKEN` (optional)
- `UNIUNI_SCRAPER_TIMEOUT_MS` (default `300000`)
- `UNIUNI_SCRAPE_MAX_ATTEMPTS` (scraper retries, default `6`)
- `UNIUNI_CDP_WS_ENDPOINT` (optional CDP endpoint)
- `UNIUNI_TRACKING_KEY` (optional override)

- `UPS_SCRAPER_URL` (backend -> scraper URL, default `http://127.0.0.1:8790`)
- `UPS_SCRAPER_TOKEN` (optional)
- `UPS_SCRAPER_TIMEOUT_MS` (default `300000`)
- `UPS_SCRAPE_MAX_ATTEMPTS` (scraper retries, default `5`)
- `UPS_CDP_WS_ENDPOINT` (optional CDP endpoint)

- `YUNEXPRESS_SCRAPER_URL` (backend -> scraper URL, default `http://127.0.0.1:8790`)
- `YUNEXPRESS_SCRAPER_TOKEN` (optional)
- `YUNEXPRESS_SCRAPER_TIMEOUT_MS` (default `300000`)
- `YUNEXPRESS_SCRAPE_MAX_ATTEMPTS` (scraper retries, default `5`)
- `YUNEXPRESS_CDP_WS_ENDPOINT` (optional CDP endpoint)
- YunExpress data comes from YunExpress's own tracking backend
  (`services.yuntrack.com`). The request is signed and issued from inside a real
  Chromium page to pass the carrier's WAF, so no third-party API key or quota is
  required.

- `AMAZON_SCRAPER_URL` (backend -> scraper URL, default `http://127.0.0.1:8790`)
- `AMAZON_SCRAPER_TOKEN` (optional)
- `AMAZON_SCRAPER_TIMEOUT_MS` (backend timeout, default `300000`)
- `AMAZON_IMPORT_TIMEOUT_MS` (scraper timeout, default `60000`)
- `AMAZON_CDP_WS_ENDPOINT` (optional CDP endpoint)
- Amazon session cookies/local storage are persisted by default so authenticated
  sessions can be reused longer between imports.

## Self-Hosted: Local Configuration / OrbStack

Paqq is deployable through the companion `local-configuration` stack behind shared Traefik + OIDC.

From your `local-configuration` repo:

```bash
just paqq-shared-traefik-orbstack
```

Current defaults in that stack are already aligned to Paqq:

- repo: `https://github.com/doprdele/paqq.git`
- host: `paqq.orb.local`
- API base URL: `https://paqq.orb.local`

## Local Development (Non-Docker)

- Backend + frontend checks use **Bun**.
- Scraper currently uses **Node.js + npm**.

### Backend

```bash
cd backend
bun install
bun run start:node
```

### Fetch-Compatible Edge Wrapper

For fetch-compatible edge/serverless runtimes, wrap backend with the runtime-agnostic adapter:

```ts
import { createFetchRuntimeAdapter } from "./dist/fetch-adapter.js";

const app = createFetchRuntimeAdapter(process.env as Record<string, string | undefined>);
export default app;
```

### Scraper

```bash
cd usps-scraper
npm install
npm run start
```

### Frontend

Serve `frontend/` with any static server and point runtime config at your backend.

For frontend static checks:

```bash
cd frontend
bun install
bun run test
```

## Tests

### Backend tests

```bash
cd backend
bun run test
bun run test:integration
bun run test:live:uniuni
bun run test:live:ups
```

### Scraper tests

```bash
cd usps-scraper
npm test
npm run test:live
npm run test:live:ups
npm run test:live:uniuni
npm run test:live:all
```

## GitHub CI / Releases

- CI workflow: `.github/workflows/ci.yml`
  - Runs on pull requests and pushes to `main`
  - Executes Bun-based backend build/tests, Node/npm-based scraper build/tests, and Bun-based frontend static checks

- Release workflow: `.github/workflows/release-calver.yml`
  - Runs after successful `CI` on `main` pushes
  - Uses date-based CalVer (`YYYY.M.D`, with `-rN` when multiple releases happen the same day)
  - Automatically updates package versions in:
    - `backend/package.json`
    - `frontend/package.json`
    - `usps-scraper/package.json` + `usps-scraper/package-lock.json`
  - Commits the version update, tags (`v<version>`), and publishes a GitHub Release

- Upstream sync workflow: `.github/workflows/upstream-sync.yml`
  - Runs on a daily schedule and via manual dispatch
  - Merges the upstream repo's default branch, then runs the backend, scraper,
    and frontend build/test suites against the merged tree
  - If everything passes it opens a PR and merges it automatically; on merge
    conflicts or failing checks it leaves the PR open for manual review
  - Optional secret `UPSTREAM_SYNC_TOKEN` (a PAT with `repo` + `workflow`
    scope). Without it the default `GITHUB_TOKEN` is used, which cannot push
    changes to files under `.github/workflows/`; set the secret if upstream
    modifies workflow files.

## API

### `GET /api/list`

Returns supported carriers and required fields.

### `GET /api/get?source=<carrier>&trackingNumber=<id>`

Returns normalized tracking payload:

- `trackingNumber`
- `trackingUrl`
- `carrier`
- `status { code, description, timestamp, location }`
- `estimatedDelivery`
- `events[]`

### `POST /api/amazon/import`

Imports recent Amazon shipments and invoice artifacts. Supports two-step auth:

- Request 1: `username`, `password`, optional `totpKey`, `maxShipments`, `lookbackDays`, `archiveDelivered`
- If `totpKey` is provided, backend attempts automatic TOTP submission when prompted.
- If `status === "totp_required"`: Request 2 with `challengeId` + `totpCode`

### Scheduler endpoints (Node runtime)

- `GET /api/scheduler/status`
- `GET /api/scheduler/targets`
- `POST /api/scheduler/watch`
- `POST /api/scheduler/unwatch`

### Settings endpoints (Node runtime)

- `GET /api/settings/schema`
- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/settings/notifications/test`

### Source health endpoint (Node runtime)

- `GET /api/health/sources`

Returns `{ sources: [...] }` where each entry is:

- `source`
- `status` (`up` | `degraded` | `down` | `unknown`)
- `watchedCount`, `failingCount`, `healthyCount`
- `lastSuccessAt`, `lastFailureAt`, `lastError`
- `since` (when the current status began)

The frontend polls this endpoint and shows a banner when any source is degraded
or down.

## Fork Attribution

- Original project: [Paylicier/Packt](https://github.com/Paylicier/Packt)
- Fork/project: [doprdele/paqq](https://github.com/doprdele/paqq)
- Maintainer of this fork: Evan Sarmiento

## License and Notices

This fork includes code from Packt by Paylicier, and original notices are preserved.

- Upstream/inherited code: **MPL-2.0** (`LICENSE`)
- Additional distribution in this fork: **AGPL-3.0-or-later** (`LICENSE-AGPL-3.0.txt`) where MPL secondary-license terms allow it
- Attribution/provenance: `NOTICE.md`
- Branding/trademark policy: `TRADEMARKS.md`

---

<div align="center">
  <img src="./frontend/logo.svg" alt="Paqq Logo" width="520" />
  <p><strong>Paqq by Evan Sarmiento</strong></p>
</div>
