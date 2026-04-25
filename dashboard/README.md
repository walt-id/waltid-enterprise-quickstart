# Walt.id Enterprise CLI Dashboard

A web-based dashboard for the [walt.id Enterprise Stack](https://walt.id) CLI tool (`walt.ts`). It lets operators trigger any CLI command from a browser UI and watch output stream in real time, without touching a terminal. Run logs and full HTTP traces from past executions are browsable from the same interface.

---

## Table of Contents

- [Purpose](#purpose)
- [Technical Implementation](#technical-implementation)
  - [Stack](#stack)
  - [Project Structure](#project-structure)
  - [How Command Execution Works](#how-command-execution-works)
  - [How Logs Are Served](#how-logs-are-served)
- [Security Model](#security-model)
  - [Threat Surface](#threat-surface)
  - [Controls Implemented](#controls-implemented)
  - [Residual Risks and Recommendations](#residual-risks-and-recommendations)
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [Environment Variables](#environment-variables)
  - [Running Locally](#running-locally)
  - [Running in Production](#running-in-production)
- [Usage](#usage)
- [API Reference](#api-reference)

---

## Purpose

The CLI tool `cli/walt.ts` is a 2 000-line TypeScript program that orchestrates 40+ commands across the walt.id Enterprise Stack — bootstrapping an organisation, importing cryptographic keys, creating mDL issuance and verification services, and running end-to-end credential flows. Running it from a terminal is fine for a single developer but impractical for a shared team or a hosted test environment.

This dashboard solves that by:

- Providing a point-and-click interface to every CLI command, grouped by category.
- Streaming live terminal output back to the browser as commands run.
- Persisting a non-sensitive configuration (base URL, organisation, tenant, admin email) that is pre-filled on every command run.
- Storing sensitive credentials (passwords, tokens) exclusively in server-side environment variables — they are never sent to the browser.
- Letting anyone on the team browse past execution logs and full HTTP request/response traces without SSH access.

---

## Technical Implementation

### Stack

| Layer | Technology |
|---|---|
| Framework | [Nuxt 3](https://nuxt.com) (SPA mode, `ssr: false`) |
| Server runtime | [Nitro](https://nitro.unjs.io) (bundled with Nuxt) |
| Styling | [Tailwind CSS](https://tailwindcss.com) via `@nuxtjs/tailwindcss` |
| Language | TypeScript throughout |
| Real-time output | [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) |
| CLI runner | Node.js `child_process.spawn` (no shell, no interpolation) |

### Project Structure

```
dashboard/
├── assets/
│   ├── css/tailwind.css        # Global Tailwind base + component classes
│   └── img.png                 # Walt.id logo
│
├── components/
│   ├── AppSidebar.vue          # Navigation + run-status indicator + logout
│   ├── CommandCard.vue         # Single command tile with Run button
│   ├── ConfigPanel.vue         # Non-sensitive config form + env-var status
│   ├── EnvVarRow.vue           # Read-only indicator for a server env var
│   ├── HttpLogEntry.vue        # Expandable request/response accordion
│   └── TerminalOutput.vue      # Real-time colour-coded terminal pane
│
├── composables/
│   ├── useAuth.ts              # Session check, logout, cached auth state
│   ├── useCommandStream.ts     # POST → job token → SSE pipeline (global state)
│   └── useConfig.ts            # Non-sensitive config load/save + toEnv()
│
├── data/
│   └── commands.ts             # All 37 CLI flags, organised into 4 categories
│
├── layouts/
│   └── default.vue             # AppSidebar + <slot> page layout
│
├── middleware/
│   └── auth.global.ts          # Client-side route guard → /login
│
├── pages/
│   ├── index.vue               # Dashboard overview, quick actions, recent logs
│   ├── commands.vue            # Full command panel + live terminal
│   ├── login.vue               # Login form (layout: false)
│   └── logs/
│       ├── index.vue           # List of all walt-log-* run directories
│       └── [dir].vue           # HTTP log timeline + file viewer for one run
│
├── server/
│   ├── middleware/
│   │   ├── 01.security-headers.ts   # Security response headers on every reply
│   │   └── 02.auth.ts               # Session guard for all /api/ routes
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login.post.ts        # Credential validation, session cookie
│   │   │   ├── logout.post.ts       # Session invalidation
│   │   │   └── me.get.ts            # Auth status check
│   │   ├── execute.get.ts           # Tombstone — returns 410 Gone
│   │   ├── execute/
│   │   │   ├── start.post.ts        # Validate cmd, create job token
│   │   │   └── stream.get.ts        # Claim job, spawn process, stream SSE
│   │   ├── config.get.ts            # Non-sensitive config + env-var booleans
│   │   ├── config.post.ts           # Persist non-sensitive config to disk
│   │   └── logs/
│   │       ├── index.get.ts         # List walt-log-* directories
│   │       ├── [dir].get.ts         # List files inside one log directory
│   │       └── [dir]/[file].get.ts  # Serve one JSON log file
│   └── utils/
│       ├── session.ts          # In-memory session store, 24 h TTL
│       ├── jobs.ts             # Single-use job tokens, 30 s TTL
│       └── commands.ts         # Authoritative whitelist of valid CLI flags
│
├── types/index.ts              # Shared TypeScript interfaces
├── nuxt.config.ts
├── tailwind.config.ts
├── .env.example
└── .gitignore
```

### How Command Execution Works

The naive approach — `GET /api/execute?cmd=--recreate&ADMIN_PASSWORD=secret` — puts credentials in URLs which appear in proxy logs, browser history, and `Referer` headers. It was replaced with a two-step job-token flow:

```
Browser                         Nitro server                  walt.ts CLI
  │                                  │                              │
  │  POST /api/execute/start         │                              │
  │  { cmd, env (non-sensitive) } ──►│                              │
  │                                  │  validate cmd against        │
  │                                  │  VALID_COMMAND_FLAGS set     │
  │                                  │  inject credentials from     │
  │                                  │  process.env                 │
  │                                  │  createJob(cmd, safeEnv)     │
  │◄── { jobId: "a3f2..." } ─────────│                              │
  │                                  │                              │
  │  GET /api/execute/stream         │                              │
  │  ?jobId=a3f2...  ───────────────►│                              │
  │                                  │  claimJob(jobId)  ← single-use, 30 s window
  │                                  │  spawn("npx tsx walt.ts", [cmd], {
  │                                  │    shell: false,             │
  │                                  │    env: { ...safeEnv,        │
  │                                  │      ADMIN_PASSWORD: process.env.WALT_ADMIN_PASSWORD,
  │                                  │      ... }                   │
  │                                  │  })                          │
  │                                  │ ────────────────────────────►│
  │◄── SSE: stdout / stderr / exit ──│◄── stdout/stderr/close ──────│
```

Key properties of this design:

- **Credentials never appear in URLs or logs.** The job token in the query string is a random 16-byte hex string with no relationship to the actual command or credentials.
- **Job tokens are single-use.** `claimJob()` deletes the token from the store on first use. A replayed URL gets 404.
- **Job tokens expire in 30 seconds.** If the browser never opens the SSE connection after the POST, the token is automatically discarded.
- **`shell: false`** is passed to `spawn`. Even if a malformed flag somehow reached the process, no shell metacharacter expansion can occur.
- **The env passed to the process is built from a clean base** (`PATH`, `HOME`, `NODE_ENV`), not a copy of the full `process.env`. Only the keys the CLI actually needs are forwarded.

### How Logs Are Served

Each execution of `walt.ts` writes its output to a directory named `walt-log-YYYY-MM-DD-NNN/` inside `cli/`. The dashboard's log APIs point directly at that directory:

- `GET /api/logs` — reads `cli/` and returns every directory matching the naming pattern.
- `GET /api/logs/:dir` — lists files inside one run directory.
- `GET /api/logs/:dir/:file` — serves a single JSON artifact.

All three endpoints validate their path parameters against strict regex patterns before constructing any file path, preventing path-traversal attacks.

---

## Security Model

### Threat Surface

The dashboard is a privileged internal tool: it can spawn arbitrary processes on the host and read secret credentials. The following threats were considered during design:

| Threat | Vector |
|---|---|
| Unauthenticated command execution | Direct HTTP request to `/api/execute/*` |
| Credential leakage via URL | Credentials in query string → proxy/access logs |
| Command injection | Crafted `cmd` value with shell metacharacters |
| Credential leakage via config API | `GET /api/config` returning stored passwords |
| Path traversal in log APIs | `../../etc/passwd` in `:dir` or `:file` params |
| Clickjacking / XSS | Malicious page embedding or injecting into the dashboard |
| Cross-site request forgery | Third-party site triggering commands via the user's session |
| Brute-force login | Automated credential guessing |

### Controls Implemented

**Authentication — session cookies**

Every request to `/api/*` (except `/api/auth/*`) is checked by `server/middleware/02.auth.ts` for a valid `walt-session` cookie. Sessions are random 32-byte hex tokens stored in server memory with a 24-hour TTL. The cookie is set with:

```
HttpOnly; SameSite=Strict; Secure (production); Path=/
```

- `HttpOnly` prevents JavaScript from reading the token — XSS cannot steal it.
- `SameSite=Strict` means the cookie is never sent on cross-origin requests — CSRF is blocked at the browser level.
- `Secure` ensures the cookie is only transmitted over HTTPS in production.

**Brute-force rate limiting**

`login.post.ts` tracks failed attempts per client IP. After 10 failures within 15 minutes the endpoint returns `429 Too Many Requests`. Credential comparison uses Node's `crypto.timingSafeEqual` to prevent timing-based username enumeration.

**Command whitelist**

`server/utils/commands.ts` defines a `Set` of the 37 known valid CLI flags. `start.post.ts` rejects any `cmd` not present in this set before `spawn` is ever called. An attacker cannot pass `--some-unknown-flag` or anything resembling a shell injection payload.

**No credentials in URLs**

The two-step job-token flow (described above) ensures that no password, token, or other sensitive value appears in any URL. Proxy access logs will record only opaque job IDs.

**Credentials server-side only**

`config.get.ts` returns only non-sensitive fields (base URL, organisation, tenant, admin email) plus boolean flags indicating which sensitive env vars are present. Passwords and tokens are never read from the database, never sent over the wire, and never written to `.walt-config.json`. They live exclusively in the server's environment variables.

`config.post.ts` enforces an allowlist of writable keys — any password field submitted in a POST body is silently dropped before the file is written.

**Path traversal prevention**

Log API endpoints validate `:dir` against `/^walt-log-\d{4}-\d{2}-\d{2}-\d{3}$/` and `:file` against `/^[\w.-]+\.json$/` before constructing any filesystem path. Requests outside these patterns receive a `400 Bad Request`.

**Security response headers**

`server/middleware/01.security-headers.ts` adds the following headers to every response:

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `X-XSS-Protection` | `1; mode=block` |
| `Content-Security-Policy` | `default-src 'self'` + narrow allowances for fonts and inline Nuxt hydration scripts |

`X-Frame-Options: DENY` prevents the dashboard from being embedded in an iframe (clickjacking). The CSP blocks loading scripts, styles, or data from any origin not explicitly listed.

### Residual Risks and Recommendations

| Risk | Recommendation |
|---|---|
| In-memory session store is lost on server restart | Replace `server/utils/session.ts` with a Redis-backed store for production |
| `DASHBOARD_PASSWORD` is a shared secret | Add per-user accounts or integrate with an SSO/OAuth provider (e.g. Keycloak) for multi-user deployments |
| Dashboard host can reach the Enterprise Stack directly | Deploy the dashboard inside the same private network/VPN; do not expose it on a public IP |
| Log files may contain sensitive response data | Mount `cli/` on a volume with restricted OS-level permissions; rotate and archive old runs |
| No TLS termination built in | Terminate HTTPS at a reverse proxy (Caddy, nginx) in front of the Nitro server; the existing `Caddyfile` in this repo is a good starting point |

---

## Setup

### Prerequisites

- Node.js 18+
- The `cli/` directory of this repository (dashboard reads logs from `../cli/`)
- `npx` available on the host (used to invoke `tsx walt.ts`)

### Environment Variables

Copy `.env.example` to `.env` and fill in all values before starting the server.

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `DASHBOARD_USER` | No | Dashboard login username. Defaults to `admin`. |
| `DASHBOARD_PASSWORD` | **Yes** | Dashboard login password. No default — server refuses to start login without it. |
| `WALT_ADMIN_PASSWORD` | Recommended | Passed as `ADMIN_PASSWORD` to the CLI. |
| `WALT_SUPERADMIN_EMAIL` | Recommended | Passed as `EMAIL` to the CLI. |
| `WALT_SUPERADMIN_PASSWORD` | Recommended | Passed as `PASSWORD` to the CLI. |
| `WALT_SUPERADMIN_TOKEN` | Recommended | Passed as `SUPERADMIN_TOKEN` to the CLI. |
| `NODE_ENV` | No | Set to `production` to enable the `Secure` flag on session cookies (requires HTTPS). |

The `ConfigPanel` in the UI shows a green/red indicator for each `WALT_*` variable so you can verify server-side credential configuration at a glance without ever seeing the values.

### Running Locally

```bash
cd dashboard
npm install
cp .env.example .env   # then edit .env
npm run dev            # starts on http://localhost:3003
```

### Running in Production

```bash
npm run build
NODE_ENV=production node .output/server/index.mjs
```

Place a TLS-terminating reverse proxy (e.g. Caddy) in front of the Nitro server. Example minimal `Caddyfile` snippet:

```
dashboard.internal {
    reverse_proxy localhost:3003
}
```

The `Secure` cookie flag requires the connection to arrive over HTTPS, which Caddy handles automatically with Let's Encrypt or internal PKI.

---

## Usage

### 1. Sign in

Navigate to the dashboard URL. You will be redirected to `/login`. Enter the credentials you configured in `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.

### 2. Configure the target stack

Open **Command Runner → Configuration** (or any page's config panel). Set:

- **Base URL** — hostname of the Enterprise Stack (e.g. `enterprise.localhost`)
- **Port** — leave blank when using HTTPS/Caddy
- **Organization** / **Tenant** — as configured in your stack
- **Admin Email** — non-superadmin user email

Click **Save**. These values are written to `.walt-config.json` on disk and pre-filled on every subsequent command run. Passwords are configured via environment variables and never editable from the UI.

### 3. Run a command

Go to **Command Runner**. Commands are grouped into four categories:

| Category | Colour | Purpose |
|---|---|---|
| **System** | Red | DB initialisation, superadmin and org creation |
| **Setup** | Blue | Create all services and resources in dependency order |
| **Run** | Green | Execute the mDL issue + verify end-to-end flow |
| **Flows** | Purple | Specialised flows (ETSI trust lists, revocation) |

Click **Run** on any command. Output streams immediately in the terminal pane on the right, colour-coded by log prefix (`[OK]`, `[ERROR]`, `[WARN]`, `[SETUP]`, `[RUN]`, etc.). The sidebar status indicator shows running / success / failed at a glance.

> Commands marked **Destructive** (e.g. `--recreate`) drop and reinitialise the database. Use with care.

### 4. Browse logs

Go to **Run Logs**. Each card represents one execution run, named `walt-log-YYYY-MM-DD-NNN`. Click a card to open the detail view, which has two tabs:

- **HTTP Log** — every HTTP request the CLI made, with method, URL, status code, and expandable request/response JSON bodies. Authorization headers are redacted.
- **Files** — individual `NNN-command-request.json` / `NNN-command-response.json` artifacts from the run, viewable in a modal JSON viewer.

---

## API Reference

All endpoints except `/api/auth/*` require a valid `walt-session` cookie.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Authenticate. Body: `{ username, password }`. Sets `walt-session` cookie. |
| `GET` | `/api/auth/me` | Returns `{ authenticated, user }` or `401`. |
| `POST` | `/api/auth/logout` | Invalidates the current session. |
| `GET` | `/api/config` | Returns non-sensitive config + `envStatus` booleans. |
| `POST` | `/api/config` | Persists non-sensitive config. Only `baseUrl`, `port`, `organization`, `tenant`, `adminEmail` are accepted. |
| `POST` | `/api/execute/start` | Body: `{ cmd, env }`. Validates `cmd` against whitelist. Returns `{ jobId }`. |
| `GET` | `/api/execute/stream?jobId=` | SSE stream. Claims the job token (single-use, 30 s window), spawns `tsx walt.ts <cmd>`, streams `stdout`/`stderr`/`exit` events. |
| `GET` | `/api/logs` | Returns list of `walt-log-*` run directories. |
| `GET` | `/api/logs/:dir` | Returns file list for one run directory. |
| `GET` | `/api/logs/:dir/:file` | Returns parsed JSON content of one log file. |
