import { ensureSchema, getDataSourceId } from "../notion/schema.ts";
import { pingNotion, pingRootPage } from "../notion/client.ts";
import { hasGitHubAuth } from "../github/auth.ts";
import { logger } from "../logging.ts";

export async function initCommand(): Promise<void> {
  console.log("mirror init — validating environment and ensuring Notion schema\n");

  console.log("1. Notion token + root page");
  const me = await pingNotion();
  if (!me.ok) {
    console.error(`   FAIL: ${me.error}`);
    process.exit(1);
  }
  console.log("   OK: token valid");

  const root = await pingRootPage();
  if (!root.ok) {
    console.error(`   FAIL: root page — ${root.error}`);
    console.error("   Make sure NOTION_ROOT_PAGE_ID is set and the page is shared with the integration.");
    process.exit(1);
  }
  console.log("   OK: root page accessible");

  console.log("\n2. GitHub auth");
  if (!hasGitHubAuth()) {
    console.error("   FAIL: set GITHUB_TOKEN (PAT) for Phase 1, or GITHUB_APP_ID + GITHUB_INSTALLATION_ID for Phase 2.");
    process.exit(1);
  }
  console.log("   OK: GitHub credentials present");

  console.log("\n3. Notion schema (databases + data sources)");
  const result = await ensureSchema();
  console.log(`   Repositories  — database ${result.repos.database_id}, data source ${result.repos.data_source_id}`);
  console.log(`   Work Items    — database ${result.work_items.database_id}, data source ${result.work_items.data_source_id}`);

  console.log("\n4. Persistence check");
  const reposDs = getDataSourceId("repos");
  const workDs = getDataSourceId("work_items");
  if (!reposDs || !workDs) {
    console.error("   FAIL: data source IDs not persisted");
    process.exit(1);
  }
  console.log("   OK: data source IDs stored in SQLite meta");

  console.log("\ninit complete. Next: `mirror backfill --repo owner/name` to test on one repo.");
  logger.info("init complete");
}
