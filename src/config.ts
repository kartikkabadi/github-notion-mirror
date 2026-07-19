import { z } from "zod";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const ConfigSchema = z.object({
  // Notion
  NOTION_TOKEN: z.string().min(1),
  NOTION_ROOT_PAGE_ID: z.string().min(1),
  NOTION_VERSION: z.string().default("2026-03-11"),
  NOTION_REPOS_DATA_SOURCE_ID: z.string().default(""),
  NOTION_WORK_ITEMS_DATA_SOURCE_ID: z.string().default(""),

  // GitHub App (Phase 2)
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default("./secrets/github-app.pem"),
  GITHUB_INSTALLATION_ID: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),

  // OR PAT (Phase 1)
  GITHUB_TOKEN: z.string().default(""),

  // Server
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().default(4317),
  LOG_LEVEL: z.string().default("info"),

  // Sync policy
  RECONCILE_INTERVAL_MINUTES: z.coerce.number().default(15),
  MAX_NOTION_RPS: z.coerce.number().default(2),
  MAX_JOB_ATTEMPTS: z.coerce.number().default(8),
  BACKFILL_INCLUDE_CLOSED: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),
  MAX_COMMENTS_PER_ITEM: z.coerce.number().default(50),
  MAX_BODY_CHARS: z.coerce.number().default(100000),
  MAX_CHANGED_FILES_LISTED: z.coerce.number().default(100),
  MAPPER_VERSION: z.coerce.number().default(1),

  // Code sync
  CODE_MAX_FILE_BYTES: z.coerce.number().default(200_000),
  CODE_MAX_FILES_PER_REPO: z.coerce.number().default(5000),
  CODE_EXCLUDE_DIRS: z.string().default("node_modules,dist,build,.git,vendor,target,.next,coverage,.turbo,out,bin,obj"),
  CODE_EXCLUDE_EXTS: z.string().default(".png,.jpg,.jpeg,.gif,.webp,.ico,.pdf,.zip,.gz,.wasm,.mp4,.woff,.woff2,.ttf,.eot,.otf,.parquet,.bin,.exe,.dll,.so,.dylib,.min.js,.min.css,.map,.lock,.sum"),
  CODE_TEXT_EXTS: z.string().default(".ts,.tsx,.js,.jsx,.mjs,.cjs,.json,.md,.mdx,.py,.go,.rs,.java,.kt,.swift,.rb,.php,.yml,.yaml,.toml,.ini,.env.example,.css,.scss,.html,.svg,.sql,.sh,.bash,.c,.h,.cpp,.hpp,.cs,.fs,.vue,.svelte,.txt,.gitignore,.dockerfile,.editorconfig"),
  CODE_EXCLUDE_FILES: z.string().default("package-lock.json,pnpm-lock.yaml,yarn.lock,Cargo.lock,go.sum,Gemfile.lock,composer.lock,Pipfile.lock,poetry.lock,.env,.env.local,.env.production,.env.staging"),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().default(5),
  STAR_REFRESH_HOURS: z.coerce.number().default(12),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  // Bun auto-loads .env; nothing to do here. TOML overlay is optional.
  const tomlPath = resolve(process.cwd(), "config.toml");
  let tomlOverrides: Record<string, string> = {};
  if (existsSync(tomlPath)) {
    tomlOverrides = parseSimpleToml(readFileSync(tomlPath, "utf8"));
  }

  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  // TOML overrides env defaults but does NOT override env secrets (env wins).
  const merged: Record<string, string> = {};
  for (const key of ConfigSchema.keyof().options as string[]) {
    const envVal = env[key];
    const tomlVal = tomlOverrides[key.toLowerCase()];
    if (typeof envVal === "string" && envVal !== "") merged[key] = envVal;
    else if (typeof tomlVal === "string") merged[key] = tomlVal;
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

// ponytail: minimal TOML reader for flat key=value + sections + arrays of strings.
// Ceiling: if config grows nested tables, switch to a real TOML parser dep.
function parseSimpleToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith("#")) continue;
    // strip inline comment after value (only when value is quoted or bare word)
    if (val.startsWith('"')) {
      const end = val.indexOf('"', 1);
      if (end !== -1) val = val.slice(1, end);
    } else if (val.startsWith("[")) {
      // array of strings: ["a", "b"] -> comma-joined for downstream split; keep raw
      val = val.replace(/^\[|\]$/g, "").replace(/"/g, "");
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    out[key] = val;
  }
  return out;
}

export function resetConfigCache(): void {
  cached = null;
}
