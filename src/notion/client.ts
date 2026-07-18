import { Client, type APIResponseError } from "@notionhq/client";
import { loadConfig } from "../config.ts";
import { logger } from "../logging.ts";
import { sleep } from "../util.ts";

let client: Client | null = null;

export function getNotion(): Client {
  if (client) return client;
  const cfg = loadConfig();
  client = new Client({
    auth: cfg.NOTION_TOKEN,
    notionVersion: cfg.NOTION_VERSION,
  });
  return client;
}

// Single global request queue: serializes all Notion calls, caps at MAX_NOTION_RPS,
// handles 429/529 with Retry-After. ponytail: one queue, no per-resource queues at v1.
// Ceiling: if parallelism needed, partition by page id.

type RateLimitState = {
  lastRequestAt: number;
  inflight: Promise<unknown> | null;
};

const state: RateLimitState = {
  lastRequestAt: 0,
  inflight: null,
};

const minIntervalMs = () => 1000 / Math.max(0.5, loadConfig().MAX_NOTION_RPS);

async function gate<T>(fn: () => Promise<T>): Promise<T> {
  // Serialize: wait for previous inflight to settle before starting.
  while (state.inflight) {
    await state.inflight.catch(() => {});
  }
  const elapsed = Date.now() - state.lastRequestAt;
  const wait = minIntervalMs() - elapsed;
  if (wait > 0) await sleep(wait);

  const promise = (async () => {
    let attempt = 0;
    while (true) {
      try {
        state.lastRequestAt = Date.now();
        const result = await fn();
        return result;
      } catch (err) {
        const apiErr = err as APIResponseError;
        const status = apiErr?.status ?? 0;
        if (status === 429 || status === 529) {
          const headers = apiErr?.headers as Record<string, string | undefined> | undefined;
          const retryAfter = Number(headers?.["retry-after"] ?? 1);
          const delayMs = (isFinite(retryAfter) ? retryAfter : 1) * 1000;
          logger.warn({ status, delayMs, attempt }, "notion rate limited, backing off");
          await sleep(delayMs);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  })();
  state.inflight = promise;
  try {
    return (await promise) as T;
  } finally {
    if (state.inflight === promise) state.inflight = null;
  }
}

export async function notionCall<T>(fn: () => Promise<T>): Promise<T> {
  return gate(fn);
}

export async function pingNotion(): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = loadConfig();
    await notionCall(() => getNotion().users.me({}));
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.message };
  }
}

export async function pingRootPage(): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = loadConfig();
    await notionCall(() => getNotion().pages.retrieve({ page_id: cfg.NOTION_ROOT_PAGE_ID }));
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.message };
  }
}
