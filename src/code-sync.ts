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

      // Skip binary files — detect by checking for null bytes or high ratio
      // of non-printable characters in the first 8KB.
      // ponytail: simple null-byte check catches PNG, JPEG, PDF, etc.
      // Ceiling: use file magic bytes for precise detection.
      if (content.includes("\0")) {
        logger.debug({ repo: repo.full_name, path: entry.path }, "skipping binary file");
        skipped.push({ path: entry.path, sha: entry.sha, reason: "binary" });
        continue;
      }

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
  // Remove null bytes
  s = s.replace(/\0/g, "");
  // Remove carriage returns — Notion's markdown parser chokes on \r inside code blocks.
  s = s.replace(/\r/g, "");
  // Strip all ASCII control characters except newline (0x0A).
  // Notion's parser fails on bell (0x07), backspace (0x08), vertical tab (0x0B),
  // form feed (0x0C), shift in/out (0x0E/0x0F), escape (0x1B), etc.
  s = s.replace(/[\x01-\x08\x0B-\x1F]/g, "");
  // Strip zero-width and invisible Unicode characters that break Notion's parser:
  // ZWJ U+200D, ZWNJ U+200C, ZWSP U+200B, BOM U+FEFF, line separator U+2028,
  // paragraph separator U+2029, word joiner U+2060, soft hyphen U+00AD.
  s = s.replace(/[\u200B\u200C\u200D\uFEFF\u2028\u2029\u2060\u00AD]/g, "");
  // Replace tab characters with spaces — Notion's markdown parser interprets
  // tabs as code block indentation and fails to create blocks.
  s = s.replace(/\t/g, "  ");
  // Strip HTML comments (Notion tries to parse them even in code blocks)
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Strip <details>, <summary>, and other HTML tags that confuse Notion's parser
  s = s.replace(/<\/?(details|summary|script|style|iframe|object|embed)\b[^>]*>/gi, "");
  // Replace triple backticks in content — they break the outer code fence.
  // ponytail: use a visual equivalent that won't break the fence.
  // Ceiling: use Notion's code block API directly for exact content preservation.
  s = s.replace(/```/g, "´´´");
  // Break long lines — Notion's markdown parser fails on lines over ~2000 chars.
  // ponytail: insert newlines at the nearest space/comma every 2000 chars.
  // Ceiling: preserve original formatting via Notion's code block API.
  s = s.split("\n").map(line => {
    if (line.length <= 2000) return line;
    const chunks: string[] = [];
    let rest = line;
    while (rest.length > 2000) {
      // Try to break at a space or comma near the 2000 char mark
      let breakAt = rest.lastIndexOf(" ", 2000);
      if (breakAt < 1000) breakAt = rest.lastIndexOf(",", 2000);
      if (breakAt < 1000) breakAt = 2000;
      chunks.push(rest.slice(0, breakAt));
      rest = rest.slice(breakAt);
    }
    chunks.push(rest);
    return chunks.join("\n");
  }).join("\n");
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
