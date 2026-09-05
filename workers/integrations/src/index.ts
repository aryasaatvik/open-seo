// Auxiliary worker "open-seo-integrations": the integration gateway. Embeds
// the Executor SDK over the shared D1 and owns every upstream credential. The
// app and audit workers call it through the INTEGRATIONS service binding;
// nothing routes to fetch.
import { WorkerEntrypoint } from "cloudflare:workers";
import { Cause, Effect, Exit, Option } from "effect";
import {
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  ToolAddress,
  AuthTemplateSlug,
  isToolResult,
  type ToolResult,
} from "@executor-js/sdk/core";
import { bootstrap } from "./bootstrap";
import { GOOGLE_AUTH_TEMPLATE, GOOGLE_INTEGRATION_SLUGS } from "./catalog";
import {
  GOOGLE_OAUTH_CLIENT,
  getExecutor,
  type GatewayEnv,
  type GatewayExecutor,
} from "./executor";
import { CONNECTION_NAME } from "../../../src/shared/integration-addresses";

/**
 * What every gateway call returns. Same shape as Executor's own ToolResult so
 * callers branch on `ok` once: upstream failures arrive as `ok: false` with the
 * HTTP status, and SDK failures (unknown tool, missing connection, credential
 * refresh rejected) arrive the same way with the error's tag as `code`.
 */
export type GatewayResult = ToolResult<unknown>;

export interface GatewayConnection {
  integration: string;
  name: string;
  identityLabel: string | null;
  expiresAt: number | null;
}

const GOOGLE_TEMPLATE = AuthTemplateSlug.make(GOOGLE_AUTH_TEMPLATE);

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

  /** Invoke one tool by full address (`tools.<integration>.org.default.<tool>`). */
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

  async listConnections(): Promise<GatewayConnection[]> {
    const executor = await this.#executor();
    const connections = await run(executor.connections.list());
    return connections.map((connection) => ({
      integration: String(connection.integration),
      name: String(connection.name),
      identityLabel: connection.identityLabel ?? null,
      expiresAt: connection.expiresAt ?? null,
    }));
  }

  /** Begin a Google OAuth grant for one Google integration. */
  async googleOAuthStart(
    integration: string,
  ): Promise<{ authorizationUrl: string }> {
    if (!GOOGLE_INTEGRATION_SLUGS.includes(integration)) {
      throw new Error(`Not a Google integration: ${integration}`);
    }
    const executor = await this.#executor();
    const result = await run(
      executor.oauth.start({
        client: OAuthClientSlug.make(`first-party:${GOOGLE_OAUTH_CLIENT}`),
        clientOwner: "org",
        owner: "org",
        name: ConnectionName.make(CONNECTION_NAME),
        integration: IntegrationSlug.make(integration),
        template: GOOGLE_TEMPLATE,
      }),
    );
    if (result.status !== "redirect") {
      throw new Error("Google OAuth did not produce a redirect");
    }
    return { authorizationUrl: result.authorizationUrl };
  }

  /** Finish the grant Google redirected back with. */
  async googleOAuthComplete(input: {
    state: string;
    code: string;
  }): Promise<GatewayConnection> {
    const executor = await this.#executor();
    const connection = await run(
      executor.oauth.complete({
        state: OAuthState.make(input.state),
        code: input.code,
      }),
    );
    return {
      integration: String(connection.integration),
      name: String(connection.name),
      identityLabel: connection.identityLabel ?? null,
      expiresAt: connection.expiresAt ?? null,
    };
  }

  async removeConnection(integration: string): Promise<void> {
    const executor = await this.#executor();
    await run(
      executor.connections.remove({
        owner: "org",
        integration: IntegrationSlug.make(integration),
        name: ConnectionName.make(CONNECTION_NAME),
      }),
    );
  }
}
