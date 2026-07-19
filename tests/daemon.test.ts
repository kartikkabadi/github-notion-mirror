import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// Tests for the launchd daemon installer.
// We run install-daemon from the real project root and verify the plist
// and start script contain the correct paths. We use a temp HOME so the
// plist doesn't clobber the real one.
// We do NOT test launchctl bootstrap (that requires a real session).

const PROJECT_ROOT = resolve(import.meta.dir, "..");

describe("install-daemon", () => {
  const TMP_HOME = resolve("/tmp/mirror-daemon-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(join(TMP_HOME, "Library/LaunchAgents"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("generates plist and start script with correct paths", () => {
    const env = { ...process.env, HOME: TMP_HOME };
    try {
      execSync(`bun ${join(PROJECT_ROOT, "src/index.ts")} install-daemon`, {
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
    const startPath = join(PROJECT_ROOT, "start-daemon.sh");

    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(startPath)).toBe(true);

    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("com.kartikkabadi.github-notion-mirror");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain(PROJECT_ROOT);

    const start = readFileSync(startPath, "utf8");
    expect(start).toContain("cd");
    expect(start).toContain(PROJECT_ROOT);
    expect(start).toContain("serve");
  });
});
