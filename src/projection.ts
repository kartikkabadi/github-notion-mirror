import { loadConfig } from "./config.ts";
import { sha256, stableJson, nowIso } from "./util.ts";
import { renderIssueBody, renderPullBody } from "./notion/markdown.ts";
import type {
  RepoData,
  IssueData,
  PullData,
  CommentData,
  ReviewData,
  ReviewCommentData,
  PullFileData,
} from "./github/loaders.ts";

// Notion property value builders.
// ponytail: PropVal is `Record<string, unknown>` rather than the SDK's strict per-property
// union (which would require importing ~20 types and casting at every builder).
// The shapes we emit match the SDK's expected request shapes; upsert.ts casts at the call site.
// Ceiling: if Notion rejects a shape, narrow PropVal to the SDK's PropertyValueMap type.
type PropVal = Record<string, unknown>;

function richText(s: string | null | undefined): PropVal {
  const v = (s ?? "").slice(0, 2000);
  return { rich_text: [{ type: "text", text: { content: v } }] };
}

function selectVal(name: string | null | undefined): PropVal {
  if (!name) return { select: null };
  return { select: { name } };
}

function multiSelectVal(names: string[]): PropVal {
  return { multi_select: names.map((n) => ({ name: n })) };
}

function dateVal(iso: string | null | undefined): PropVal {
  if (!iso) return { date: null };
  return { date: { start: iso, end: null } };
}

function numberVal(n: number | null | undefined): PropVal {
  return { number: n ?? null };
}

function checkboxVal(b: boolean): PropVal {
  return { checkbox: b };
}

function urlVal(u: string | null | undefined): PropVal {
  return { url: u ?? null };
}

function statusVal(name: string): PropVal {
  return { status: { name } };
}

function relationVal(pageId: string | null | undefined): PropVal {
  if (!pageId) return { relation: [] };
  return { relation: [{ id: pageId }] };
}

function titleVal(s: string): PropVal {
  const v = s.slice(0, 2000);
  return { title: [{ type: "text", text: { content: v } }] };
}

export type RepoProjection = {
  githubNodeId: string;
  fullName: string;
  notionProperties: Record<string, PropVal>;
  markdown: string;
  githubUpdatedAt: string;
  sourceHash: string;
  bodyHash: string;
  // Labels/languages/visibility that need option-ensure before page update.
  selectOptionsToEnsure: { prop: string; value: string; kind: "select" }[];
  source: "owned" | "starred";
};

export function projectRepo(repo: RepoData, notionPageId?: string, source?: "owned" | "starred"): RepoProjection {
  const cfg = loadConfig();
  const visibility = (repo.visibility ?? "public") as "public" | "private" | "internal";
  const properties: Record<string, PropVal> = {
    Name: titleVal(repo.full_name),
    "GitHub Node ID": richText(repo.node_id),
    "Full Name": richText(repo.full_name),
    "GitHub URL": urlVal(repo.html_url),
    Description: richText(repo.description ?? ""),
    Visibility: selectVal(visibility),
    "Default Branch": richText(repo.default_branch),
    "Primary Language": selectVal(repo.language),
    Archived: checkboxVal(repo.archived),
    Fork: checkboxVal(repo.fork),
    Owner: richText(repo.owner?.login ?? ""),
    "Pushed At": dateVal(repo.pushed_at),
    "Updated At": dateVal(repo.updated_at),
    "Last Synced": dateVal(nowIso()),
    "Sync Status": statusVal("synced"),
    "Source Hash": richText(""), // filled after hash computed
    Source: selectVal(source ?? "owned"),
  };

  // Hash input: stable subset of props (exclude Last Synced, Source Hash, Sync Status — volatile).
  const hashInput = stableJson({
    mapper: cfg.MAPPER_VERSION,
    node_id: repo.node_id,
    full_name: repo.full_name,
    description: repo.description,
    visibility,
    default_branch: repo.default_branch,
    language: repo.language,
    archived: repo.archived,
    fork: repo.fork,
    owner: repo.owner?.login,
    pushed_at: repo.pushed_at,
    updated_at: repo.updated_at,
    html_url: repo.html_url,
  });
  const sourceHash = sha256(hashInput);
  properties["Source Hash"] = richText(sourceHash);

  const markdown = [
    "## Repository",
    "",
    `_Updated: ${nowIso()}_`,
    "",
    `- **Full name:** ${repo.full_name}`,
    `- **Visibility:** ${visibility}`,
    `- **Default branch:** ${repo.default_branch}`,
    `- **Language:** ${repo.language ?? "n/a"}`,
    `- **Archived:** ${repo.archived}`,
    `- **Fork:** ${repo.fork}`,
    `- **Owner:** ${repo.owner?.login ?? "n/a"}`,
    `- **Pushed at:** ${repo.pushed_at ?? "n/a"}`,
    `- **Updated at:** ${repo.updated_at}`,
    `- **URL:** ${repo.html_url}`,
    "",
    repo.description ? repo.description : "_No description._",
    "",
    "## Synchronization",
    "",
    `- GitHub node id: \`${repo.node_id}\``,
    `- Source hash: \`${sourceHash}\``,
    `- Mapper version: ${cfg.MAPPER_VERSION}`,
    `- Last synced: ${nowIso()}`,
  ].join("\n");

  const selectOptionsToEnsure: { prop: string; value: string; kind: "select" }[] = [];
  if (visibility) selectOptionsToEnsure.push({ prop: "Visibility", value: visibility, kind: "select" });
  if (repo.language) selectOptionsToEnsure.push({ prop: "Primary Language", value: repo.language, kind: "select" });
  selectOptionsToEnsure.push({ prop: "Source", value: source ?? "owned", kind: "select" });

  return {
    githubNodeId: repo.node_id,
    fullName: repo.full_name,
    notionProperties: properties,
    markdown,
    githubUpdatedAt: repo.updated_at,
    sourceHash,
    bodyHash: sha256(markdown),
    selectOptionsToEnsure,
    source: source ?? "owned",
  };
}

export type WorkItemProjection = {
  githubNodeId: string;
  repoNodeId: string;
  repoFullName: string;
  type: "Issue" | "Pull Request";
  number: number;
  notionProperties: Record<string, PropVal>;
  markdown: string;
  githubUpdatedAt: string;
  sourceHash: string;
  bodyHash: string;
  selectOptionsToEnsure: { prop: string; value: string; kind: "select" | "multi_select" }[];
  multiSelectValues: { prop: string; values: string[]; kind: "multi_select" }[];
};

type IssueEnrichment = {
  comments: CommentData[];
};

type PullEnrichment = {
  issueComments: CommentData[];
  reviews: ReviewData[];
  reviewComments: ReviewCommentData[];
  files: PullFileData[];
};

export function projectIssue(
  issue: IssueData,
  repo: RepoData,
  repoNotionPageId: string | null,
  enrichment: IssueEnrichment,
): WorkItemProjection {
  const cfg = loadConfig();
  const state: "open" | "closed" = issue.state;
  const assignees = issue.assignees.map((a) => a.login);
  const labels = issue.labels.map((l) => l.name);

  const hashInput = stableJson({
    mapper: cfg.MAPPER_VERSION,
    node_id: issue.node_id,
    title: issue.title,
    state,
    state_reason: issue.state_reason,
    body: issue.body,
    author: issue.user?.login,
    assignees,
    labels,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: issue.html_url,
    comments_count: issue.comments,
    conversation: enrichment.comments.map((c) => ({ id: c.id, body: c.body, updated: c.updated_at, author: c.user?.login })),
  });
  const sourceHash = sha256(hashInput);

  const markdown = renderIssueBody({
    body: issue.body,
    comments: enrichment.comments,
    updatedAt: issue.updated_at,
    nodeId: issue.node_id,
    sourceHash,
    mapperVersion: cfg.MAPPER_VERSION,
    maxBodyChars: cfg.MAX_BODY_CHARS,
    maxComments: cfg.MAX_COMMENTS_PER_ITEM,
  });

  const properties: Record<string, PropVal> = {
    Title: titleVal(issue.title),
    "GitHub Node ID": richText(issue.node_id),
    Repository: relationVal(repoNotionPageId),
    Type: selectVal("Issue"),
    Number: numberVal(issue.number),
    State: selectVal(state),
    Draft: checkboxVal(false),
    Author: richText(issue.user?.login ?? ""),
    Assignees: multiSelectVal(assignees),
    Labels: multiSelectVal(labels),
    "Review State": selectVal("none"),
    "Base Branch": richText(""),
    "Head Branch": richText(""),
    "Created At": dateVal(issue.created_at),
    "Updated At": dateVal(issue.updated_at),
    "Closed At": dateVal(issue.closed_at),
    "Merged At": dateVal(null),
    "GitHub URL": urlVal(issue.html_url),
    "Source Hash": richText(sourceHash),
    "Last Synced": dateVal(nowIso()),
    "Sync Status": statusVal("synced"),
    "Comment Count": numberVal(issue.comments),
    Origin: selectVal("github"),
    "Publish State": selectVal("created"),
  };

  const selectOptionsToEnsure: { prop: string; value: string; kind: "select" | "multi_select" }[] = [
    { prop: "Type", value: "Issue", kind: "select" },
    { prop: "State", value: state, kind: "select" },
    { prop: "Review State", value: "none", kind: "select" },
    { prop: "Origin", value: "github", kind: "select" },
    { prop: "Publish State", value: "created", kind: "select" },
  ];
  const multiSelectValues: { prop: string; values: string[]; kind: "multi_select" }[] = [
    { prop: "Assignees", values: assignees, kind: "multi_select" },
    { prop: "Labels", values: labels, kind: "multi_select" },
  ];

  return {
    githubNodeId: issue.node_id,
    repoNodeId: repo.node_id,
    repoFullName: repo.full_name,
    type: "Issue",
    number: issue.number,
    notionProperties: properties,
    markdown,
    githubUpdatedAt: issue.updated_at,
    sourceHash,
    bodyHash: sha256(markdown),
    selectOptionsToEnsure,
    multiSelectValues,
  };
}

export function projectPull(
  pull: PullData,
  repo: RepoData,
  repoNotionPageId: string | null,
  enrichment: PullEnrichment,
): WorkItemProjection {
  const cfg = loadConfig();
  const state: "open" | "closed" | "merged" = pull.merged ? "merged" : pull.state;
  const assignees = pull.assignees.map((a) => a.login);
  const labels = pull.labels.map((l) => l.name);
  const reviewState = pull.draft ? "draft" : "none"; // ponytail: v1 doesn't fetch review state from API; reviews are in body. Ceiling: query /reviews summary.

  const hashInput = stableJson({
    mapper: cfg.MAPPER_VERSION,
    node_id: pull.node_id,
    title: pull.title,
    state,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.merged_at,
    body: pull.body,
    author: pull.user?.login,
    assignees,
    labels,
    head: pull.head.ref,
    base: pull.base.ref,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    html_url: pull.html_url,
    commits: pull.commits,
    additions: pull.additions,
    deletions: pull.deletions,
    changed_files: pull.changed_files,
    files: enrichment.files.map((f) => ({ path: f.filename, status: f.status, a: f.additions, d: f.deletions, patch: f.patch?.slice(0, 5000) })),
    conversation: [
      ...enrichment.issueComments.map((c) => ({ id: c.id, body: c.body, updated: c.updated_at, author: c.user?.login, kind: "issue_comment" })),
      ...enrichment.reviews.map((r) => ({ id: r.id, body: r.body, updated: r.submitted_at, author: r.user?.login, kind: `review:${r.state}` })),
      ...enrichment.reviewComments.map((rc) => ({ id: rc.id, body: rc.body, updated: rc.updated_at, author: rc.user?.login, kind: "review_comment" })),
    ],
  });
  const sourceHash = sha256(hashInput);

  const markdown = renderPullBody({
    body: pull.body,
    issueComments: enrichment.issueComments,
    reviews: enrichment.reviews,
    reviewComments: enrichment.reviewComments,
    files: enrichment.files,
    pull: {
      base: { ref: pull.base.ref },
      head: { ref: pull.head.ref },
      commits: pull.commits,
      changed_files: pull.changed_files,
      additions: pull.additions,
      deletions: pull.deletions,
      html_url: pull.html_url,
    },
    updatedAt: pull.updated_at,
    nodeId: pull.node_id,
    sourceHash,
    mapperVersion: cfg.MAPPER_VERSION,
    maxBodyChars: cfg.MAX_BODY_CHARS,
    maxComments: cfg.MAX_COMMENTS_PER_ITEM,
    maxFiles: cfg.MAX_CHANGED_FILES_LISTED,
  });

  const properties: Record<string, PropVal> = {
    Title: titleVal(pull.title),
    "GitHub Node ID": richText(pull.node_id),
    Repository: relationVal(repoNotionPageId),
    Type: selectVal("Pull Request"),
    Number: numberVal(pull.number),
    State: selectVal(state),
    Draft: checkboxVal(pull.draft),
    Author: richText(pull.user?.login ?? ""),
    Assignees: multiSelectVal(assignees),
    Labels: multiSelectVal(labels),
    "Review State": selectVal(reviewState),
    "Base Branch": richText(pull.base.ref),
    "Head Branch": richText(pull.head.ref),
    "Created At": dateVal(pull.created_at),
    "Updated At": dateVal(pull.updated_at),
    "Closed At": dateVal(pull.closed_at),
    "Merged At": dateVal(pull.merged_at),
    "GitHub URL": urlVal(pull.html_url),
    "Source Hash": richText(sourceHash),
    "Last Synced": dateVal(nowIso()),
    "Sync Status": statusVal("synced"),
    "Comment Count": numberVal(pull.comments + pull.review_comments),
    Origin: selectVal("github"),
    "Publish State": selectVal("created"),
  };

  const selectOptionsToEnsure: { prop: string; value: string; kind: "select" | "multi_select" }[] = [
    { prop: "Type", value: "Pull Request", kind: "select" },
    { prop: "State", value: state, kind: "select" },
    { prop: "Review State", value: reviewState, kind: "select" },
    { prop: "Origin", value: "github", kind: "select" },
    { prop: "Publish State", value: "created", kind: "select" },
  ];
  const multiSelectValues: { prop: string; values: string[]; kind: "multi_select" }[] = [
    { prop: "Assignees", values: assignees, kind: "multi_select" },
    { prop: "Labels", values: labels, kind: "multi_select" },
  ];

  return {
    githubNodeId: pull.node_id,
    repoNodeId: repo.node_id,
    repoFullName: repo.full_name,
    type: "Pull Request",
    number: pull.number,
    notionProperties: properties,
    markdown,
    githubUpdatedAt: pull.updated_at,
    sourceHash,
    bodyHash: sha256(markdown),
    selectOptionsToEnsure,
    multiSelectValues,
  };
}
