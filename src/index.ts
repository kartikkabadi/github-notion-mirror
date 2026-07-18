#!/usr/bin/env bun
import { initCommand } from "./cli/init.ts";
import { backfillCommand, syncSingle } from "./cli/backfill.ts";
import { statusCommand } from "./cli/status.ts";
import { doctorCommand } from "./cli/doctor.ts";

const USAGE = `GitHub Notion Mirror v1 — Phase 1

Usage:
  mirror init                              Validate env + create/ensure Notion DBs
  mirror backfill [--repo owner/name]      Backfill repos, issues, PRs
  mirror sync issue owner/name#n           Sync a single issue
  mirror sync pull owner/name#n            Sync a single PR
  mirror status                            Show queue/state summary
  mirror doctor                            Run health checks

Phase 2+ commands (not yet implemented):
  mirror serve                             Start webhook server + worker + reconcile
  mirror reconcile                         One-shot incremental reconcile
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    switch (cmd) {
      case "init":
        await initCommand();
        break;
      case "backfill":
        await backfillCommand(rest);
        break;
      case "sync":
        if (rest[0] === "issue" && rest[1]) {
          await syncSingle("issue", rest[1]);
        } else if (rest[0] === "pull" && rest[1]) {
          await syncSingle("pull", rest[1]);
        } else {
          console.error("Usage: mirror sync issue|pull owner/name#n");
          process.exit(1);
        }
        break;
      case "status":
        statusCommand();
        break;
      case "doctor":
        await doctorCommand();
        break;
      case "serve":
      case "reconcile":
        console.error(`"${cmd}" is Phase 2/3 — not implemented yet. See docs/AGENT_NOTES.md.`);
        process.exit(1);
      case "--help":
      case "-h":
      case "help":
        console.log(USAGE);
        break;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
