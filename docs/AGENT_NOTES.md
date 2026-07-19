# Agent notes — build state and decisions

## Phase 1 build state (this release)

Implemented:
- Repo scaffold, package.json, tsconfig, .gitignore, .env.example, config.example.toml
- SQLite migration `001_init.sql` + `src/state/sqlite.ts` wrapper (WAL, CRUD helpers, meta, checkpoints)
- `src/config.ts` (Zod schema, env + optional TOML overlay), `src/logging.ts` (pino with redact), `src/util.ts` (hash/sleep/time/verifySignature/truncate/chunk — consolidated)
- `src/github/auth.ts` (PAT-only), `src/github/loaders.ts` (repo/issue/pull REST loaders + backfill + reconcile listing helpers)
- `src/notion/client.ts` (single global rate-limited queue, 429/529 + Retry-After), `schema.ts` (ensureSchema, ensureOption, findPageByNodeId), `markdown.ts` (issue + PR body templates), `upsert.ts` (idempotent upsert with SQLite map + Notion recovery path)
- `src/projection.ts` (projectRepo, projectIssue, projectPull with stable hashing)
- `src/cli/{init,backfill,status,doctor}.ts` + `src/index.ts` dispatcher
- `tests/hash.test.ts` (stableJson, sha256, verifySignature, truncate), `tests/project-work-item.test.ts` (state mapping, hash stability, markdown content)

Not implemented (Phase 2/3):
- `src/cli/serve.ts`, `src/cli/reconcile.ts` (stubbed in dispatcher with exit-1)
- `src/server.ts` (Hono webhook server)
- `src/queue/{db,worker}.ts` (SQLite-backed job queue + worker loop)
- `src/github/webhooks.ts` (HMAC verify + normalize → targets)
- `src/reconciliation/run.ts` (reconcile loop + startup reconcile)
- `scripts/launchd.plist.example`, `scripts/tunnel.example.yml`
- `docs/TUNNEL.md`, `docs/OPERATIONS.md`

## File consolidations vs spec (ponytail ultra)

The spec listed more granular files. These were consolidated because the per-file content was tiny:

- `src/util/{hash,sleep,time}.ts` → `src/util.ts` (one file, ~50 lines total)
- `src/github/loaders/{repo,issue,pull}.ts` → `src/github/loaders.ts` (one file, REST loaders share paginate helper)
- `src/projection/{repository,workItem}.ts` → `src/projection.ts` (shared property builders)

If any of these grow past ~200 lines, split them per the spec's original layout. The spec's other directories (`notion/`, `cli/`, `state/`) were kept as-is because the concerns are genuinely separable.

## ponytail shortcuts marked in code

Grep for `ponytail:` to find deliberate simplifications with their ceiling and upgrade path:

- `src/state/sqlite.ts`: single-file migration runner (no framework). Ceiling: handful of migrations.
- `src/config.ts`: minimal TOML reader (no dep). Ceiling: nested tables.
- `src/github/auth.ts`: PAT-only. Ceiling: Phase 2 swaps in `@octokit/auth-app`.
- `src/notion/client.ts`: one global queue, no per-resource queues. Ceiling: parallelism by page id.
- `src/notion/schema.ts`: data source IDs persisted to SQLite meta (not auto-editing `.env`). Ceiling: none.
- `src/notion/markdown.ts`: minimal sanitization (truncate only). Ceiling: secret-pattern redaction when code sync lands.
- `src/projection.ts`: `PropVal = Record<string, unknown>` with `as never` at SDK call sites. Ceiling: narrow to SDK's `PropertyValueMap` if Notion rejects a shape.
- `src/projection.ts` (projectPull): review state is `none`/`draft` only (doesn't query review summary API). Ceiling: query `/reviews` summary.
- `src/cli/backfill.ts`: archived repos skipped by default. Ceiling: `include_archived` config flag.

## Notion API shape (2025-09-03+ / 2026-03-11)

This build uses the modern data-source API, NOT the deprecated database-query-only model:

- `notion.databases.create({ parent: { type: "page_id", page_id }, initial_data_source: { properties } })` → returns `{ id, data_sources: [{ id }] }`
- `notion.dataSources.query({ data_source_id, filter, sorts })` for querying rows
- `notion.dataSources.retrieve({ data_source_id })` for schema inspection
- `notion.dataSources.update({ data_source_id, properties })` for adding select/multi_select options
- `notion.pages.create({ parent: { data_source_id }, properties, markdown })` for row creation with markdown body
- `notion.pages.update({ page_id, properties })` for property patches
- `notion.pages.updateMarkdown({ page_id, type: "replace_content", replace_content: { new_str } })` for body replacement
- Relation properties configured with `data_source_id` (not `database_id`)

## Dependency versions (pinned, all >= 7 days old at install time)

- `octokit@5.0.5` (2025-10-31)
- `@notionhq/client@5.23.0` (2026-07-08; skipped 5.23.1/5.23.2 as < 7 days)
- `zod@4.4.3` (2026-05-04)
- `pino@10.3.1` (2026-02-09)
- `vitest@4.1.10` (2026-07-06)
- `typescript@5.9.3` (2025-09-30)
- `@types/bun@1.3.14` (2026-05-13; matches installed Bun 1.3.14)

## Acceptance criteria for Phase 1 (spec §12)

1. Backfill twice → zero duplicate Notion rows. ✓ (upsert keys on `node_id`; hash-skip on unchanged)
2. Issue title/state/body match GitHub. ✓ (projection maps all fields; markdown renders body)
3. PRs show `merged` vs `closed` correctly. ✓ (test `project-work-item.test.ts` covers this)
4. Repo relation populated. ✓ (Work Items `Repository` relation set to repo page id; repo upserted before work items)
5. `.env.example` + SETUP.md complete; no secrets in git. ✓

## Phase 2 starting point

When Phase 2 begins:
1. Add `hono` dep (`sfw bun add hono`).
2. Implement `src/server.ts` (Hono on `127.0.0.1:4317`, `POST /webhooks/github`, `GET /healthz`).
3. Implement `src/github/webhooks.ts` (verifySignature from `src/util.ts`, normalize → targets table per spec §7.4).
4. Implement `src/queue/{db,worker}.ts` (SQLite `sync_jobs` table already in migration; dedupe on `dedupe_key`).
5. Implement `src/cli/serve.ts` (start server + worker + reconcile timer).
6. Swap `src/github/auth.ts` to support `@octokit/auth-app` installation tokens when `GITHUB_APP_ID` is set.
7. Write `docs/TUNNEL.md` + `scripts/tunnel.example.yml`.
8. Add webhook fixture tests under `tests/fixtures/webhooks/`.

The SQLite schema (`sync_jobs`, `webhook_deliveries`) is already in `001_init.sql` from Phase 1, so Phase 2 doesn't need a migration.

## Hardening (star code sync era)

### Single-writer rule

Only one `mirror serve` process should run at a time. A PID lockfile at `.data/serve.lock` enforces this — a second serve will exit immediately with the PID of the running instance. The lockfile is auto-reclaimed if the process is dead.

Bulk `mirror code sync --stars` can run alongside serve (different code path, no lock conflict), but avoid running two bulk code syncs simultaneously.

### Star code sync progress

Bulk star code sync persists progress to SQLite meta:
- `stars_code_total` — total repos to sync
- `stars_code_done` — repos completed
- `stars_code_current` — repo currently syncing
- `stars_code_last_error` — last error if any

View via `mirror status`, `mirror code status`, or `mirror dashboard`.

Starred repos are sorted by file count ascending (smaller repos first) so one huge star doesn't block hundreds.

### File-cap honesty

Repos hitting `CODE_MAX_FILES_PER_REPO` (default 5000) or with truncated Git trees are marked `partial` with `last_error: "file cap reached"`, not `ready`. This distinguishes "fully synced" from "synced up to the cap."

### Source property backfill

`mirror repair repo-sources` reads `repo_source` from SQLite and writes the `Source` property to Notion repo pages. Run once after upgrading to the version that added the Source property.
