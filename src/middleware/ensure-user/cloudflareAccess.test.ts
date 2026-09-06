import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCloudflareAccessContext,
  serviceTokenAliasEmail,
} from "./cloudflareAccess";

const { jwtVerifyMock, byIdMock, byEmailMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  byIdMock: vi.fn(),
  byEmailMock: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    POLICY_AUD: "aud",
    ACCESS_SERVICE_TOKEN_ALIASES: "abc.access=saatvik@example.com",
  },
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: jwtVerifyMock,
}));

vi.mock("./delegated", () => ({
  resolveSharedWorkspaceContext: byIdMock,
  resolveSharedWorkspaceContextByEmail: byEmailMock,
}));

const headers = new Headers({ "cf-access-jwt-assertion": "token" });

describe("resolveCloudflareAccessContext", () => {
  beforeEach(() => {
    byIdMock.mockResolvedValue({ userId: "u1" });
    byEmailMock.mockResolvedValue({ userId: "u1" });
  });

  it("resolves a human token by sub and email", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "u1", email: "saatvik@example.com" },
    });

    await resolveCloudflareAccessContext(headers);

    expect(byIdMock).toHaveBeenCalledWith("u1", "saatvik@example.com");
  });

  it("resolves an aliased service token as the mapped user", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { common_name: "abc.access" },
    });

    await resolveCloudflareAccessContext(headers);

    expect(byEmailMock).toHaveBeenCalledWith("saatvik@example.com");
  });

  it("rejects a service token with no alias", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { common_name: "other.access" },
    });

    await expect(resolveCloudflareAccessContext(headers)).rejects.toMatchObject(
      { code: "UNAUTHENTICATED" },
    );
    expect(byEmailMock).not.toHaveBeenCalled();
  });
});

describe("serviceTokenAliasEmail", () => {
  it("ignores malformed entries and whitespace", () => {
    expect(
      serviceTokenAliasEmail(
        " a.access = a@x.com ,broken, b.access=b@x.com",
        "b.access",
      ),
    ).toBe("b@x.com");
    expect(serviceTokenAliasEmail(undefined, "a.access")).toBeNull();
  });
});
