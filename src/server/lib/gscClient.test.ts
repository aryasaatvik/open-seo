import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeTool: vi.fn(),
  listTools: vi.fn(async () => [
    "webmasters.sites.list",
    "webmasters.searchanalytics.query",
    "searchconsole.urlInspection.index.inspect",
  ]),
}));

vi.mock("cloudflare:workers", () => ({
  env: { INTEGRATIONS: { listTools: mocks.listTools } },
}));
vi.mock("@/server/lib/executor/client", () => ({
  invokeTool: mocks.invokeTool,
}));

import { createGscClient } from "./gscClient";
import { GscApiError, GscTokenError } from "./gscErrors";

describe("gscClient", () => {
  it("resolves the tool by method suffix and passes the site and body", async () => {
    mocks.invokeTool.mockResolvedValue({ ok: true, data: { rows: [] } });

    await createGscClient({ organizationId: "org_1" }).querySearchAnalytics(
      "sc-domain:example.com",
      {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
    );

    expect(mocks.invokeTool).toHaveBeenCalledWith(
      "tools.google_search_console.org.org_1.webmasters.searchanalytics.query",
      {
        siteUrl: "sc-domain:example.com",
        body: { startDate: "2026-01-01", endDate: "2026-01-31" },
      },
    );
  });

  it("maps a credential failure to a token error", async () => {
    mocks.invokeTool.mockResolvedValue({
      ok: false,
      error: { code: "CredentialResolutionError", message: "expired" },
    });

    await expect(
      createGscClient({ organizationId: "org_1" }).listSites(),
    ).rejects.toBeInstanceOf(GscTokenError);
  });

  it("keeps the upstream status on API errors", async () => {
    mocks.invokeTool.mockResolvedValue({
      ok: false,
      error: { code: "upstream_http_error", message: "denied", status: 403 },
    });

    await expect(
      createGscClient({ organizationId: "org_1" }).listSites(),
    ).rejects.toMatchObject({
      name: "GscApiError",
      status: 403,
    });
    await expect(
      createGscClient({ organizationId: "org_1" }).listSites(),
    ).rejects.toBeInstanceOf(GscApiError);
  });
});
