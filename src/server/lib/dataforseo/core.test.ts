import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/executor/client", () => ({ invokeTool: vi.fn() }));

import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  address,
  envelope,
  gateway,
  httpFailure,
  requestOf,
} from "@/server/lib/dataforseo/gateway-test-support";

describe("DataForSEO transport", () => {
  it("retries a transient 5xx on idempotent reads and returns the envelope", async () => {
    gateway
      .mockResolvedValueOnce(httpFailure(503))
      .mockResolvedValueOnce(envelope({ status_code: 20000, tasks: [] }));

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", [{ target: "a.com" }]),
    ).resolves.toEqual({ status_code: 20000, tasks: [] });
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(requestOf()).toEqual({
      address: address("/v3/backlinks/summary/live"),
      args: { body: [{ target: "a.com" }] },
    });
  });

  it("passes path parameters as top-level arguments", async () => {
    gateway.mockResolvedValue(envelope({ status_code: 20000, tasks: [] }));

    await dataforseoGet("/v3/serp/google/locations/{country}", {
      params: { country: "us" },
    });

    expect(requestOf()).toEqual({
      address: "tools.dataforseo_api.org.default.serp.google.locations",
      args: { country: "us" },
    });
  });

  it("maps upstream statuses onto the app's error codes without retrying 4xx", async () => {
    gateway.mockResolvedValue(httpFailure(401, "unauthorized"));

    await expect(
      dataforseoPost("/v3/serp/google/organic/live/advanced", []),
    ).rejects.toMatchObject({
      code: "DATAFORSEO_AUTH_FAILED",
      name: "DataForSEOHttpError",
      details: { providerPath: "/v3/serp/google/organic/live/advanced" },
    });
    expect(gateway).toHaveBeenCalledOnce();
  });

  // A call past the deadline may already be billed by DataForSEO, and nothing
  // meters it, so replaying would be spend eaten twice.
  it("maps a deadline overrun to UPSTREAM_UNAVAILABLE without retrying", async () => {
    gateway.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(envelope({ status_code: 20000 })), 50),
        ),
    );

    await expect(
      dataforseoPost("/v3/serp/google/organic/live/advanced", [], {
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      name: "DataForSEOTimeoutError",
    });
    expect(gateway).toHaveBeenCalledOnce();
  });
});
