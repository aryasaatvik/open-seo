import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/executor/client", () => ({ invokeTool: vi.fn() }));

import { fetchQuestionsAnswers } from "@/server/lib/dataforseo/business";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from "@/server/lib/dataforseo/ai";
import { buildLlmTarget } from "@/server/lib/dataforseo/shared";
import {
  address,
  envelope,
  gateway,
  requestOf,
} from "@/server/lib/dataforseo/gateway-test-support";

describe("DataForSEO SDK-backed endpoints", () => {
  it("uses the live endpoint for Google Business Q&A and returns items + billing", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            path: [
              "v3",
              "business_data",
              "google",
              "questions_and_answers",
              "live",
            ],
            cost: 0.0006,
            result_count: 1,
            result: [
              {
                items: [
                  {
                    question_text: "Do you offer indoor storage?",
                    answer_text: "Yes.",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = await fetchQuestionsAnswers({
      keyword: "Acme Storage",
      locationCoordinate: "33.1234568,-84.9876543,5000",
      languageCode: "en",
      depth: 20,
    });

    expect(requestOf().address).toBe(
      address("/v3/business_data/google/questions_and_answers/live"),
    );
    expect(result.data).toEqual([
      { question_text: "Do you offer indoor storage?", answer_text: "Yes." },
    ]);
    expect(result.billing).toEqual({
      path: ["v3", "business_data", "google", "questions_and_answers", "live"],
      costUsd: 0.0006,
    });
  });

  it("serializes LLM mentions domain targets for search, top pages, and aggregated endpoints", async () => {
    gateway.mockImplementation((toolAddress) => {
      const tool = toolAddress.split(".org.default.")[1] ?? "";
      const result = tool.endsWith(".aggregated_metrics.live")
        ? { total: { platform: [] } }
        : { items: [] };

      return Promise.resolve(
        envelope({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              path: ["v3", ...tool.split(".")],
              cost: 0.0001,
              result_count: 1,
              result: [result],
            },
          ],
        }),
      );
    });

    const target = buildLlmTarget({
      type: "domain",
      value: "example.com",
    });

    await fetchLlmMentionsSearch({
      target,
      platform: "google",
      locationCode: 2840,
      languageCode: "en",
    });
    await fetchLlmAggregatedMetrics({
      target,
      platform: "google",
      locationCode: 2840,
      languageCode: "en",
    });
    await fetchLlmTopPages({
      target,
      platform: "google",
      locationCode: 2840,
      languageCode: "en",
      itemsListLimit: 10,
    });
    const expectedTarget = [
      {
        search_scope: ["any"],
        search_filter: "include",
        domain: "example.com",
        include_subdomains: true,
      },
    ];
    const payloads = gateway.mock.calls.map(
      (_, index) => requestOf(index).args.body,
    );

    expect(payloads).toEqual([
      [
        {
          target: expectedTarget,
          location_code: 2840,
          language_code: "en",
          platform: "google",
          limit: 100,
        },
      ],
      [
        {
          target: expectedTarget,
          location_code: 2840,
          language_code: "en",
          platform: "google",
          internal_list_limit: 10,
        },
      ],
      [
        {
          target: expectedTarget,
          location_code: 2840,
          language_code: "en",
          platform: "google",
          links_scope: "sources",
          items_list_limit: 10,
          internal_list_limit: 5,
        },
      ],
    ]);
  });

  it("serializes cross-aggregated target groups", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            path: [
              "v3",
              "ai_optimization",
              "llm_mentions",
              "cross_aggregated_metrics",
              "live",
            ],
            cost: 0.0001,
            result_count: 1,
            result: [{ items: [] }],
          },
        ],
      }),
    );

    await fetchLlmCrossAggregatedMetrics({
      groups: [
        {
          key: "example.com",
          target: buildLlmTarget({ type: "domain", value: "example.com" }),
        },
        {
          key: "Acme Storage",
          target: buildLlmTarget({ type: "keyword", value: "Acme Storage" }),
        },
      ],
      platform: "google",
      locationCode: 2840,
      languageCode: "en",
    });

    expect(requestOf().args.body).toEqual([
      {
        targets: [
          {
            aggregation_key: "example.com",
            target: [
              {
                search_scope: ["any"],
                search_filter: "include",
                domain: "example.com",
                include_subdomains: true,
              },
            ],
          },
          {
            aggregation_key: "Acme Storage",
            target: [
              {
                search_scope: ["any", "brand_entities"],
                search_filter: "include",
                keyword: "Acme Storage",
                match_type: "word_match",
              },
            ],
          },
        ],
        location_code: 2840,
        language_code: "en",
        platform: "google",
        internal_list_limit: 5,
      },
    ]);
  });

  it("serializes LLM mentions keyword targets", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            path: ["v3", "ai_optimization", "llm_mentions", "search", "live"],
            cost: 0.0001,
            result_count: 1,
            result: [{ items: [] }],
          },
        ],
      }),
    );

    await fetchLlmMentionsSearch({
      target: buildLlmTarget({
        type: "keyword",
        value: "Acme Storage",
      }),
      platform: "chat_gpt",
      locationCode: 2840,
      languageCode: "en",
    });

    expect(requestOf().args.body).toEqual([
      {
        target: [
          {
            search_scope: ["any", "brand_entities"],
            search_filter: "include",
            keyword: "Acme Storage",
            match_type: "word_match",
          },
        ],
        location_code: 2840,
        language_code: "en",
        platform: "chat_gpt",
        limit: 100,
      },
    ]);
  });

  it("preserves web_search for Perplexity LLM responses", async () => {
    gateway.mockResolvedValue(
      envelope({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            path: [
              "v3",
              "ai_optimization",
              "perplexity",
              "llm_responses",
              "live",
            ],
            cost: 0.0001,
            result_count: 1,
            result: [
              {
                model_name: "sonar",
                output_tokens: 12,
                web_search: false,
                items: [],
              },
            ],
          },
        ],
      }),
    );

    await fetchLlmResponse({
      userPrompt: "What is OpenSEO?",
      modelSlug: "perplexity",
      modelName: "sonar",
      webSearch: false,
      webSearchCountryCode: "US",
    });

    const request = requestOf();
    expect(request.address).toBe(
      address("/v3/ai_optimization/perplexity/llm_responses/live"),
    );
    expect(request.args.body).toEqual([
      {
        user_prompt: "What is OpenSEO?",
        model_name: "sonar",
        web_search: false,
        max_output_tokens: 1024,
        web_search_country_iso_code: "US",
      },
    ]);
  });
});

describe("fetchLlmResponse model_name validation", () => {
  it("rejects an unknown model_name before dispatching a paid LLM task", async () => {
    await expect(
      fetchLlmResponse({
        userPrompt: "What is OpenSEO?",
        modelSlug: "claude",
        // DataForSEO dropped this from its catalog; it must never be dispatched.
        modelName: "claude-sonnet-4-0",
      }),
    ).rejects.toThrow(/Unsupported DataForSEO model_name/);

    expect(gateway).not.toHaveBeenCalled();
  });
});
