import { beforeEach, describe, expect, it, vi } from "vitest";
import { GscApiError, GscTokenError } from "@/server/lib/gscErrors";
import { GscService } from "./GscService";

const mocks = vi.hoisted(() => ({
  listSites: vi.fn(),
  querySearchAnalytics: vi.fn(),
  googleConnectionStatus: vi.fn(),
  upsert: vi.fn(),
  getByProjectId: vi.fn(),
  deleteByProjectId: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/gscClient", () => ({
  createGscClient: () => ({
    listSites: mocks.listSites,
    querySearchAnalytics: mocks.querySearchAnalytics,
  }),
}));
vi.mock("@/server/lib/executor/google", () => ({
  googleConnectionStatus: mocks.googleConnectionStatus,
  GoogleNotConnectedError: class extends Error {},
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: {
    upsert: mocks.upsert,
    getByProjectId: mocks.getByProjectId,
    deleteByProjectId: mocks.deleteByProjectId,
  },
}));

const baseInput = { projectId: "p1", organizationId: "org1" };

describe("GscService", () => {
  beforeEach(() => {
    mocks.googleConnectionStatus.mockResolvedValue({
      connected: true,
      email: "owner@example.com",
    });
    mocks.upsert.mockResolvedValue({ siteUrl: "https://x/" });
  });

  it("binds a verified property without touching the grant", async () => {
    mocks.listSites.mockResolvedValue([
      { siteUrl: "https://x/", permissionLevel: "siteOwner" },
    ]);

    await GscService.setSite({ ...baseInput, siteUrl: "https://x/" });

    expect(mocks.upsert).toHaveBeenCalledWith({
      projectId: "p1",
      organizationId: "org1",
      siteUrl: "https://x/",
    });
  });

  it("rejects an unverified property with FORBIDDEN", async () => {
    mocks.listSites.mockResolvedValue([
      { siteUrl: "https://x/", permissionLevel: "siteUnverifiedUser" },
    ]);

    await expect(
      GscService.setSite({ ...baseInput, siteUrl: "https://x/" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("reports a dead grant as a reconnect instead of failing the list", async () => {
    mocks.listSites.mockRejectedValue(new GscTokenError("revoked"));

    await expect(GscService.listSites(baseInput)).resolves.toEqual({
      requiresReconnect: true,
      sitesUnavailable: false,
      email: "owner@example.com",
      sites: [],
    });
    expect(mocks.googleConnectionStatus).toHaveBeenCalledWith(
      "org1",
      "google_search_console",
    );
  });

  it("reports a non-auth API error as a retry, not a reconnect", async () => {
    const rateLimit = new GscApiError(429, "slow down");
    mocks.listSites.mockRejectedValue(rateLimit);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(GscService.listSites(baseInput)).resolves.toMatchObject({
      requiresReconnect: false,
      sitesUnavailable: true,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to list Search Console sites",
      rateLimit,
    );
    consoleError.mockRestore();
  });

  it("labels performance results with the connected Google account", async () => {
    mocks.getByProjectId.mockResolvedValue({
      siteUrl: "https://x/",
      organizationId: "org1",
    });
    mocks.querySearchAnalytics.mockResolvedValue([]);

    await expect(
      GscService.getPerformance({
        projectId: "p1",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }),
    ).resolves.toMatchObject({
      siteUrl: "https://x/",
      connectedBy: "owner@example.com",
    });
  });
});
