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
