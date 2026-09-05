/* eslint-disable max-lines -- one client module per Google integration (gscClient precedent); GA4 spans the Admin and Data APIs */
import { z } from "zod";
import type { ToolFailure } from "@/server/lib/executor/client";
import {
  invokeGoogleTool,
  isCredentialFailure,
} from "@/server/lib/executor/google";
import {
  Ga4AdminApiError,
  Ga4DataApiError,
  Ga4MalformedResponseError,
  Ga4TokenError,
} from "@/server/lib/ga4Errors";
import {
  GOOGLE_ANALYTICS_ADMIN_INTEGRATION,
  GOOGLE_ANALYTICS_DATA_INTEGRATION,
} from "@/shared/integration-addresses";

const MAX_ACCOUNT_SUMMARY_PAGES = 100;
const propertyIdSchema = z.string().regex(/^properties\/\d+$/);
const dataStreamNameSchema = z
  .string()
  .regex(/^properties\/\d+\/dataStreams\/\d+$/);

const propertySummarySchema = z.object({
  property: propertyIdSchema,
  displayName: z.string(),
});

const accountSummarySchema = z.object({
  account: z.string().regex(/^accounts\/\d+$/),
  displayName: z.string(),
  propertySummaries: z.array(propertySummarySchema).optional(),
});

const accountSummariesResponseSchema = z.object({
  accountSummaries: z.array(accountSummarySchema).optional(),
  nextPageToken: z.string().optional(),
});

const propertySchema = z.object({
  name: propertyIdSchema,
  displayName: z.string(),
  timeZone: z.string().min(1),
  currencyCode: z.string().min(1),
});

const dataStreamSchema = z.object({
  name: dataStreamNameSchema,
  type: z.string(),
  displayName: z.string().default(""),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  webStreamData: z
    .object({
      measurementId: z.string().optional(),
      defaultUri: z.string().optional(),
    })
    .optional(),
  androidAppStreamData: z
    .object({ packageName: z.string().optional() })
    .optional(),
  iosAppStreamData: z.object({ bundleId: z.string().optional() }).optional(),
});
const dataStreamsResponseSchema = z.object({
  dataStreams: z.array(dataStreamSchema).optional(),
  nextPageToken: z.string().optional(),
});
const enhancedMeasurementSettingsSchema = z.object({
  // ProtoJSON omits scalar fields at their default values.
  streamEnabled: z.boolean().default(false),
  scrollsEnabled: z.boolean().default(false),
  outboundClicksEnabled: z.boolean().default(false),
  siteSearchEnabled: z.boolean().default(false),
  videoEngagementEnabled: z.boolean().default(false),
  fileDownloadsEnabled: z.boolean().default(false),
  pageChangesEnabled: z.boolean().default(false),
  formInteractionsEnabled: z.boolean().default(false),
  searchQueryParameter: z.string().default(""),
  uriQueryParameter: z.string().optional().default(""),
});
const keyEventSchema = z.object({
  eventName: z.string(),
  createTime: z.string().optional(),
  deletable: z.boolean().optional(),
  custom: z.boolean().optional(),
  countingMethod: z.string(),
  defaultValue: z
    .object({ numericValue: z.number(), currencyCode: z.string() })
    .optional(),
});
const keyEventsResponseSchema = z.object({
  keyEvents: z.array(keyEventSchema).optional(),
  nextPageToken: z.string().optional(),
});
const customDimensionSchema = z.object({
  parameterName: z.string(),
  displayName: z.string(),
  description: z.string().optional().default(""),
  scope: z.string(),
  disallowAdsPersonalization: z.boolean().optional().default(false),
});
const customDimensionsResponseSchema = z.object({
  customDimensions: z.array(customDimensionSchema).optional(),
  nextPageToken: z.string().optional(),
});
const customMetricSchema = z.object({
  parameterName: z.string(),
  displayName: z.string(),
  description: z.string().optional().default(""),
  measurementUnit: z.string(),
  scope: z.string(),
  restrictedMetricType: z.array(z.string()).optional().default([]),
});
const customMetricsResponseSchema = z.object({
  customMetrics: z.array(customMetricSchema).optional(),
  nextPageToken: z.string().optional(),
});

type Ga4PropertySummary = {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
};

type Ga4Property = z.infer<typeof propertySchema>;

function adminMessageForStatus(status: number): string {
  if (status === 401) return "Google Analytics connection expired.";
  if (status === 403) {
    return "Google Analytics denied access. Check the account's property access and enabled APIs.";
  }
  if (status === 429) return "Google Analytics rate limit reached.";
  return `Google Analytics Admin API error (${status}).`;
}

function tokenError(failure: ToolFailure): Ga4TokenError {
  return new Ga4TokenError(
    "Google Analytics access is gone (grant revoked or expired). Reconnect Google.",
    failure,
  );
}

/** Read-only Admin API client used only for account/property discovery. The
 *  gateway holds and refreshes the OAuth grant. */
export function createGa4AdminClient() {
  async function call(
    suffix: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await invokeGoogleTool<unknown>(
      GOOGLE_ANALYTICS_ADMIN_INTEGRATION,
      suffix,
      args,
    );
    if (result.ok) return result.data;
    if (isCredentialFailure(result.error)) throw tokenError(result.error);
    const status = result.error.status ?? 0;
    throw new Ga4AdminApiError(
      status,
      status === 0
        ? "Google Analytics Admin API is temporarily unavailable."
        : adminMessageForStatus(status),
    );
  }

  return {
    async listProperties(): Promise<Ga4PropertySummary[]> {
      const properties: Ga4PropertySummary[] = [];
      let pageToken: string | undefined;

      for (let page = 0; page < MAX_ACCOUNT_SUMMARY_PAGES; page += 1) {
        const response = accountSummariesResponseSchema.parse(
          await call("accountSummaries.list", {
            pageSize: 200,
            ...(pageToken ? { pageToken } : {}),
          }),
        );
        for (const account of response.accountSummaries ?? []) {
          for (const property of account.propertySummaries ?? []) {
            properties.push({
              propertyId: property.property,
              displayName: property.displayName,
              accountDisplayName: account.displayName,
            });
          }
        }

        pageToken = response.nextPageToken || undefined;
        if (!pageToken) return properties;
      }

      throw new Error(
        "Google Analytics property discovery exceeded 100 pages.",
      );
    },

    async getProperty(propertyId: string): Promise<Ga4Property> {
      const name = propertyIdSchema.parse(propertyId);
      return propertySchema.parse(await call("properties.get", { name }));
    },

    async listDataStreams(propertyId: string) {
      const parent = propertyIdSchema.parse(propertyId);
      const response = dataStreamsResponseSchema.parse(
        await call("properties.dataStreams.list", { parent, pageSize: 200 }),
      );
      return response.dataStreams ?? [];
    },

    async getEnhancedMeasurementSettings(streamName: string) {
      const name = `${dataStreamNameSchema.parse(streamName)}/enhancedMeasurementSettings`;
      return enhancedMeasurementSettingsSchema.parse(
        await call("properties.dataStreams.getEnhancedMeasurementSettings", {
          name,
        }),
      );
    },

    async listKeyEvents(propertyId: string) {
      const parent = propertyIdSchema.parse(propertyId);
      const response = keyEventsResponseSchema.parse(
        await call("properties.keyEvents.list", { parent, pageSize: 200 }),
      );
      return response.keyEvents ?? [];
    },

    async listCustomDimensions(propertyId: string) {
      const parent = propertyIdSchema.parse(propertyId);
      const response = customDimensionsResponseSchema.parse(
        await call("properties.customDimensions.list", {
          parent,
          pageSize: 200,
        }),
      );
      return response.customDimensions ?? [];
    },

    async listCustomMetrics(propertyId: string) {
      const parent = propertyIdSchema.parse(propertyId);
      const response = customMetricsResponseSchema.parse(
        await call("properties.customMetrics.list", { parent, pageSize: 200 }),
      );
      return response.customMetrics ?? [];
    },
  };
}

const quotaStatusSchema = z.object({
  consumed: z.number().int(),
  remaining: z.number().int(),
});

const propertyQuotaSchema = z.object({
  tokensPerDay: quotaStatusSchema.optional(),
  tokensPerHour: quotaStatusSchema.optional(),
  concurrentRequests: quotaStatusSchema.optional(),
  serverErrorsPerProjectPerHour: quotaStatusSchema.optional(),
  potentiallyThresholdedRequestsPerHour: quotaStatusSchema.optional(),
  tokensPerProjectPerHour: quotaStatusSchema.optional(),
});

const responseMetadataSchema = z.object({
  dataLossFromOtherRow: z.boolean().optional(),
  samplingMetadatas: z
    .array(
      z.object({
        samplesReadCount: z.string(),
        samplingSpaceSize: z.string(),
      }),
    )
    .optional(),
  schemaRestrictionResponse: z
    .object({
      activeMetricRestrictions: z
        .array(
          z.object({
            metricName: z.string(),
            restrictedMetricTypes: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  currencyCode: z.string().optional(),
  timeZone: z.string().optional(),
  emptyReason: z.string().optional(),
  subjectToThresholding: z.boolean().optional(),
});

const runReportResponseSchema = z.object({
  dimensionHeaders: z.array(z.object({ name: z.string() })).optional(),
  metricHeaders: z
    .array(z.object({ name: z.string(), type: z.string().optional() }))
    .optional(),
  rows: z
    .array(
      z.object({
        dimensionValues: z.array(z.object({ value: z.string() })).optional(),
        metricValues: z.array(z.object({ value: z.string() })).optional(),
      }),
    )
    .optional(),
  rowCount: z.number().int().nonnegative().optional(),
  metadata: responseMetadataSchema.optional(),
  propertyQuota: propertyQuotaSchema.optional(),
  kind: z.string().optional(),
});

const googleErrorSchema = z.object({
  error: z.object({
    details: z
      .array(
        z.object({
          reason: z.string().optional(),
          metadata: z.object({ service: z.string().optional() }).optional(),
        }),
      )
      .optional(),
  }),
});

export type Ga4RunReportResponse = z.infer<typeof runReportResponseSchema>;

export type Ga4RunReportRequest = {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: unknown;
  metricFilter?: unknown;
  offset: string;
  limit: string;
  orderBys: Array<{
    metric?: { metricName: string };
    dimension?: { dimensionName: string };
    desc?: boolean;
  }>;
  keepEmptyRows: false;
  returnPropertyQuota: true;
};

function dataMessageForStatus(status: number): string {
  if (status === 400) return "Google Analytics rejected this report.";
  if (status === 401) return "Google Analytics connection expired.";
  if (status === 403) return "Google Analytics denied access to this property.";
  if (status === 429) return "Google Analytics reporting quota was exhausted.";
  return "Google Analytics reporting is temporarily unavailable.";
}

/** Google's error body rides on the failure's `details`; pull the reason the
 *  Data API attached (e.g. SERVICE_DISABLED) when it is there. */
function upstreamReasonOf(failure: ToolFailure): string | null {
  const parsed = googleErrorSchema.safeParse(failure.details);
  if (!parsed.success) return null;
  return (
    parsed.data.error.details?.find(
      (detail) => detail.metadata?.service === "analyticsdata.googleapis.com",
    )?.reason ??
    parsed.data.error.details?.find((detail) => detail.reason)?.reason ??
    null
  );
}

export function createGa4DataClient(opts: { propertyId: string }) {
  const property = propertyIdSchema.parse(opts.propertyId);

  return {
    async runReport(
      request: Ga4RunReportRequest,
    ): Promise<Ga4RunReportResponse> {
      const result = await invokeGoogleTool<unknown>(
        GOOGLE_ANALYTICS_DATA_INTEGRATION,
        "properties.runReport",
        { property, body: request },
      );
      if (!result.ok) {
        if (isCredentialFailure(result.error)) throw tokenError(result.error);
        const status = result.error.status ?? 0;
        throw new Ga4DataApiError(
          status,
          status === 0
            ? "Google Analytics reporting is temporarily unavailable."
            : dataMessageForStatus(status),
          null,
          upstreamReasonOf(result.error),
        );
      }

      const parsed = runReportResponseSchema.safeParse(result.data);
      if (!parsed.success) throw new Ga4MalformedResponseError();
      return parsed.data;
    },
  };
}
