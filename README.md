# github-notion-mirror

Local one-way sync daemon that projects GitHub repositories, issues, and pull requests into Notion databases so any Notion AI model can read them as normal workspace content.

**Source of truth:** GitHub
**Projection / query surface:** Notion
**Integration primitive:** Deterministic TypeScript code (not an LLM agent loop)

## What this is

- Mirrors repos + issues + PRs (metadata + bodies + comments as page sections) into two Notion databases under a root `GitHub` page.
- Idempotent: re-running sync never duplicates pages; edits converge to latest GitHub state.
- SQLite-backed control plane (object map, webhook deliveries, job queue, checkpoints).
- Rate-limited Notion writes (~2 rps, handles 429/529 + Retry-After).
- Stable identity via GitHub `node_id` (survives renames/transfers).

## What this is not (v1)

- No code tree mirror, no CI logs dump.
- No Notion→GitHub writes (one-way only).
- No multi-model review DB automation.
- No hosted workers (local control; portable).

## Architecture

```
GitHub (PAT Phase 1 / App Phase 2)
   |
   +- REST backfill + reconcile
   |
   +- Webhooks (Phase 2) --HTTPS--> Cloudflare Tunnel --> Local Hono :4317
                                                              |
                                                              v
                                                   Worker loop (SQLite queue)
                                                   refetch canonical GitHub object
                                                   project + stable hash
                                                   rate-limited Notion upsert
                                                              |
                                                              v
                                                   Notion root page "GitHub"
                                                   +- Repositories (DB)
                                                   +- Work Items (DB)
```

## Prerequisites

- Bun >= 1.3 (runtime + SQLite + test runner)
- A Notion account with permission to create an internal integration
- A GitHub account with a repo or two to mirror
- (Phase 2) Cloudflare account with `cloudflared` for a named tunnel

## Quick start (Phase 1: backfill only, no webhooks)

1. **Install deps** (Socket Firewall wraps the install per machine policy):
   ```bash
   sfw bun install
   ```
2. **Notion setup** — see `docs/SETUP.md` for click-by-click. You need:
   - An internal integration token → `NOTION_TOKEN`
   - A page shared with the integration → `NOTION_ROOT_PAGE_ID`
3. **GitHub PAT** — fine-grained PAT with Issues + Pull requests read on the repos you want to mirror → `GITHUB_TOKEN`
4. **Copy and fill env**:
   ```bash
   cp .env.example .env
   # edit .env with the three values above
   ```
5. **Init schema + validate**:
   ```bash
   bun src/index.ts init
   ```
   Creates `Repositories` and `Work Items` databases under your root page; persists data source IDs to SQLite.
6. **Backfill one repo**:
   ```bash
   bun src/index.ts backfill --repo owner/name
   ```
7. **Backfill all installation repos**:
   ```bash
   bun src/index.ts backfill
   ```
8. **Check status**:
   ```bash
   bun src/index.ts status
   bun src/index.ts doctor
   ```

## Operations

| Command | What it does |
| --- | --- |
| `mirror init` | Validate env; create/ensure Notion DBs + data sources; persist IDs |
| `mirror backfill [--repo o/r] [--include-closed]` | Full or single-repo backfill |
| `mirror sync issue owner/repo#n` | Manual single-issue sync |
| `mirror sync pull owner/repo#n` | Manual single-PR sync |
| `mirror status` | Repo count, data source IDs, last reconcile, recent errors |
| `mirror doctor` | Health checks: config, Notion token, root page, data sources, GitHub API, SQLite |

Phase 2+ commands (`serve`, `reconcile`) are stubbed; see `docs/AGENT_NOTES.md`.

## Security notes

- `.env`, `*.pem`, `config.toml`, `.data/`, `*.db` are gitignored.
- Notion integration is shared only with the root `GitHub` page (least privilege).
- GitHub PAT is read-only for Phase 1. Phase 2 GitHub App is also read-only.
- Logs redact tokens, secrets, authorization headers (pino redact paths).
- Webhook endpoint (Phase 2) binds `127.0.0.1` only; tunnel is sole ingress; HMAC-SHA256 required.
- Sanitization of issue/PR bodies is minimal in v1 (truncate only). Secret-pattern redaction is a ceiling, not a default.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `doctor` fails: `NOTION_TOKEN: Invalid input` | Copy `.env.example` to `.env` and fill values |
| `init` fails: root page inaccessible | Share the page with the integration (page → ••• → Connect → GitHub Mirror) |
| `backfill` 401 on GitHub | PAT expired or lacks repo scope; regenerate with Issues + Pull requests read |
| Notion 429 / 529 | Worker backs off automatically; reduce `MAX_NOTION_RPS` if sustained |
| Duplicate rows after re-backfill | Should not happen — upsert keys on GitHub `node_id`. Run `mirror doctor`. |
| SQLite locked | Only one `mirror` process should write at a time. WAL mode handles concurrent readers. |

## Phase roadmap

- **Phase 1 (this release):** skeleton, Notion init, backfill, status, doctor, tests.
- **Phase 2:** queue worker, webhook server (Hono), HMAC verify, Cloudflare Tunnel docs, `serve` command.
- **Phase 3:** reconcile loop, startup reconcile, rename/missing hardening, dead-letter visibility.
- **Phase 4 (polish):** launchd examples, label option cache, metrics counters.

Deferred (not in scope): code mirror, AI reviews DB, bidirectional sync, Cloudflare Worker buffer, hosted workers, Discussions/Projects/Actions.

See `docs/AGENT_NOTES.md` for the file-by-file build state and ponytail shortcuts marked.
