import { describe, it, expect, beforeEach } from "vitest";

// Tests for projection logic that don't require Notion or GitHub network calls.
// We import projection functions and exercise them with fixture data.

// Set env before importing config-dependent modules.
process.env.NOTION_TOKEN = "test-token";
process.env.NOTION_ROOT_PAGE_ID = "00000000-0000-0000-0000-000000000000";
process.env.GITHUB_TOKEN = "test-token";
process.env.MAPPER_VERSION = "1";
process.env.MAX_BODY_CHARS = "100000";
process.env.MAX_COMMENTS_PER_ITEM = "50";
process.env.MAX_CHANGED_FILES_LISTED = "100";

// Import after env is set so config loads with test values.
const { projectRepo, projectIssue, projectPull } = await import("../src/projection.ts");

const repoFixture = {
  node_id: "R_kgA1",
  id: 1,
  name: "test",
  full_name: "owner/test",
  owner: { login: "owner" },
  html_url: "https://github.com/owner/test",
  description: "a repo",
  visibility: "public" as const,
  default_branch: "main",
  language: "TypeScript",
  archived: false,
  fork: false,
  pushed_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

const issueFixture = {
  node_id: "I_kgA1",
  id: 10,
  number: 5,
  title: "Bug: thing broken",
  state: "open" as const,
  state_reason: null,
  body: "Steps to reproduce...",
  user: { login: "alice" },
  assignees: [{ login: "bob" }],
  labels: [{ name: "bug" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  html_url: "https://github.com/owner/test/issues/5",
  comments: 0,
};

const closedIssueFixture = { ...issueFixture, node_id: "I_kgA2", number: 6, state: "closed" as const, closed_at: "2026-01-03T00:00:00Z" };

const pullOpenFixture = {
  node_id: "PR_kgA1",
  id: 20,
  number: 7,
  title: "Fix thing",
  state: "open" as const,
  body: "This PR fixes...",
  user: { login: "carol" },
  assignees: [],
  labels: [],
  draft: false,
  head: { ref: "fix", label: "owner:fix" },
  base: { ref: "main", label: "owner:main" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  merged_at: null,
  merged: false,
  html_url: "https://github.com/owner/test/pull/7",
  comments: 0,
  review_comments: 0,
  commits: 1,
  additions: 10,
  deletions: 2,
  changed_files: 1,
};

const pullMergedFixture = { ...pullOpenFixture, node_id: "PR_kgA2", number: 8, state: "closed" as const, merged: true, merged_at: "2026-01-03T00:00:00Z" };
const pullClosedNotMergedFixture = { ...pullOpenFixture, node_id: "PR_kgA3", number: 9, state: "closed" as const, merged: false };

describe("projectRepo", () => {
  it("produces a stable source hash for identical input", () => {
    const a = projectRepo(repoFixture);
    const b = projectRepo(repoFixture);
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it("changes hash when a hashed field changes", () => {
    const a = projectRepo(repoFixture);
    const b = projectRepo({ ...repoFixture, description: "different" });
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it("includes visibility as a select option to ensure", () => {
    const a = projectRepo(repoFixture);
    expect(a.selectOptionsToEnsure.find((o) => o.prop === "Visibility" && o.value === "public")).toBeTruthy();
  });

  it("defaults Source to owned", () => {
    const a = projectRepo(repoFixture);
    const sourceProp = a.notionProperties["Source"] as { select: { name: string } };
    expect(sourceProp.select.name).toBe("owned");
    expect(a.source).toBe("owned");
  });

  it("sets Source to starred when passed", () => {
    const a = projectRepo(repoFixture, undefined, "starred");
    const sourceProp = a.notionProperties["Source"] as { select: { name: string } };
    expect(sourceProp.select.name).toBe("starred");
    expect(a.source).toBe("starred");
  });

  it("includes Source in selectOptionsToEnsure", () => {
    const a = projectRepo(repoFixture);
    expect(a.selectOptionsToEnsure.find((o) => o.prop === "Source" && o.value === "owned")).toBeTruthy();
  });
});

describe("projectIssue state mapping", () => {
  it("maps open issue to State=open", () => {
    const proj = projectIssue(issueFixture, repoFixture, "repo-page-id", { comments: [] });
    const stateProp = proj.notionProperties["State"] as { select: { name: string } };
    expect(stateProp.select.name).toBe("open");
  });

  it("maps closed issue to State=closed", () => {
    const proj = projectIssue(closedIssueFixture, repoFixture, "repo-page-id", { comments: [] });
    const stateProp = proj.notionProperties["State"] as { select: { name: string } };
    expect(stateProp.select.name).toBe("closed");
  });

  it("sets Type=Issue", () => {
    const proj = projectIssue(issueFixture, repoFixture, "repo-page-id", { comments: [] });
    const typeProp = proj.notionProperties["Type"] as { select: { name: string } };
    expect(typeProp.select.name).toBe("Issue");
  });

  it("produces stable hash for identical input", () => {
    const a = projectIssue(issueFixture, repoFixture, "repo-page-id", { comments: [] });
    const b = projectIssue(issueFixture, repoFixture, "repo-page-id", { comments: [] });
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it("hash changes when a comment is added", () => {
    const a = projectIssue(issueFixture, repoFixture, "repo-page-id", { comments: [] });
    const b = projectIssue(issueFixture, repoFixture, "repo-page-id", {
      comments: [{ id: 1, user: { login: "x" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", body: "hi" }],
    });
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it("sets Origin=github and Publish State=created", () => {
    const proj = projectIssue(issueFixture, repoFixture, "repo-page-id", { comments: [] });
    const originProp = proj.notionProperties["Origin"] as { select: { name: string } };
    const pubProp = proj.notionProperties["Publish State"] as { select: { name: string } };
    expect(originProp.select.name).toBe("github");
    expect(pubProp.select.name).toBe("created");
  });

  it("includes Origin and Publish State in selectOptionsToEnsure", () => {
    const proj = projectIssue(issueFixture, repoFixture, "repo-page-id", { comments: [] });
    expect(proj.selectOptionsToEnsure.find((o) => o.prop === "Origin" && o.value === "github")).toBeTruthy();
    expect(proj.selectOptionsToEnsure.find((o) => o.prop === "Publish State" && o.value === "created")).toBeTruthy();
  });
});

describe("projectPull merged vs closed", () => {
  it("maps merged PR to State=merged", () => {
    const proj = projectPull(pullMergedFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [],
    });
    const stateProp = proj.notionProperties["State"] as { select: { name: string } };
    expect(stateProp.select.name).toBe("merged");
  });

  it("maps closed-not-merged PR to State=closed", () => {
    const proj = projectPull(pullClosedNotMergedFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [],
    });
    const stateProp = proj.notionProperties["State"] as { select: { name: string } };
    expect(stateProp.select.name).toBe("closed");
  });

  it("maps open PR to State=open", () => {
    const proj = projectPull(pullOpenFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [],
    });
    const stateProp = proj.notionProperties["State"] as { select: { name: string } };
    expect(stateProp.select.name).toBe("open");
  });

  it("sets Type=Pull Request and Draft=false for non-draft", () => {
    const proj = projectPull(pullOpenFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [],
    });
    const typeProp = proj.notionProperties["Type"] as { select: { name: string } };
    const draftProp = proj.notionProperties["Draft"] as { checkbox: boolean };
    expect(typeProp.select.name).toBe("Pull Request");
    expect(draftProp.checkbox).toBe(false);
  });

  it("includes Changes section in markdown for PRs", () => {
    const proj = projectPull(pullOpenFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [{ filename: "src/x.ts", status: "modified", additions: 5, deletions: 1, patch: "@@ -1,3 +1,5 @@\n+new line\n+another line" }],
    });
    expect(proj.markdown).toContain("## Changes");
    expect(proj.markdown).toContain("src/x.ts");
  });

  it("produces stable hash for identical input", () => {
    const a = projectPull(pullOpenFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [],
    });
    const b = projectPull(pullOpenFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [],
    });
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it("sets Origin=github and Publish State=created on PRs", () => {
    const proj = projectPull(pullOpenFixture, repoFixture, "repo-page-id", {
      issueComments: [],
      reviews: [],
      reviewComments: [],
      files: [],
    });
    const originProp = proj.notionProperties["Origin"] as { select: { name: string } };
    const pubProp = proj.notionProperties["Publish State"] as { select: { name: string } };
    expect(originProp.select.name).toBe("github");
    expect(pubProp.select.name).toBe("created");
  });
});
