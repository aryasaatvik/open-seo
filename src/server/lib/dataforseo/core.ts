import { AppError } from "@/server/lib/errors";
import { invokeTool, type ToolFailure } from "@/server/lib/executor/client";
import { dataforseoToolAddress } from "@/shared/integration-addresses";
import type { ErrorCode } from "@/shared/error-codes";
// Type-only: erased at compile, so no runtime cycle with envelope.ts (which
// imports DataforseoErrorClassifier from here the same way).
import type {
  DataforseoResponseLike,
  DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";

// Every DataForSEO call goes through the integration gateway
// (workers/integrations), which holds the credential and returns the
// provider's response envelope verbatim. This module keeps the retry, timeout,
// and HTTP-error policy the section fetchers rely on.

const MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH = 1600;
// Safety ceiling on any live call (Lighthouse passes its own, longer one).
const DATAFORSEO_REQUEST_TIMEOUT_MS = 60_000;
// Retry idempotent reads on transient 5xx. Total attempts = retries + 1; the
// shared deadline still caps overall wall time.
const DATAFORSEO_MAX_RETRIES = 2;
const DATAFORSEO_RETRY_BACKOFF_MS = 250;

/**
 * Translates a DataForSEO HTTP/task failure into a product-specific AppError
 * (e.g. "billing issue"). Returns null when the failure isn't one this
 * classifier recognises, so the caller can fall back to a generic error. See
 * {@link createDataforseoBillingClassifier}.
 */
export type DataforseoErrorClassifier = (
  status: number | undefined,
  details: string,
  path: string,
) => AppError | null;

function formatDataforseoErrorPayload(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();

  return text.length > MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH
    ? `${text.slice(0, MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH)}... [truncated]`
    : text;
}

/** Strip path parameters so error metadata names the endpoint, not the id. */
function formatDataforseoRequestPath(path: string): string {
  return path.replace(/\{[^}]+\}/g, "").replace(/\/+$/, "");
}

class DataforseoTimeout extends Error {
  override name = "DataforseoTimeout";
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return Promise.reject(new DataforseoTimeout());
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DataforseoTimeout()), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

type DataforseoRequestOptions = {
  /** Maps a recognised access / billing HTTP failure to a product error. */
  classify?: DataforseoErrorClassifier;
  /**
   * Set 0 for billed, non-idempotent calls (business task_post, Lighthouse):
   * a 5xx does not prove the provider skipped the charge, so those must never
   * be replayed. Defaults to retrying idempotent reads on transient 5xx.
   */
  maxServerErrorRetries?: number;
  /** Values for `{param}` segments in the path (`{ id }`, `{ country }`). */
  params?: Record<string, string>;
  /** Overall wall-clock budget across retries. */
  timeoutMs?: number;
};

function httpFailure(
  failure: ToolFailure,
  path: string,
  classify: DataforseoErrorClassifier | undefined,
): AppError {
  const status = failure.status;
  const details = formatDataforseoErrorPayload(
    failure.details ?? failure.message,
  );
  const classified = classify?.(status, details, path);
  if (classified) return classified;

  const code: ErrorCode =
    status === undefined
      ? "INTERNAL_ERROR"
      : status >= 500
        ? "UPSTREAM_UNAVAILABLE"
        : status === 429
          ? "RATE_LIMITED"
          : status === 401
            ? "DATAFORSEO_AUTH_FAILED"
            : "INTERNAL_ERROR";
  const error = new AppError(
    code,
    status === undefined
      ? `DataForSEO call failed on ${path}: ${failure.message}`
      : `DataForSEO HTTP ${status} on ${path}`,
    {
      provider: "dataforseo",
      providerStatus: status === undefined ? failure.code : String(status),
      providerPath: path,
      responseBody: details,
    },
  );
  error.name = "DataForSEOHttpError";
  // UPSTREAM_UNAVAILABLE is non-reportable, and the error handlers only log
  // what they capture, so warn here to keep the provider's failure rate
  // visible in Workers Observability. Warn, not error: there is nothing in
  // the app to fix.
  if (code === "UPSTREAM_UNAVAILABLE")
    console.warn("dataforseo.upstream-http-failed", { path, status });
  return error;
}

async function requestDataforseo<TTask extends DataforseoTaskLike>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  options: DataforseoRequestOptions,
): Promise<DataforseoResponseLike<TTask> | null> {
  const address = dataforseoToolAddress(path);
  const displayPath = formatDataforseoRequestPath(path);
  const args = {
    ...options.params,
    ...(method === "POST" ? { body } : {}),
  };
  const maxRetries = options.maxServerErrorRetries ?? DATAFORSEO_MAX_RETRIES;
  const deadline =
    Date.now() + (options.timeoutMs ?? DATAFORSEO_REQUEST_TIMEOUT_MS);

  for (let attempt = 0; ; attempt++) {
    let result;
    try {
      result = await withDeadline(invokeTool(address, args), deadline);
    } catch (error) {
      // Deliberately not retried: a call that ran past the deadline may
      // already be billed by DataForSEO, and because this is not a
      // DataforseoChargedTaskError the customer is metered nothing for it, so
      // replaying would be spend we eat twice.
      if (error instanceof DataforseoTimeout) {
        const timeoutError = new AppError(
          "UPSTREAM_UNAVAILABLE",
          `DataForSEO request timed out on ${displayPath}`,
          { provider: "dataforseo", providerPath: displayPath },
        );
        timeoutError.name = "DataForSEOTimeoutError";
        throw timeoutError;
      }
      throw error;
    }

    if (result.ok) {
      if (result.data == null) return null;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the task type is the caller's claim about the payload; billing metadata and item fields are validated downstream (envelope.ts + section Zod schemas)
      return result.data as DataforseoResponseLike<TTask>;
    }

    // Transient upstream 5xx on an idempotent read -> back off and retry.
    const status = result.error.status;
    if (status !== undefined && status >= 500 && attempt < maxRetries) {
      await new Promise((resolve) =>
        setTimeout(resolve, DATAFORSEO_RETRY_BACKOFF_MS * (attempt + 1)),
      );
      continue;
    }
    throw httpFailure(result.error, displayPath, options.classify);
  }
}

/**
 * POST `tasks` (the standard array-of-task-payloads body) to a DataForSEO
 * endpoint and return the parsed response envelope. The task type parameter is
 * the caller's claim about the payload shape — fields we act on are validated
 * downstream (billing metadata in envelope.ts, items via the section fetchers'
 * Zod schemas).
 */
export function dataforseoPost<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo("POST", path, tasks, options);
}

/**
 * GET a DataForSEO endpoint (task_get collection, appendix/locations data).
 * Templated paths take their values through `options.params`:
 * `dataforseoGet("/v3/serp/google/locations/{country}", { params: { country } })`.
 */
export function dataforseoGet<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo("GET", path, undefined, options);
}
