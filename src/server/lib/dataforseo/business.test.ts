import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/executor/client", () => ({ invokeTool: vi.fn() }));

import {
  fetchBusinessDataTaskResult,
  fetchBusinessListingsCategories,
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  postGoogleReviewsTask,
} from "@/server/lib/dataforseo/business";
import {
  address,
  envelope,
  gateway,
  httpFailure,
  requestOf,
} from "@/server/lib/dataforseo/gateway-test-support";

const okTask = (path: string[], result: unknown[]) =>
  envelope({
    status_code: 20000,
    tasks: [{ status_code: 20000, path, cost: 0.002, result }],
  });

describe("Google business_data fetchers", () => {
  it("sends a coordinate for my_business_info and returns the single item", async () => {
    gateway.mockResolvedValue(
      okTask(
        ["v3", "business_data", "google", "my_business_info", "live"],
        [{ items: [{ title: "Acme Cafe", is_claimed: true }] }],
      ),
    );

    const result = await fetchMyBusinessInfo({
      keyword: "cid:123",
      locationCoordinate: "33.1234568,-84.9876543,5000",
      locationCode: 2840,
      languageCode: "en",
    });

    const request = requestOf();
    expect(request.address).toBe(
      address("/v3/business_data/google/my_business_info/live"),
    );
    // The coordinate wins: DataForSEO rejects a request carrying both.
    expect(request.args.body).toEqual([
      {
        keyword: "cid:123",
        location_coordinate: "33.1234568,-84.9876543,5000",
        language_code: "en",
      },
    ]);
    expect(result.data).toEqual({ title: "Acme Cafe", is_claimed: true });
    expect(result.billing.costUsd).toBe(0.002);
  });

  it("falls back to location_code and treats no-results as an empty success", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            status_code: 40501,
            status_message: "No Search Results.",
            path: ["v3", "business_data", "google", "my_business_info", "live"],
            cost: 0.002,
          },
        ],
      }),
    );

    const result = await fetchMyBusinessInfo({
      keyword: "Nowhere Cafe",
      locationCode: 2840,
      languageCode: "en",
    });

    expect(requestOf().args.body).toEqual([
      {
        keyword: "Nowhere Cafe",
        location_code: 2840,
        language_code: "en",
      },
    ]);
    expect(result.data).toBeNull();
    // DataForSEO charges for an empty result, so it still has to be metered.
    expect(result.billing.costUsd).toBe(0.002);
  });

  it("posts regular reviews with sort_by and bills from the post entry", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            id: "task-1",
            status_code: 20100,
            cost: 0.00375,
            path: ["v3", "business_data", "google", "reviews", "task_post"],
          },
        ],
      }),
    );

    const result = await postGoogleReviewsTask({
      cid: "123",
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      sortBy: "newest",
      includeOtherSources: false,
    });

    const request = requestOf();
    expect(request.address).toBe(
      address("/v3/business_data/google/reviews/task_post"),
    );
    expect(request.args.body).toEqual([
      {
        cid: "123",
        location_code: 2840,
        language_code: "en",
        depth: 20,
        sort_by: "newest",
        priority: 2,
      },
    ]);
    expect(result).toEqual({
      data: "task-1",
      billing: {
        path: ["v3", "business_data", "google", "reviews", "task_post"],
        costUsd: 0.00375,
      },
    });
  });

  it("posts to the extended_reviews endpoint when other sources are requested", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            id: "task-2",
            status_code: 20100,
            cost: 0.01,
            path: [
              "v3",
              "business_data",
              "google",
              "extended_reviews",
              "task_post",
            ],
          },
        ],
      }),
    );

    const result = await postGoogleReviewsTask({
      cid: "123",
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      // The extended endpoint has no sort_by; the fetcher drops it.
      sortBy: "newest",
      includeOtherSources: true,
    });

    const request = requestOf();
    expect(request.address).toBe(
      address("/v3/business_data/google/extended_reviews/task_post"),
    );
    expect(request.args.body).toEqual([
      {
        cid: "123",
        location_code: 2840,
        language_code: "en",
        depth: 20,
        priority: 2,
      },
    ]);
    expect(result.data).toBe("task-2");
    expect(result.billing.path).toEqual([
      "v3",
      "business_data",
      "google",
      "extended_reviews",
      "task_post",
    ]);
  });

  it("never replays a task_post on a 5xx (a retry could double-charge)", async () => {
    gateway.mockResolvedValue(httpFailure(500, "upstream error"));

    await expect(
      postGoogleReviewsTask({
        cid: "123",
        locationCode: 2840,
        languageCode: "en",
        depth: 20,
        sortBy: "newest",
        includeOtherSources: false,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("reports a queued task as pending instead of failing", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [{ status_code: 40602, status_message: "Task In Queue." }],
      }),
    );

    await expect(
      fetchBusinessDataTaskResult({ endpoint: "reviews", taskId: "task-1" }),
    ).resolves.toEqual({ status: "pending", result: null });
  });

  it("returns the first result once the task completed", async () => {
    gateway.mockResolvedValue(
      okTask(
        ["v3", "business_data", "google", "extended_reviews", "task_get"],
        [{ reviews_count: 12, items: [{ review_text: "Great" }] }],
      ),
    );

    const outcome = await fetchBusinessDataTaskResult({
      endpoint: "extended_reviews",
      taskId: "task-9",
    });

    expect(requestOf()).toEqual({
      address: address(
        "/v3/business_data/google/extended_reviews/task_get/{id}",
      ),
      args: { id: "task-9" },
    });
    expect(outcome).toEqual({
      status: "completed",
      result: { reviews_count: 12, items: [{ review_text: "Great" }] },
    });
  });

  it("maps the free categories list onto category/businessCount rows", async () => {
    gateway.mockResolvedValue(
      okTask(
        ["v3", "business_data", "business_listings", "categories"],
        [
          { category_name: "pizza_restaurant", business_count: 12 },
          { category_name: "plumber" },
        ],
      ),
    );

    const result = await fetchBusinessListingsCategories();

    expect(result.data).toEqual([
      { category: "pizza_restaurant", businessCount: 12 },
      { category: "plumber", businessCount: null },
    ]);
  });

  it("forwards business-listing filters, claim status, and offset", async () => {
    gateway.mockResolvedValue(
      okTask(
        ["v3", "business_data", "business_listings", "search", "live"],
        [{ items: [] }],
      ),
    );

    await fetchBusinessListingsSearch({
      locationCoordinate: "33.1,-84.9,5",
      isClaimed: false,
      filters: [["rating.value", ">=", 4]],
      orderBy: ["rating.value,desc"],
      limit: 20,
      offset: 10,
    });

    expect(requestOf().args.body).toEqual([
      {
        location_coordinate: "33.1,-84.9,5",
        is_claimed: false,
        filters: [["rating.value", ">=", 4]],
        order_by: ["rating.value,desc"],
        limit: 20,
        offset: 10,
      },
    ]);
  });
});
