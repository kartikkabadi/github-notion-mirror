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
  // ponytail: single-file migration runner; no migration framework needed at v1 scale.
  // Ceiling: if migrations grow past a handful, switch to a tracked schema_migrations table.
  const initSql = readFileSync(join(MIGRATIONS_DIR, "001_init.sql"), "utf8");
  database.exec(initSql);
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
