import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  googleOAuthStart: vi.fn(),
  googleOAuthComplete: vi.fn(),
  listConnections: vi.fn(),
  removeConnection: vi.fn(),
  resolveUserContextFromHeaders: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    INTEGRATIONS: {
      googleOAuthStart: mocks.googleOAuthStart,
      googleOAuthComplete: mocks.googleOAuthComplete,
      listConnections: mocks.listConnections,
      removeConnection: mocks.removeConnection,
    },
  },
}));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: mocks.resolveUserContextFromHeaders,
}));

import {
  handleGoogleConnectCallback,
  handleGoogleConnectStart,
} from "./connect";

const ORIGIN = "https://seo.example";

function flowCookie(flow: object) {
  return `openseo_google_connect=${encodeURIComponent(JSON.stringify(flow))}`;
}

function cookieFlow(response: Response) {
  const raw = response.headers.get("set-cookie") ?? "";
  const value = raw.slice("openseo_google_connect=".length, raw.indexOf(";"));
  return value ? (JSON.parse(decodeURIComponent(value)) as unknown) : null;
}

describe("Google connect flow", () => {
  beforeEach(() => {
    mocks.resolveUserContextFromHeaders.mockResolvedValue({
      organizationId: "org_1",
    });
    mocks.googleOAuthStart.mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/consent",
    });
    mocks.listConnections.mockResolvedValue([]);
  });

  it("starts the grant under the caller's organization and keeps the return path", async () => {
    const response = await handleGoogleConnectStart(
      new Request(
        `${ORIGIN}/api/integrations/google/start?provider=gsc&returnTo=/p/1/settings`,
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.com/consent",
    );
    expect(mocks.googleOAuthStart).toHaveBeenCalledWith(
      "google_search_console",
      "org_1",
    );
    expect(cookieFlow(response)).toEqual({
      provider: "gsc",
      returnTo: "/p/1/settings",
      step: 0,
    });
  });

  it("falls back to the projects list for a backslash return path", async () => {
    const response = await handleGoogleConnectStart(
      new Request(
        `${ORIGIN}/api/integrations/google/start?provider=gsc&returnTo=${encodeURIComponent("/\\evil.example")}`,
      ),
    );

    expect(cookieFlow(response)).toMatchObject({ returnTo: "/projects" });
  });

  it("drops an Analytics Data grant made with a different Google account", async () => {
    mocks.googleOAuthComplete.mockResolvedValue({
      integration: "google_analytics_data",
      name: "org_1",
      identityLabel: "other@example.com",
      expiresAt: null,
    });
    mocks.listConnections.mockResolvedValue([
      {
        integration: "google_analytics_admin",
        name: "org_1",
        identityLabel: "admin@example.com",
        expiresAt: null,
      },
    ]);
    const flow = { provider: "ga4", returnTo: "/p/1/settings", step: 1 };

    const response = await handleGoogleConnectCallback(
      new Request(`${ORIGIN}/api/integrations/google/callback?state=s&code=c`, {
        headers: { cookie: flowCookie(flow) },
      }),
    );

    expect(mocks.removeConnection).toHaveBeenCalledWith(
      "google_analytics_data",
      "org_1",
    );
    expect(response.headers.get("location")).toBe(
      "/p/1/settings?google_link_error=ga4&error=account_mismatch",
    );
  });

  it("refuses to act on a grant minted for another organization", async () => {
    mocks.googleOAuthComplete.mockResolvedValue({
      integration: "google_analytics_data",
      name: "org_other",
      identityLabel: "other@example.com",
      expiresAt: null,
    });

    const response = await handleGoogleConnectCallback(
      new Request(`${ORIGIN}/api/integrations/google/callback?state=s&code=c`, {
        headers: {
          cookie: flowCookie({ provider: "ga4", returnTo: "/p/1", step: 1 }),
        },
      }),
    );

    expect(mocks.listConnections).not.toHaveBeenCalled();
    expect(mocks.removeConnection).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "/p/1?google_link_error=ga4&error=organization_mismatch",
    );
  });
});
