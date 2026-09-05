import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4AdminApiError, Ga4TokenError } from "@/server/lib/ga4Errors";
import { Ga4Service } from "./Ga4Service";

const mocks = vi.hoisted(() => ({
  listProperties: vi.fn(),
  getProperty: vi.fn(),
  googleConnectionStatus: vi.fn(),
  upsert: vi.fn(),
  getByProjectId: vi.fn(),
  deleteByProjectId: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4AdminClient: () => ({
    listProperties: mocks.listProperties,
    getProperty: mocks.getProperty,
  }),
}));
vi.mock("@/server/lib/executor/google", () => ({
  googleConnectionStatus: mocks.googleConnectionStatus,
  GoogleNotConnectedError: class extends Error {},
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: {
    upsert: mocks.upsert,
    getByProjectId: mocks.getByProjectId,
    deleteByProjectId: mocks.deleteByProjectId,
  },
}));

describe("Ga4Service", () => {
  beforeEach(() => {
    mocks.googleConnectionStatus.mockResolvedValue({
      connected: true,
      email: "owner@example.com",
    });
  });

  it("verifies a discovered property before persisting its metadata", async () => {
    mocks.listProperties.mockResolvedValue([
      {
        propertyId: "properties/11",
        displayName: "Site A",
        accountDisplayName: "Agency",
      },
    ]);
    mocks.getProperty.mockResolvedValue({
      name: "properties/11",
      displayName: "Site A",
      timeZone: "America/New_York",
      currencyCode: "USD",
    });
    mocks.upsert.mockResolvedValue({ propertyId: "properties/11" });

    await Ga4Service.setProperty({
      projectId: "p1",
      organizationId: "org1",
      propertyId: "properties/11",
    });

    expect(mocks.upsert).toHaveBeenCalledWith({
      projectId: "p1",
      organizationId: "org1",
      propertyId: "properties/11",
      propertyDisplayName: "Site A",
      propertyTimeZone: "America/New_York",
      propertyCurrencyCode: "USD",
    });
  });

  it("rejects a property the connected account cannot see", async () => {
    mocks.listProperties.mockResolvedValue([]);

    await expect(
      Ga4Service.setProperty({
        projectId: "p1",
        organizationId: "org1",
        propertyId: "properties/11",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("distinguishes an expired grant from inaccessible property discovery", async () => {
    mocks.listProperties.mockRejectedValueOnce(new Ga4TokenError("revoked"));
    await expect(Ga4Service.listProperties()).resolves.toMatchObject({
      requiresReconnect: true,
      propertiesUnavailable: false,
    });

    mocks.listProperties.mockRejectedValueOnce(
      new Ga4AdminApiError(403, "forbidden"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(Ga4Service.listProperties()).resolves.toMatchObject({
      requiresReconnect: false,
      propertiesUnavailable: true,
    });
    expect(consoleError).toHaveBeenCalledWith("ga4.property_discovery_failed", {
      errorName: "Ga4AdminApiError",
      status: 403,
    });
    consoleError.mockRestore();
  });

  it("reports both Analytics grants as one connection", async () => {
    mocks.googleConnectionStatus
      .mockResolvedValueOnce({ connected: true, email: "owner@example.com" })
      .mockResolvedValueOnce({ connected: false, email: null });

    await expect(Ga4Service.getGoogleConnection()).resolves.toEqual({
      connected: false,
      email: "owner@example.com",
    });
  });
});
