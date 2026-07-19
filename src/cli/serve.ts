import { loadConfig } from "../config.ts";
import { listRepos, listReposBySource, getRepoCheckpoint, getRepoCodeState, setRepoCheckpoint, setMeta, getMeta, type GithubObjectRow } from "../state/sqlite.ts";
import { syncRepoCode } from "../code-sync.ts";
import { pollReadyIssues } from "../publish.ts";
import {
  listInstallationRepos,
  listStarredRepos,
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
// 2. Star discovery (infrequent — every STAR_REFRESH_HOURS)
// 3. Code sync (only repos whose pushed_at changed since last cycle)
// 4. Issues/PRs incremental (only owned repos whose pushed_at changed)

export async function serveCommand(): Promise<void> {
  const cfg = loadConfig();
  const intervalMs = cfg.RECONCILE_INTERVAL_SECONDS * 1000;

  console.log(`Reconcile loop started (interval: ${cfg.RECONCILE_INTERVAL_SECONDS}s)`);
  console.log("Press Ctrl+C to stop.\n");

  await reconcileOnce();
  const timer = setInterval(() => {
    reconcileOnce().catch((err) => {
      logger.error({ err: (err as Error).message }, "reconcile cycle failed");
    });
  }, intervalMs);

  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\nReconcile loop stopped.");
    process.exit(0);
  });
}

async function reconcileOnce(): Promise<void> {
  const start = Date.now();
  logger.info("reconcile cycle started");

  // 1. Publish ready issues (Notion query, no GitHub API cost)
  try {
    const pub = await pollReadyIssues();
    if (pub.created > 0 || pub.errors > 0) {
      logger.info({ created: pub.created, errors: pub.errors }, "publish cycle done");
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "publish cycle failed");
  }

  // 2. Maybe refresh stars (infrequent)
  try {
    await maybeRefreshStars();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "star refresh failed");
  }

  // 3. Fetch all owned repos once, find which ones changed since last cycle
  let changedRepos: { node_id: string; full_name: string; pushed_at: string }[] = [];
  try {
    changedRepos = await detectChangedRepos();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "detect changed repos failed");
  }

  if (changedRepos.length === 0) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info({ elapsed_s: elapsed, changed: 0 }, "reconcile cycle done (nothing changed)");
    return;
  }

  logger.info({ changed: changedRepos.length }, "repos changed since last cycle");

  // 4. Sync code + work items for changed repos only
  const knownRepos = listRepos();
  for (const changed of changedRepos) {
    const known = knownRepos.find((r) => r.github_node_id === changed.node_id);
    if (!known?.repo_full_name || !known?.notion_page_id) continue;

    const [owner, name] = known.repo_full_name.split("/");
    if (!owner || !name) continue;

    const isStarred = known.repo_source === "starred";

    // Code sync (both owned and starred)
    try {
      await syncRepoCode({
        node_id: known.github_node_id,
        full_name: known.repo_full_name,
        owner,
        name,
        notion_page_id: known.notion_page_id,
      });
    } catch (err) {
      logger.debug({ repo: known.repo_full_name, err: (err as Error).message }, "code reconcile repo failed");
    }

    // Work items sync (owned only — starred repos skip issues/PRs)
    if (!isStarred) {
      try {
        await reconcileWorkItemsForRepo(owner, name, known.github_node_id, known.repo_full_name);
      } catch (err) {
        logger.debug({ repo: known.repo_full_name, err: (err as Error).message }, "work item reconcile repo failed");
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  setMeta("last_reconcile_at", new Date().toISOString());
  logger.info({ elapsed_s: elapsed, changed: changedRepos.length }, "reconcile cycle done");
}

// Refresh stars every STAR_REFRESH_HOURS, not every cycle.
// Also triggers code sync for starred repos whose pushed_at changed.
async function maybeRefreshStars(): Promise<void> {
  const cfg = loadConfig();
  const last = getMeta("last_star_refresh_at");
  if (last) {
    const ageMs = Date.now() - new Date(last).getTime();
    if (ageMs < cfg.STAR_REFRESH_HOURS * 3600_000) return;
  }

  logger.info("refreshing starred repos");
  const stars = await listStarredRepos();
  const owned = await listInstallationRepos();
  const ownedIds = new Set(owned.map((r) => r.node_id));

  // Build a map of existing starred repos from SQLite to compare pushed_at
  const existingStars = new Map<string, GithubObjectRow>();
  for (const row of listReposBySource("starred")) {
    existingStars.set(row.github_node_id, row);
  }

  let upserted = 0;
  let codeSynced = 0;
  const seenNodeIds = new Set<string>();

  for (const repo of stars) {
    seenNodeIds.add(repo.node_id);
    if (ownedIds.has(repo.node_id)) continue;

    const existing = existingStars.get(repo.node_id);
    // Determine if code sync is needed: compare repo.pushed_at to last code scan time.
    // New stars (no existing row) always need initial code sync.
    // Existing stars need code sync only if pushed_at is newer than last_full_scan_at.
    const codeState = existing ? getRepoCodeState(repo.node_id) : null;
    const needsCodeSync = !codeState
      || (repo.pushed_at && codeState.last_full_scan_at && repo.pushed_at > codeState.last_full_scan_at)
      || (repo.pushed_at && !codeState.last_full_scan_at);

    try {
      const repoPageId = await upsertRepo(projectRepo(repo, undefined, "starred"));
      upserted++;

      // If pushed_at changed (or new star), sync code for this starred repo
      if (needsCodeSync) {
        const [owner, name] = repo.full_name.split("/");
        if (owner && name) {
          try {
            await syncRepoCode({
              node_id: repo.node_id,
              full_name: repo.full_name,
              owner,
              name,
              notion_page_id: repoPageId,
            });
            codeSynced++;
          } catch (err) {
            logger.debug({ repo: repo.full_name, err: (err as Error).message }, "star code sync failed");
          }
        }
      }
    } catch (err) {
      logger.debug({ repo: repo.full_name, err: (err as Error).message }, "star upsert failed");
    }
  }

  // Mark starred repos that are no longer starred as missing
  for (const [nodeId, row] of existingStars) {
    if (!seenNodeIds.has(nodeId) && row.repo_full_name) {
      logger.info({ repo: row.repo_full_name }, "star removed (no longer starred)");
      // ponytail: just log, don't delete the Notion page. Ceiling: mark as unstarred or delete.
    }
  }

  setMeta("last_star_refresh_at", new Date().toISOString());
  logger.info({ stars: stars.length, upserted, codeSynced }, "star refresh done");
}

// Fetch all repos from GitHub (1 API call), compare pushed_at to last cycle.
// Returns only repos whose pushed_at changed. Updates the watermark.
async function detectChangedRepos(): Promise<{ node_id: string; full_name: string; pushed_at: string }[]> {
  const allRepos = await listInstallationRepos();
  const lastWatermark = getMeta("reconcile_pushed_watermark");
  const changed: { node_id: string; full_name: string; pushed_at: string }[] = [];

  for (const repo of allRepos) {
    if (!repo.pushed_at) continue;
    if (!lastWatermark || repo.pushed_at > lastWatermark) {
      changed.push({ node_id: repo.node_id, full_name: repo.full_name, pushed_at: repo.pushed_at });
    }
  }

  // Update watermark to latest pushed_at
  if (allRepos.length > 0) {
    const latest = allRepos.reduce((a, b) => ((a.pushed_at ?? "") > (b.pushed_at ?? "") ? a : b));
    if (latest.pushed_at) setMeta("reconcile_pushed_watermark", latest.pushed_at);
  }

  return changed;
}

async function reconcileWorkItemsForRepo(owner: string, name: string, repoNodeId: string, repoFullName: string): Promise<void> {
  const cfg = loadConfig();
  const checkpoint = getRepoCheckpoint(repoNodeId);
  const issuesWatermark = checkpoint?.issues_updated_watermark;
  const prsWatermark = checkpoint?.prs_updated_watermark;

  const repoData = await loadRepo(owner, name);
  const repoPageId = await upsertRepo(projectRepo(repoData));

  // Incremental issues
  const issues = await listIssuesForBackfill(owner, name, true);
  const newIssues = issuesWatermark
    ? issues.filter((i) => i.updated_at > issuesWatermark)
    : [];

  for (const issueSummary of newIssues) {
    try {
      const full = await loadIssue(owner, name, issueSummary.number);
      const comments = await loadIssueComments(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM);
      const proj = projectIssue(full, repoData, repoPageId, { comments });
      await upsertWorkItem(proj);
    } catch (err) {
      markObjectError(issueSummary.node_id, err);
    }
  }

  if (issues.length > 0) {
    const latestIssue = issues.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
    setRepoCheckpoint(repoNodeId, repoFullName, "issues_updated_watermark", latestIssue.updated_at);
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
    } catch (err) {
      markObjectError(pullSummary.node_id, err);
    }
  }

  if (pulls.length > 0) {
    const latestPull = pulls.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
    setRepoCheckpoint(repoNodeId, repoFullName, "prs_updated_watermark", latestPull.updated_at);
  }

  if (newIssues.length > 0 || newPulls.length > 0) {
    logger.info({ repo: repoFullName, newIssues: newIssues.length, newPulls: newPulls.length }, "work items synced");
  }
}
