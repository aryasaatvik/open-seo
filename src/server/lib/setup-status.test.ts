import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataforseoToolAddress } from "@/shared/integration-addresses";

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  invokeTool: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { INTEGRATIONS: { listConnections: mocks.listConnections } },
}));
vi.mock("@/server/lib/executor/client", () => ({
  invokeTool: mocks.invokeTool,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => undefined,
}));
// The database probe is not under test here; it only has to resolve so the
// integrations probe runs alongside it.
vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => Promise.resolve([{ value: 0 }]) }) },
}));

import { getSelfHostSetupStatus, getSetupIssueSummary } from "./setup-status";

const dataforseoConnection = {
  integration: "dataforseo_api",
  identityLabel: "DataForSEO",
};

async function integrationsCheck() {
  const status = await getSelfHostSetupStatus();
  return status.checks.integrations;
}

describe("integrations health check", () => {
  beforeEach(() => {
    mocks.listConnections.mockResolvedValue([dataforseoConnection]);
    mocks.invokeTool.mockResolvedValue({
      ok: true,
      data: { status_code: 20000 },
    });
  });

  it("is ok when the gateway holds DataForSEO and the free account call succeeds", async () => {
    mocks.listConnections.mockResolvedValue([
      dataforseoConnection,
      { integration: "google_search_console", identityLabel: "a@b.c" },
    ]);

    await expect(integrationsCheck()).resolves.toEqual({
      status: "ok",
      detail: "2 connections",
    });
    expect(mocks.invokeTool).toHaveBeenCalledWith(
      dataforseoToolAddress("/v3/appendix/user_data"),
      {},
    );
  });

  it("errors without calling the provider when the DataForSEO connection is missing", async () => {
    mocks.listConnections.mockResolvedValue([]);

    const check = await integrationsCheck();
    expect(check.status).toBe("error");
    expect(check.detail).toContain("DATAFORSEO_API_KEY");
    expect(mocks.invokeTool).not.toHaveBeenCalled();
  });

  it("errors with the gateway code and status when the provider rejects the credential", async () => {
    mocks.invokeTool.mockResolvedValue({
      ok: false,
      error: { code: "upstream_status", message: "Unauthorized", status: 401 },
    });

    const check = await integrationsCheck();
    expect(check.status).toBe("error");
    expect(check.detail).toContain("upstream_status 401");
  });

  it("errors as unreachable when the gateway RPC throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.listConnections.mockRejectedValue(new Error("binding missing"));

    const check = await integrationsCheck();
    expect(check.status).toBe("error");
    expect(check.detail).toContain("unreachable");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("skips the gateway probe with the database probe for the telemetry summary", async () => {
    const summary = await getSetupIssueSummary();

    expect(mocks.listConnections).not.toHaveBeenCalled();
    expect(summary).not.toContain("integrations:error");
  });
});
