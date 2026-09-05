import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/executor/client", () => ({ invokeTool: vi.fn() }));

import {
  fetchLiveSerp,
  fetchRankCheckTaskResult,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";
import {
  address,
  envelope,
  gateway,
  requestOf,
} from "@/server/lib/dataforseo/gateway-test-support";

describe("live SERP", () => {
  // 40102 is the documented "No Search Results." code (40501 is "Invalid
  // Field."). isNoResultsTask matches on the status message, not the code, so
  // this stays correct whichever code DataForSEO attaches to the message.
  it("returns an empty result for DataForSEO's no-results task", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            status_code: 40102,
            status_message: "No Search Results.",
            path: ["v3", "serp", "google", "organic", "live", "advanced"],
            cost: 0.002,
            result_count: 0,
            result: [],
          },
        ],
      }),
    );

    await expect(
      fetchLiveSerp({
        keyword: "obscure query",
        locationCode: 2840,
        languageCode: "en",
      }),
    ).resolves.toMatchObject({
      data: [],
      billing: { costUsd: 0.002 },
    });
  });
});

describe("rank check task queue", () => {
  it("posts queued tasks, maps ids by tag, and sums cost over all entries", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:desktop" },
          },
          {
            id: "task-b",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:mobile" },
          },
          {
            id: "task-c",
            status_code: 40006,
            status_message: "Task Limit Exceeded",
            cost: 0.0006,
            data: { tag: "kw-2:desktop" },
          },
        ],
      }),
    );

    const result = await postRankCheckTasks({
      tasks: [
        { keyword: "alpha", keywordId: "kw-1", device: "desktop" },
        { keyword: "alpha", keywordId: "kw-1", device: "mobile" },
        { keyword: "beta", keywordId: "kw-2", device: "desktop" },
      ],
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      targetDomain: "example.com",
    });

    const request = requestOf();
    expect(request.address).toBe(address("/v3/serp/google/organic/task_post"));

    // Every posted task asks DataForSEO to stop crawling at the target's
    // organic listing — that is what cuts the actual crawl cost for ranking
    // domains without false "not ranking" stops on sitelinks/PAA mentions.
    const stopCrawl = {
      stop_crawl_on_match: [
        { match_value: "example.com", match_type: "with_subdomains" },
      ],
      find_targets_in: ["organic"],
    };
    expect(request.args.body).toMatchObject([stopCrawl, stopCrawl, stopCrawl]);
    expect(result.data).toEqual([
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "desktop",
        taskId: "task-a",
      },
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "mobile",
        taskId: "task-b",
      },
    ]);
    // The rejected entry's cost is still metered: a charge is a charge.
    expect(result.billing.costUsd).toBeCloseTo(0.0018, 10);
    expect(result.billing.path).toEqual([
      "v3",
      "serp",
      "google",
      "organic",
      "task_post",
    ]);
  });

  it("reports a queued task still in progress as pending", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({ status: "pending" });
    expect(requestOf()).toEqual({
      address: address("/v3/serp/google/organic/task_get/advanced/{id}"),
      args: { id: "task-a" },
    });
  });

  it("parses a completed queued task into a rank check result", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20000,
            cost: 0,
            path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
            result: [
              {
                items: [
                  {
                    type: "organic",
                    rank_group: 3,
                    rank_absolute: 4,
                    domain: "www.example.com",
                    url: "https://www.example.com/page",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({
      status: "completed",
      result: {
        keywordId: "kw-1",
        keyword: "alpha",
        position: 3,
        url: "https://www.example.com/page",
        serpFeatures: ["organic"],
      },
    });
  });
});
