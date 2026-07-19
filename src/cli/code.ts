import { listRepos, listReposBySource, getRepoCodeState, setMeta, getMeta } from "../state/sqlite.ts";
import { syncRepoCode } from "../code-sync.ts";
import { logger } from "../logging.ts";

export async function codeCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "sync") {
    await codeSyncCommand(args.slice(1));
  } else if (sub === "status") {
    await codeStatusCommand();
  } else {
    console.log(`Usage:
  mirror code sync [--all|--owned|--stars]   Sync repo code files to Notion
                   [--repo owner/name]
  mirror code status                          Show code sync state per repo
`);
  }
}

async function codeSyncCommand(args: string[]): Promise<void> {
  const all = args.includes("--all");
  const ownedOnly = args.includes("--owned");
  const starsOnly = args.includes("--stars");
  const repoArg = args.find((a) => a.startsWith("--repo="))?.split("=")[1]
    ?? (args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined);

  if (!all && !repoArg && !ownedOnly && !starsOnly) {
    console.error("Usage: mirror code sync --all | --owned | --stars | --repo owner/name");
    process.exit(1);
  }

  let targets;
  if (repoArg) {
    targets = listRepos().filter((r) => r.repo_full_name === repoArg && !r.sync_status.includes("missing"));
  } else if (ownedOnly) {
    targets = listReposBySource("owned").filter((r) => !r.sync_status.includes("missing"));
  } else if (starsOnly) {
    targets = listReposBySource("starred").filter((r) => !r.sync_status.includes("missing"));
  } else {
    // --all: everything
    targets = listRepos().filter((r) => !r.sync_status.includes("missing"));
  }

  if (targets.length === 0) {
    console.error(`No repos found${repoArg ? ` matching ${repoArg}` : ""}. Run \`mirror backfill\` first.`);
    process.exit(1);
  }

  // Sort starred repos by size ascending so one huge star doesn't block hundreds.
  // ponytail: GitHub doesn't give us repo size in the SQLite row, so we sort by
  // existing code state file_count (already-synced repos first), then by name.
  // Ceiling: fetch repo size from GitHub API for true size-ascending order.
  if (starsOnly) {
    targets.sort((a, b) => {
      const sa = getRepoCodeState(a.github_node_id);
      const sb = getRepoCodeState(b.github_node_id);
      // Repos without code state first (need syncing), sorted by name
      if (!sa && sb) return -1;
      if (sa && !sb) return 1;
      if (!sa && !sb) return (a.repo_full_name ?? "").localeCompare(b.repo_full_name ?? "");
      // Both have state — sort by file count ascending
      return (sa!.file_count ?? 0) - (sb!.file_count ?? 0);
    });
  }

  // For star sync: persist progress counters so restart resumes cleanly.
  if (starsOnly) {
    setMeta("stars_code_total", String(targets.length));
    setMeta("stars_code_done", "0");
    setMeta("stars_code_current", "");
  }

  console.log(`Code syncing ${targets.length} repo(s)...\n`);

  let totalSynced = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let reposDone = 0;

  for (const repo of targets) {
    if (!repo.repo_full_name) continue;
    const [owner, name] = repo.repo_full_name.split("/");
    if (!owner || !name) continue;

    if (starsOnly) setMeta("stars_code_current", repo.repo_full_name);

    console.log(`== ${repo.repo_full_name} ==`);
    try {
      const result = await syncRepoCode({
        node_id: repo.github_node_id,
        full_name: repo.repo_full_name,
        owner,
        name,
        notion_page_id: repo.notion_page_id,
      });
      totalSynced += result.synced;
      totalSkipped += result.skipped;
      totalErrors += result.errors;
      console.log(`  synced: ${result.synced}, skipped: ${result.skipped}, errors: ${result.errors}`);
    } catch (err) {
      console.log(`  FAILED: ${(err as Error).message}`);
      totalErrors++;
      if (starsOnly) setMeta("stars_code_last_error", `${repo.repo_full_name}: ${(err as Error).message}`);
    }
    reposDone++;
    if (starsOnly) setMeta("stars_code_done", String(reposDone));
    if (reposDone % 10 === 0) console.log(`\n--- ${reposDone}/${targets.length} repos done ---\n`);
  }

  if (starsOnly) setMeta("stars_code_current", "");

  console.log(`\nCode sync complete: ${totalSynced} files synced, ${totalSkipped} skipped, ${totalErrors} errors across ${targets.length} repos.`);
}

async function codeStatusCommand(): Promise<void> {
  const repos = listRepos();
  console.log("Code sync status:\n");

  // Star code progress
  const starsTotal = getMeta("stars_code_total");
  if (starsTotal) {
    const starsDone = getMeta("stars_code_done") ?? "0";
    const starsCurrent = getMeta("stars_code_current") ?? "";
    const starsError = getMeta("stars_code_last_error");
    const remaining = Math.max(0, Number(starsTotal) - Number(starsDone));
    console.log(`Star code sync: ${starsDone}/${starsTotal} done, ${remaining} remaining`);
    if (starsCurrent) console.log(`  Current: ${starsCurrent}`);
    if (starsError) console.log(`  Last error: ${starsError.slice(0, 100)}`);
    console.log();
  }

  for (const repo of repos) {
    if (!repo.repo_full_name) continue;
    const state = getRepoCodeState(repo.github_node_id);
    if (state) {
      console.log(`  ${repo.repo_full_name}: ${state.sync_status}, ${state.synced_count ?? 0}/${state.file_count ?? 0} files, HEAD ${state.head_sha?.slice(0, 8) ?? "none"}`);
    } else {
      console.log(`  ${repo.repo_full_name}: (not synced)`);
    }
  }
}
