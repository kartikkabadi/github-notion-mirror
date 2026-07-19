import type { Client } from "@notionhq/client";
import { getNotion, notionCall } from "./client.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logging.ts";
import { setMeta, getMeta } from "../state/sqlite.ts";

// Data source ID persistence: env var wins, else SQLite meta table.
// ponytail: avoids auto-editing user's .env; init writes to meta, all consumers read via helper.
export type DataSourceKind = "repos" | "work_items" | "code_files";

export function getDataSourceId(kind: DataSourceKind): string {
  const cfg = loadConfig();
  if (kind === "repos") {
    return cfg.NOTION_REPOS_DATA_SOURCE_ID || getMeta("NOTION_REPOS_DATA_SOURCE_ID") || "";
  }
  if (kind === "work_items") {
    return cfg.NOTION_WORK_ITEMS_DATA_SOURCE_ID || getMeta("NOTION_WORK_ITEMS_DATA_SOURCE_ID") || "";
  }
  return getMeta("NOTION_CODE_FILES_DATA_SOURCE_ID") || "";
}

export function requireDataSourceId(kind: DataSourceKind): string {
  const id = getDataSourceId(kind);
  if (!id) throw new Error(`Data source ID for ${kind} not set. Run \`mirror init\` first.`);
  return id;
}

export function persistDataSourceId(kind: DataSourceKind, id: string): void {
  const key = kind === "repos" ? "NOTION_REPOS_DATA_SOURCE_ID"
    : kind === "work_items" ? "NOTION_WORK_ITEMS_DATA_SOURCE_ID"
    : "NOTION_CODE_FILES_DATA_SOURCE_ID";
  setMeta(key, id);
  logger.info({ kind, id }, "data source id persisted");
}

const REPO_PROPERTIES = {
  Name: { title: {} },
  "GitHub Node ID": { rich_text: {} },
  "Full Name": { rich_text: {} },
  "GitHub URL": { url: {} },
  Description: { rich_text: {} },
  Visibility: { select: { options: [{ name: "public" }, { name: "private" }, { name: "internal" }] } },
  "Default Branch": { rich_text: {} },
  "Primary Language": { select: { options: [] } },
  Archived: { checkbox: {} },
  Fork: { checkbox: {} },
  Owner: { rich_text: {} },
  "Pushed At": { date: {} },
  "Updated At": { date: {} },
  "Last Synced": { date: {} },
  "Sync Status": { status: { options: [{ name: "synced" }, { name: "error" }, { name: "missing" }] } },
  "Source Hash": { rich_text: {} },
  Source: { select: { options: [{ name: "owned" }, { name: "starred" }] } },
  "Code Sync Enabled": { checkbox: {} },
  "Code HEAD SHA": { rich_text: {} },
  "Code File Count": { number: {} },
  "Code Last Synced": { date: {} },
  "Code Sync Status": { select: { options: [{ name: "idle" }, { name: "syncing" }, { name: "ready" }, { name: "partial" }, { name: "error" }] } },
};

const WORK_ITEM_PROPERTIES = (repoDataSourceId: string) => ({
  Title: { title: {} },
  "GitHub Node ID": { rich_text: {} },
  Repository: { relation: { data_source_id: repoDataSourceId, type: "single_property", single_property: {} } },
  Type: { select: { options: [{ name: "Issue" }, { name: "Pull Request" }] } },
  Number: { number: {} },
  State: { select: { options: [{ name: "open" }, { name: "closed" }, { name: "merged" }] } },
  Draft: { checkbox: {} },
  Author: { rich_text: {} },
  Assignees: { multi_select: { options: [] } },
  Labels: { multi_select: { options: [] } },
  "Review State": {
    select: {
      options: [
        { name: "none" },
        { name: "review_required" },
        { name: "approved" },
        { name: "changes_requested" },
        { name: "draft" },
      ],
    },
  },
  "Base Branch": { rich_text: {} },
  "Head Branch": { rich_text: {} },
  "Created At": { date: {} },
  "Updated At": { date: {} },
  "Closed At": { date: {} },
  "Merged At": { date: {} },
  "GitHub URL": { url: {} },
  "Source Hash": { rich_text: {} },
  "Last Synced": { date: {} },
  "Sync Status": { status: { options: [{ name: "synced" }, { name: "error" }, { name: "missing" }] } },
  "Comment Count": { number: {} },
  Origin: { select: { options: [{ name: "github" }, { name: "notion" }] } },
  "Publish State": { select: { options: [{ name: "draft" }, { name: "ready" }, { name: "creating" }, { name: "created" }, { name: "error" }] } },
  "Publish Error": { rich_text: {} },
});

const CODE_FILE_PROPERTIES = (repoDataSourceId: string) => ({
  Path: { title: {} },
  "Full Path Key": { rich_text: {} },
  Repository: { relation: { data_source_id: repoDataSourceId, type: "single_property", single_property: {} } },
  "Blob SHA": { rich_text: {} },
  Ref: { rich_text: {} },
  Language: { select: { options: [] } },
  "Size Bytes": { number: {} },
  "GitHub URL": { url: {} },
  "Content Hash": { rich_text: {} },
  "Sync Status": { status: { options: [{ name: "synced" }, { name: "skipped" }, { name: "error" }, { name: "too_large" }, { name: "binary" }, { name: "missing" }] } },
  "Last Synced": { date: {} },
});

export type EnsureResult = {
  repos: { database_id: string; data_source_id: string };
  work_items: { database_id: string; data_source_id: string };
  code_files: { database_id: string; data_source_id: string };
};

export async function ensureSchema(): Promise<EnsureResult> {
  const cfg = loadConfig();
  const notion = getNotion();
  const rootPageId = cfg.NOTION_ROOT_PAGE_ID;

  // Repositories DB
  let reposDbId = getMeta("NOTION_REPOS_DATABASE_ID") || "";
  let reposDsId = getDataSourceId("repos");

  if (!reposDsId) {
    logger.info("creating Repositories database");
    const created = await notionCall(() =>
      notion.databases.create({
        parent: { type: "page_id", page_id: rootPageId },
        is_inline: false,
        title: [{ type: "text", text: { content: "Repositories" } }],
        initial_data_source: { properties: REPO_PROPERTIES as never },
      }),
    );
    reposDbId = created.id;
    const ds = (created as { data_sources?: Array<{ id: string }> }).data_sources?.[0]?.id;
    if (!ds) throw new Error("Repositories database created but no data source returned");
    reposDsId = ds;
    setMeta("NOTION_REPOS_DATABASE_ID", reposDbId);
    persistDataSourceId("repos", reposDsId);
  } else if (!reposDbId) {
    // Recover database_id from the data source
    const ds = await notionCall(() => notion.dataSources.retrieve({ data_source_id: reposDsId }));
    const dbId = (ds as { database_id?: string }).database_id;
    if (dbId) {
      reposDbId = dbId;
      setMeta("NOTION_REPOS_DATABASE_ID", reposDbId);
    }
  }

  // Work Items DB (needs repos data_source_id for relation)
  let workDbId = getMeta("NOTION_WORK_ITEMS_DATABASE_ID") || "";
  let workDsId = getDataSourceId("work_items");

  if (!workDsId) {
    logger.info("creating Work Items database");
    const created = await notionCall(() =>
      notion.databases.create({
        parent: { type: "page_id", page_id: rootPageId },
        is_inline: false,
        title: [{ type: "text", text: { content: "Work Items" } }],
        initial_data_source: { properties: WORK_ITEM_PROPERTIES(reposDsId) as never },
      }),
    );
    workDbId = created.id;
    const ds = (created as { data_sources?: Array<{ id: string }> }).data_sources?.[0]?.id;
    if (!ds) throw new Error("Work Items database created but no data source returned");
    workDsId = ds;
    setMeta("NOTION_WORK_ITEMS_DATABASE_ID", workDbId);
    persistDataSourceId("work_items", workDsId);
  } else if (!workDbId) {
    const ds = await notionCall(() => notion.dataSources.retrieve({ data_source_id: workDsId }));
    const dbId = (ds as { database_id?: string }).database_id;
    if (dbId) {
      workDbId = dbId;
      setMeta("NOTION_WORK_ITEMS_DATABASE_ID", workDbId);
    }
  }

  // Add new properties to existing repos/work_items data sources (idempotent migration).
  // ponytail: dataSources.update with new properties is additive — existing properties are untouched.
  // Ceiling: if Notion changes behavior, check current schema before patching.
  await ensureNewProperties(reposDsId, REPO_PROPERTIES);
  await ensureNewProperties(workDsId, WORK_ITEM_PROPERTIES(reposDsId));

  // Code Files DB (needs repos data_source_id for relation)
  let codeDbId = getMeta("NOTION_CODE_FILES_DATABASE_ID") || "";
  let codeDsId = getDataSourceId("code_files");

  if (!codeDsId) {
    logger.info("creating Code Files database");
    const created = await notionCall(() =>
      notion.databases.create({
        parent: { type: "page_id", page_id: rootPageId },
        is_inline: false,
        title: [{ type: "text", text: { content: "Code Files" } }],
        initial_data_source: { properties: CODE_FILE_PROPERTIES(reposDsId) as never },
      }),
    );
    codeDbId = created.id;
    const ds = (created as { data_sources?: Array<{ id: string }> }).data_sources?.[0]?.id;
    if (!ds) throw new Error("Code Files database created but no data source returned");
    codeDsId = ds;
    setMeta("NOTION_CODE_FILES_DATABASE_ID", codeDbId);
    persistDataSourceId("code_files", codeDsId);
  } else if (!codeDbId) {
    const ds = await notionCall(() => notion.dataSources.retrieve({ data_source_id: codeDsId }));
    const dbId = (ds as { database_id?: string }).database_id;
    if (dbId) {
      codeDbId = dbId;
      setMeta("NOTION_CODE_FILES_DATABASE_ID", codeDbId);
    }
  }

  // Add new properties to existing code_files data source (idempotent migration).
  await ensureNewProperties(codeDsId, CODE_FILE_PROPERTIES(reposDsId));

  return {
    repos: { database_id: reposDbId, data_source_id: reposDsId },
    work_items: { database_id: workDbId, data_source_id: workDsId },
    code_files: { database_id: codeDbId, data_source_id: codeDsId },
  };
}

// Add properties that don't exist yet on a data source. Idempotent.
// ponytail: fetches current schema, diffs property names, patches only missing ones.
async function ensureNewProperties(dataSourceId: string, desired: Record<string, unknown>): Promise<void> {
  const notion = getNotion();
  const ds = await notionCall(() => notion.dataSources.retrieve({ data_source_id: dataSourceId }));
  const existing = new Set(Object.keys(ds.properties as Record<string, unknown>));
  const missing: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(desired)) {
    if (!existing.has(name)) missing[name] = config;
  }
  if (Object.keys(missing).length === 0) return;
  logger.info({ dataSourceId, added: Object.keys(missing) }, "adding new properties");
  await notionCall(() => notion.dataSources.update({ data_source_id: dataSourceId, properties: missing as never }));
}

// Ensure a select/multi_select option exists before setting it on a page.
// ponytail: in-memory cache avoids repeated schema reads; SQLite cache would survive restarts but v1 scale doesn't need it.
// Ceiling: if label/assignee volume grows across restarts, persist cache in meta table.
const optionCache = new Map<string, Set<string>>();

function cacheKey(dataSourceId: string, propName: string): string {
  return `${dataSourceId}::${propName}`;
}

export async function ensureOption(
  dataSourceId: string,
  propName: string,
  optionName: string,
  kind: "select" | "multi_select",
): Promise<void> {
  const key = cacheKey(dataSourceId, propName);
  let known = optionCache.get(key);
  if (!known) {
    known = new Set();
    optionCache.set(key, known);
  }
  if (known.has(optionName)) return;

  const notion = getNotion();
  // Retrieve current schema to find existing options.
  const ds = await notionCall(() => notion.dataSources.retrieve({ data_source_id: dataSourceId }));
  const props = ds.properties as Record<string, { type: string; select?: { options: { name: string }[] }; multi_select?: { options: { name: string }[] } }>;
  const prop = props[propName];
  if (!prop) throw new Error(`Property ${propName} not found on data source ${dataSourceId}`);
  const existing = kind === "select" ? prop.select?.options ?? [] : prop.multi_select?.options ?? [];
  for (const o of existing) known.add(o.name);
  if (known.has(optionName)) return;

  // Add the new option by updating the data source schema with the full option set.
  const merged = [...existing, { name: optionName }];
  const patch = {
    [propName]: kind === "select" ? { select: { options: merged } } : { multi_select: { options: merged } },
  };
  await notionCall(() => notion.dataSources.update({ data_source_id: dataSourceId, properties: patch }));
  known.add(optionName);
  logger.debug({ propName, optionName }, "created option");
}

export async function findPageByNodeId(dataSourceId: string, nodeId: string): Promise<string | null> {
  const notion = getNotion();
  let cursor: string | undefined;
  do {
    const res = await notionCall(() =>
      notion.dataSources.query({
        data_source_id: dataSourceId,
        filter: { property: "GitHub Node ID", rich_text: { equals: nodeId } },
        page_size: 1,
        start_cursor: cursor,
      }),
    );
    if (res.results.length > 0) return res.results[0]!.id;
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return null;
}

export type { Client };
