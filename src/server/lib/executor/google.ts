import { env } from "cloudflare:workers";
import { invokeTool, type ToolFailure, type ToolResult } from "./client";
import {
  organizationConnectionName,
  toolAddress,
} from "@/shared/integration-addresses";

// Google APIs reach the gateway as Discovery-derived tools. Their names carry
// the service prefix Google assigns (`webmasters.sites.list`,
// `analyticsdata.properties.runReport`), which differs per Discovery version,
// so the app pins each call by the method's suffix and resolves the full name
// from the gateway's tool list once per isolate. Every call names the
// organization whose grant it runs under: the gateway keeps one connection per
// organization and integration, so no address can reach another tenant's.

export class GoogleNotConnectedError extends Error {
  constructor(public readonly integration: string) {
    super(`${integration} is not connected`);
    this.name = "GoogleNotConnectedError";
  }
}

const toolNamesByIntegration = new Map<string, Promise<readonly string[]>>();

async function toolNames(integration: string): Promise<readonly string[]> {
  let pending = toolNamesByIntegration.get(integration);
  if (!pending) {
    pending = env.INTEGRATIONS.listTools(integration).then(
      (names) => {
        // No tools means no connection yet; do not cache the miss.
        if (names.length === 0) toolNamesByIntegration.delete(integration);
        return names;
      },
      (error: unknown) => {
        // A failed lookup (gateway still bootstrapping, database hiccup) must
        // not pin the integration to that failure for the isolate's lifetime.
        toolNamesByIntegration.delete(integration);
        throw error;
      },
    );
    toolNamesByIntegration.set(integration, pending);
  }
  return pending;
}

/** Drop the cached tool list, e.g. after a connection is created or removed. */
export function forgetGoogleTools(integration: string): void {
  toolNamesByIntegration.delete(integration);
}

async function resolveTool(
  organizationId: string,
  integration: string,
  suffix: string,
): Promise<string> {
  const names = await toolNames(integration);
  if (names.length === 0) throw new GoogleNotConnectedError(integration);
  const match = names.find(
    (name) => name === suffix || name.endsWith(`.${suffix}`),
  );
  if (!match) {
    throw new Error(`${integration} exposes no tool ending in "${suffix}"`);
  }
  return toolAddress(
    integration,
    match,
    organizationConnectionName(organizationId),
  );
}

/** Call a Google tool by its method suffix, e.g. `sites.list`, under the
 *  organization's grant. */
export async function invokeGoogleTool<T>(
  organizationId: string,
  integration: string,
  suffix: string,
  args: Record<string, unknown>,
): Promise<ToolResult<T>> {
  return invokeTool<T>(
    await resolveTool(organizationId, integration, suffix),
    args,
  );
}

/** The gateway could not produce a usable credential: the grant is gone,
 *  expired past refresh, or was never made. The user has to reconnect. */
export function isCredentialFailure(failure: ToolFailure): boolean {
  if (
    failure.code === "CredentialResolutionError" ||
    failure.code === "ConnectionNotFoundError" ||
    failure.code === "oauth_connection_missing" ||
    failure.code === "connection_rejected"
  ) {
    return true;
  }
  return (
    typeof failure.details === "object" &&
    failure.details !== null &&
    "reauthRequired" in failure.details &&
    failure.details.reauthRequired === true
  );
}

type GoogleConnectionStatus = {
  connected: boolean;
  /** The Google account email Executor recorded at consent, when known. */
  email: string | null;
};

export async function googleConnectionStatus(
  organizationId: string,
  integration: string,
): Promise<GoogleConnectionStatus> {
  const connections = await env.INTEGRATIONS.listConnections({
    organizationId,
  });
  const connection = connections.find(
    (entry) => entry.integration === integration,
  );
  return {
    connected: connection !== undefined,
    email: connection?.identityLabel ?? null,
  };
}
