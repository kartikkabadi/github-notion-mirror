import { Octokit } from "octokit";
import { loadConfig } from "../config.ts";
import { logger } from "../logging.ts";

let octokitInstance: Octokit | null = null;

// ponytail: PAT-only for Phase 1. Phase 2 swaps in @octokit/auth-app installation token.
// Ceiling: when GITHUB_APP_ID is set, replace this with auth-app + installation token flow.
export function getOctokit(): Octokit {
  if (octokitInstance) return octokitInstance;
  const cfg = loadConfig();
  if (!cfg.GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is required for Phase 1 backfill. Set a fine-grained PAT in .env, or wait for Phase 2 GitHub App support.",
    );
  }
  octokitInstance = new Octokit({ auth: cfg.GITHUB_TOKEN });
  logger.info("octokit ready (PAT auth)");
  return octokitInstance;
}

export function hasGitHubAuth(): boolean {
  try {
    const cfg = loadConfig();
    return Boolean(cfg.GITHUB_TOKEN || (cfg.GITHUB_APP_ID && cfg.GITHUB_INSTALLATION_ID));
  } catch {
    return false;
  }
}
