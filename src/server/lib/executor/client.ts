import { env } from "cloudflare:workers";

// The app's one door to upstream APIs: the integration gateway's
// IntegrationGateway entrypoint (workers/integrations), reached over the
// INTEGRATIONS service binding. Results keep Executor's ToolResult shape so
// callers branch on `ok` once and read the upstream payload verbatim.

type ToolHttpMeta = {
  status: number;
  headers: Record<string, string>;
};

type ToolFailure = {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
  retryable?: boolean;
};

type ToolResult<T> =
  | { ok: true; data: T; http?: ToolHttpMeta }
  | { ok: false; error: ToolFailure };

export function invokeTool<T = unknown>(
  address: string,
  args: unknown,
): Promise<ToolResult<T>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the gateway returns the upstream payload untyped; callers narrow with their own schemas
  return env.INTEGRATIONS.execute(address, args) as Promise<ToolResult<T>>;
}
