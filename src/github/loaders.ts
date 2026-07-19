import type { Octokit } from "octokit";
import { getOctokit } from "./auth.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logging.ts";

// Canonical GitHub object loaders. Always refetch; never trust webhook payload as final state.

export type RepoData = {
  node_id: string;
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  html_url: string;
  description: string | null;
  visibility: "public" | "private" | "internal";
  default_branch: string;
  language: string | null;
  archived: boolean;
  fork: boolean;
  pushed_at: string | null;
  updated_at: string;
};

export type CommentData = {
  id: number;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  body: string | null;
};

export type ReviewData = {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
};

export type ReviewCommentData = {
  id: number;
  user: { login: string } | null;
  path: string;
  line: number | null;
  body: string | null;
  created_at: string;
  updated_at: string;
};

export type IssueData = {
  node_id: string;
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason: string | null;
  body: string | null;
  user: { login: string } | null;
  assignees: { login: string }[];
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  comments: number;
  // PR-only fields (absent on pure issues)
  pull_request?: { url?: string };
};

export type PullData = {
  node_id: string;
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  body: string | null;
  user: { login: string } | null;
  assignees: { login: string }[];
  labels: { name: string }[];
  draft: boolean;
  head: { ref: string; label: string };
  base: { ref: string; label: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merged: boolean;
  html_url: string;
  comments: number;
  review_comments: number;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
};

export type PullFileData = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
};

type PaginableResponse<T> = { data: T[]; headers: { link?: string } };

async function paginate<T>(fn: (page: number) => Promise<PaginableResponse<T>>, cap?: number): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  while (true) {
    const res = await fn(page);
    out.push(...res.data);
    if (cap && out.length >= cap) return out.slice(0, cap);
    const link = res.headers.link ?? "";
    if (!link.includes('rel="next"')) return out;
    page++;
  }
}

export async function loadRepo(owner: string, repo: string): Promise<RepoData> {
  const ok = getOctokit();
  const { data } = await ok.rest.repos.get({ owner, repo });
  return data as unknown as RepoData;
}

export async function listInstallationRepos(): Promise<RepoData[]> {
  const ok = getOctokit();
  // For PAT, /user/repos; for App it'd be /installation/repositories (Phase 2).
  const repos = await paginate((page) =>
    ok.rest.repos.listForAuthenticatedUser({ per_page: 100, page, sort: "updated", direction: "desc" }),
  );
  return repos as unknown as RepoData[];
}

export async function loadIssue(owner: string, repo: string, number: number): Promise<IssueData> {
  const ok = getOctokit();
  const { data } = await ok.rest.issues.get({ owner, repo, issue_number: number });
  return data as unknown as IssueData;
}

export async function loadIssueComments(owner: string, repo: string, number: number, cap: number): Promise<CommentData[]> {
  const ok = getOctokit();
  const comments = await paginate(
    (page) => ok.rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100, page }),
    cap,
  );
  // Most recent first when capped.
  return (comments as unknown as CommentData[]).slice(-cap);
}

export async function loadPull(owner: string, repo: string, number: number): Promise<PullData> {
  const ok = getOctokit();
  const { data } = await ok.rest.pulls.get({ owner, repo, pull_number: number });
  return data as unknown as PullData;
}

export async function loadPullReviews(owner: string, repo: string, number: number, cap: number): Promise<ReviewData[]> {
  const ok = getOctokit();
  const reviews = await paginate(
    (page) => ok.rest.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100, page }),
    cap,
  );
  return (reviews as unknown as ReviewData[]).slice(-cap);
}

export async function loadPullReviewComments(owner: string, repo: string, number: number, cap: number): Promise<ReviewCommentData[]> {
  const ok = getOctokit();
  const comments = await paginate(
    (page) => ok.rest.pulls.listReviewComments({ owner, repo, pull_number: number, per_page: 100, page }),
    cap,
  );
  return (comments as unknown as ReviewCommentData[]).slice(-cap);
}

export async function loadPullFiles(owner: string, repo: string, number: number, cap: number): Promise<PullFileData[]> {
  const ok = getOctokit();
  const files = await paginate(
    (page) => ok.rest.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100, page }),
    cap,
  );
  return files as unknown as PullFileData[];
}

// Backfill helpers — list issues (filtering out PRs) and PRs separately.
export async function listIssuesForBackfill(owner: string, repo: string, includeClosed: boolean): Promise<IssueData[]> {
  const ok = getOctokit();
  const state: "open" | "all" = includeClosed ? "all" : "open";
  const all = await paginate((page) =>
    ok.rest.issues.listForRepo({ owner, repo, state, per_page: 100, page, sort: "updated", direction: "desc" }),
  );
  // REST issues list includes PRs; filter them out.
  return (all as unknown as IssueData[]).filter((i) => !i.pull_request);
}

export async function listPullsForBackfill(owner: string, repo: string, includeClosed: boolean): Promise<PullData[]> {
  const ok = getOctokit();
  const state: "open" | "all" = includeClosed ? "all" : "open";
  const all = await paginate((page) =>
    ok.rest.pulls.list({ owner, repo, state, per_page: 100, page, sort: "updated", direction: "desc" }),
  );
  return all as unknown as PullData[];
}

// Reconcile helpers — issues updated since watermark.
export async function listIssuesUpdatedSince(owner: string, repo: string, since: string): Promise<IssueData[]> {
  const ok = getOctokit();
  const all = await paginate((page) =>
    ok.rest.issues.listForRepo({ owner, repo, state: "all", since, per_page: 100, page, sort: "updated", direction: "asc" }),
  );
  return (all as unknown as IssueData[]).filter((i) => !i.pull_request);
}

export async function listPullsUpdatedSince(owner: string, repo: string, since: string): Promise<PullData[]> {
  const ok = getOctokit();
  // pulls API has no `since` filter; paginate recent pages until older than watermark.
  const out: PullData[] = [];
  let page = 1;
  while (page <= 20) {
    const res = await ok.rest.pulls.list({ owner, repo, state: "all", per_page: 100, page, sort: "updated", direction: "desc" });
    const batch = res.data as unknown as PullData[];
    if (batch.length === 0) break;
    const oldestSeen = new Date(since);
    for (const p of batch) {
      if (new Date(p.updated_at) >= oldestSeen) out.push(p);
    }
    const last = batch[batch.length - 1];
    if (last && new Date(last.updated_at) < new Date(since)) break;
    const link = res.headers.link ?? "";
    if (!link.includes('rel="next"')) break;
    page++;
  }
  return out;
}

export type { Octokit };

export function logLoaderError(target: string, err: unknown): void {
  const e = err as { status?: number; message?: string };
  logger.error({ target, status: e?.status, message: e?.message }, "github load failed");
}

// --- Code sync: tree fetch + blob fetch + filter ---

export type TreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

export type RepoTree = {
  treeSha: string;
  entries: TreeEntry[];
  truncated: boolean;
};

export async function fetchRepoTree(owner: string, repo: string, ref?: string): Promise<RepoTree> {
  const ok = getOctokit();
  // Resolve ref to commit sha → tree sha
  const branch = ref ?? (await ok.rest.repos.get({ owner, repo })).data.default_branch;
  const refRes = await ok.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const commitSha = refRes.data.object.sha;
  const commitRes = await ok.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
  const treeSha = commitRes.data.tree.sha;

  const treeRes = await ok.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: "1" });
  const entries = (treeRes.data.tree as unknown as TreeEntry[]).filter((e) => e.type === "blob");
  return { treeSha, entries, truncated: treeRes.data.truncated ?? false };
}

export async function fetchBlob(owner: string, repo: string, blobSha: string): Promise<{ content: string; size: number }> {
  const ok = getOctokit();
  const blob = await ok.rest.git.getBlob({ owner, repo, file_sha: blobSha });
  const content = Buffer.from(blob.data.content, "base64").toString("utf8");
  return { content, size: blob.data.size ?? 0 };
}

export type FileFilterConfig = {
  maxFileBytes: number;
  maxFiles: number;
  excludeDirs: string[];
  excludeExts: string[];
  excludeFiles: string[];
  textExts: string[];
};

export function filterTreeEntries(entries: TreeEntry[], cfg: FileFilterConfig): { included: TreeEntry[]; skipped: { entry: TreeEntry; reason: string }[] } {
  const excludeDirSet = new Set(cfg.excludeDirs);
  const excludeExtSet = new Set(cfg.excludeExts);
  const excludeFileSet = new Set(cfg.excludeFiles);
  const textExtSet = new Set(cfg.textExts);

  const included: TreeEntry[] = [];
  const skipped: { entry: TreeEntry; reason: string }[] = [];

  for (const entry of entries) {
    const path = entry.path;
    const segments = path.split("/");
    const fileName = segments[segments.length - 1]!;
    const ext = fileName.includes(".") ? "." + fileName.split(".").pop()!.toLowerCase() : "";

    // Check exclude dirs
    if (segments.some((s) => excludeDirSet.has(s))) {
      skipped.push({ entry, reason: "excluded dir" });
      continue;
    }
    // Check exclude files
    if (excludeFileSet.has(fileName)) {
      skipped.push({ entry, reason: "excluded file" });
      continue;
    }
    // Check exclude extensions
    if (excludeExtSet.has(ext)) {
      skipped.push({ entry, reason: "excluded ext" });
      continue;
    }
    // Check text extensions allowlist
    if (ext && !textExtSet.has(ext)) {
      skipped.push({ entry, reason: "non-text ext" });
      continue;
    }
    // Check size
    if (entry.size && entry.size > cfg.maxFileBytes) {
      skipped.push({ entry, reason: "too large" });
      continue;
    }
    included.push(entry);
    if (included.length >= cfg.maxFiles) break;
  }

  return { included, skipped };
}

export function languageFromPath(path: string): string {
  const ext = path.includes(".") ? "." + path.split(".").pop()!.toLowerCase() : "";
  const map: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go", ".rs": "Rust",
    ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".rb": "Ruby", ".php": "PHP",
    ".css": "CSS", ".scss": "SCSS", ".html": "HTML", ".svg": "SVG", ".sql": "SQL",
    ".sh": "Shell", ".bash": "Shell", ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++",
    ".cs": "C#", ".fs": "F#", ".vue": "Vue", ".svelte": "Svelte", ".json": "JSON",
    ".md": "Markdown", ".mdx": "MDX", ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML",
    ".ini": "INI", ".txt": "Text",
  };
  return map[ext] ?? "Other";
}
