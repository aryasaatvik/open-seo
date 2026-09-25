import { vi } from "vitest";
import { z } from "zod";
import { invokeTool } from "@/server/lib/executor/client";
import { dataforseoToolAddress } from "@/shared/integration-addresses";

// Shared shapes for tests of the DataForSEO section fetchers. Each test file
// still declares `vi.mock("@/server/lib/executor/client", ...)` itself (the
// mock must be hoisted in the file under test); this module only reads and
// builds gateway results.

export const gateway = vi.mocked(invokeTool);

/** A successful gateway call carrying a DataForSEO envelope verbatim. */
export function envelope<T>(data: T) {
  return { ok: true as const, data };
}

/** An upstream HTTP failure as the gateway reports it. */
export function httpFailure(status: number, message = "upstream failure") {
  return {
    ok: false as const,
    error: { code: "upstream_status", message, status, details: message },
  };
}

/** The address and arguments of the n-th gateway call. */
export function requestOf(call = 0) {
  const entry = gateway.mock.calls[call];
  if (!entry) throw new Error(`No gateway call #${call}`);
  const [address, args] = entry;
  return { address, args: z.record(z.string(), z.unknown()).parse(args) };
}

export const address = dataforseoToolAddress;
