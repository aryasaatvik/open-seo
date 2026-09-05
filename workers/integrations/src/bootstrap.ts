import { Effect } from "effect";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
} from "@executor-js/sdk/core";
import {
  DATAFORSEO_AUTH_TEMPLATE,
  DATAFORSEO_INTEGRATION,
  GOOGLE_AUTH_TEMPLATE,
  GOOGLE_AUTHORIZATION_URL,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_INTEGRATIONS,
  GOOGLE_TOKEN_URL,
} from "./catalog";
import type { GatewayExecutor } from "./executor";
import dataforseoSpec from "../specs/dataforseo.json";
import { CONNECTION_NAME } from "../../../src/shared/integration-addresses";

// Idempotent catalog bring-up: register the integrations the app addresses
// and the DataForSEO connection. Runs on the first gateway call per isolate
// and is a handful of reads when everything already exists.

const registerDataforseo = (executor: GatewayExecutor) =>
  Effect.gen(function* () {
    const existing = yield* executor.openapi.getIntegration(
      DATAFORSEO_INTEGRATION,
    );
    if (existing) return;
    yield* executor.openapi.addSpec({
      spec: { kind: "blob", value: JSON.stringify(dataforseoSpec) },
      slug: DATAFORSEO_INTEGRATION,
      name: "DataForSEO",
      description:
        "DataForSEO v3: SERP, Labs, backlinks, business data, LLM mentions, Lighthouse. Trimmed to the operations OpenSEO uses.",
      displayDomain: "dataforseo.com",
      authenticationTemplate: [
        {
          slug: DATAFORSEO_AUTH_TEMPLATE,
          type: "apiKey",
          label: "HTTP Basic",
          // `{ type: "variable" }` marks where the connection value renders.
          headers: {
            Authorization: ["Basic ", { type: "variable", name: "token" }],
          },
        },
      ],
    });
  });

const registerGoogle = (executor: GatewayExecutor) =>
  Effect.forEach(
    GOOGLE_INTEGRATIONS,
    (integration) =>
      Effect.gen(function* () {
        const existing = yield* executor.openapi.getIntegration(
          integration.slug,
        );
        if (existing) return;
        yield* executor.openapi.addSpec({
          spec: { kind: "url", url: integration.discoveryUrl },
          slug: integration.slug,
          name: integration.name,
          description: integration.description,
          specFormat: "google-discovery",
          family: "google",
          authenticationTemplate: [
            {
              slug: GOOGLE_AUTH_TEMPLATE,
              kind: "oauth2",
              authorizationUrl: GOOGLE_AUTHORIZATION_URL,
              tokenUrl: GOOGLE_TOKEN_URL,
              scopes: [...GOOGLE_IDENTITY_SCOPES, ...integration.scopes],
            },
          ],
        });
      }),
    { discard: true },
  );

const ensureDataforseoConnection = (
  executor: GatewayExecutor,
  apiKey: string,
) =>
  Effect.gen(function* () {
    const connections = yield* executor.connections.list({
      integration: IntegrationSlug.make(DATAFORSEO_INTEGRATION),
    });
    if (connections.some((connection) => connection.name === CONNECTION_NAME)) {
      return;
    }
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make(CONNECTION_NAME),
      integration: IntegrationSlug.make(DATAFORSEO_INTEGRATION),
      template: AuthTemplateSlug.make(DATAFORSEO_AUTH_TEMPLATE),
      value: apiKey,
    });
  });

export const bootstrap = (
  executor: GatewayExecutor,
  dataforseoApiKey: string,
) =>
  Effect.gen(function* () {
    yield* registerDataforseo(executor);
    yield* registerGoogle(executor);
    yield* ensureDataforseoConnection(executor, dataforseoApiKey);
  });
