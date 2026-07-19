import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// Tests for the launchd daemon installer.
// We test the plist/start-script generation by running install-daemon in a temp HOME
// and verifying the files exist and contain expected content.
// We do NOT test launchctl bootstrap (that requires a real session).

const TMP_DIR = resolve("/tmp/mirror-daemon-test-" + Date.now());
const TMP_HOME = join(TMP_DIR, "home");
const TMP_REPO = join(TMP_DIR, "repo");

describe("install-daemon", () => {
  beforeEach(() => {
    mkdirSync(TMP_HOME, { recursive: true });
    mkdirSync(TMP_REPO, { recursive: true });
    mkdirSync(join(TMP_REPO, "src"), { recursive: true });
    writeFileSync(join(TMP_REPO, ".env"), "NOTION_TOKEN=test\nNOTION_ROOT_PAGE_ID=test\n");
    writeFileSync(join(TMP_REPO, "src/index.ts"), "console.log('test');\n");
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("generates plist and start script with correct paths", () => {
    const env = { ...process.env, HOME: TMP_HOME };
    try {
      execSync(`cd ${TMP_REPO} && bun ${resolve(process.cwd(), "src/index.ts")} install-daemon`, {
        env,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      // install-daemon may fail on launchctl bootstrap in test env, but files should exist
      const stderr = (err as { stderr?: string }).stderr ?? "";
      if (!stderr.includes("launchctl") && !stderr.includes("bootstrap") && !stderr.includes("bootout")) {
        throw err;
      }
    }

    const plistPath = join(TMP_HOME, "Library/LaunchAgents/com.kartikkabadi.github-notion-mirror.plist");
    const startPath = join(TMP_REPO, "start-daemon.sh");

    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(startPath)).toBe(true);

    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("com.kartikkabadi.github-notion-mirror");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain(TMP_REPO);

    const start = readFileSync(startPath, "utf8");
    expect(start).toContain("cd");
    expect(start).toContain(TMP_REPO);
    expect(start).toContain("serve");
  });
});
