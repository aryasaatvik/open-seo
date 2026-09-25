import { describe, expect, it } from "vitest";
import { runSelfhostPreflight } from "./selfhost-preflight";

function itemFor(
  result: ReturnType<typeof runSelfhostPreflight>,
  name: string,
) {
  return result.items.find((item) => item.name === name);
}

describe("runSelfhostPreflight", () => {
  it("passes the stock Docker setup (local_noauth)", () => {
    const result = runSelfhostPreflight({ AUTH_MODE: "local_noauth" });

    expect(result.failed).toBe(false);
    expect(itemFor(result, "AUTH_MODE")?.level).toBe("ok");
  });

  it("fails an invalid AUTH_MODE with the valid list", () => {
    const result = runSelfhostPreflight({ AUTH_MODE: "local-noauth" });

    expect(result.failed).toBe(true);
    expect(itemFor(result, "AUTH_MODE")?.message).toContain(
      "cloudflare_access, local_noauth, hosted",
    );
  });

  it("fails cloudflare_access mode without TEAM_DOMAIN and POLICY_AUD", () => {
    const result = runSelfhostPreflight({});

    expect(result.failed).toBe(true);
    const item = itemFor(result, "AUTH_MODE");
    expect(item?.message).toContain("TEAM_DOMAIN and POLICY_AUD");
    expect(item?.message).toContain("AUTH_MODE is unset");
  });

  it("fails a bare-hostname TEAM_DOMAIN with the https:// fix", () => {
    const result = runSelfhostPreflight({
      AUTH_MODE: "cloudflare_access",
      TEAM_DOMAIN: "your-team.cloudflareaccess.com",
      POLICY_AUD: "aud-tag",
    });

    expect(result.failed).toBe(true);
    expect(itemFor(result, "TEAM_DOMAIN")?.message).toContain("https://");
  });

  it("fails hosted mode listing every missing variable", () => {
    const result = runSelfhostPreflight({
      AUTH_MODE: "hosted",
      BETTER_AUTH_SECRET: "x".repeat(40),
    });

    expect(result.failed).toBe(true);
    const item = itemFor(result, "AUTH_MODE");
    expect(item?.message).toContain("BETTER_AUTH_URL");
    expect(item?.message).toContain("GOOGLE_CLIENT_ID");
    expect(item?.message).not.toContain("BETTER_AUTH_SECRET,");
  });

  it("mentions ALLOWED_HOST when unset", () => {
    const result = runSelfhostPreflight({ AUTH_MODE: "local_noauth" });

    expect(itemFor(result, "ALLOWED_HOST")?.level).toBe("info");
    expect(itemFor(result, "ALLOWED_HOST")?.message).toContain("reverse proxy");
  });
});
