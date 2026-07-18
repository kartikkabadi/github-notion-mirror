-- Code sync tables — tracks repo code state + individual file sync status

CREATE TABLE IF NOT EXISTS code_files (
  full_path_key TEXT PRIMARY KEY,           -- owner/repo@ref:path
  repo_node_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  path TEXT NOT NULL,
  ref TEXT NOT NULL,
  blob_sha TEXT,
  content_hash TEXT,
  notion_page_id TEXT,
  size_bytes INTEGER,
  language TEXT,
  sync_status TEXT NOT NULL,                -- synced | skipped | error | too_large | binary | missing
  skip_reason TEXT,
  last_synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_code_files_repo ON code_files(repo_node_id);
CREATE INDEX IF NOT EXISTS idx_code_files_status ON code_files(sync_status);

CREATE TABLE IF NOT EXISTS repo_code_state (
  repo_node_id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  head_sha TEXT,
  tree_sha TEXT,
  ref TEXT,
  last_full_scan_at TEXT,
  file_count INTEGER,
  synced_count INTEGER,
  skipped_count INTEGER,
  sync_status TEXT NOT NULL,                -- idle | syncing | ready | partial | error
  last_error TEXT
);
