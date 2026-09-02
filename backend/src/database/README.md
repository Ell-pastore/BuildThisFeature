# Database layer — boundary (Phase 6)

This directory will contain **all** database access. It is intentionally empty
of code: no client, no ORM, no schema, no migrations exist yet, and none may be
created until the Phase 6 schema is designed and approved.

Planned contents:

- Connection/client wiring — provider and ORM are deliberately undecided
  (PostgreSQL + an ORM is the current direction; chosen in Phase 6)
- Repositories per aggregate: users, files, folders, relationships, sync
  records, versions, stars, tags, activity, search metadata, duplicates,
  AI metadata, permissions
- Migrations — only after the schema is reviewed and approved

Rules for everything that will live here:

1. Only this layer imports the database driver/ORM. Routes and services never do.
2. Binary file contents never go into the relational database — they belong to
   object storage (`src/storage/`); the database stores metadata and keys.
3. Configuration comes from the environment; no credentials in source control.
4. Every query is user-scoped — authorization is enforced before data access.
