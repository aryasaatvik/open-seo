import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/executor/client", () => ({ invokeTool: vi.fn() }));

import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";
import {
  envelope,
  gateway,
  httpFailure,
} from "@/server/lib/dataforseo/gateway-test-support";

describe("fetchLighthouseResult", () => {
  it("carries billing metadata when parsing fails after a billed success", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        status_message: "Ok.",
        tasks: [
          {
            id: "task-1",
            status_code: 20000,
            status_message: "Ok.",
            path: ["v3", "on_page", "lighthouse", "live", "json"],
            cost: 0.00425,
            result: [
              {
                requestedUrl: "https://example.com/",
                finalUrl: "https://example.com/",
                categories: {},
                audits: {},
              },
            ],
          },
        ],
      }),
    );

    const rejection = fetchLighthouseResult({
      url: "https://example.com/",
      strategy: "mobile",
    });

    await expect(rejection).rejects.toBeInstanceOf(DataforseoChargedTaskError);
    await expect(rejection).rejects.toMatchObject({
      billing: {
        path: ["v3", "on_page", "lighthouse", "live", "json"],
        costUsd: 0.00425,
      },
    });
  });

  it("does not retry an HTTP 5xx (the provider may have charged the task)", async () => {
    gateway.mockResolvedValue(httpFailure(503));

    await expect(
      fetchLighthouseResult({
        url: "https://example.com/",
        strategy: "mobile",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(gateway).toHaveBeenCalledOnce();
  });
});
