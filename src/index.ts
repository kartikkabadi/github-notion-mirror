#!/usr/bin/env bun
import { initCommand } from "./cli/init.ts";
import { backfillCommand, syncSingle } from "./cli/backfill.ts";
import { statusCommand } from "./cli/status.ts";
import { doctorCommand } from "./cli/doctor.ts";
import { codeCommand } from "./cli/code.ts";
import { pollReadyIssues } from "./publish.ts";
import { serveCommand } from "./cli/serve.ts";

const USAGE = `GitHub Notion Mirror

Usage:
  mirror init                              Validate env + create/ensure Notion DBs
  mirror backfill [--repo owner/name]      Backfill repos, issues, PRs
  mirror sync issue owner/name#n           Sync a single issue
  mirror sync pull owner/name#n            Sync a single PR
  mirror code sync [--all | --repo o/r]    Sync repo code files to Notion
  mirror code status                       Show code sync state per repo
  mirror status                            Show queue/state summary
  mirror doctor                            Run health checks
  mirror publish                           Create GitHub issues from Notion (Publish State=ready)
  mirror serve                             Start auto-sync reconcile loop (30s interval)
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
      case "code":
        await codeCommand(rest);
        break;
      case "publish": {
        const result = await pollReadyIssues();
        console.log(`Publish complete: ${result.created} issues created, ${result.errors} errors.`);
        break;
      }
      case "serve":
        await serveCommand();
        break;
      case "reconcile":
        console.error(`"reconcile" is not implemented yet. Use "mirror serve" for the auto-sync loop.`);
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
