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
├── README.md          ← you are here (project orientation)
├── AGENTS.md          ← AI agent development guidance
├── CLAUDE.md          ← tooling / environment notes
│
├── web/               ← React web application
│
├── desktop/           ← Tauri desktop application
│   └── src/
│       ├── lib.rs            ← Tauri command wrappers
│       └── fs_service.rs     ← Rust filesystem service (security-sensitive)
│
├── backend/           ← Hono / Node / TypeScript backend API
│   └── src/
│       ├── auth/            ← authentication, sessions
│       ├── db/              ← Prisma schema, migrations
│       └── routes/          ← API endpoints
│
└── mobile/           ← mobile application (mobile team owns this)
```

**Mobile collaborators** own `mobile/` and must not modify anything else without explicit approval.

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
Phase 17  Production Hardening
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

