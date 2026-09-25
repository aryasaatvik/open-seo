// Trim DataForSEO's published OpenAPI document to the operations OpenSEO calls
// and stamp each with the tool name the app derives from its path. The full
// spec is 4.9 MB / 570 operations; importing it into the embedded Executor on a
// Worker is slow and lands in D1's blob table, which caps a value near 1 MB.
// The trimmed document is committed at workers/integrations/specs and
// registered from memory at bootstrap, so no network fetch happens there.
//
// Usage: node scripts/trim-dataforseo-spec.ts [path-to-openapi_specification.yaml]
// Source: https://github.com/dataforseo/OpenApiDocumentation
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { dataforseoToolName } from "../src/shared/integration-addresses.ts";

// Every DataForSEO path the app calls (src/server/lib/dataforseo/*.ts and
// src/server/lib/audit/lighthouse.ts). Templated paths keep their parameter.
const PATHS = [
  "/v3/serp/google/organic/live/advanced",
  "/v3/serp/google/organic/task_post",
  "/v3/serp/google/organic/task_get/advanced/{id}",
  "/v3/serp/google/maps/live/advanced",
  "/v3/serp/google/local_finder/live/advanced",
  "/v3/serp/google/locations/{country}",
  "/v3/dataforseo_labs/google/related_keywords/live",
  "/v3/dataforseo_labs/google/keyword_suggestions/live",
  "/v3/dataforseo_labs/google/keyword_ideas/live",
  "/v3/dataforseo_labs/google/keyword_overview/live",
  "/v3/dataforseo_labs/google/domain_rank_overview/live",
  "/v3/dataforseo_labs/google/ranked_keywords/live",
  "/v3/dataforseo_labs/google/relevant_pages/live",
  "/v3/dataforseo_labs/google/serp_competitors/live",
  "/v3/keywords_data/google_ads/search_volume/live",
  "/v3/keywords_data/google_ads/keywords_for_keywords/live",
  "/v3/backlinks/summary/live",
  "/v3/backlinks/backlinks/live",
  "/v3/backlinks/referring_domains/live",
  "/v3/backlinks/domain_pages_summary/live",
  "/v3/backlinks/history/live",
  "/v3/business_data/business_listings/search/live",
  "/v3/business_data/business_listings/categories",
  "/v3/business_data/google/questions_and_answers/live",
  "/v3/business_data/google/my_business_info/live",
  "/v3/business_data/google/reviews/task_post",
  "/v3/business_data/google/reviews/task_get/{id}",
  "/v3/business_data/google/extended_reviews/task_post",
  "/v3/business_data/google/extended_reviews/task_get/{id}",
  "/v3/business_data/google/my_business_updates/task_post",
  "/v3/business_data/google/my_business_updates/task_get/{id}",
  "/v3/ai_optimization/llm_mentions/search/live",
  "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
  "/v3/ai_optimization/llm_mentions/top_pages/live",
  "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
  "/v3/ai_optimization/chat_gpt/llm_responses/live",
  "/v3/ai_optimization/claude/llm_responses/live",
  "/v3/ai_optimization/gemini/llm_responses/live",
  "/v3/ai_optimization/perplexity/llm_responses/live",
  "/v3/on_page/lighthouse/live/json",
  "/v3/appendix/user_data",
] as const;

type Json = Record<string, unknown>;

const source = process.argv[2] ?? "openapi_specification.yaml";
const output = new URL(
  "../workers/integrations/specs/dataforseo.json",
  import.meta.url,
);

const spec = parse(readFileSync(source, "utf8")) as Json;
const allPaths = spec.paths as Record<string, Json>;

// Endpoints DataForSEO ships but has not documented in the public spec yet.
// Free-form schemas: the app validates these responses with its own Zod.
const SYNTHETIC_POST_PATHS = new Set<string>([
  "/v3/ai_optimization/llm_mentions/search/live",
  "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
  "/v3/ai_optimization/llm_mentions/top_pages/live",
  "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
]);

const syntheticPost = (path: string): Json => ({
  post: {
    tags: ["AiOptimization"],
    operationId: path
      .replace(/^\/v3\//, "")
      .split("/")
      .map((segment) =>
        segment.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase()),
      )
      .join(""),
    description: `DataForSEO ${path} (not yet in the published OpenAPI document).`,
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Successful operation",
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    security: [{ basicAuth: [] }],
  },
});

const paths: Record<string, Json> = {};
const missing: string[] = [];
for (const path of PATHS) {
  const item =
    allPaths[path] ??
    (SYNTHETIC_POST_PATHS.has(path) ? syntheticPost(path) : undefined);
  if (!item) {
    missing.push(path);
    continue;
  }
  const trimmed: Json = {};
  for (const [method, operation] of Object.entries(item)) {
    if (!["get", "post"].includes(method)) continue;
    trimmed[method] = {
      ...(operation as Json),
      "x-executor-toolPath": dataforseoToolName(path),
    };
  }
  paths[path] = trimmed;
}
if (missing.length > 0) {
  console.error(`Paths missing from the spec:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

// The gateway only routes calls: OpenSEO's server code builds every request
// body and validates every response with its own Zod schemas, so request and
// response shapes are replaced with free-form JSON. That drops the document
// from 555 KiB to a few KiB and makes catalog import instant on a Worker.
const FREE_FORM_ARRAY = {
  type: "array",
  items: { type: "object", additionalProperties: true },
};
const FREE_FORM_OBJECT = { type: "object", additionalProperties: true };

const slim = (operation: Json): Json => ({
  operationId: operation.operationId,
  ...(operation.tags ? { tags: operation.tags } : {}),
  ...(operation.parameters
    ? {
        parameters: (operation.parameters as Json[]).map(
          ({ name, in: location, required, schema }) => ({
            name,
            in: location,
            ...(required ? { required } : {}),
            schema: schema ?? { type: "string" },
          }),
        ),
      }
    : {}),
  ...(operation.requestBody
    ? {
        requestBody: {
          required: true,
          content: { "application/json": { schema: FREE_FORM_ARRAY } },
        },
      }
    : {}),
  responses: {
    "200": {
      description: "DataForSEO response envelope",
      content: { "application/json": { schema: FREE_FORM_OBJECT } },
    },
  },
  "x-executor-toolPath": operation["x-executor-toolPath"],
});

for (const [path, item] of Object.entries(paths)) {
  paths[path] = Object.fromEntries(
    Object.entries(item).map(([method, operation]) => [
      method,
      slim(operation as Json),
    ]),
  );
}

const trimmedSpec = {
  openapi: spec.openapi,
  info: {
    title: "DataForSEO API (OpenSEO subset)",
    version: (spec.info as Json).version,
    description:
      "The DataForSEO v3 operations OpenSEO calls, with free-form bodies. Generated by scripts/trim-dataforseo-spec.ts.",
  },
  servers: spec.servers,
  paths,
  components: {
    securitySchemes: (spec.components as Json).securitySchemes,
  },
  security: spec.security,
};

const json = JSON.stringify(trimmedSpec, null, 2);
writeFileSync(output, json + "\n");
console.log(
  `Wrote ${output.pathname}: ${Object.keys(paths).length} paths, ${(json.length / 1024).toFixed(0)} KiB`,
);
