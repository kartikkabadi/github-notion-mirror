import { loadConfig } from "../config.ts";
import { listRepos, getRepoCheckpoint, setRepoCheckpoint } from "../state/sqlite.ts";
import { syncRepoCode } from "../code-sync.ts";
import { pollReadyIssues } from "../publish.ts";
import {
  listIssuesForBackfill,
  listPullsForBackfill,
  loadRepo,
  loadIssue,
  loadIssueComments,
  loadPull,
  loadPullReviews,
  loadPullReviewComments,
  loadPullFiles,
} from "../github/loaders.ts";
import { projectRepo, projectIssue, projectPull } from "../projection.ts";
import { upsertRepo, upsertWorkItem, markObjectError } from "../notion/upsert.ts";
import { logger } from "../logging.ts";

// Reconcile loop: runs every N seconds, doing incremental sync of:
// 1. Notion → GitHub issue creation (Publish State = ready)
// 2. Code sync (HEAD sha changed → sync changed files)
// 3. Issues/PRs incremental (updated_at watermark → sync changed items)

export async function serveCommand(): Promise<void> {
  const cfg = loadConfig();
  const intervalMs = cfg.RECONCILE_INTERVAL_SECONDS * 1000;

  console.log(`Reconcile loop started (interval: ${cfg.RECONCILE_INTERVAL_SECONDS}s)`);
  console.log("Press Ctrl+C to stop.\n");

  // Run once immediately, then on interval
  await reconcileOnce();
  const timer = setInterval(() => {
    reconcileOnce().catch((err) => {
      logger.error({ err: (err as Error).message }, "reconcile cycle failed");
    });
  }, intervalMs);

  // Keep process alive
  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\nReconcile loop stopped.");
    process.exit(0);
  });
}

async function reconcileOnce(): Promise<void> {
  const start = Date.now();
  logger.info("reconcile cycle started");

  // 1. Publish ready issues
  try {
    const pub = await pollReadyIssues();
    if (pub.created > 0 || pub.errors > 0) {
      logger.info({ created: pub.created, errors: pub.errors }, "publish cycle done");
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "publish cycle failed");
  }

  // 2. Incremental code sync (check HEAD sha for each repo)
  try {
    await reconcileCode();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "code reconcile failed");
  }

  // 3. Incremental issue/PR sync (watermark-based)
  try {
    await reconcileWorkItems();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "work item reconcile failed");
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info({ elapsed_s: elapsed }, "reconcile cycle done");
}

async function reconcileCode(): Promise<void> {
  const repos = listRepos().filter((r) => r.repo_full_name && r.notion_page_id);
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const repo of repos) {
    if (!repo.repo_full_name || !repo.notion_page_id) continue;
    const [owner, name] = repo.repo_full_name.split("/");
    if (!owner || !name) continue;

    try {
      const result = await syncRepoCode({
        node_id: repo.github_node_id,
        full_name: repo.repo_full_name,
        owner,
        name,
        notion_page_id: repo.notion_page_id,
      });
      synced += result.synced;
      skipped += result.skipped;
      errors += result.errors;
    } catch (err) {
      errors++;
      logger.debug({ repo: repo.repo_full_name, err: (err as Error).message }, "code reconcile repo failed");
    }
  }

  if (synced > 0 || errors > 0) {
    logger.info({ synced, skipped, errors, repos: repos.length }, "code reconcile done");
  }
}

async function reconcileWorkItems(): Promise<void> {
  const cfg = loadConfig();
  const repos = listRepos().filter((r) => r.repo_full_name);
  let totalSynced = 0;

  for (const repo of repos) {
    if (!repo.repo_full_name) continue;
    const [owner, name] = repo.repo_full_name.split("/");
    if (!owner || !name) continue;

    const checkpoint = getRepoCheckpoint(repo.github_node_id);
    const issuesWatermark = checkpoint?.issues_updated_watermark;
    const prsWatermark = checkpoint?.prs_updated_watermark;

    try {
      // Fetch repo to get current state + page id
      const repoData = await loadRepo(owner, name);
      const repoPageId = await upsertRepo(projectRepo(repoData));

      // Incremental issues: fetch issues updated since watermark
      const issues = await listIssuesForBackfill(owner, name, true);
      const newIssues = issuesWatermark
        ? issues.filter((i) => i.updated_at > issuesWatermark)
        : [];
      // ponytail: on first run (no watermark), skip — backfill already done.
      // Ceiling: use GitHub's since parameter for server-side filtering.

      for (const issueSummary of newIssues) {
        try {
          const full = await loadIssue(owner, name, issueSummary.number);
          const comments = await loadIssueComments(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM);
          const proj = projectIssue(full, repoData, repoPageId, { comments });
          await upsertWorkItem(proj);
          totalSynced++;
        } catch (err) {
          markObjectError(issueSummary.node_id, err);
        }
      }

      // Update watermark
      if (issues.length > 0) {
        const latestIssue = issues.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
        setRepoCheckpoint(repo.github_node_id, repo.repo_full_name, "issues_updated_watermark", latestIssue.updated_at);
      }

      // Incremental PRs
      const pulls = await listPullsForBackfill(owner, name, true);
      const newPulls = prsWatermark
        ? pulls.filter((p) => p.updated_at > prsWatermark)
        : [];

      for (const pullSummary of newPulls) {
        try {
          const full = await loadPull(owner, name, pullSummary.number);
          const [issueComments, reviews, reviewComments, files] = await Promise.all([
            loadIssueComments(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM),
            loadPullReviews(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM),
            loadPullReviewComments(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM),
            loadPullFiles(owner, name, full.number, cfg.MAX_CHANGED_FILES_LISTED),
          ]);
          const proj = projectPull(full, repoData, repoPageId, { issueComments, reviews, reviewComments, files });
          await upsertWorkItem(proj);
          totalSynced++;
        } catch (err) {
          markObjectError(pullSummary.node_id, err);
        }
      }

      if (pulls.length > 0) {
        const latestPull = pulls.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
        setRepoCheckpoint(repo.github_node_id, repo.repo_full_name, "prs_updated_watermark", latestPull.updated_at);
      }
    } catch (err) {
      logger.debug({ repo: repo.repo_full_name, err: (err as Error).message }, "work item reconcile repo failed");
    }
  }

  if (totalSynced > 0) {
    logger.info({ synced: totalSynced }, "work item reconcile done");
  }
}
