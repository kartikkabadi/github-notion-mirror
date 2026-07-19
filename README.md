# github-notion-mirror

Local one-way sync daemon that mirrors GitHub repositories, issues, pull requests, and code files into Notion databases so any Notion AI model can read them as normal workspace content.

**Source of truth:** GitHub
**Projection / query surface:** Notion
**Integration primitive:** Deterministic TypeScript code (not an LLM agent loop)

## Why

If you use Devin Cloud or other AI coding tools with limited model access, but you have unlimited AI access in Notion (Claude, GPT, Grok, open-weight models), this lets you point any of those models at your actual code, PRs, and issues without API token costs.

Ask 5 models the same question about a PR, cross-reference their answers, find bugs that one model catches but another misses. Notion AI is a flat subscription; this turns it into a multi-model code review and analysis engine.

## What this does

- Mirrors repos, issues, and PRs (metadata + bodies + comments + reviews + diffs) into Notion databases
- Syncs code files from each repo's default branch into a Code Files database (full file content, language-detected, SHA-based incremental)
- Creates GitHub issues from Notion (set Publish State = ready, run `mirror publish`)
- Auto-sync daemon (`mirror serve`) runs every 5 seconds — only syncs repos that actually changed
- Idempotent: re-running sync never duplicates pages; edits converge to latest GitHub state
- SQLite-backed control plane (object map, checkpoints, code file state)
- Rate-limited Notion writes (~2 rps, handles 429/529 + Retry-After)
- Stable identity via GitHub `node_id` (survives renames/transfers)

## Architecture

```
                    GITHUB                          NOTION
                    ======                          =====

  ┌──────────────────────────┐         ┌───────────────────────────────┐
  │  Repos                   │         │  Repositories DB              │
  │  Issues                  │         │  Work Items DB (issues + PRs) │
  │  Pull Requests           │         │  Code Files DB                │
  │  Code files              │         │                               │
  └──────────┬───────────────┘         │  AI access (Claude, GPT,      │
             │   PAT (read+write)      │  Grok, open weights)          │
             ▼                         └───────────────────────────────┘
  ┌──────────────────────────┐
  │  Mirror daemon (Bun)     │
  │                          │
  │  backfill  → one-shot    │
  │  code sync → one-shot    │
  │  publish   → Notion→GH   │
  │  serve     → 5s loop     │
  └──────────┬───────────────┘
             │
             ▼
  ┌──────────────────────────┐
  │  SQLite (.data/mirror.db)│
  │  github_objects          │
  │  code_files              │
  │  repo_code_state         │
  │  repo_checkpoints        │
  └──────────────────────────┘
```

## Prerequisites

- Bun >= 1.3 (runtime + SQLite + test runner)
- A Notion account with permission to create an internal integration
- A GitHub personal access token (fine-grained PAT with repo + issues read/write)

## Quick start

1. **Install deps**:
   ```bash
   bun install
   ```
2. **Notion setup** — see `docs/SETUP.md` for click-by-click. You need:
   - An internal integration token → `NOTION_TOKEN`
   - A page shared with the integration → `NOTION_ROOT_PAGE_ID`
3. **GitHub PAT** — fine-grained PAT with Issues + Pull requests + Contents read on the repos you want to mirror → `GITHUB_TOKEN`
4. **Copy and fill env**:
   ```bash
   cp .env.example .env
   # edit .env with the three values above
   ```
5. **Init schema + validate**:
   ```bash
   bun src/index.ts init
   ```
   Creates `Repositories`, `Work Items`, and `Code Files` databases under your root page.
6. **Backfill repos + issues + PRs**:
   ```bash
   bun src/index.ts backfill --include-closed
   ```
7. **Sync code files**:
   ```bash
   bun src/index.ts code sync --all
   ```
8. **Start auto-sync daemon** (5s interval):
   ```bash
   bun src/index.ts serve
   ```

## Commands

| Command | What it does |
| --- | --- |
| `mirror init` | Validate env; create/ensure Notion DBs; persist IDs |
| `mirror backfill [--repo o/r] [--include-closed]` | Full or single-repo backfill of repos, issues, PRs |
| `mirror sync issue owner/repo#n` | Manual single-issue sync |
| `mirror sync pull owner/repo#n` | Manual single-PR sync (includes full diffs) |
| `mirror code sync [--all \| --repo o/r]` | Sync code files from default branch |
| `mirror code status` | Show code sync state per repo |
| `mirror publish` | Create GitHub issues from Notion (Publish State = ready) |
| `mirror serve` | Start auto-sync reconcile loop (5s interval) |
| `mirror status` | Repo count, data source IDs, recent errors |
| `mirror doctor` | Health checks: config, Notion token, root page, data sources, GitHub API, SQLite |

## Notion → GitHub issue creation

Work Items database has `Origin`, `Publish State`, and `Publish Error` properties:

1. Create a row in Work Items, set Title, Repository relation, and Labels
2. Set `Publish State` = `ready`
3. Run `mirror publish` (or let `mirror serve` handle it)
4. The daemon creates the GitHub issue and writes back: Number, URL, Node ID, State, Origin = notion, Publish State = created

Publish State transitions: `draft` → `ready` → `creating` → `created` (or `error` with error message)

## Code sync

- Syncs text files from each repo's default branch into the Code Files database
- Full file content in the page body (truncated at 100K chars)
- Filtered: no binaries (null-byte detection), no node_modules/dist/build, no images, no lock files
- Capped at 200KB per file, 5000 files per repo
- SHA-based incremental — only re-syncs files whose blob SHA changed
- Content sanitization: strips control chars, zero-width Unicode, HTML comments, replaces triple backticks

## Security notes

- `.env`, `*.pem`, `config.toml`, `.data/`, `*.db` are gitignored
- Notion integration is shared only with the root `GitHub` page (least privilege)
- GitHub PAT scope: read for sync, write for issue creation (if using publish feature)
- Logs redact tokens, secrets, authorization headers (pino redact paths)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `doctor` fails: `NOTION_TOKEN: Invalid input` | Copy `.env.example` to `.env` and fill values |
| `init` fails: root page inaccessible | Share the page with the integration (page → ••• → Connect → your integration) |
| `backfill` 401 on GitHub | PAT expired or lacks repo scope; regenerate with Issues + Pull requests + Contents read |
| Notion 429 / 529 | Worker backs off automatically; reduce `MAX_NOTION_RPS` if sustained |
| Code file sync errors | Binary files are auto-skipped; content is sanitized for Notion's parser |
| PR sync 413 / too large | PR has very large diffs exceeding Notion's async markdown limit; metadata + comments still sync |

## Tech stack

- **Runtime:** Bun (TypeScript, SQLite, test runner)
- **GitHub:** Octokit REST API
- **Notion:** @notionhq/client (databases, pages, async markdown)
- **Config:** Zod schema validation
- **Tests:** Vitest (37 tests)

See `docs/AGENT_NOTES.md` for the file-by-file build state and ponytail shortcuts marked.
