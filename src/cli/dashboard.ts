import { listRepos, listReposBySource, getRepoCodeState, listErrors, getMeta, type GithubObjectRow, type RepoCodeStateRow } from "../state/sqlite.ts";
import { getDataSourceId } from "../notion/schema.ts";
import { execSync } from "node:child_process";

// Live code sync dashboard.
// Shows a summary header + per-repo table with progress bars, auto-refreshing.
// Usage: mirror dashboard [--watch] [--interval 2] [--stars|--owned|--all]

export async function dashboardCommand(args: string[]): Promise<void> {
  // Suppress info logs — they corrupt the dashboard layout
  process.env.LOG_LEVEL = "error";

  const watch = args.includes("--watch") || args.includes("-w");
  const intervalArg = args.find((a) => a.startsWith("--interval="))?.split("=")[1];
  const interval = intervalArg ? parseFloat(intervalArg) : 2;
  const starsOnly = args.includes("--stars");
  const ownedOnly = args.includes("--owned");
  const all = args.includes("--all") || (!starsOnly && !ownedOnly);

  if (watch) {
    // Enter alternate screen, hide cursor, enable raw mode for key capture
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    let scroll = 0;
    let lastAutoRender = Date.now();

    const cleanup = () => {
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.exit(0);
    };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);

    const render = () => {
      const lines = renderDashboard({ starsOnly, ownedOnly, all, scroll });
      process.stdout.write("\x1b[H\x1b[2J" + lines.join("\n") + "\n");
    };

    // Key handler: scroll with arrows, quit with q/Ctrl+C
    process.stdin.on("data", (buf: Buffer) => {
      const s = buf.toString();
      if (s === "q" || s === "Q" || s === "\x03") cleanup();
      if (s === "\x1b[A" || s === "k") { scroll = Math.max(0, scroll - 1); render(); }
      if (s === "\x1b[B" || s === "j") { scroll++; render(); }
      if (s === "\x1b[5~") { scroll = Math.max(0, scroll - 10); render(); }
      if (s === "\x1b[6~") { scroll += 10; render(); }
      if (s === "\x1b[H" || s === "g") { scroll = 0; render(); }
      if (s === "\x1b[F" || s === "G") { scroll = 99999; render(); }
    });

    // Initial render
    render();

    // Auto-refresh loop: poll at 50ms so keypresses feel instant
    while (true) {
      await sleep(50);
      if (Date.now() - lastAutoRender >= interval * 1000) {
        render();
        lastAutoRender = Date.now();
      }
    }
  } else {
    const lines = renderDashboard({ starsOnly, ownedOnly, all });
    console.log(lines.join("\n"));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function renderDashboard(filter: { starsOnly: boolean; ownedOnly: boolean; all: boolean; scroll?: number }): string[] {
  const scroll = filter.scroll ?? 0;
  const repos = filter.starsOnly
    ? listReposBySource("starred")
    : filter.ownedOnly
      ? listReposBySource("owned")
      : listRepos();

  const errors = listErrors(10);
  const reposDs = getDataSourceId("repos");
  const workDs = getDataSourceId("work_items");
  const codeDs = getDataSourceId("code_files");
  const lastReconcile = getMeta("last_reconcile_at");
  const lastStarRefresh = getMeta("last_star_refresh_at");

  // Collect code states
  const rows: { repo: GithubObjectRow; state: RepoCodeStateRow | null }[] = [];
  for (const repo of repos) {
    if (!repo.repo_full_name) continue;
    const state = getRepoCodeState(repo.github_node_id);
    rows.push({ repo, state });
  }

  // Sort: syncing first, then errors, then by file_count desc, then not-synced
  rows.sort((a, b) => {
    const sa = a.state?.sync_status ?? "none";
    const sb = b.state?.sync_status ?? "none";
    const priority: Record<string, number> = { syncing: 0, error: 1, partial: 2, ready: 3, idle: 4, none: 5 };
    const pa = priority[sa] ?? 5;
    const pb = priority[sb] ?? 5;
    if (pa !== pb) return pa - pb;
    return (b.state?.file_count ?? 0) - (a.state?.file_count ?? 0);
  });

  // Aggregate stats
  const totalRepos = rows.length;
  const syncedRepos = rows.filter((r) => r.state?.sync_status === "ready" || r.state?.sync_status === "partial").length;
  const errorRepos = rows.filter((r) => r.state?.sync_status === "error").length;
  const notSynced = rows.filter((r) => !r.state).length;
  const totalFiles = rows.reduce((sum, r) => sum + (r.state?.file_count ?? 0), 0);
  const totalSynced = rows.reduce((sum, r) => sum + (r.state?.synced_count ?? 0), 0);
  const totalSkipped = rows.reduce((sum, r) => sum + (r.state?.skipped_count ?? 0), 0);

  const ownedCount = repos.filter((r) => r.repo_source === "owned").length;
  const starredCount = repos.filter((r) => r.repo_source === "starred").length;

  // Build output
  const lines: string[] = [];
  const now = new Date().toISOString().slice(11, 19);

  // Check if daemon process is running
  const daemonRunning = isDaemonRunning();

  // Header
  lines.push(`${bold("GitHub Notion Mirror")} ${dim("— code sync dashboard")} ${dim("[" + now + " UTC]")}`);
  lines.push("");

  // Summary box
  const pct = totalRepos > 0 ? Math.round((syncedRepos / totalRepos) * 100) : 0;
  lines.push(`  ${bold("Repos:")}     ${totalRepos} total ${dim(`(${ownedCount} owned, ${starredCount} starred)`)}`);
  lines.push(`  ${bold("Synced:")}    ${green(syncedRepos.toString())}/${totalRepos} repos ${dim(`(${pct}%)`)}  ${red(errorRepos + " errors")}  ${yellow(notSynced + " pending")}`);
  lines.push(`  ${bold("Files:")}     ${totalSynced.toLocaleString()} synced  ${dim(`${totalSkipped.toLocaleString()} skipped  /  ${totalFiles.toLocaleString()} total`)}`);
  lines.push(`  ${bold("Daemon:")}    ${daemonRunning ? green("running") : red("stopped")}  ${dim("last reconcile: " + (lastReconcile ? timeAgo(lastReconcile) : "never"))}`);
  lines.push(`  ${bold("Stars:")}     ${dim("last refresh: " + (lastStarRefresh ? timeAgo(lastStarRefresh) : "never"))}`);

  // Star code sync progress
  const starsTotal = getMeta("stars_code_total");
  if (starsTotal) {
    const starsDone = getMeta("stars_code_done") ?? "0";
    const starsCurrent = getMeta("stars_code_current") ?? "";
    const starsError = getMeta("stars_code_last_error");
    const remaining = Math.max(0, Number(starsTotal) - Number(starsDone));
    const starsPct = Math.round((Number(starsDone) / Number(starsTotal)) * 100);
    lines.push(`  ${bold("Star Sync:")}  ${green(starsDone)}/${starsTotal} repos ${dim(`(${starsPct}%, ${remaining} remaining)`)}${starsCurrent ? "  " + dim(starsCurrent.slice(0, 30)) : ""}`);
    if (starsError) lines.push(`  ${bold("Last Err:")}   ${red(starsError.slice(0, 60))}`);
  }

  lines.push(`  ${bold("Notion:")}    ${dim("repos=" + (reposDs?.slice(0, 8) ?? "—") + " work=" + (workDs?.slice(0, 8) ?? "—") + " code=" + (codeDs?.slice(0, 8) ?? "—"))}`);
  lines.push("");

  // Progress bar
  const barWidth = 50;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = green("█".repeat(filled)) + dim("░".repeat(barWidth - filled));
  lines.push(`  ${bar} ${pct}%`);
  lines.push("");

  // Table header — fixed column widths, repo name truncated to 35 chars
  const colRepo = 35;
  const headerFmt = (s: string) => `\x1b[1;4m${s}\x1b[0m`;
  lines.push(
    `  ${headerFmt(pad("Repo", colRepo))}  ${headerFmt(pad("Status", 8))}  ${headerFmt(pad("Files", 8))}  ${headerFmt(pad("Synced", 8))}  ${headerFmt(pad("Skip", 6))}  ${headerFmt(pad("HEAD", 10))}  ${headerFmt(pad("Source", 7))}  ${headerFmt(pad("Last Scan", 12))}`,
  );
  lines.push(`  ${dim("─".repeat(colRepo + 2 + 8 + 2 + 8 + 2 + 8 + 2 + 6 + 2 + 10 + 2 + 7 + 2 + 12))}`);

  // Table rows — scrollable in --watch mode
  const maxRows = process.stdout.rows && process.stdout.rows > 10 ? process.stdout.rows - 20 : 40;
  const effectiveScroll = Math.min(scroll, Math.max(0, rows.length - maxRows));
  const visibleRows = rows.slice(effectiveScroll, effectiveScroll + maxRows);
  for (const { repo, state } of visibleRows) {
    const fullName = repo.repo_full_name ?? "?";
    const name = pad(fullName.length > colRepo ? fullName.slice(0, colRepo - 1) + "…" : fullName, colRepo);
    const status = statusColored(state?.sync_status ?? "none");
    const files = pad((state?.file_count ?? 0).toLocaleString(), 8, "right");
    const synced = pad((state?.synced_count ?? 0).toLocaleString(), 8, "right");
    const skip = pad((state?.skipped_count ?? 0).toLocaleString(), 6, "right");
    const head = pad(state?.head_sha?.slice(0, 10) ?? dim("—"), 10);
    const source = repo.repo_source === "starred" ? yellow("starred") : cyan("owned");
    const lastScan = pad(state?.last_full_scan_at ? timeAgo(state.last_full_scan_at) : dim("never"), 12);

    lines.push(`  ${name}  ${status}  ${files}  ${synced}  ${skip}  ${head}  ${source}  ${lastScan}`);
  }

  if (rows.length > maxRows) {
    const from = effectiveScroll + 1;
    const to = Math.min(effectiveScroll + maxRows, rows.length);
    lines.push(`  ${dim(`Showing ${from}-${to} of ${rows.length}`)}`);
  }

  // Errors section
  if (errors.length > 0) {
    lines.push("");
    lines.push(`  ${red(bold("Recent Errors:"))}`);
    for (const e of errors.slice(0, 5)) {
      const label = `${e.repo_full_name ?? "?"} ${e.object_type} ${e.number ?? ""}`;
      lines.push(`  ${red("✗")} ${pad(label, 45)} ${dim(e.last_error?.slice(0, 60) ?? "?")}`);
    }
  }

  // Footer
  lines.push("");
  if (filter.scroll !== undefined) {
    lines.push(`  ${dim("↑↓/jk scroll  PgUp/PgDn jump  g/G top/bottom  q quit")}`);
  } else {
    lines.push(`  ${dim("mirror dashboard --watch  for live scrollable view")}`);
  }

  return lines;
}

// --- Helpers ---

function isDaemonRunning(): boolean {
  try {
    const uid = process.getuid?.() ?? 0;
    const out = execSync(`launchctl print gui/${uid}/com.kartikkabadi.github-notion-mirror 2>&1`, {
      encoding: "utf8",
      timeout: 2000,
    });
    return out.includes("pid =") && !out.includes("pid = 0");
  } catch {
    return false;
  }
}

function pad(s: string, len: number, align: "left" | "right" = "left"): string {
  // Strip ANSI codes for length calculation
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length >= len) return s.slice(0, len);
  const padLen = len - stripped.length;
  return align === "right" ? " ".repeat(padLen) + s : s + " ".repeat(padLen);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function statusColored(status: string): string {
  switch (status) {
    case "ready": return green(pad("ready", 8));
    case "syncing": return yellow(bold(pad("syncing", 8)));
    case "partial": return yellow(pad("partial", 8));
    case "error": return red(pad("error", 8));
    case "idle": return dim(pad("idle", 8));
    default: return dim(pad("—", 8));
  }
}

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s: string): string { return `\x1b[36m${s}\x1b[0m`; }
