import { AppError } from "@/server/lib/errors";
import {
  GoogleNotConnectedError,
  googleConnectionStatus,
} from "@/server/lib/executor/google";
import {
  createGscClient,
  type GscSite,
  type UrlInspectionResult,
} from "@/server/lib/gscClient";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
export { GscNotConnectedError } from "@/server/lib/gscErrors";
import {
  buildSearchAnalyticsRequest,
  type GscPerformanceInput,
} from "@/server/features/gsc/searchAnalytics";
import {
  GscConnectionRepository,
  type GscConnection,
} from "@/server/features/gsc/repositories/GscConnectionRepository";
import type {
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";
import { GOOGLE_SEARCH_CONSOLE_INTEGRATION } from "@/shared/integration-addresses";

const SITE_UNVERIFIED_PERMISSION = "siteUnverifiedUser";

type GscPerformanceResult = {
  siteUrl: string;
  connectedBy: string | null;
  request: GscSearchAnalyticsRequest;
  rows: GscSearchAnalyticsRow[];
};

type GscSiteListResult = {
  /** The grant is gone or expired past refresh; the user has to reconnect. */
  requiresReconnect: boolean;
  /** Search Console answered with a non-auth failure (rate limit, outage);
   *  the grant is fine and a retry is the right move. */
  sitesUnavailable: boolean;
  email: string | null;
  sites: GscSite[];
};

async function getConnection(projectId: string): Promise<GscConnection | null> {
  return GscConnectionRepository.getByProjectId(projectId);
}

/** The organization's Google grant held by the integration gateway. */
async function getGoogleConnection(input: { organizationId: string }) {
  return googleConnectionStatus(
    input.organizationId,
    GOOGLE_SEARCH_CONSOLE_INTEGRATION,
  );
}

/** Expected ways the stored grant fails to reach Search Console: the gateway
 *  could not mint a token (refresh token revoked or expired), or Google
 *  rejected the call (401/403). These surface a reconnect prompt without
 *  fault logging. */
export function isExpectedGrantFailure(error: unknown): boolean {
  if (error instanceof GscTokenError) return true;
  if (error instanceof GoogleNotConnectedError) return true;
  return (
    error instanceof GscApiError &&
    (error.status === 401 || error.status === 403)
  );
}

async function listSites(input: {
  organizationId: string;
}): Promise<GscSiteListResult> {
  const google = await getGoogleConnection(input);
  if (!google.connected) {
    return {
      requiresReconnect: true,
      sitesUnavailable: false,
      email: null,
      sites: [],
    };
  }
  try {
    const sites = await createGscClient(input).listSites();
    return {
      requiresReconnect: false,
      sitesUnavailable: false,
      email: google.email,
      sites,
    };
  } catch (error) {
    const reconnect = isExpectedGrantFailure(error);
    if (!reconnect) {
      console.error("Failed to list Search Console sites", error);
    }
    return {
      requiresReconnect: reconnect,
      sitesUnavailable: !reconnect,
      email: google.email,
      sites: [],
    };
  }
}

/** Map a verified property to a project. Rejects unverified properties and
 *  properties not present on the grant. */
async function setSite(input: {
  projectId: string;
  organizationId: string;
  siteUrl: string;
}): Promise<GscConnection> {
  const sites = await createGscClient(input).listSites();
  const match = sites.find((s) => s.siteUrl === input.siteUrl);
  if (!match) {
    throw new AppError(
      "NOT_FOUND",
      "That Search Console property isn't available on the connected Google account.",
    );
  }
  if (match.permissionLevel === SITE_UNVERIFIED_PERMISSION) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have verified access to that Search Console property.",
    );
  }
  return GscConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    siteUrl: input.siteUrl,
  });
}

/** Unbind the property from the project. The Google grant itself stays in the
 *  gateway for the other projects that use it. */
async function disconnect(input: { projectId: string }): Promise<void> {
  await GscConnectionRepository.deleteByProjectId(input.projectId);
}

/** Pass-through of GSC `searchAnalytics.query` for a project's connected property. */
async function getPerformance(
  input: GscPerformanceInput,
): Promise<GscPerformanceResult> {
  const connection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) {
    throw new GscNotConnectedError(input.projectId);
  }
  const request = buildSearchAnalyticsRequest(input);
  const [rows, google] = await Promise.all([
    createGscClient(connection).querySearchAnalytics(
      connection.siteUrl,
      request,
    ),
    getGoogleConnection(connection),
  ]);
  return {
    siteUrl: connection.siteUrl,
    connectedBy: google.email,
    request,
    rows,
  };
}

type GscUrlInspection = {
  url: string;
  result: UrlInspectionResult | null;
  error?: string;
};

type GscInspectUrlsResult = {
  siteUrl: string;
  connectedBy: string | null;
  results: GscUrlInspection[];
};

/** Inspect 1–N URLs against a project's connected property. Resolves the
 *  connection once, then inspects each URL; per-URL failures are captured
 *  inline so one bad URL doesn't fail the batch. Token/grant failures
 *  propagate so the caller can prompt a reconnect. */
async function inspectUrls(input: {
  projectId: string;
  urls: string[];
  languageCode?: string;
}): Promise<GscInspectUrlsResult> {
  const connection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) {
    throw new GscNotConnectedError(input.projectId);
  }
  const client = createGscClient(connection);
  const results: GscUrlInspection[] = [];
  for (const url of input.urls) {
    try {
      const result = await client.inspectUrl(
        connection.siteUrl,
        url,
        input.languageCode,
      );
      results.push({ url, result });
    } catch (error) {
      if (
        error instanceof GscTokenError ||
        error instanceof GoogleNotConnectedError
      ) {
        throw error;
      }
      results.push({
        url,
        result: null,
        error: error instanceof Error ? error.message : "Inspection failed",
      });
    }
  }
  const google = await getGoogleConnection(connection);
  return {
    siteUrl: connection.siteUrl,
    connectedBy: google.email,
    results,
  };
}

export const GscService = {
  getConnection,
  getGoogleConnection,
  listSites,
  setSite,
  disconnect,
  getPerformance,
  inspectUrls,
};
