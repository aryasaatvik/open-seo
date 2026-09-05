import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  dataforseoToolAddress,
  dataforseoToolName,
} from "./integration-addresses";

const trimmedSpec = z.object({
  paths: z.record(
    z.string(),
    z.record(z.string(), z.object({ "x-executor-toolPath": z.string() })),
  ),
});

const spec = trimmedSpec.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../workers/integrations/specs/dataforseo.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

// The app derives DataForSEO tool names from API paths; the committed spec
// stamps each operation with `x-executor-toolPath`. If the two rules drift,
// every gateway call misses its tool, so pin them to each other here.
describe("dataforseoToolName", () => {
  it("matches the tool path stamped on every operation in the trimmed spec", () => {
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const operation of Object.values(operations)) {
        expect(operation["x-executor-toolPath"]).toBe(dataforseoToolName(path));
      }
    }
  });

  it("drops path parameters from the name", () => {
    expect(
      dataforseoToolAddress("/v3/serp/google/organic/task_get/advanced/{id}"),
    ).toBe(
      "tools.dataforseo_api.org.default.serp.google.organic.task_get.advanced",
    );
  });
});
