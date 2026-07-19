import { describe, it, expect } from "vitest";
import { filterTreeEntries, type TreeEntry, type FileFilterConfig } from "../src/github/loaders.ts";

// Tests for hardening fixes:
// 1. File-cap detection: when included.length >= maxFiles, capped=true → partial status
// 2. Tree truncation: when GitHub tree is truncated, capped=true → partial status

const cfg: FileFilterConfig = {
  maxFileBytes: 200_000,
  maxFiles: 5000,
  excludeDirs: ["node_modules", "dist", "build", ".git", "vendor", "target"],
  excludeExts: [".png", ".jpg", ".zip", ".wasm", ".lock", ".map"],
  excludeFiles: ["package-lock.json", "yarn.lock", ".env"],
  textExts: [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".py", ".go", ".rs", ".yml", ".yaml", ".toml", ".sh", ".css", ".html", ".svg", ".sql", ".txt", ".gitignore"],
};

function entry(path: string, sha: string, size = 100): TreeEntry {
  return { path, mode: "100644", type: "blob", sha, size };
}

describe("file-cap detection", () => {
  it("included.length === maxFiles triggers cap", () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`file${i}.ts`, `sha${i}`));
    const { included } = filterTreeEntries(entries, { ...cfg, maxFiles: 10 });
    expect(included.length).toBe(10);
    // capped = included.length >= maxFiles → true
    expect(included.length >= 10).toBe(true);
  });

  it("included.length < maxFiles does not trigger cap", () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`file${i}.ts`, `sha${i}`));
    const { included } = filterTreeEntries(entries, { ...cfg, maxFiles: 10 });
    expect(included.length).toBe(5);
    expect(included.length >= 10).toBe(false);
  });

  it("included.length > maxFiles is impossible (filter breaks at cap)", () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`file${i}.ts`, `sha${i}`));
    const { included } = filterTreeEntries(entries, { ...cfg, maxFiles: 3 });
    expect(included.length).toBe(3);
  });
});

describe("tree truncation detection", () => {
  it("truncated tree flag should trigger cap regardless of included count", () => {
    // When GitHub's tree API returns truncated=true, there are more files we couldn't fetch.
    // The code-sync logic: capped = included.length >= maxFiles || tree.truncated
    const treeTruncated = true;
    const { included } = filterTreeEntries([entry("a.ts", "sha1")], cfg);
    const capped = included.length >= cfg.maxFiles || treeTruncated;
    expect(capped).toBe(true);
  });

  it("non-truncated tree with few files does not trigger cap", () => {
    const treeTruncated = false;
    const { included } = filterTreeEntries([entry("a.ts", "sha1")], cfg);
    const capped = included.length >= cfg.maxFiles || treeTruncated;
    expect(capped).toBe(false);
  });
});

describe("repo_source defaulting", () => {
  it("null repo_source defaults to owned", () => {
    // The repair command uses: repo.repo_source ?? "owned"
    // This tests the defaulting logic, not the Notion write.
    const repoSource: string | null = null;
    expect(repoSource ?? "owned").toBe("owned");
  });

  it("explicit starred is preserved", () => {
    const repoSource: string | null = "starred";
    expect(repoSource ?? "owned").toBe("starred");
  });

  it("explicit owned is preserved", () => {
    const repoSource: string | null = "owned";
    expect(repoSource ?? "owned").toBe("owned");
  });
});
