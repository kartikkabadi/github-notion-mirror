# Setup — GitHub Notion Mirror v1 (Phase 1)

Phase 1 needs three things: a Notion integration, a GitHub PAT, and a filled `.env`. No webhook server, no tunnel, no GitHub App yet.

## 1. Notion integration

1. Go to https://www.notion.so/my-integrations
2. Click **New integration** (or "Create new integration").
3. Name it `GitHub Mirror`.
4. Type: **Internal** (for your workspace).
5. Capabilities:
   - Read content: **on**
   - Update content: **on**
   - Insert content: **on**
   - User info: not required
6. Save. You'll see an **Internal Integration Secret** — copy it. This is `NOTION_TOKEN`.
7. In Notion, create a new private page titled `GitHub`.
8. Open the page, click the ••• menu (top right) → **Connections** → search `GitHub Mirror` → select.
   - The integration must be connected to the page, or `mirror init` will get a 404.
9. Copy the page URL. The page ID is the 32-char UUID at the end of the URL (or the part after the page title slug). This is `NOTION_ROOT_PAGE_ID`.
   - If the URL is `https://www.notion.so/yourworkspace/GitHub-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`, the ID is `1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d` (dashes optional).

## 2. GitHub PAT (Phase 1)

1. Go to https://github.com/settings/personal-access-tokens/new (fine-grained PAT).
2. Name: `notion-mirror-backfill`.
3. Expiration: pick something reasonable (90 days is fine; you'll rotate).
4. Repository access: **Only select repositories** → pick the repos you want to mirror.
5. Permissions:
   - Repository permissions:
     - **Issues**: Read-only
     - **Pull requests**: Read-only
     - **Metadata**: Read-only (mandatory, auto-selected)
     - Contents: No access (v1 doesn't mirror code)
6. Generate token. Copy it immediately (you won't see it again). This is `GITHUB_TOKEN`.

Phase 2 replaces this PAT with a GitHub App (webhooks + installation-scoped permissions). The PAT is only for backfill.

## 3. Fill `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```bash
NOTION_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_ROOT_PAGE_ID=1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d
NOTION_VERSION=2026-03-11

GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Leave these empty — mirror init fills them:
# NOTION_REPOS_DATA_SOURCE_ID=
# NOTION_WORK_ITEMS_DATA_SOURCE_ID=
```

The rest of `.env.example` has sane defaults; leave them unless you have a reason to change.

## 4. Install + init + backfill

```bash
sfw bun install
bun src/index.ts init
bun src/index.ts backfill --repo yourname/yourrepo
```

`mirror init` will:
- Validate the Notion token by calling `users.me`
- Validate the root page is accessible
- Create a `Repositories` database and a `Work Items` database under the root page
- Persist the data source IDs to SQLite (`.data/mirror.db`)
- Print the database + data source IDs

`mirror backfill --repo owner/name` will:
- Upsert the repo row in `Repositories`
- List issues (open by default; `--include-closed` for all)
- List PRs (open by default)
- For each issue/PR: fetch full details + comments (+ reviews + review comments + files for PRs), project, upsert to Notion

Open Notion. You should see rows in both databases under your `GitHub` page.

## 5. Verify

```bash
bun src/index.ts status
bun src/index.ts doctor
```

`doctor` runs 8 checks: config loads, Notion token valid, root page accessible, data source IDs set, GitHub auth present, GitHub API sample call, SQLite readable, `.env` exists.

## 6. Backfill all repos

```bash
bun src/index.ts backfill
```

This lists all repos your PAT can see (sorted by `updated_at` desc) and mirrors each. Archived repos are skipped by default (toggle with `BACKFILL_INCLUDE_CLOSED` or `--include-closed`).

## 7. Re-run to verify idempotence

```bash
bun src/index.ts backfill --repo yourname/yourrepo
```

Second run should not create duplicate rows. The upsert keys on GitHub `node_id` and skips writes when `source_hash` is unchanged (you'll see `repo unchanged, skipping` / `work item unchanged, skipping` in logs at debug level).

## Phase 2 handoff (do this after Phase 1 is verified)

When you're ready for webhooks + realtime updates:

1. Create a GitHub App (see `docs/SETUP.md` Phase 2 section — to be written in Phase 2 build).
2. Set up a Cloudflare named tunnel (see `docs/TUNNEL.md` — to be written in Phase 2 build).
3. Fill the `GITHUB_APP_*` env vars.
4. Run `mirror serve` (Phase 2 command).

For now, Phase 1 backfill + manual `mirror sync issue|pull` is enough to populate Notion.
