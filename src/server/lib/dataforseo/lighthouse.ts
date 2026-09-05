import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  DataforseoChargedTaskError,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import {
  parseDataforseoLighthousePayload,
  requestCategories,
  type LighthouseStrategy,
} from "@/server/lib/dataforseoLighthousePayload";
import type { StoredLighthousePayload } from "@/server/lib/lighthouseStoredPayload";

const LIGHTHOUSE_PATH = "/v3/on_page/lighthouse/live/json";
const REQUEST_TIMEOUT_MS = 60_000;

// This module runs in the open-seo-audit worker, and the raw Lighthouse
// payload (1-10MB, held several times over while parsing) is the operation
// that OOMed the main worker. The audit workflow starts ten checks at once
// (mobile and desktop for five URLs), and the gateway RPC hands each payload
// over fully materialized, so the cap has to cover the call itself, not only
// the parse: at most MAX_IN_FLIGHT payloads exist per isolate, and one parses
// at a time. Three keeps the worst-case wait for a ten-call chunk (three
// queued 60s rounds plus its own run) inside the workflow's 5-minute step.
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiters.shift()?.();
  }
}

let parseChain: Promise<unknown> = Promise.resolve();
function withParseLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = parseChain.then(fn, fn);
  parseChain = run.catch(() => {});
  return run;
}

export async function fetchLighthouseResult(input: {
  url: string;
  strategy: LighthouseStrategy;
}): Promise<DataforseoApiResponse<StoredLighthousePayload>> {
  return withSlot(async () => {
    // Billed, non-idempotent POST: a 5xx does not prove the provider skipped
    // the charge, so never replay it. Lighthouse runs are the slowest call the
    // app makes, so it carries its own deadline, which starts once the call
    // holds a slot rather than while it queues.
    const body = await dataforseoPost(
      LIGHTHOUSE_PATH,
      [
        {
          url: input.url,
          for_mobile: input.strategy === "mobile",
          categories: [...requestCategories],
        },
      ],
      { maxServerErrorRetries: 0, timeoutMs: REQUEST_TIMEOUT_MS },
    );

    return withParseLock(async () => {
      // Build the metering envelope before parsing. The provider has already
      // charged a successful task, so a malformed payload must carry its
      // billing metadata out to the metered client instead of looking
      // retryable.
      const task = assertOk(body);
      const billing = buildTaskBilling(task);
      try {
        const data = parseDataforseoLighthousePayload(body, input);
        return { data, billing };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DataforseoChargedTaskError(message, billing);
      }
    });
  });
}
