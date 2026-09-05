import type { ToolFailure } from "@/server/lib/executor/client";
import {
  invokeGoogleTool,
  isCredentialFailure,
} from "@/server/lib/executor/google";
import { GOOGLE_SEARCH_CONSOLE_INTEGRATION } from "@/shared/integration-addresses";
import { GscApiError, GscTokenError } from "./gscErrors";

/** A GSC REST call returned a non-2xx status. `status` drives user-facing messaging. */
export type GscSite = {
  siteUrl: string;
  permissionLevel: string;
};

export type GscSearchAnalyticsRow = {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscDimensionFilter = {
  dimension: string;
  operator: string;
  expression: string;
};

export type GscSearchAnalyticsRequest = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  dimensionFilterGroups?: Array<{
    groupType: "and" | "or";
    filters: GscDimensionFilter[];
  }>;
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dataState?: string;
  aggregationType?: string;
};

/** Subset of the URL Inspection API `inspectionResult` we surface. The wire
 *  shape is richer; extra fields are ignored. */
export type UrlInspectionResult = {
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  mobileUsabilityResult?: { verdict?: string };
  richResultsResult?: { verdict?: string };
  inspectionResultLink?: string;
};

function messageForStatus(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "Search Console denied access to this property (no verified permission, or the connection was revoked).";
  }
  if (status === 429) {
    return "Search Console rate limit reached. Retry shortly.";
  }
  if (status === 404) {
    return "Search Console property not found. It may have been removed in Search Console.";
  }
  return `Search Console API error (${status}): ${body.slice(0, 300)}`;
}

function toError(failure: ToolFailure): Error {
  if (isCredentialFailure(failure)) {
    return new GscTokenError(
      "Search Console access is gone (grant revoked or expired). Reconnect Google.",
      failure,
    );
  }
  const body = JSON.stringify(failure.details ?? failure.message);
  return new GscApiError(
    failure.status ?? 0,
    messageForStatus(failure.status ?? 0, body),
    body,
  );
}

/** Free Google Search Console client over the integration gateway. Unlike the
 *  DataForSEO client it does NOT meter credits — GSC is first-party data with
 *  no per-call cost. The gateway holds and refreshes the OAuth grant. */
export function createGscClient(opts: { organizationId: string }) {
  async function call<T>(
    suffix: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await invokeGoogleTool<T>(
      opts.organizationId,
      GOOGLE_SEARCH_CONSOLE_INTEGRATION,
      suffix,
      args,
    );
    if (!result.ok) throw toError(result.error);
    return result.data;
  }

  return {
    /** Webmasters API `sites.list` — the verified properties on the grant. */
    async listSites(): Promise<GscSite[]> {
      const data = await call<{ siteEntry?: GscSite[] }>("sites.list", {});
      return data.siteEntry ?? [];
    },

    /** Webmasters API `searchAnalytics.query`. siteUrl is used verbatim. */
    async querySearchAnalytics(
      siteUrl: string,
      body: GscSearchAnalyticsRequest,
    ): Promise<GscSearchAnalyticsRow[]> {
      const data = await call<{ rows?: GscSearchAnalyticsRow[] }>(
        "searchanalytics.query",
        { siteUrl, body },
      );
      return data.rows ?? [];
    },

    /** URL Inspection API `urlInspection.index.inspect`. Same
     *  `webmasters.readonly` scope as the Webmasters API. */
    async inspectUrl(
      siteUrl: string,
      inspectionUrl: string,
      languageCode?: string,
    ): Promise<UrlInspectionResult | null> {
      const data = await call<{ inspectionResult?: UrlInspectionResult }>(
        "urlInspection.index.inspect",
        {
          body: {
            siteUrl,
            inspectionUrl,
            ...(languageCode ? { languageCode } : {}),
          },
        },
      );
      return data.inspectionResult ?? null;
    },
  };
}
