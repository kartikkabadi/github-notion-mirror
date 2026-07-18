-- GitHub Notion Mirror — control plane schema
-- SQLite WAL, file: .data/mirror.db

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS github_objects (
  github_node_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,              -- repository | issue | pull_request
  repo_node_id TEXT,
  repo_full_name TEXT,
  number INTEGER,
  github_updated_at TEXT,
  source_hash TEXT NOT NULL,
  body_hash TEXT,
  mapper_version INTEGER NOT NULL,
  notion_page_id TEXT,
  last_synced_at TEXT,
  last_checked_at TEXT,
  sync_status TEXT NOT NULL,              -- synced | error | missing | pending
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_objects_repo ON github_objects(repo_node_id);
CREATE INDEX IF NOT EXISTS idx_github_objects_status ON github_objects(sync_status);
CREATE INDEX IF NOT EXISTS idx_github_objects_type ON github_objects(object_type);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  action TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL,                    -- accepted | duplicate | rejected | processed
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,                    -- queued | active | done | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_available ON sync_jobs(status, available_at);

CREATE TABLE IF NOT EXISTS repo_checkpoints (
  repo_node_id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  issues_updated_watermark TEXT,
  prs_updated_watermark TEXT,
  last_full_reconcile_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
