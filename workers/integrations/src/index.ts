// Auxiliary worker "open-seo-integrations": the integration gateway. Embeds
// the Executor SDK over the shared D1 and owns every upstream credential. The
// app and audit workers call it through the INTEGRATIONS service binding;
// nothing routes to fetch.
import { WorkerEntrypoint } from "cloudflare:workers";
import { Cause, Effect, Exit, Option } from "effect";
import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  isToolResult,
  type ToolResult,
} from "@executor-js/sdk/core";
import { bootstrap } from "./bootstrap";
import { getExecutor, type GatewayEnv, type GatewayExecutor } from "./executor";
import {
  googleOAuthComplete,
  googleOAuthStart,
  toGatewayConnection,
  type GatewayConnection,
} from "./google-oauth";
import { organizationConnectionName } from "../../../src/shared/integration-addresses";

/**
 * What every gateway call returns. Same shape as Executor's own ToolResult so
 * callers branch on `ok` once: upstream failures arrive as `ok: false` with the
 * HTTP status, and SDK failures (unknown tool, missing connection, credential
 * refresh rejected) arrive the same way with the error's tag as `code`.
 */
export type GatewayResult = ToolResult<unknown>;

export type { GatewayConnection } from "./google-oauth";

function readField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function failure(error: unknown): GatewayResult {
  const tagField = readField(error, "_tag");
  const tag = typeof tagField === "string" ? tagField : "GatewayError";
  const messageField = readField(error, "message");
  const message =
    typeof messageField === "string" ? messageField : String(error);
  const reauthRequired = readField(error, "reauthRequired") === true;
  return {
    ok: false,
    error: {
      code: tag,
      message,
      // A credential the SDK could not refresh needs a human to reconnect;
      // everything else is worth retrying.
      retryable: tag !== "CredentialResolutionError" && !reauthRequired,
      details: reauthRequired ? { reauthRequired: true } : undefined,
    },
  };
}

async function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const cause = exit.cause;
  const failed = Cause.findErrorOption(cause);
  throw Option.isSome(failed) ? failed.value : Cause.squash(cause);
}

// Bootstrap runs once per isolate. Module scope, not the class: the runtime
// constructs a fresh WorkerEntrypoint for every RPC call, so an instance field
// would rerun the catalog import concurrently on each call. Failures reset it
// so the next call retries.
let ready: Promise<GatewayExecutor> | null = null;

function readyExecutor(env: GatewayEnv): Promise<GatewayExecutor> {
  ready ??= (async () => {
    const executor = await getExecutor(env);
    await run(bootstrap(executor, env.DB, env.DATAFORSEO_API_KEY));
    console.log("gateway: catalog ready");
    return executor;
  })().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

export default class IntegrationGateway extends WorkerEntrypoint<GatewayEnv> {
  override fetch(): Response {
    return new Response("Not found", { status: 404 });
  }

  #executor(): Promise<GatewayExecutor> {
    return readyExecutor(this.env);
  }

  /** Invoke one tool by full address (`tools.<integration>.org.<connection>.<tool>`). */
  async execute(address: string, args: unknown): Promise<GatewayResult> {
    const executor = await this.#executor();
    try {
      const result = await run(
        executor.execute(ToolAddress.make(address), args),
      );
      return isToolResult(result) ? result : { ok: true, data: result };
    } catch (error) {
      return failure(error);
    }
  }

  /** Tool names under one integration, for pinning addresses at setup time. */
  async listTools(integration: string): Promise<string[]> {
    const executor = await this.#executor();
    const tools = await run(
      executor.tools.list({ integration: IntegrationSlug.make(integration) }),
    );
    return tools.map((tool) => String(tool.name));
  }

  /** Every connection, or only those under one organization's name. */
  async listConnections(filter?: {
    organizationId: string;
  }): Promise<GatewayConnection[]> {
    const executor = await this.#executor();
    const connections = await run(executor.connections.list());
    const name = filter
      ? organizationConnectionName(filter.organizationId)
      : null;
    return connections
      .filter((connection) => name === null || connection.name === name)
      .map(toGatewayConnection);
  }

  /** Begin a Google grant for one organization and one Google integration. */
  async googleOAuthStart(
    integration: string,
    organizationId: string,
  ): Promise<{ authorizationUrl: string }> {
    const executor = await this.#executor();
    return run(
      googleOAuthStart(
        executor,
        integration,
        organizationConnectionName(organizationId),
      ),
    );
  }

  /** Finish the grant Google redirected back with. */
  async googleOAuthComplete(input: {
    state: string;
    code: string;
  }): Promise<GatewayConnection> {
    const executor = await this.#executor();
    return run(googleOAuthComplete(executor, input));
  }

  async removeConnection(
    integration: string,
    organizationId: string,
  ): Promise<void> {
    const executor = await this.#executor();
    await run(
      executor.connections.remove({
        owner: "org",
        integration: IntegrationSlug.make(integration),
        name: ConnectionName.make(organizationConnectionName(organizationId)),
      }),
    );
  }
}
