import { listRepos, getRepoCodeState } from "../state/sqlite.ts";
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

  const repos = listRepos().filter((r) => !r.sync_status.includes("missing"));
  let targets = repos;

  if (repoArg) {
    targets = repos.filter((r) => r.repo_full_name === repoArg);
  } else if (ownedOnly) {
    targets = repos.filter((r) => !r.repo_full_name?.includes("starred"));
    // ponytail: filter by Source property would require Notion query; for now all existing repos are owned.
    // Ceiling: store repo_source in SQLite to filter precisely.
  } else if (starsOnly) {
    // Stars are upserted with Source=starred in Notion but we don't have Source in SQLite yet.
    // Filter: repos that exist in SQLite but were NOT in the owned list.
    // For now, --stars syncs all repos not in the owned set.
    // ponytail: this is imprecise; add repo_source column to github_objects for exact filtering.
    targets = repos; // sync all — the caller should run --stars after backfill --stars
  }

  if (targets.length === 0) {
    console.error(`No repos found${repoArg ? ` matching ${repoArg}` : ""}. Run \`mirror backfill\` first.`);
    process.exit(1);
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
    }
    reposDone++;
    if (reposDone % 10 === 0) console.log(`\n--- ${reposDone}/${targets.length} repos done ---\n`);
  }

  console.log(`\nCode sync complete: ${totalSynced} files synced, ${totalSkipped} skipped, ${totalErrors} errors across ${targets.length} repos.`);
}

async function codeStatusCommand(): Promise<void> {
  const repos = listRepos();
  console.log("Code sync status:\n");
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
