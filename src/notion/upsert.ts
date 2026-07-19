import { getNotion, notionCall } from "./client.ts";
import { requireDataSourceId, ensureOption, findPageByNodeId } from "./schema.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logging.ts";
import { upsertObject, getObject, touchChecked, type GithubObjectRow } from "../state/sqlite.ts";
import { nowIso, sleep, truncate } from "../util.ts";
import type { RepoProjection, WorkItemProjection } from "../projection.ts";

// Idempotent upsert: SQLite map is source of truth for page_id; Notion is queried by
// GitHub Node ID property as a recovery path when SQLite is missing the mapping.

// ponytail: async markdown path only for large bodies (>= 50KB).
// Ceiling: if Notion raises the sync timeout, lower the threshold or always use async.
const ASYNC_MARKDOWN_THRESHOLD = 50_000;
// Hard cap on markdown body sent to Notion. Bodies above this get truncated.
// Notion's async markdown path rejects content well below its 500KB HTTP limit
// with "too large to process asynchronously" — 200KB is empirically safe.
const HARD_MARKDOWN_CAP = 200_000;

type AsyncTaskInitial = {
  object: "async_task";
  id: string;
  status: "queued" | "running" | "retrying";
  status_url: string;
  poll_after_seconds: number;
};

type AsyncTaskSucceeded = {
  object: "async_task";
  id: string;
  status: "succeeded";
  result: Record<string, unknown>;
};

type AsyncTaskFailed = {
  object: "async_task";
  id: string;
  status: "failed";
  error: { object: "error"; status: number; code: string; message: string };
};

type AsyncTaskResponse = AsyncTaskInitial | AsyncTaskSucceeded | AsyncTaskFailed;

function capMarkdown(md: string): string {
  if (md.length <= HARD_MARKDOWN_CAP) return md;
  // ponytail: truncate at cap with a notice. Ceiling: smarter section-aware truncation.
  return truncate(md, HARD_MARKDOWN_CAP) + "\n\n_...body truncated (over 500KB)_\n";
}

async function replaceMarkdown(pageId: string, markdown: string): Promise<void> {
  const notion = getNotion();
  const md = capMarkdown(markdown);
  if (md.length < ASYNC_MARKDOWN_THRESHOLD) {
    await notionCall(() =>
      notion.pages.updateMarkdown({
        page_id: pageId,
        type: "replace_content",
        replace_content: { new_str: md },
      }),
    );
    return;
  }
  const res = await notionCall(() =>
    notion.pages.updateMarkdown({
      page_id: pageId,
      type: "replace_content",
      replace_content: { new_str: md },
      allow_async: true,
    } as Parameters<typeof notion.pages.updateMarkdown>[0] & { allow_async: boolean }),
  ) as unknown as AsyncTaskInitial;
  // Async response: object is "async_task" with a task id, no page content
  if (res.object === "async_task" && res.status) {
    logger.info({ page_id: pageId, task_id: res.id, body_len: md.length }, "markdown async task started");
    await pollAsyncTask(res.id, res.poll_after_seconds);
    return;
  }
  // Notion processed synchronously despite allow_async
}

async function createPageWithMarkdown(parent: { data_source_id: string }, properties: never, markdown: string): Promise<{ id: string }> {
  const notion = getNotion();
  const md = capMarkdown(markdown);
  if (md.length < ASYNC_MARKDOWN_THRESHOLD) {
    const created = await notionCall(() =>
      notion.pages.create({ parent, properties, markdown: md }),
    );
    return { id: created.id };
  }
  const res = await notionCall(() =>
    notion.pages.create({
      parent,
      properties,
      markdown: md,
      allow_async: true,
    } as Parameters<typeof notion.pages.create>[0] & { allow_async: boolean }),
  ) as unknown as AsyncTaskInitial & { id: string; object: string };
  if (res.object === "async_task") {
    logger.info({ task_id: res.id, body_len: md.length }, "create page async task started");
    const result = await pollAsyncTask(res.id, res.poll_after_seconds);
    // Extract page id from result. Shape: { page: { id: "..." } } or { id: "..." }
    const r = result.result as Record<string, unknown>;
    const pageId = r?.page ? (r.page as { id: string }).id : (r as { id?: string })?.id;
    if (!pageId) throw new Error(`Async page create succeeded but no page id in result: ${JSON.stringify(r).slice(0, 200)}`);
    return { id: pageId };
  }
  // Notion processed synchronously despite allow_async
  return { id: res.id };
}

async function pollAsyncTask(taskId: string, pollAfterSeconds: number): Promise<AsyncTaskSucceeded> {
  const notion = getNotion();
  // ponytail: poll with cap of 15 attempts. Ceiling: exponential backoff + dead-letter if Notion async fails.
  for (let i = 0; i < 15; i++) {
    await sleep(Math.max(1, pollAfterSeconds) * 1000);
    const task = await notionCall(() =>
      notion.asyncTasks.retrieve({ task_id: taskId }),
    ) as AsyncTaskResponse;
    if (task.status === "succeeded") return task;
    if (task.status === "failed") {
      throw new Error(`Notion async task ${taskId} failed: ${task.error.message}`);
    }
    logger.debug({ task_id: taskId, status: task.status, attempt: i }, "async task pending");
  }
  throw new Error(`Notion async task ${taskId} did not complete within 15 polls`);
}

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
      await replaceMarkdown(prev.notion_page_id, proj.markdown);
    }
    pageId = prev.notion_page_id;
  } else {
    const existing = await findPageByNodeId(dsId, proj.githubNodeId);
    if (existing) {
      await notionCall(() => notion.pages.update({ page_id: existing, properties: proj.notionProperties as never }));
      await replaceMarkdown(existing, proj.markdown);
      pageId = existing;
    } else {
      const created = await createPageWithMarkdown({ data_source_id: dsId }, proj.notionProperties as never, proj.markdown);
      pageId = created.id;
    }
  }

  const row: GithubObjectRow = {
    github_node_id: proj.githubNodeId,
    object_type: "repository",
    repo_node_id: null,
    repo_full_name: proj.fullName,
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
    repo_source: proj.source,
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
    // On update: don't clobber Origin or Publish State — user may have set Origin=notion
    // or Publish State=ready/creating. Only set these on create.
    const updateProps = { ...proj.notionProperties };
    delete updateProps["Origin"];
    delete updateProps["Publish State"];
    await notionCall(() =>
      notion.pages.update({ page_id: prev.notion_page_id!, properties: updateProps as never }),
    );
    if (prev.body_hash !== proj.bodyHash) {
      await replaceMarkdown(prev.notion_page_id, proj.markdown);
    }
    pageId = prev.notion_page_id;
  } else {
    const existing = await findPageByNodeId(dsId, proj.githubNodeId);
    if (existing) {
      const updateProps = { ...proj.notionProperties };
      delete updateProps["Origin"];
      delete updateProps["Publish State"];
      await notionCall(() => notion.pages.update({ page_id: existing, properties: updateProps as never }));
      await replaceMarkdown(existing, proj.markdown);
      pageId = existing;
    } else {
      const created = await createPageWithMarkdown({ data_source_id: dsId }, proj.notionProperties as never, proj.markdown);
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
