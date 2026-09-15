# Smart File Manager

> An agentic file manager that gives users natural-language control over their filesystem — powered by an AI that proposes actions through explicitly defined, permissioned tools.

---

## What Is This Project?

Smart File Manager is a multi-surface desktop and mobile application that lets users manage their files using natural-language instructions. The AI interprets what the user wants to do, but the AI **never** has unrestricted filesystem access. Every action passes through an explicit tool registry, a permission/policy layer, and application services before reaching the filesystem.

**Vision examples:**
- "Find all PDFs from last month."
- "Create a folder called University."
- "Move these files into the Documents folder."
- "Find duplicate files."
- "Rename these files using a consistent naming scheme."
- "Show me the largest files."
- "Read this document and summarize it."
- "Clean up these files."

The core principle: **the application is the authority. The AI is the intelligence. The AI proposes; the application validates and authorizes.**

---

## Architecture Overview

```
User instruction
        ↓
AI Agent
        ↓
Tool Registry   ← explicit, controlled capabilities
        ↓
Permission / Policy   ← authorization layer
        ↓
Application service   ← business logic
        ↓
Filesystem Provider / Backend API   ← domain layer
        ↓
Tauri / Rust   (desktop)   or   Mobile OS   (mobile)
        ↓
Operating System filesystem
```

The AI **never** receives arbitrary shell or filesystem access. It operates exclusively through the tool registry.

---

## Repository Structure

```
BuildThisFeature/
│
├── README.md          ← you are here (project orientation + local setup)
├── AGENTS.md          ← AI agent development guidance
├── CLAUDE.md          ← tooling / environment notes (@AGENTS.md)
├── .mise.toml         ← pinned toolchain: Node 22 + pnpm 10.34.3
│
├── web/               ← React + Vite + Tailwind web app (own package.json + pnpm-lock.yaml)
│   └── src/
│       ├── App.tsx             ← primary application component
│       ├── components/         ← UI views, dialogs, conversation components
│       └── services/           ← backend API client, filesystem providers, session, settings
│
├── desktop/           ← Tauri v2 desktop shell wrapping the web app (Rust + tauri.conf.json)
│   └── src/
│       ├── lib.rs              ← Tauri command wrappers
│       └── fs_service.rs       ← Rust filesystem service (security-sensitive AllowList)
│
└── backend/           ← Hono / Node / TypeScript API (own package.json + pnpm-lock.yaml)
    ├── prisma/                 ← Prisma schema + migrations
    └── src/
        ├── app.ts / index.ts   ← app factory + server bootstrap
        ├── config.ts           ← typed, env-driven configuration
        ├── core/               ← auth middleware, single JSON error envelope
        ├── routes/             ← one module per feature (auth, ai, health)
        ├── services/           ← auth, AI providers/agent, conversations, approvals
        ├── tools/              ← AI tool registry, policy, executors
        └── database/           ← Prisma client + repositories (the ONLY layer that touches the DB)
```

> **There is no root `package.json` or workspace.** `web/`, `backend/`, and `desktop/` are
> three independent pnpm projects with their own dependencies and lockfiles. Install and run
> them separately.

**Mobile collaborators** own `mobile/` (a planned surface, not present in this repository yet)
and must not modify anything else without explicit approval.

---

## Getting Started (Local Setup)

This section is written for someone who has never seen the code. It lists **everything you need**
and the **exact order** to run it, so the project actually starts.

### 0. What runs where

| Surface | Folder | Technology | Talks to |
|---|---|---|---|
| Web app | `web/` | React 19 + Vite + Tailwind CSS v4 | Backend API over HTTP; Tauri when run inside the desktop shell |
| Backend API | `backend/` | Node 22 + Hono + Prisma 7 + PostgreSQL | PostgreSQL; AI providers over HTTPS |
| Desktop app | `desktop/` | Tauri v2 (Rust) wrapping the web app | Local OS filesystem; backend API |

The **backend is the piece everything else depends on**. Start it first.

### 1. Prerequisites

**Required to run the backend + web app:**

| Requirement | Version | Why |
|---|---|---|
| Node.js | 22 (`.mise.toml`) | Runs the backend and the Vite dev server |
| pnpm | 10.x (pinned `10.34.3`) | Package manager for all three projects |
| PostgreSQL | 14+ | The backend's database (Prisma) |
| One AI provider | — | The backend **refuses to start without one** (see step 4) |

**Required only to run the desktop app:**

| Requirement | Version | Why |
|---|---|---|
| Rust + Cargo | >= 1.77.2 (`desktop/Cargo.toml`) | Compiles the Tauri shell |
| Tauri OS prerequisites | — | macOS: Xcode Command Line Tools · Linux: WebKitGTK/`libwebkit2gtk` · Windows: WebView2 |

**Optional:**

- [Ollama](https://ollama.com) installed locally — the only AI provider that needs **no API key**.

**Install the pinned toolchain** (recommended). With [mise](https://mise.jdx.dev):

```sh
mise install          # installs Node 22 + pnpm 10.34.3 from .mise.toml
```

If you do not use mise, install Node 22 and pnpm manually and confirm `node -v` and `pnpm -v`.

### 2. Backend (do this first)

```sh
cd backend
pnpm install
cp .env.example .env      # then edit .env — see the environment table below
```

Create the database, generate the Prisma client, and apply migrations:

```sh
createdb smart_file_manager        # or: psql -c 'CREATE DATABASE smart_file_manager;'
pnpm db:generate                   # generates the Prisma client (REQUIRED, git-ignored)
pnpm db:migrate                    # applies prisma/migrations/* to your database
pnpm dev                           # tsx watch → http://127.0.0.1:4000
```

> **Important:** `pnpm db:generate` must run at least once **before** `pnpm dev`,
> `pnpm typecheck`, or `pnpm build`. The generated Prisma client
> (`backend/src/database/generated/`) is not committed to Git.

**Verify it is up:**

```sh
curl http://127.0.0.1:4000/api/health
```

### 3. Web app

```sh
cd web
pnpm install
cp .env.example .env
pnpm dev            # Vite → http://localhost:5173
```

`VITE_API_BASE_URL` in `web/.env` must point at the backend (default `http://127.0.0.1:4000`).

> Local filesystem features (browsing real files, moving them, etc.) only work **inside the
> desktop shell**. In a plain browser the app still runs, but the local filesystem provider is
> unavailable.

### 4. AI provider (required — the backend will not boot without one)

At startup the backend composes its AI provider chain and **fails loudly** if the configured
provider requires a credential and none is set. The default provider is **Grok**, so leaving
`.env` untouched means the server will **not** start.

**Easiest option — local Ollama, no API key:**

```sh
ollama pull qwen3            # pull any tool-capable model you have space for
```

```ini
# backend/.env
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen3
```

**Or a hosted provider** (put real keys **only** in `backend/.env` — never commit them):

```ini
# backend/.env
AI_PROVIDER=grok
GROK_API_KEY=your-key-here
# GROK_MODEL defaults to grok-3
```

Other supported providers: `groq`, `gemini`, `openrouter` (each needs its key, and
`openrouter` also needs `OPENROUTER_MODEL`). Use `AI_PROVIDER_FALLBACK` (comma-separated) to set
the order tried on a rotation-eligible failure. See `backend/.env.example` for every variable.

### 5. Desktop app (optional — not needed for the backend or web app)

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS first,
then:

```sh
cd desktop
pnpm install
pnpm dev            # tauri dev: compiles Rust, starts the web dev server on :5174
```

The desktop shell loads the **same** `web/` app: `desktop/tauri.conf.json` points `frontendDist`
at `../web/dist` and its dev URL at `http://localhost:5174`.

### Ports

| Port | Used by |
|---|---|
| `4000` | Backend API (`backend/.env` `PORT`) |
| `5173` | Web dev server (standalone) |
| `5174` | Web dev server when launched by Tauri (`desktop/tauri.conf.json`) |
| `8443` | Figma Make preview server (this environment; already allow-listed in CORS) |
| `11434` | Local Ollama API (only if you use Ollama) |

### Environment variables

**Backend** — copy `backend/.env.example` to `backend/.env`. Full annotated list lives there;
the essentials are:

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | — | ✅ | PostgreSQL connection string (Prisma + runtime) |
| `AI_PROVIDER` | `grok` | ✅* | Primary AI provider id (`grok`/`groq`/`gemini`/`openrouter`/`ollama`) |
| `AI_PROVIDER_FALLBACK` | `AI_PROVIDER` | — | Comma-separated order tried on failure |
| `GROK_API_KEY` | — | if Grok used | xAI credential |
| `GROQ_API_KEY` | — | if Groq used | Groq credential |
| `GEMINI_API_KEY` | — | if Gemini used | Google AI credential |
| `OPENROUTER_API_KEY` | — | if OpenRouter used | OpenRouter credential |
| `OPENROUTER_MODEL` | — | if OpenRouter used | Model slug (e.g. `anthropic/claude-sonnet-4`) |
| `OLLAMA_MODEL` | — | if Ollama used | Local model name (e.g. `qwen3`) |
| `PORT` | `4000` | — | HTTP port |
| `HOST` | `127.0.0.1` | — | Bind address (loopback only by default) |
| `CORS_ORIGINS` | local dev + Tauri origins | — | Comma-separated allowed browser origins |
| `SESSION_TTL_HOURS` | `12` | — | Auth session lifetime |
| `PROVIDER_COOLDOWN_MS` | `5000` | — | Cooldown after a provider credential fails |

\* At least one usable provider must be configured, or startup fails.

**Web** — copy `web/.env.example` to `web/.env`:

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `http://127.0.0.1:4000` | Backend API base URL |
| `VITE_DEV_PORT` | `5173` | Vite dev-server port (Tauri overrides to `5174`) |

> `VITE_*` values are embedded into the browser bundle at build time and are **public by nature**.
> Never put secrets in `web/.env`.

### Commands per project

There is no root script runner — run these inside the relevant folder.

| Command | `backend/` | `web/` | `desktop/` |
|---|---|---|---|
| `pnpm install` | ✅ | ✅ | ✅ |
| `pnpm dev` | ✅ API on `:4000` | ✅ Vite on `:5173` | ✅ `tauri dev` |
| `pnpm test` | ✅ Vitest | ✅ Vitest | — |
| `pnpm typecheck` | ✅ `tsc --noEmit` | ✅ `tsc --noEmit` | `cargo check` |
| `pnpm build` | ✅ `tsc` → `dist/` | ✅ `vite build` → `dist/` | ✅ `tauri build` |
| `pnpm start` | ✅ `node dist/index.js` | — | — |
| `pnpm format` | — | ✅ `oxfmt` | — |
| Prisma | `pnpm db:generate` / `db:validate` / `db:migrate` / `db:studio` | — | — |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `DATABASE_URL is not configured` | Copy `backend/.env.example` to `backend/.env` and set `DATABASE_URL` |
| Cannot find module `.../generated/prisma/client` | Run `pnpm db:generate` in `backend/` |
| Backend exits with `provider-composition/missing-credentials` | Configure a provider (step 4) |
| Web app cannot reach the backend | Ensure the backend runs on `http://127.0.0.1:4000`; if you use another port, add it to `CORS_ORIGINS` |
| Prisma migrate cannot connect | Make sure PostgreSQL is running and `DATABASE_URL` is correct, then re-run `pnpm db:migrate` |
| `tauri dev` / `tauri build` fails | Install Rust and the [Tauri OS prerequisites](https://v2.tauri.app/start/prerequisites/) |

---

## Security Model

### Desktop Filesystem

The desktop uses an **AllowList security boundary**:

```
Filesystem request
        ↓
Canonicalize path
        ↓
AllowList authorization   ← authoritative gate
        ↓
Filesystem operation
```

The `AllowList` is the only filesystem authorization mechanism. It is implemented in `desktop/src/fs_service.rs` and has been developed across multiple tested phases (8.1–8.10). **Do not casually modify it.**

### Never Do These Things

- ❌ Introduce arbitrary shell execution (`rm -rf`, `mv`, `cp`, `find`, `bash`, `sh`)
- ❌ Bypass the AllowList for convenience
- ❌ Weaken existing security boundaries
- ❌ Give the AI unrestricted filesystem access
- ❌ Disable or delete existing security tests
- ❌ Put API keys or secrets in source code or Git

### Mobile Sandbox

Mobile platforms have their own sandboxing, storage APIs, and permissions. The mobile implementation must respect the target platform's security model. Do not create fake unrestricted filesystem access to imitate desktop behavior.

---

## Backend

The backend is a separate system responsible for:

- Authentication (registration, login, sessions, logout)
- User management
- Cloud metadata and file metadata
- Persistent AI conversations
- File versioning
- Synchronization (future)
- Cloud storage integration (future)

**The backend must not assume it has direct access to the user's local filesystem.** The local filesystem belongs to the user's device. The mobile app communicates with the backend through API contracts.

### Database

PostgreSQL + Prisma is used for relational metadata. **Do not store large binary file contents directly in relational tables.**

Expected pattern:
```
PostgreSQL  →  metadata / relationships / state
Object storage  →  large binaries / AI artifacts / future cloud files
```

Do not create arbitrary database tables without project-owner approval.

---

## AI Architecture

The AI layer is **provider-independent**. Potential providers include OpenAI, xAI/Grok, Google Gemini, Anthropic, OpenRouter, Ollama, and others. The application must not become permanently coupled to one provider.

### AI Tool Registry

The project is entering the Tool Registry stage. Intended tools:

| Tool | Description |
|---|---|
| `list_directory` | List contents of a directory |
| `search_files` | Recursively search by filename substring |
| `get_file_metadata` | Read metadata without touching contents |
| `read_file` | Read raw file bytes |
| `create_file` | Create an empty file |
| `create_folder` | Create a directory |
| `write_file` | Write content to a file |
| `copy_item` | Copy a file or directory recursively |
| `move_item` | Move an item to a destination directory |
| `rename_item` | Rename an item in place |
| `duplicate_item` | Duplicate an item with collision-safe naming |
| `trash_item` | Move to application-managed trash |
| `restore_item` | Restore from trash to original location |

The AI receives **explicit, validated tool calls**, not direct filesystem access. The application validates and authorizes every action.

---

## Completed Work

### Backend Foundation
- PostgreSQL database + Prisma schema
- Authentication (registration, login, session management, logout)
- Session middleware, `/me` endpoint
- Security-oriented auth behavior

### Desktop Filesystem — Phase 8
Phases 8.1 through 8.10 are complete, tested, and committed:

| Phase | Capability |
|---|---|
| 8.1 | Filesystem service core |
| 8.2 | AllowList security boundary |
| 8.3 | File metadata retrieval |
| 8.4 | Safe copy operation |
| 8.5 | Safe file content reading |
| 8.6 | Safe file content writing |
| 8.7 | Safe recursive file search |
| 8.8 | Safe trash and restore |
| 8.9 | Safe duplicate operation |
| 8.10 | Safe file creation |

These are **already implemented and tested. Do not redo them. Do not rewrite them merely to make the architecture look different.**

---

## Mobile Team Responsibility

### Scope

The mobile team is responsible for the `mobile/` directory. The mobile app should eventually provide a mobile-friendly experience including:

- Authentication screens
- File browser UI (folders, browsing)
- Search interface
- File details / metadata
- Recent files
- Trash management
- Settings / account
- Synchronization state
- AI assistant interface
- Activity / history
- Cloud file access

**Do not assume every feature should be implemented immediately.** Follow the project's incremental development workflow.

### Filesystem on Mobile

A mobile OS is **not equivalent to the desktop filesystem.** Do not copy the Tauri filesystem implementation into mobile. Mobile platforms have their own:

- Storage APIs and document providers
- Sandboxing and permissions
- Application containers
- Platform restrictions

Implement within `mobile/` using the target platform's appropriate APIs. Keep local and cloud state conceptually separate.

### Mobile / Backend Communication

```
Mobile app  →  Backend API  →  Database / cloud services
Mobile app  →  Mobile OS storage APIs  →  local files
```

- **Do not make the backend directly manipulate arbitrary files on the user's phone.**
- **Do not make the mobile client pretend that a backend file is automatically a local file.**
- **Do not introduce a second AI execution architecture** — integrate with the existing tool/API contract instead.

### Mobile / AI Integration

The mobile app is a client. It is **not** the security authority for arbitrary filesystem operations.

- Do not put AI provider API keys in mobile frontend code.
- Do not hard-code provider secrets.
- Do not add API keys to Git.
- AI integration should go through the same tool registry / permission architecture used by other surfaces.

---

## Long-Term Roadmap

```
Phase 8   Filesystem capabilities   ← desktop filesystem done
Phase 9    Tool Registry             ← current focus (desktop + mobile)
Phase 10  AI Agent
Phase 11  AI Conversations
Phase 12  AI Permissions & Safety
Phase 13  Backend / Cloud
Phase 14  Synchronization
Phase 15  Web Application
Phase 16  Full UI / UX 
Phase 17  Production Hardenings
``` 

Mobile is developed alongside the broader product but must integrate with these contracts rather than creating a parallel architecture.

---

## Shared Contracts

If mobile needs changes to API endpoints, authentication behavior, database models, synchronization logic, file metadata schemas, or AI conversation structures, **do not silently modify those systems.**

Instead:
1. Identify the required contract change
2. Document the requirement
3. Discuss it with the project owner
4. Implement only after explicit approval

This prevents multiple teams from modifying shared infrastructure independently and breaking each other's work.

---

## Development Rules

### Development Philosophy

```
Inspect → Understand → Identify the smallest meaningful task →
Implement → Test → Review → Commit → Stop
```

- Do not continuously expand scope.
- One completed feature is better than five partially implemented features.
- Every meaningful checkpoint should have: implementation, tests, validation, focused commit, clean working tree.

### Scope Boundaries

Before modifying any file, ask: **"Is this file part of my assigned work?"**

For the mobile team, the default answer is: `mobile/**`

If a change outside `mobile/` appears necessary:
1. **STOP.**
2. Identify the specific file that needs changing.
3. Explain why it needs changing and what the change would do.
4. Discuss whether an API/contract change is sufficient.
5. Get explicit approval before proceeding.

Do not silently modify shared infrastructure.

### Git Rules

- The `main` branch is protected. Do not bypass branch protection.
- Do not force-push. Do not change GitHub branch protection settings.
- Do not push directly to `main` if the repository workflow requires approval.
- Prefer focused branches for work.
- Commits should be small and logically complete.
- Use descriptive commit messages: `Mobile: add authentication screens`, `Mobile: add file browser shell`, `Mobile: add API client`.
- Do not combine unrelated desktop/backend/mobile changes into one commit.

### No Fake Data

Do not build functionality around fake/mock data and then claim the feature is complete. Mocks may be used temporarily for UI development only when clearly isolated and documented. When implementing real functionality, connect it to the actual API or platform capability.

---

## When You Are Unsure

Do not guess when a decision affects shared architecture. Prefer:

```
document → discuss → approve → implement
```

over:

```
guess → modify shared code → break another team's work
```

---

## CRITICAL: What Mobile Must NOT Touch

| File / Directory | Why |
|---|---|
| `desktop/src/fs_service.rs` | Security-sensitive AllowList implementation; already tested across 10 phases |
| `desktop/src/lib.rs` | Tauri command wrappers; part of desktop filesystem layer |
| `desktop/src/` | All desktop Rust code is off-limits |
| `backend/src/auth/` | Authentication is shared; changes require approval |
| `backend/src/db/` | Prisma schema changes require project-owner approval |
| `backend/src/routes/` | Shared API contracts; changes require approval |
| `web/src/` | Web application; not mobile's responsibility |
| `AGENTS.md` | Project-wide AI development guidance; not mobile-specific |

---

## README Maintenance

This README is the project's orientation document. Update it when major architectural decisions or project-wide development rules change. Do not turn it into a daily task log. Detailed implementation notes belong in appropriate project documentation or commit history.

