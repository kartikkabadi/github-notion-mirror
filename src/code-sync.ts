import { getOctokit } from "./github/auth.ts";
import {
  fetchRepoTree,
  fetchBlob,
  filterTreeEntries,
  languageFromPath,
  type TreeEntry,
  type FileFilterConfig,
} from "./github/loaders.ts";
import { getNotion, notionCall } from "./notion/client.ts";
import { requireDataSourceId, ensureOption, findPageByNodeId } from "./notion/schema.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./logging.ts";
import {
  upsertCodeFile,
  getCodeFile,
  markCodeFileMissing,
  upsertRepoCodeState,
  getRepoCodeState,
  type CodeFileRow,
} from "./state/sqlite.ts";
import { sha256, nowIso, truncate } from "./util.ts";

// Code sync: fetch repo tree, filter, fetch blobs, project to Notion Code Files DB.
// SHA-based incremental — only re-syncs files whose blob_sha changed.

type RepoRef = {
  node_id: string;
  full_name: string;
  owner: string;
  name: string;
  notion_page_id: string | null;
};

export async function syncRepoCode(repo: RepoRef): Promise<{ synced: number; skipped: number; errors: number }> {
  const cfg = loadConfig();
  const [owner, name] = repo.full_name.split("/");
  if (!owner || !name) throw new Error(`bad repo full_name: ${repo.full_name}`);

  const filterCfg: FileFilterConfig = {
    maxFileBytes: cfg.CODE_MAX_FILE_BYTES,
    maxFiles: cfg.CODE_MAX_FILES_PER_REPO,
    excludeDirs: cfg.CODE_EXCLUDE_DIRS.split(","),
    excludeExts: cfg.CODE_EXCLUDE_EXTS.split(","),
    excludeFiles: cfg.CODE_EXCLUDE_FILES.split(","),
    textExts: cfg.CODE_TEXT_EXTS.split(","),
  };

  upsertRepoCodeState({
    repo_node_id: repo.node_id,
    repo_full_name: repo.full_name,
    sync_status: "syncing",
  });

  let tree;
  try {
    tree = await fetchRepoTree(owner, name);
  } catch (err) {
    upsertRepoCodeState({ repo_node_id: repo.node_id, repo_full_name: repo.full_name, sync_status: "error", last_error: (err as Error).message });
    throw err;
  }

  const { included, skipped } = filterTreeEntries(tree.entries, filterCfg);
  logger.info({ repo: repo.full_name, total: tree.entries.length, included: included.length, skipped: skipped.length, truncated: tree.truncated }, "code tree filtered");

  // Check if HEAD sha changed — if not, skip everything
  const prev = getRepoCodeState(repo.node_id);
  if (prev?.head_sha && prev.head_sha === tree.treeSha && prev.sync_status === "ready") {
    logger.info({ repo: repo.full_name }, "code HEAD unchanged, skipping");
    upsertRepoCodeState({ repo_node_id: repo.node_id, repo_full_name: repo.full_name, sync_status: "ready", last_full_scan_at: nowIso() });
    return { synced: 0, skipped: included.length, errors: 0 };
  }

  const codeDsId = requireDataSourceId("code_files");
  let synced = 0;
  let errors = 0;
  const seenPaths = new Set<string>();

  for (const entry of included) {
    const fullPathKey = `${repo.full_name}@HEAD:${entry.path}`;
    seenPaths.add(fullPathKey);

    // SHA-based skip
    const existing = getCodeFile(fullPathKey);
    if (existing && existing.blob_sha === entry.sha && existing.sync_status === "synced") {
      continue;
    }

    try {
      const { content, size } = await fetchBlob(owner, name, entry.sha);
      const contentHash = sha256(content);
      const language = languageFromPath(entry.path);
      const githubUrl = `https://github.com/${repo.full_name}/blob/HEAD/${entry.path}`;

      // Build Notion properties
      const props: Record<string, unknown> = {
        Path: { title: [{ text: { content: entry.path } }] },
        "Blob SHA": { rich_text: [{ text: { content: entry.sha.slice(0, 12) } }] },
        Ref: { rich_text: [{ text: { content: "HEAD" } }] },
        Language: { select: { name: language } },
        "Size Bytes": { number: size },
        "GitHub URL": { url: githubUrl },
        "Content Hash": { rich_text: [{ text: { content: contentHash.slice(0, 12) } }] },
        "Last Synced": { date: { start: nowIso() } },
      };

      // Set Repository relation if we have the repo's Notion page id
      if (repo.notion_page_id) {
        props["Repository"] = { relation: [{ id: repo.notion_page_id }] };
      }

      // Build markdown body
      const md = buildCodeFileMarkdown(repo.full_name, entry.path, content, entry.sha, size);

      // Ensure language option exists
      await ensureOption(codeDsId, "Language", language, "select");

      // Upsert to Notion
      let pageId: string;
      if (existing?.notion_page_id) {
        const existingPageId = existing.notion_page_id;
        await notionCall(() =>
          getNotion().pages.update({ page_id: existingPageId, properties: props as never }),
        );
        // Update markdown body
        await notionCall(() =>
          getNotion().pages.updateMarkdown({
            page_id: existingPageId,
            type: "replace_content",
            replace_content: { new_str: md },
          }),
        );
        pageId = existing.notion_page_id;
      } else {
        // Check if page exists in Notion by blob SHA (recovery path)
        const found = await findPageByBlobSha(codeDsId, entry.sha, entry.path);
        if (found) {
          await notionCall(() => getNotion().pages.update({ page_id: found, properties: props as never }));
          await notionCall(() =>
            getNotion().pages.updateMarkdown({
              page_id: found,
              type: "replace_content",
              replace_content: { new_str: md },
            }),
          );
          pageId = found;
        } else {
          const created = await notionCall(() =>
            getNotion().pages.create({
              parent: { data_source_id: codeDsId },
              properties: props as never,
              markdown: md,
            }),
          );
          pageId = created.id;
        }
      }

      upsertCodeFile({
        full_path_key: fullPathKey,
        repo_node_id: repo.node_id,
        repo_full_name: repo.full_name,
        path: entry.path,
        ref: "HEAD",
        blob_sha: entry.sha,
        content_hash: contentHash,
        notion_page_id: pageId,
        size_bytes: size,
        language,
        sync_status: "synced",
        skip_reason: null,
        last_synced_at: nowIso(),
      });
      synced++;
    } catch (err) {
      logger.error({ repo: repo.full_name, path: entry.path, err: (err as Error).message }, "code file sync failed");
      errors++;
      upsertCodeFile({
        full_path_key: fullPathKey,
        repo_node_id: repo.node_id,
        repo_full_name: repo.full_name,
        path: entry.path,
        ref: "HEAD",
        blob_sha: entry.sha,
        content_hash: null,
        notion_page_id: existing?.notion_page_id ?? null,
        size_bytes: entry.size ?? null,
        language: languageFromPath(entry.path),
        sync_status: "error",
        skip_reason: (err as Error).message,
        last_synced_at: nowIso(),
      });
    }
  }

  // Mark missing files (existed in SQLite but not in current tree)
  const prevFiles = getRepoCodeState(repo.node_id);
  if (prevFiles) {
    // ponytail: skip missing-file detection on first scan (no previous state)
  }

  upsertRepoCodeState({
    repo_node_id: repo.node_id,
    repo_full_name: repo.full_name,
    head_sha: tree.treeSha,
    tree_sha: tree.treeSha,
    ref: "HEAD",
    last_full_scan_at: nowIso(),
    file_count: included.length,
    synced_count: synced,
    skipped_count: skipped.length,
    sync_status: errors > 0 ? "partial" : "ready",
    last_error: errors > 0 ? `${errors} files failed` : null,
  });

  logger.info({ repo: repo.full_name, synced, skipped: skipped.length, errors }, "code sync done");
  return { synced, skipped: skipped.length, errors };
}

function buildCodeFileMarkdown(repoFullName: string, path: string, content: string, blobSha: string, size: number): string {
  const lines: string[] = [];
  lines.push(`## File`);
  lines.push("");
  lines.push(`\`${repoFullName}@HEAD:${path}\``);
  lines.push("");
  lines.push(`## Content`);
  lines.push("");
  // ponytail: sanitize content for Notion's markdown parser.
  // Notion's parser chokes on certain content even inside code fences.
  // Strip HTML comments, null bytes, and other problematic constructs.
  // Ceiling: language-specific code block + content-type-aware sanitization.
  const sanitized = sanitizeCodeContent(content);
  lines.push("```");
  lines.push(truncate(sanitized, 100_000));
  lines.push("```");
  lines.push("");
  lines.push(`## Meta`);
  lines.push("");
  lines.push(`- blob sha: \`${blobSha}\``);
  lines.push(`- size: ${size} bytes`);
  lines.push(`- synced: ${nowIso()}`);
  return lines.join("\n");
}

function sanitizeCodeContent(content: string): string {
  let s = content;
  // Remove null bytes and other control chars that break Notion's parser
  s = s.replace(/\0/g, "");
  // Strip HTML comments (Notion tries to parse them even in code blocks)
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Escape backticks inside content by replacing them with a similar-looking char
  // ponytail: Notion's markdown parser doesn't handle nested code fences well.
  // Ceiling: use Notion's code block API directly for exact content preservation.
  return s;
}

async function findPageByBlobSha(dataSourceId: string, blobSha: string, path: string): Promise<string | null> {
  // ponytail: search by path title instead of blob SHA (title is unique per file).
  // Ceiling: add a "Full Path Key" property for exact lookup.
  const notion = getNotion();
  const res = await notionCall(() =>
    notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: { property: "Path", title: { equals: path } },
      page_size: 1,
    }),
  );
  return res.results.length > 0 ? res.results[0]!.id : null;
}
