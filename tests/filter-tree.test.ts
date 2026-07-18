import { describe, it, expect } from "vitest";
import { filterTreeEntries, languageFromPath, type TreeEntry, type FileFilterConfig } from "../src/github/loaders.ts";

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

describe("filterTreeEntries", () => {
  it("includes text files with allowed extensions", () => {
    const { included, skipped } = filterTreeEntries([
      entry("src/index.ts", "sha1"),
      entry("README.md", "sha2"),
      entry("main.py", "sha3"),
    ], cfg);
    expect(included).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it("excludes files in excluded directories", () => {
    const { included, skipped } = filterTreeEntries([
      entry("node_modules/foo/index.js", "sha1"),
      entry("dist/bundle.js", "sha2"),
      entry("src/index.ts", "sha3"),
    ], cfg);
    expect(included).toHaveLength(1);
    expect(included[0]!.path).toBe("src/index.ts");
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.reason).toBe("excluded dir");
  });

  it("excludes files with excluded extensions", () => {
    const { included, skipped } = filterTreeEntries([
      entry("logo.png", "sha1"),
      entry("data.zip", "sha2"),
      entry("index.ts", "sha3"),
    ], cfg);
    expect(included).toHaveLength(1);
    expect(skipped).toHaveLength(2);
  });

  it("excludes specific files by name", () => {
    const { included, skipped } = filterTreeEntries([
      entry("package-lock.json", "sha1"),
      entry("yarn.lock", "sha2"),
      entry(".env", "sha3"),
      entry("index.ts", "sha4"),
    ], cfg);
    expect(included).toHaveLength(1);
    expect(included[0]!.path).toBe("index.ts");
    expect(skipped).toHaveLength(3);
  });

  it("excludes files over max size", () => {
    const { included, skipped } = filterTreeEntries([
      entry("big.ts", "sha1", 300_000),
      entry("small.ts", "sha2", 1000),
    ], cfg);
    expect(included).toHaveLength(1);
    expect(included[0]!.path).toBe("small.ts");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("too large");
  });

  it("excludes non-text extensions", () => {
    const { included, skipped } = filterTreeEntries([
      entry("data.bin", "sha1"),
      entry("file.exe", "sha2"),
      entry("index.ts", "sha3"),
    ], cfg);
    expect(included).toHaveLength(1);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.reason).toBe("non-text ext");
  });

  it("respects maxFiles limit", () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`file${i}.ts`, `sha${i}`));
    const { included } = filterTreeEntries(entries, { ...cfg, maxFiles: 3 });
    expect(included).toHaveLength(3);
  });

  it("handles nested excluded directories", () => {
    const { included, skipped } = filterTreeEntries([
      entry("packages/app/node_modules/react/index.js", "sha1"),
      entry("packages/app/src/index.ts", "sha2"),
    ], cfg);
    expect(included).toHaveLength(1);
    expect(included[0]!.path).toBe("packages/app/src/index.ts");
  });
});

describe("languageFromPath", () => {
  it("maps common extensions to languages", () => {
    expect(languageFromPath("index.ts")).toBe("TypeScript");
    expect(languageFromPath("App.tsx")).toBe("TypeScript");
    expect(languageFromPath("main.js")).toBe("JavaScript");
    expect(languageFromPath("app.py")).toBe("Python");
    expect(languageFromPath("main.go")).toBe("Go");
    expect(languageFromPath("lib.rs")).toBe("Rust");
  });

  it("returns Other for unknown extensions", () => {
    expect(languageFromPath("file.unknown")).toBe("Other");
    expect(languageFromPath("Makefile")).toBe("Other");
  });

  it("handles dotfiles", () => {
    expect(languageFromPath(".gitignore")).toBe("Other");
  });
});
