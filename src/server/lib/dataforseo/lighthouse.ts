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
// at a time.
const MAX_IN_FLIGHT = 3;
// The cap is per isolate, not per audit: two audits sharing an isolate queue
// twenty calls behind three slots. A call that waits longer than this fails
// instead of starting so late that its 60s run lands past the workflow's
// 5-minute step; the audit layer records that as a failed check for the page
// rather than losing the whole step to a timeout.
const SLOT_WAIT_MS = 3 * 60_000;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  const acquired = await new Promise<boolean>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(wake), 1);
      resolve(false);
    }, SLOT_WAIT_MS);
    waiters.push(wake);
  });
  if (!acquired) {
    throw new Error(
      "Lighthouse call waited over 3 minutes for a slot in this worker and was skipped; rerun the audit later.",
    );
  }
  inFlight += 1;
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
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
