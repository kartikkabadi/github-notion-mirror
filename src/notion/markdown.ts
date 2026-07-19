import { loadConfig } from "../config.ts";
import { truncate, nowIso } from "../util.ts";
import type {
  CommentData,
  ReviewData,
  ReviewCommentData,
  PullFileData,
} from "../github/loaders.ts";

// ponytail: Notion's markdown endpoint accepts a single markdown string per append.
// We build the full body markdown and replace the page body in one operation.
// Ceiling: if Notion markdown API is unavailable in pinned SDK, upsert.ts falls back to block chunks.

export function sanitizeBody(text: string | null, maxChars: number): string {
  if (!text) return "_No body._";
  // Strip HTML constructs Notion's markdown parser can't handle.
  // ponytail: regex-based strip. Ceiling: proper HTML parser if needed.
  let s = text;
  // HTML comments (bot review metadata, hidden annotations)
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // <details>/<summary> unwrap — keep inner content, drop tags
  s = s.replace(/<\/?(?:details|summary)>/g, "");
  // Other common HTML tags from bot comments — unwrap to text
  s = s.replace(/<\/?(?:div|span|section|article|aside|header|footer|nav|main|figure|figcaption|table|thead|tbody|tr|td|th|ul|ol|li|p|br|hr|strong|em|b|i|a|img|code|pre|blockquote|h[1-6])[^>]*>/g, "");
  // Collapse multiple blank lines from removed tags
  s = s.replace(/\n{3,}/g, "\n\n");
  return truncate(s, maxChars);
}

export function renderIssueBody(params: {
  body: string | null;
  comments: CommentData[];
  updatedAt: string;
  nodeId: string;
  sourceHash: string;
  mapperVersion: number;
  maxBodyChars: number;
  maxComments: number;
}): string {
  const { body, comments, updatedAt, nodeId, sourceHash, mapperVersion, maxBodyChars, maxComments } = params;
  const lines: string[] = [];
  lines.push("## Source");
  lines.push("");
  lines.push(`_Updated: ${updatedAt}_`);
  lines.push("");
  lines.push(sanitizeBody(body, maxBodyChars));
  lines.push("");
  lines.push("## Conversation");
  lines.push("");
  if (comments.length === 0) {
    lines.push("_No comments._");
  } else {
    const recent = comments.slice(-maxComments);
    for (const c of recent) {
      lines.push(`### ${c.updated_at} — ${c.user?.login ?? "unknown"} — issue_comment`);
      lines.push("");
      lines.push(sanitizeBody(c.body, Math.min(maxBodyChars, 20000)));
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## Changes");
  lines.push("");
  lines.push("N/A");
  lines.push("");
  appendSyncSection(lines, nodeId, updatedAt, sourceHash, mapperVersion);
  return lines.join("\n");
}

export function renderPullBody(params: {
  body: string | null;
  issueComments: CommentData[];
  reviews: ReviewData[];
  reviewComments: ReviewCommentData[];
  files: PullFileData[];
  pull: {
    base: { ref: string };
    head: { ref: string };
    commits: number;
    changed_files: number;
    additions: number;
    deletions: number;
    html_url: string;
  };
  updatedAt: string;
  nodeId: string;
  sourceHash: string;
  mapperVersion: number;
  maxBodyChars: number;
  maxComments: number;
  maxFiles: number;
}): string {
  const { body, issueComments, reviews, reviewComments, files, pull, updatedAt, nodeId, sourceHash, mapperVersion, maxBodyChars, maxComments, maxFiles } = params;
  const lines: string[] = [];
  lines.push("## Source");
  lines.push("");
  lines.push(`_Updated: ${updatedAt}_`);
  lines.push("");
  lines.push(sanitizeBody(body, maxBodyChars));
  lines.push("");
  lines.push("## Conversation");
  lines.push("");
  const convEntries: { ts: string; author: string; kind: string; body: string | null }[] = [];
  for (const c of issueComments) {
    convEntries.push({ ts: c.updated_at, author: c.user?.login ?? "unknown", kind: "issue_comment", body: c.body });
  }
  for (const r of reviews) {
    convEntries.push({ ts: r.submitted_at ?? r.id.toString(), author: r.user?.login ?? "unknown", kind: `review:${r.state}`, body: r.body });
  }
  for (const rc of reviewComments) {
    convEntries.push({ ts: rc.updated_at, author: rc.user?.login ?? "unknown", kind: `review_comment:${rc.path}`, body: rc.body });
  }
  convEntries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (convEntries.length === 0) {
    lines.push("_No comments._");
  } else {
    for (const e of convEntries.slice(-maxComments)) {
      lines.push(`### ${e.ts} — ${e.author} — ${e.kind}`);
      lines.push("");
      lines.push(sanitizeBody(e.body, Math.min(maxBodyChars, 20000)));
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## Changes");
  lines.push("");
  lines.push(`- Base: \`${pull.base.ref}\` ← Head: \`${pull.head.ref}\``);
  lines.push(`- Commits: ${pull.commits}`);
  lines.push(`- Changed files: ${pull.changed_files}`);
  lines.push(`- Additions/Deletions: +${pull.additions} / -${pull.deletions}`);
  lines.push("");
  if (files.length === 0) {
    lines.push("_No file metadata._");
  } else {
    lines.push("| Path | Status | + | - |");
    lines.push("|------|--------|---|---|");
    for (const f of files.slice(0, maxFiles)) {
      lines.push(`| ${escapeTable(f.filename)} | ${escapeTable(f.status)} | ${f.additions} | ${f.deletions} |`);
    }
    if (files.length > maxFiles) {
      lines.push(`| _…${files.length - maxFiles} more files_ | | | |`);
    }
  }
  lines.push("");
  lines.push("## Diffs");
  lines.push("");
  // ponytail: cap diffs to avoid Notion "too large to process asynchronously" errors.
  // 20 files × 5KB patches = 100KB max diffs, leaving ~100KB for body + conversation
  // under the 200KB HARD_MARKDOWN_CAP in upsert.ts.
  // Ceiling: configurable per-repo diff budget if users need more.
  const MAX_DIFF_FILES = 20;
  const MAX_PATCH_CHARS = 5_000;
  const filesWithPatches = files.filter((f) => f.patch);
  const diffFiles = filesWithPatches.slice(0, MAX_DIFF_FILES);
  if (diffFiles.length === 0) {
    lines.push("_No diff content available._");
  } else {
    for (const f of diffFiles) {
      lines.push(`### ${escapeTable(f.filename)}`);
      lines.push("");
      lines.push("```diff");
      lines.push(sanitizeBody(f.patch, MAX_PATCH_CHARS));
      lines.push("```");
      lines.push("");
    }
    if (filesWithPatches.length > diffFiles.length) {
      lines.push(`_…${filesWithPatches.length - diffFiles.length} more files with diffs_`);
      lines.push("");
    }
  }
  lines.push("");
  lines.push(`> Full diff lives on GitHub: ${pull.html_url}/files`);
  lines.push("");
  appendSyncSection(lines, nodeId, updatedAt, sourceHash, mapperVersion);
  return lines.join("\n");
}

function appendSyncSection(lines: string[], nodeId: string, updatedAt: string, sourceHash: string, mapperVersion: number): void {
  lines.push("## Synchronization");
  lines.push("");
  lines.push(`- GitHub node id: \`${nodeId}\``);
  lines.push(`- GitHub updated at: ${updatedAt}`);
  lines.push(`- Source hash: \`${sourceHash}\``);
  lines.push(`- Mapper version: ${mapperVersion}`);
  lines.push(`- Last synced: ${nowIso()}`);
}

function escapeTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
