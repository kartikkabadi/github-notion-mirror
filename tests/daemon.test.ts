import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Tests for the launchd daemon installer.
// Run the real CLI in a temporary project and HOME. Stub launchctl so the test
// checks generated files without changing the user's launchd session.

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("install-daemon", () => {
  let tempDir: string;
  let fixtureRoot: string;
  let fixtureHome: string;
  let fixtureBin: string;
  let launchctlLog: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mirror-daemon-test-"));
    fixtureRoot = join(tempDir, "project");
    fixtureHome = join(tempDir, "home");
    fixtureBin = join(tempDir, "bin");
    launchctlLog = join(tempDir, "launchctl.log");
    mkdirSync(fixtureRoot);
    mkdirSync(fixtureBin);
    cpSync(join(PROJECT_ROOT, "src"), join(fixtureRoot, "src"), { recursive: true });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fixtureRoot, "node_modules"), "dir");
    writeFileSync(join(fixtureRoot, ".env"), "");
    writeFileSync(join(fixtureBin, "launchctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUNCHCTL_TEST_LOG"\n', { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("generates plist and start script with correct paths", () => {
    const env = {
      ...process.env,
      HOME: fixtureHome,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      LAUNCHCTL_TEST_LOG: launchctlLog,
    };
    execFileSync("bun", [join(fixtureRoot, "src/index.ts"), "install-daemon"], {
      cwd: fixtureRoot,
      env,
      encoding: "utf8",
      stdio: "pipe",
    });

    const plistPath = join(fixtureHome, "Library/LaunchAgents/com.kartikkabadi.github-notion-mirror.plist");
    const startPath = join(fixtureRoot, "start-daemon.sh");

    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(startPath)).toBe(true);

    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("com.kartikkabadi.github-notion-mirror");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain(fixtureRoot);

    const start = readFileSync(startPath, "utf8");
    expect(start).toContain("cd");
    expect(start).toContain(fixtureRoot);
    expect(start).toContain("serve");

    const launchctlCalls = readFileSync(launchctlLog, "utf8").trim().split("\n");
    expect(launchctlCalls).toHaveLength(2);
    expect(launchctlCalls[0]).toMatch(/^bootout gui\/\d+ /);
    expect(launchctlCalls[1]).toMatch(/^bootstrap gui\/\d+ /);
    for (const call of launchctlCalls) expect(call).toContain(plistPath);
  });
});
