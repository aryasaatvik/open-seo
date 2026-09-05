import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeTool: vi.fn(),
  listTools: vi.fn(async (integration: string) =>
    integration === "google_analytics_data"
      ? ["analyticsdata.properties.runReport"]
      : [
          "analyticsadmin.accountSummaries.list",
          "analyticsadmin.properties.get",
          "analyticsadmin.properties.dataStreams.list",
        ],
  ),
}));

vi.mock("cloudflare:workers", () => ({
  env: { INTEGRATIONS: { listTools: mocks.listTools } },
}));
vi.mock("@/server/lib/executor/client", () => ({
  invokeTool: mocks.invokeTool,
}));

import { createGa4AdminClient, createGa4DataClient } from "./ga4Client";
import {
  Ga4DataApiError,
  Ga4MalformedResponseError,
  Ga4TokenError,
} from "./ga4Errors";

const report = {
  dateRanges: [{ startDate: "2026-01-01", endDate: "2026-01-31" }],
  dimensions: [{ name: "landingPage" }],
  metrics: [{ name: "sessions" }],
  offset: "0",
  limit: "100",
  orderBys: [],
  keepEmptyRows: false as const,
  returnPropertyQuota: true as const,
};

describe("ga4Client admin API", () => {
  it("walks accountSummaries pages and flattens properties", async () => {
    mocks.invokeTool
      .mockResolvedValueOnce({
        ok: true,
        data: {
          accountSummaries: [
            {
              account: "accounts/1",
              displayName: "Agency",
              propertySummaries: [
                { property: "properties/11", displayName: "Site A" },
              ],
            },
          ],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          accountSummaries: [
            {
              account: "accounts/2",
              displayName: "Client",
              propertySummaries: [
                { property: "properties/22", displayName: "Site B" },
              ],
            },
          ],
        },
      });

    await expect(createGa4AdminClient().listProperties()).resolves.toEqual([
      {
        propertyId: "properties/11",
        displayName: "Site A",
        accountDisplayName: "Agency",
      },
      {
        propertyId: "properties/22",
        displayName: "Site B",
        accountDisplayName: "Client",
      },
    ]);
    expect(mocks.invokeTool.mock.calls[1]?.[1]).toEqual({
      pageSize: 200,
      pageToken: "page-2",
    });
  });

  it("maps a credential failure to a token error", async () => {
    mocks.invokeTool.mockResolvedValue({
      ok: false,
      error: { code: "ConnectionNotFoundError", message: "no connection" },
    });

    await expect(
      createGa4AdminClient().getProperty("properties/11"),
    ).rejects.toBeInstanceOf(Ga4TokenError);
  });
});

describe("ga4Client data API", () => {
  it("posts the report to the property and returns the parsed response", async () => {
    mocks.invokeTool.mockResolvedValue({
      ok: true,
      data: { rowCount: 0, rows: [] },
    });

    await expect(
      createGa4DataClient({ propertyId: "properties/123" }).runReport(report),
    ).resolves.toMatchObject({ rowCount: 0 });
    expect(mocks.invokeTool).toHaveBeenCalledWith(
      "tools.google_analytics_data.org.default.analyticsdata.properties.runReport",
      { property: "properties/123", body: report },
    );
  });

  it("keeps the status and Google's reason on a rejected report", async () => {
    mocks.invokeTool.mockResolvedValue({
      ok: false,
      error: {
        code: "upstream_http_error",
        message: "quota",
        status: 429,
        details: {
          error: {
            details: [
              {
                reason: "RATE_LIMIT_EXCEEDED",
                metadata: { service: "analyticsdata.googleapis.com" },
              },
            ],
          },
        },
      },
    });

    const rejection = createGa4DataClient({
      propertyId: "properties/123",
    }).runReport(report);
    await expect(rejection).rejects.toBeInstanceOf(Ga4DataApiError);
    await expect(rejection).rejects.toMatchObject({
      status: 429,
      upstreamReason: "RATE_LIMIT_EXCEEDED",
    });
  });

  it("rejects malformed successful responses", async () => {
    mocks.invokeTool.mockResolvedValue({
      ok: true,
      data: { rowCount: "not-a-number" },
    });

    await expect(
      createGa4DataClient({ propertyId: "properties/123" }).runReport(report),
    ).rejects.toBeInstanceOf(Ga4MalformedResponseError);
  });
});
