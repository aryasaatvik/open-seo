import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listTools: vi.fn(), invokeTool: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
  env: { INTEGRATIONS: { listTools: mocks.listTools } },
}));
vi.mock("@/server/lib/executor/client", () => ({
  invokeTool: mocks.invokeTool,
}));

import { invokeGoogleTool } from "./google";

describe("invokeGoogleTool", () => {
  it("retries the tool lookup after a failed one instead of caching the failure", async () => {
    mocks.listTools
      .mockRejectedValueOnce(new Error("gateway booting"))
      .mockResolvedValueOnce(["webmasters.sites.list"]);
    mocks.invokeTool.mockResolvedValue({ ok: true, data: {} });

    await expect(
      invokeGoogleTool("org_1", "google_search_console", "sites.list", {}),
    ).rejects.toThrow("gateway booting");
    await expect(
      invokeGoogleTool("org_1", "google_search_console", "sites.list", {}),
    ).resolves.toEqual({ ok: true, data: {} });

    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.invokeTool).toHaveBeenCalledWith(
      "tools.google_search_console.org.org_1.webmasters.sites.list",
      {},
    );
  });
});
