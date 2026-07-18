import { getNotion, notionCall } from "./client.ts";
import { requireDataSourceId, ensureOption, findPageByNodeId } from "./schema.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logging.ts";
import { upsertObject, getObject, touchChecked, type GithubObjectRow } from "../state/sqlite.ts";
import { nowIso } from "../util.ts";
import type { RepoProjection, WorkItemProjection } from "../projection.ts";

// Idempotent upsert: SQLite map is source of truth for page_id; Notion is queried by
// GitHub Node ID property as a recovery path when SQLite is missing the mapping.

async function ensureSelectOptions(dataSourceId: string, opts: { prop: string; value: string; kind: "select" | "multi_select" }[]): Promise<void> {
  for (const o of opts) {
    await ensureOption(dataSourceId, o.prop, o.value, o.kind);
  }
}

async function ensureMultiSelectOptions(dataSourceId: string, multi: { prop: string; values: string[]; kind: "multi_select" }[]): Promise<void> {
  for (const m of multi) {
    for (const v of m.values) {
      await ensureOption(dataSourceId, m.prop, v, "multi_select");
    }
  }
}

export async function upsertRepo(proj: RepoProjection): Promise<string> {
  const cfg = loadConfig();
  const dsId = requireDataSourceId("repos");
  const notion = getNotion();

  const prev = getObject(proj.githubNodeId);
  if (prev && prev.source_hash === proj.sourceHash && prev.mapper_version === cfg.MAPPER_VERSION && prev.notion_page_id) {
    touchChecked(proj.githubNodeId);
    logger.debug({ node_id: proj.githubNodeId }, "repo unchanged, skipping");
    return prev.notion_page_id;
  }

  await ensureSelectOptions(dsId, proj.selectOptionsToEnsure);

  let pageId: string;
  if (prev?.notion_page_id) {
    await notionCall(() =>
      notion.pages.update({ page_id: prev.notion_page_id!, properties: proj.notionProperties as never }),
    );
    if (prev.body_hash !== proj.bodyHash) {
      await notionCall(() =>
        notion.pages.updateMarkdown({
          page_id: prev.notion_page_id!,
          type: "replace_content",
          replace_content: { new_str: proj.markdown },
        }),
      );
    }
    pageId = prev.notion_page_id;
  } else {
    const existing = await findPageByNodeId(dsId, proj.githubNodeId);
    if (existing) {
      await notionCall(() => notion.pages.update({ page_id: existing, properties: proj.notionProperties as never }));
      await notionCall(() =>
        notion.pages.updateMarkdown({
          page_id: existing,
          type: "replace_content",
          replace_content: { new_str: proj.markdown },
        }),
      );
      pageId = existing;
    } else {
      const created = await notionCall(() =>
        notion.pages.create({
          parent: { data_source_id: dsId },
          properties: proj.notionProperties as never,
          markdown: proj.markdown,
        }),
      );
      pageId = created.id;
    }
  }

  const row: GithubObjectRow = {
    github_node_id: proj.githubNodeId,
    object_type: "repository",
    repo_node_id: null,
    repo_full_name: null,
    number: null,
    github_updated_at: proj.githubUpdatedAt,
    source_hash: proj.sourceHash,
    body_hash: proj.bodyHash,
    mapper_version: cfg.MAPPER_VERSION,
    notion_page_id: pageId,
    last_synced_at: nowIso(),
    last_checked_at: nowIso(),
    sync_status: "synced",
    last_error: null,
  };
  upsertObject(row);
  logger.info({ node_id: proj.githubNodeId, page_id: pageId }, "repo upserted");
  return pageId;
}

export async function upsertWorkItem(proj: WorkItemProjection): Promise<string> {
  const cfg = loadConfig();
  const dsId = requireDataSourceId("work_items");
  const notion = getNotion();

  const prev = getObject(proj.githubNodeId);
  if (prev && prev.source_hash === proj.sourceHash && prev.mapper_version === cfg.MAPPER_VERSION && prev.notion_page_id) {
    touchChecked(proj.githubNodeId);
    logger.debug({ node_id: proj.githubNodeId }, "work item unchanged, skipping");
    return prev.notion_page_id;
  }

  await ensureSelectOptions(dsId, proj.selectOptionsToEnsure);
  await ensureMultiSelectOptions(dsId, proj.multiSelectValues);

  let pageId: string;
  if (prev?.notion_page_id) {
    await notionCall(() =>
      notion.pages.update({ page_id: prev.notion_page_id!, properties: proj.notionProperties as never }),
    );
    if (prev.body_hash !== proj.bodyHash) {
      await notionCall(() =>
        notion.pages.updateMarkdown({
          page_id: prev.notion_page_id!,
          type: "replace_content",
          replace_content: { new_str: proj.markdown },
        }),
      );
    }
    pageId = prev.notion_page_id;
  } else {
    const existing = await findPageByNodeId(dsId, proj.githubNodeId);
    if (existing) {
      await notionCall(() => notion.pages.update({ page_id: existing, properties: proj.notionProperties as never }));
      await notionCall(() =>
        notion.pages.updateMarkdown({
          page_id: existing,
          type: "replace_content",
          replace_content: { new_str: proj.markdown },
        }),
      );
      pageId = existing;
    } else {
      const created = await notionCall(() =>
        notion.pages.create({
          parent: { data_source_id: dsId },
          properties: proj.notionProperties as never,
          markdown: proj.markdown,
        }),
      );
      pageId = created.id;
    }
  }

  const row: GithubObjectRow = {
    github_node_id: proj.githubNodeId,
    object_type: proj.type === "Pull Request" ? "pull_request" : "issue",
    repo_node_id: proj.repoNodeId,
    repo_full_name: proj.repoFullName,
    number: proj.number,
    github_updated_at: proj.githubUpdatedAt,
    source_hash: proj.sourceHash,
    body_hash: proj.bodyHash,
    mapper_version: cfg.MAPPER_VERSION,
    notion_page_id: pageId,
    last_synced_at: nowIso(),
    last_checked_at: nowIso(),
    sync_status: "synced",
    last_error: null,
  };
  upsertObject(row);
  logger.info({ node_id: proj.githubNodeId, type: proj.type, page_id: pageId }, "work item upserted");
  return pageId;
}

export function markObjectError(nodeId: string, err: unknown): void {
  const prev = getObject(nodeId);
  const e = err as Error;
  if (prev) {
    upsertObject({ ...prev, sync_status: "error", last_error: e.message ?? String(err), last_synced_at: nowIso() });
  }
}
