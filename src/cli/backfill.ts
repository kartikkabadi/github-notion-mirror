import { loadConfig } from "../config.ts";
import {
  listInstallationRepos,
  listStarredRepos,
  loadRepo,
  loadIssue,
  loadIssueComments,
  loadPull,
  listIssuesForBackfill,
  listPullsForBackfill,
  loadPullReviews,
  loadPullReviewComments,
  loadPullFiles,
  type RepoData,
} from "../github/loaders.ts";
import { projectRepo, projectIssue, projectPull } from "../projection.ts";
import { upsertRepo, upsertWorkItem, markObjectError } from "../notion/upsert.ts";
import { getObject, setMeta } from "../state/sqlite.ts";
import { logger } from "../logging.ts";

function parseRepoArg(arg: string | undefined): { owner: string; repo: string } | null {
  if (!arg) return null;
  const m = arg.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) {
    console.error(`Invalid --repo value "${arg}". Expected owner/name.`);
    process.exit(1);
  }
  return { owner: m[1]!, repo: m[2]! };
}

export async function backfillCommand(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const includeClosed = cfg.BACKFILL_INCLUDE_CLOSED || args.includes("--include-closed");
  const starsOnly = args.includes("--stars");
  const repoArg = args.find((a) => a.startsWith("--repo="))?.slice(7)
    ?? (args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined);
  const target = parseRepoArg(repoArg);

  if (starsOnly) {
    await backfillStars();
    return;
  }

  const repos: RepoData[] = target ? [await loadRepo(target.owner, target.repo)] : await listInstallationRepos();

  console.log(`Backfilling ${repos.length} repo(s) (include_closed=${includeClosed})\n`);

  for (const repo of repos) {
    if (repo.archived && !cfg.BACKFILL_INCLUDE_CLOSED) {
      console.log(`- skip ${repo.full_name} (archived)`);
      continue;
    }
    await backfillRepo(repo, includeClosed, "owned");
  }
  console.log("\nBackfill complete.");
}

async function backfillStars(): Promise<void> {
  console.log("Fetching starred repos...");
  const stars = await listStarredRepos();
  console.log(`Found ${stars.length} starred repo(s)\n`);

  // Get owned repos to detect overlap (owned wins)
  const owned = await listInstallationRepos();
  const ownedIds = new Set(owned.map((r) => r.node_id));

  let upserted = 0;
  let skipped = 0;
  for (const repo of stars) {
    if (ownedIds.has(repo.node_id)) {
      // Already owned — skip, owned backfill handles it
      skipped++;
      continue;
    }
    try {
      const repoProj = projectRepo(repo, undefined, "starred");
      await upsertRepo(repoProj);
      upserted++;
      if (upserted % 10 === 0) console.log(`  ... ${upserted} starred repos upserted`);
    } catch (err) {
      console.error(`- star ${repo.full_name} failed: ${(err as Error).message}`);
      markObjectError(repo.node_id, err);
    }
  }

  setMeta("last_star_refresh_at", new Date().toISOString());
  console.log(`\nStar backfill complete: ${upserted} upserted, ${skipped} already owned.`);
}

async function backfillRepo(repo: RepoData, includeClosed: boolean, source: "owned" | "starred"): Promise<void> {
  const cfg = loadConfig();
  const [owner, name] = repo.full_name.split("/");
  if (!owner || !name) {
    console.error(`Cannot parse owner/name from ${repo.full_name}`);
    return;
  }

  console.log(`\n== ${repo.full_name} ==`);

  // 1. Upsert repo row first so work items can relate to it.
  let repoPageId: string;
  try {
    const repoProj = projectRepo(repo, undefined, source);
    repoPageId = await upsertRepo(repoProj);
  } catch (err) {
    console.error(`- repo upsert failed: ${(err as Error).message}`);
    markObjectError(repo.node_id, err);
    return;
  }

  // Starred repos: code only, no issues/PRs
  if (source === "starred") {
    console.log("- starred repo (code only, skipping issues/PRs)");
    return;
  }

  // 2. Issues
  const issues = await listIssuesForBackfill(owner, name, includeClosed);
  console.log(`- ${issues.length} issue(s)`);
  for (const issueSummary of issues) {
    try {
      const full = await loadIssue(owner, name, issueSummary.number);
      const comments = await loadIssueComments(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM);
      const proj = projectIssue(full, repo, repoPageId, { comments });
      await upsertWorkItem(proj);
    } catch (err) {
      console.error(`- issue #${issueSummary.number} failed: ${(err as Error).message}`);
      markObjectError(issueSummary.node_id, err);
    }
  }

  // 3. Pulls
  const pulls = await listPullsForBackfill(owner, name, includeClosed);
  console.log(`- ${pulls.length} pull(s)`);
  for (const pullSummary of pulls) {
    try {
      const full = await loadPull(owner, name, pullSummary.number);
      const [issueComments, reviews, reviewComments, files] = await Promise.all([
        loadIssueComments(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM),
        loadPullReviews(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM),
        loadPullReviewComments(owner, name, full.number, cfg.MAX_COMMENTS_PER_ITEM),
        loadPullFiles(owner, name, full.number, cfg.MAX_CHANGED_FILES_LISTED),
      ]);
      const proj = projectPull(full, repo, repoPageId, { issueComments, reviews, reviewComments, files });
      await upsertWorkItem(proj);
    } catch (err) {
      console.error(`- pull #${pullSummary.number} failed: ${(err as Error).message}`);
      markObjectError(pullSummary.node_id, err);
    }
  }

  logger.info({ repo: repo.full_name }, "repo backfill done");
}

export async function syncSingle(kind: "issue" | "pull", target: string): Promise<void> {
  const cfg = loadConfig();
  const m = target.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m) {
    console.error(`Invalid target "${target}". Expected owner/name#number.`);
    process.exit(1);
  }
  const [, owner, name, numStr] = m;
  const number = Number(numStr);
  const repo = await loadRepo(owner!, name!);
  const repoPageId = await upsertRepo(projectRepo(repo));

  if (kind === "issue") {
    const full = await loadIssue(owner!, name!, number);
    const comments = await loadIssueComments(owner!, name!, number, cfg.MAX_COMMENTS_PER_ITEM);
    await upsertWorkItem(projectIssue(full, repo, repoPageId, { comments }));
  } else {
    const full = await loadPull(owner!, name!, number);
    const [issueComments, reviews, reviewComments, files] = await Promise.all([
      loadIssueComments(owner!, name!, number, cfg.MAX_COMMENTS_PER_ITEM),
      loadPullReviews(owner!, name!, number, cfg.MAX_COMMENTS_PER_ITEM),
      loadPullReviewComments(owner!, name!, number, cfg.MAX_COMMENTS_PER_ITEM),
      loadPullFiles(owner!, name!, number, cfg.MAX_CHANGED_FILES_LISTED),
    ]);
    await upsertWorkItem(projectPull(full, repo, repoPageId, { issueComments, reviews, reviewComments, files }));
  }
  console.log(`Synced ${kind} ${target}`);
}
