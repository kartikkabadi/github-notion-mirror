import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "../logging.ts";

const DB_PATH = resolve(process.cwd(), ".data/mirror.db");
const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  runMigrations(db);
  logger.info({ path: DB_PATH }, "sqlite ready");
  return db;
}

function runMigrations(database: Database): void {
  // ponytail: sequential migration runner. Ceiling: tracked schema_migrations table if count grows.
  const files = ["001_init.sql", "002_code_sync.sql"];
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    database.exec(sql);
  }
}

export type GithubObjectRow = {
  github_node_id: string;
  object_type: "repository" | "issue" | "pull_request";
  repo_node_id: string | null;
  repo_full_name: string | null;
  number: number | null;
  github_updated_at: string | null;
  source_hash: string;
  body_hash: string | null;
  mapper_version: number;
  notion_page_id: string | null;
  last_synced_at: string | null;
  last_checked_at: string | null;
  sync_status: "synced" | "error" | "missing" | "pending";
  last_error: string | null;
};

const upsertObjectStmt = (db: Database) => db.prepare(`
  INSERT INTO github_objects
    (github_node_id, object_type, repo_node_id, repo_full_name, number,
     github_updated_at, source_hash, body_hash, mapper_version,
     notion_page_id, last_synced_at, last_checked_at, sync_status, last_error)
  VALUES
    (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
  ON CONFLICT(github_node_id) DO UPDATE SET
    object_type=excluded.object_type,
    repo_node_id=excluded.repo_node_id,
    repo_full_name=excluded.repo_full_name,
    number=excluded.number,
    github_updated_at=excluded.github_updated_at,
    source_hash=excluded.source_hash,
    body_hash=excluded.body_hash,
    mapper_version=excluded.mapper_version,
    notion_page_id=COALESCE(excluded.notion_page_id, github_objects.notion_page_id),
    last_synced_at=excluded.last_synced_at,
    last_checked_at=excluded.last_checked_at,
    sync_status=excluded.sync_status,
    last_error=excluded.last_error
`);

export function upsertObject(row: GithubObjectRow): void {
  const database = getDb();
  upsertObjectStmt(database).run(
    row.github_node_id,
    row.object_type,
    row.repo_node_id,
    row.repo_full_name,
    row.number,
    row.github_updated_at,
    row.source_hash,
    row.body_hash,
    row.mapper_version,
    row.notion_page_id,
    row.last_synced_at,
    row.last_checked_at,
    row.sync_status,
    row.last_error,
  );
}

export function getObject(nodeId: string): GithubObjectRow | null {
  return getDb().prepare(`SELECT * FROM github_objects WHERE github_node_id = ?`).get(nodeId) as GithubObjectRow | null;
}

export function touchChecked(nodeId: string, status: "synced" | "missing" = "synced"): void {
  getDb().prepare(`
    UPDATE github_objects SET last_checked_at = ?1, sync_status = ?2 WHERE github_node_id = ?3
  `).run(new Date().toISOString(), status, nodeId);
}

export function setMeta(key: string, value: string): void {
  getDb().prepare(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function listRepos(): GithubObjectRow[] {
  return getDb().prepare(`SELECT * FROM github_objects WHERE object_type = 'repository'`).all() as GithubObjectRow[];
}

export function listErrors(limit = 20): GithubObjectRow[] {
  return getDb().prepare(`SELECT * FROM github_objects WHERE sync_status IN ('error','missing') ORDER BY last_synced_at DESC LIMIT ?`).all(limit) as GithubObjectRow[];
}

export function setRepoCheckpoint(repoNodeId: string, repoFullName: string, field: "issues_updated_watermark" | "prs_updated_watermark", value: string): void {
  getDb().prepare(`
    INSERT INTO repo_checkpoints(repo_node_id, repo_full_name, ${field})
    VALUES(?, ?, ?)
    ON CONFLICT(repo_node_id) DO UPDATE SET ${field}=excluded.${field}
  `).run(repoNodeId, repoFullName, value);
}

export function getRepoCheckpoint(repoNodeId: string): { issues_updated_watermark: string | null; prs_updated_watermark: string | null } | null {
  return getDb().prepare(`SELECT issues_updated_watermark, prs_updated_watermark FROM repo_checkpoints WHERE repo_node_id = ?`).get(repoNodeId) as { issues_updated_watermark: string | null; prs_updated_watermark: string | null } | null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Code files ---

export type CodeFileRow = {
  full_path_key: string;
  repo_node_id: string;
  repo_full_name: string;
  path: string;
  ref: string;
  blob_sha: string | null;
  content_hash: string | null;
  notion_page_id: string | null;
  size_bytes: number | null;
  language: string | null;
  sync_status: "synced" | "skipped" | "error" | "too_large" | "binary" | "missing";
  skip_reason: string | null;
  last_synced_at: string | null;
};

export function upsertCodeFile(row: CodeFileRow): void {
  getDb().prepare(`
    INSERT INTO code_files
      (full_path_key, repo_node_id, repo_full_name, path, ref, blob_sha, content_hash,
       notion_page_id, size_bytes, language, sync_status, skip_reason, last_synced_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    ON CONFLICT(full_path_key) DO UPDATE SET
      blob_sha=excluded.blob_sha,
      content_hash=excluded.content_hash,
      notion_page_id=COALESCE(excluded.notion_page_id, code_files.notion_page_id),
      size_bytes=excluded.size_bytes,
      language=excluded.language,
      sync_status=excluded.sync_status,
      skip_reason=excluded.skip_reason,
      last_synced_at=excluded.last_synced_at
  `).run(
    row.full_path_key, row.repo_node_id, row.repo_full_name, row.path, row.ref,
    row.blob_sha, row.content_hash, row.notion_page_id, row.size_bytes,
    row.language, row.sync_status, row.skip_reason, row.last_synced_at,
  );
}

export function getCodeFile(fullPathKey: string): CodeFileRow | null {
  return getDb().prepare(`SELECT * FROM code_files WHERE full_path_key = ?`).get(fullPathKey) as CodeFileRow | null;
}

export function listCodeFilesByRepo(repoNodeId: string): CodeFileRow[] {
  return getDb().prepare(`SELECT * FROM code_files WHERE repo_node_id = ?`).all(repoNodeId) as CodeFileRow[];
}

export function markCodeFileMissing(fullPathKey: string): void {
  getDb().prepare(`UPDATE code_files SET sync_status='missing', last_synced_at=? WHERE full_path_key=?`)
    .run(new Date().toISOString(), fullPathKey);
}

// --- Repo code state ---

export type RepoCodeStateRow = {
  repo_node_id: string;
  repo_full_name: string;
  head_sha: string | null;
  tree_sha: string | null;
  ref: string | null;
  last_full_scan_at: string | null;
  file_count: number | null;
  synced_count: number | null;
  skipped_count: number | null;
  sync_status: "idle" | "syncing" | "ready" | "partial" | "error";
  last_error: string | null;
};

export function upsertRepoCodeState(row: Partial<RepoCodeStateRow> & { repo_node_id: string; repo_full_name: string }): void {
  getDb().prepare(`
    INSERT INTO repo_code_state
      (repo_node_id, repo_full_name, head_sha, tree_sha, ref, last_full_scan_at,
       file_count, synced_count, skipped_count, sync_status, last_error)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
    ON CONFLICT(repo_node_id) DO UPDATE SET
      repo_full_name=excluded.repo_full_name,
      head_sha=COALESCE(excluded.head_sha, repo_code_state.head_sha),
      tree_sha=COALESCE(excluded.tree_sha, repo_code_state.tree_sha),
      ref=COALESCE(excluded.ref, repo_code_state.ref),
      last_full_scan_at=COALESCE(excluded.last_full_scan_at, repo_code_state.last_full_scan_at),
      file_count=COALESCE(excluded.file_count, repo_code_state.file_count),
      synced_count=COALESCE(excluded.synced_count, repo_code_state.synced_count),
      skipped_count=COALESCE(excluded.skipped_count, repo_code_state.skipped_count),
      sync_status=excluded.sync_status,
      last_error=excluded.last_error
  `).run(
    row.repo_node_id, row.repo_full_name, row.head_sha ?? null, row.tree_sha ?? null,
    row.ref ?? null, row.last_full_scan_at ?? null, row.file_count ?? null,
    row.synced_count ?? null, row.skipped_count ?? null, row.sync_status ?? "idle",
    row.last_error ?? null,
  );
}

export function getRepoCodeState(repoNodeId: string): RepoCodeStateRow | null {
  return getDb().prepare(`SELECT * FROM repo_code_state WHERE repo_node_id = ?`).get(repoNodeId) as RepoCodeStateRow | null;
}
