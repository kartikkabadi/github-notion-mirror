import { listRepos, listErrors, getMeta } from "../state/sqlite.ts";
import { getDataSourceId } from "../notion/schema.ts";

export function statusCommand(): void {
  const repos = listRepos();
  const errors = listErrors(20);
  const reposDs = getDataSourceId("repos");
  const workDs = getDataSourceId("work_items");
  const lastReconcile = getMeta("last_reconcile_at");

  console.log("GitHub Notion Mirror — status\n");
  console.log(`Repositories tracked: ${repos.length}`);
  console.log(`Repos data source:    ${reposDs || "(not set — run init)"}`);
  console.log(`Work items data src:  ${workDs || "(not set — run init)"}`);
  console.log(`Last reconcile:       ${lastReconcile ?? "(never)"}`);
  console.log(`\nErrors / missing (last 20):`);
  if (errors.length === 0) {
    console.log("  none");
  } else {
    for (const e of errors) {
      console.log(`  [${e.sync_status}] ${e.repo_full_name ?? ""} ${e.object_type} ${e.number ?? ""} — ${e.last_error ?? "?"}`);
    }
  }
}
