import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { GatewayExecutor } from "./executor";
import { googleOAuthComplete, googleOAuthStart } from "./google-oauth";

function fakeExecutor(startResult: unknown = null) {
  const start = vi.fn(() =>
    Effect.succeed(
      startResult ?? {
        status: "redirect",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
      },
    ),
  );
  const complete = vi.fn(() =>
    Effect.succeed({
      integration: "google_search_console",
      name: "org_1",
      identityLabel: "owner@example.com",
      expiresAt: 1_700_000_000,
    }),
  );
  return {
    start,
    complete,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only oauth.start/complete are exercised
    executor: { oauth: { start, complete } } as unknown as GatewayExecutor,
  };
}

describe("googleOAuthStart", () => {
  it("mints the grant under the organization's connection with the first-party client", async () => {
    const { executor, start } = fakeExecutor();

    await expect(
      Effect.runPromise(
        googleOAuthStart(executor, "google_search_console", "org_1"),
      ),
    ).resolves.toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    });
    expect(start).toHaveBeenCalledWith({
      client: "first-party:google",
      clientOwner: "org",
      owner: "org",
      name: "org_1",
      integration: "google_search_console",
      template: "googleOAuth2",
    });
  });

  it("refuses a non-Google integration before touching the executor", async () => {
    const { executor, start } = fakeExecutor();

    await expect(
      Effect.runPromise(googleOAuthStart(executor, "dataforseo_api", "org_1")),
    ).rejects.toThrow(/Not a Google integration/);
    expect(start).not.toHaveBeenCalled();
  });

  it("fails when the provider does not answer with a redirect", async () => {
    const { executor } = fakeExecutor({ status: "connected" });

    await expect(
      Effect.runPromise(
        googleOAuthStart(executor, "google_search_console", "org_1"),
      ),
    ).rejects.toThrow(/did not produce a redirect/);
  });
});

describe("googleOAuthComplete", () => {
  it("hands the code and state to the executor and returns the minted connection", async () => {
    const { executor, complete } = fakeExecutor();

    await expect(
      Effect.runPromise(
        googleOAuthComplete(executor, { state: "state-1", code: "code-1" }),
      ),
    ).resolves.toEqual({
      integration: "google_search_console",
      name: "org_1",
      identityLabel: "owner@example.com",
      expiresAt: 1_700_000_000,
    });
    expect(complete).toHaveBeenCalledWith({ state: "state-1", code: "code-1" });
  });
});
