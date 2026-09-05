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
import { readMarker, writeMarker } from "./secrets";
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

// The connection value is the configured key. A rotated DATAFORSEO_API_KEY
// must replace the stored one, so a digest of the configured key is kept next
// to the connection and compared on every bring-up; a mismatch recreates the
// connection with the new value.
const KEY_DIGEST_ID = "dataforseo:configured-key-sha256";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const ensureDataforseoConnection = (
  executor: GatewayExecutor,
  db: D1Database,
  apiKey: string,
) =>
  Effect.gen(function* () {
    const integration = IntegrationSlug.make(DATAFORSEO_INTEGRATION);
    const name = ConnectionName.make(CONNECTION_NAME);
    const digest = yield* Effect.promise(() => sha256Hex(apiKey));
    const stored = yield* Effect.promise(() => readMarker(db, KEY_DIGEST_ID));
    const connections = yield* executor.connections.list({ integration });
    const existing = connections.find((connection) => connection.name === name);
    if (existing && stored === digest) return;
    if (existing) {
      yield* executor.connections.remove({ owner: "org", integration, name });
    }
    yield* executor.connections.create({
      owner: "org",
      name,
      integration,
      template: AuthTemplateSlug.make(DATAFORSEO_AUTH_TEMPLATE),
      value: apiKey,
    });
    yield* Effect.promise(() => writeMarker(db, KEY_DIGEST_ID, digest));
  });

export const bootstrap = (
  executor: GatewayExecutor,
  db: D1Database,
  dataforseoApiKey: string,
) =>
  Effect.gen(function* () {
    yield* registerDataforseo(executor);
    yield* registerGoogle(executor);
    yield* ensureDataforseoConnection(executor, db, dataforseoApiKey);
  });
