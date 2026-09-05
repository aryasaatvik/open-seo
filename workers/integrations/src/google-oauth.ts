import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { GOOGLE_AUTH_TEMPLATE, GOOGLE_INTEGRATION_SLUGS } from "./catalog";
import { GOOGLE_OAUTH_CLIENT, type GatewayExecutor } from "./executor";

// The Google grant flow as the gateway runs it. Kept apart from the
// WorkerEntrypoint so the mapping onto Executor's oauth API can be exercised
// against a fake executor.

export interface GatewayConnection {
  integration: string;
  name: string;
  identityLabel: string | null;
  expiresAt: number | null;
}

const GOOGLE_TEMPLATE = AuthTemplateSlug.make(GOOGLE_AUTH_TEMPLATE);
const GOOGLE_CLIENT = OAuthClientSlug.make(
  `first-party:${GOOGLE_OAUTH_CLIENT}`,
);

export function toGatewayConnection(connection: {
  integration: string;
  name: string;
  identityLabel?: string | null;
  expiresAt?: number | null;
}): GatewayConnection {
  return {
    integration: String(connection.integration),
    name: String(connection.name),
    identityLabel: connection.identityLabel ?? null,
    expiresAt: connection.expiresAt ?? null,
  };
}

/** Begin a Google grant for one Google integration, saved under
 *  `org/<connectionName>`. Completing it for a name that already has a
 *  connection replaces that connection's grant (reconnect). */
export function googleOAuthStart(
  executor: GatewayExecutor,
  integration: string,
  connectionName: string,
) {
  return Effect.gen(function* () {
    if (!GOOGLE_INTEGRATION_SLUGS.includes(integration)) {
      return yield* Effect.fail(
        new Error(`Not a Google integration: ${integration}`),
      );
    }
    const result = yield* executor.oauth.start({
      client: GOOGLE_CLIENT,
      clientOwner: "org",
      owner: "org",
      name: ConnectionName.make(connectionName),
      integration: IntegrationSlug.make(integration),
      template: GOOGLE_TEMPLATE,
    });
    if (result.status !== "redirect") {
      return yield* Effect.fail(
        new Error("Google OAuth did not produce a redirect"),
      );
    }
    return { authorizationUrl: result.authorizationUrl };
  });
}

/** Finish the grant Google redirected back with. The state ties the code to
 *  the integration and connection name `googleOAuthStart` registered. */
export function googleOAuthComplete(
  executor: GatewayExecutor,
  input: { state: string; code: string },
) {
  return Effect.map(
    executor.oauth.complete({
      state: OAuthState.make(input.state),
      code: input.code,
    }),
    toGatewayConnection,
  );
}
