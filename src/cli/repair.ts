import { getNotion, notionCall } from "../notion/client.ts";
import { requireDataSourceId, ensureOption } from "../notion/schema.ts";
import { listRepos, getRepoCodeState, listErrors, getObject } from "../state/sqlite.ts";
import { logger } from "../logging.ts";
import { nowIso } from "../util.ts";

// Repair commands: fix stale or missing Notion properties that backfill couldn't set
// because the properties didn't exist yet at initial sync time.

export async function repairCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "repo-rollups") {
    await repairRepoRollups();
  } else if (sub === "work-item-origins") {
    await repairWorkItemOrigins();
  } else if (sub === "repo-sources") {
    await repairRepoSources();
  } else {
    console.log(`Usage:
  mirror repair repo-rollups         Fix Notion repo code rollup fields (Code HEAD SHA, File Count, etc.)
  mirror repair work-item-origins    Fix missing Origin/Publish State on GitHub-sourced work items
  mirror repair repo-sources         Backfill Source property on Notion repo pages from SQLite
`);
  }
}

// Phase C: After code sync, repo pages may have stale or empty code rollup fields.
// This reads repo_code_state from SQLite and writes the rollup to Notion.
async function repairRepoRollups(): Promise<void> {
  const repos = listRepos();
  const notion = getNotion();
  let fixed = 0;
  let skipped = 0;

  console.log(`Repairing code rollups for ${repos.length} repos...\n`);

  for (const repo of repos) {
    if (!repo.notion_page_id || !repo.repo_full_name) {
      skipped++;
      continue;
    }
    const state = getRepoCodeState(repo.github_node_id);
    if (!state) {
      skipped++;
      continue;
    }

    try {
      await notionCall(() =>
        notion.pages.update({
          page_id: repo.notion_page_id!,
          properties: {
            "Code Sync Enabled": { checkbox: true },
            "Code HEAD SHA": { rich_text: [{ text: { content: state.head_sha?.slice(0, 12) ?? "" } }] },
            "Code File Count": { number: state.file_count ?? 0 },
            "Code Last Synced": { date: { start: state.last_full_scan_at ?? nowIso() } },
            "Code Sync Status": { select: { name: state.sync_status } },
          } as never,
        }),
      );
      fixed++;
      console.log(`  ✓ ${repo.repo_full_name}: ${state.sync_status}, ${state.file_count ?? 0} files`);
    } catch (err) {
      console.error(`  ✗ ${repo.repo_full_name}: ${(err as Error).message}`);
    }
  }

  console.log(`\nRepair complete: ${fixed} fixed, ${skipped} skipped.`);
}

// Phase D: Backfill Origin=github and Publish State=created on work items
// that were synced before these properties existed.
async function repairWorkItemOrigins(): Promise<void> {
  const workDsId = requireDataSourceId("work_items");
  const notion = getNotion();

  // Query all work items where Origin is empty
  // ponytail: Notion API doesn't support "is empty" on select directly, so we query all and filter.
  // Ceiling: use a "not equals" filter on Origin when Notion supports it.
  let cursor: string | undefined;
  let fixed = 0;
  let checked = 0;

  await ensureOption(workDsId, "Origin", "github", "select");
  await ensureOption(workDsId, "Publish State", "created", "select");

  console.log("Scanning work items for missing Origin/Publish State...\n");

  do {
    const res = await notionCall(() =>
      notion.dataSources.query({
        data_source_id: workDsId,
        page_size: 100,
        start_cursor: cursor,
      }),
    );

    for (const page of res.results) {
      checked++;
      const props = (page as { properties: Record<string, unknown> }).properties;
      const originProp = props["Origin"] as { select?: { name?: string } | null } | undefined;
      const origin = originProp?.select?.name;

      if (origin) continue; // Already has Origin set — skip

      // Check if this is a GitHub-sourced item (has GitHub Node ID)
      const nodeIdProp = props["GitHub Node ID"] as { rich_text?: { plain_text?: string }[] } | undefined;
      const nodeId = nodeIdProp?.rich_text?.[0]?.plain_text;
      if (!nodeId) continue; // Notion-created item without GitHub Node ID — leave alone

      try {
        await notionCall(() =>
          notion.pages.update({
            page_id: page.id,
            properties: {
              Origin: { select: { name: "github" } },
              "Publish State": { select: { name: "created" } },
            } as never,
          }),
        );
        fixed++;
      } catch (err) {
        logger.debug({ page_id: page.id, err: (err as Error).message }, "repair work item origin failed");
      }
    }

    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);

  console.log(`\nRepair complete: ${fixed} work items fixed (out of ${checked} checked).`);
}

// Backfill Source property on Notion repo pages from SQLite repo_source.
// Older repos were synced before the Source property existed; their Notion pages
// have Source=null even though SQLite has repo_source=owned.
async function repairRepoSources(): Promise<void> {
  const repos = listRepos();
  const notion = getNotion();
  let fixed = 0;
  let skipped = 0;

  console.log(`Repairing Source property on ${repos.length} repo pages...\n`);

  for (const repo of repos) {
    if (!repo.notion_page_id || !repo.repo_full_name) {
      skipped++;
      continue;
    }
    const source = repo.repo_source ?? "owned";
    try {
      await notionCall(() =>
        notion.pages.update({
          page_id: repo.notion_page_id!,
          properties: {
            Source: { select: { name: source } },
          } as never,
        }),
      );
      fixed++;
    } catch (err) {
      console.error(`  ✗ ${repo.repo_full_name}: ${(err as Error).message}`);
    }
  }

  console.log(`\nRepair complete: ${fixed} fixed, ${skipped} skipped.`);
}
