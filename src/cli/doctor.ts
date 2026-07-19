import { loadConfig } from "../config.ts";
import { hasGitHubAuth, getOctokit } from "../github/auth.ts";
import { pingNotion, pingRootPage } from "../notion/client.ts";
import { getDataSourceId } from "../notion/schema.ts";
import { getDb } from "../state/sqlite.ts";
import { daemonChecks } from "./daemon.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type Check = { name: string; ok: boolean; detail: string };

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];

  // 1. Config loads
  let cfg;
  try {
    cfg = loadConfig();
    checks.push({ name: "config loads", ok: true, detail: "env + optional config.toml parsed" });
  } catch (err) {
    checks.push({ name: "config loads", ok: false, detail: (err as Error).message });
    printChecks(checks);
    process.exit(1);
  }

  // 2. Notion token
  const notion = await pingNotion();
  checks.push({ name: "notion token", ok: notion.ok, detail: notion.ok ? "valid" : notion.error ?? "unknown" });

  // 3. Notion root page
  const root = await pingRootPage();
  checks.push({ name: "notion root page", ok: root.ok, detail: root.ok ? "accessible" : root.error ?? "inaccessible" });

  // 4. Data source IDs set
  const reposDs = getDataSourceId("repos");
  const workDs = getDataSourceId("work_items");
  checks.push({ name: "repos data source id", ok: Boolean(reposDs), detail: reposDs || "missing — run init" });
  checks.push({ name: "work items data source id", ok: Boolean(workDs), detail: workDs || "missing — run init" });

  // 5. GitHub auth
  checks.push({ name: "github auth present", ok: hasGitHubAuth(), detail: hasGitHubAuth() ? "yes" : "set GITHUB_TOKEN or App creds" });

  // 6. GitHub API sample call
  if (hasGitHubAuth()) {
    try {
      const ok = getOctokit();
      await ok.rest.users.getAuthenticated();
      checks.push({ name: "github api call", ok: true, detail: "user.getAuthenticated succeeded" });
    } catch (err) {
      checks.push({ name: "github api call", ok: false, detail: (err as Error).message });
    }
  }

  // 7. SQLite
  try {
    const db = getDb();
    const count = db.prepare(`SELECT COUNT(*) as c FROM github_objects`).get() as { c: number };
    checks.push({ name: "sqlite", ok: true, detail: `${count.c} object(s) tracked` });
  } catch (err) {
    checks.push({ name: "sqlite", ok: false, detail: (err as Error).message });
  }

  // 8. No secrets in git
  const envPath = resolve(process.cwd(), ".env");
  checks.push({ name: ".env exists", ok: existsSync(envPath), detail: existsSync(envPath) ? "present" : "copy .env.example to .env" });

  // 9. Daemon (launchd)
  checks.push(...daemonChecks());

  printChecks(checks);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

function printChecks(checks: Check[]): void {
  console.log("mirror doctor\n");
  for (const c of checks) {
    const mark = c.ok ? "OK" : "FAIL";
    console.log(`  [${mark}] ${c.name} — ${c.detail}`);
  }
}
