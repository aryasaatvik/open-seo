import { afterEach, describe, expect, it, vi } from "vitest";

// Mocks the transport rather than the gateway so the pending calls carry no
// request deadline of their own; only the slot wait is on the fake clock.
vi.mock("@/server/lib/dataforseo/core", () => ({ dataforseoPost: vi.fn() }));

import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";

const transport = vi.mocked(dataforseoPost);

describe("fetchLighthouseResult slot wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails a queued call after three minutes instead of starting it late", async () => {
    vi.useFakeTimers();
    transport.mockImplementation(() => new Promise(() => undefined));
    const input = { url: "https://example.com/", strategy: "mobile" as const };

    const pending = Array.from({ length: 3 }, () =>
      fetchLighthouseResult(input),
    );
    const rejection = expect(fetchLighthouseResult(input)).rejects.toThrow(
      /waited over 3 minutes/,
    );
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await rejection;
    expect(transport).toHaveBeenCalledTimes(3);
    void pending;
  });
});
