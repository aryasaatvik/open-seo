import { Effect } from "effect";
import { drizzle } from "drizzle-orm/d1";
import {
  createExecutor,
  IntegrationSlug,
  Tenant,
  type Executor,
} from "@executor-js/sdk/core";
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import { openApiPlugin } from "@executor-js/plugin-openapi/core";
import { googleDiscoveryAdapter } from "@executor-js/plugin-openapi/providers/google";
import { makeR2BlobStore } from "./blob-store";
import { fingerprintOf, prepareSchema } from "./schema";
import { ensureSecretsTable, makeD1SecretProvider } from "./secrets";
import { GOOGLE_INTEGRATIONS } from "./catalog";

export interface GatewayEnv {
  DB: D1Database;
  R2: R2Bucket;
  /** Master key for the credential store. Any long random string. */
  EXECUTOR_SECRET_KEY: string;
  /** Base64 of `login:password`; becomes the DataForSEO connection value. */
  DATAFORSEO_API_KEY: string;
  /** Public origin of the app worker, e.g. https://seo.arya.sh. Google
   *  redirects back to `${PUBLIC_ORIGIN}/api/integrations/google/callback`. */
  PUBLIC_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

// Single tenant, org-owned connections only. The org segment of every tool
// address is literally "org"; the tenant id only partitions rows.
const TENANT = Tenant.make("openseo");
const NAMESPACE = "openseo_integrations";
// FumaDB requires a semver string here.
const SCHEMA_VERSION = "1.0.0";

export const GOOGLE_OAUTH_CLIENT = "google";
const GOOGLE_CALLBACK_PATH = "/api/integrations/google/callback";

const plugins = [
  openApiPlugin({ specFormats: [googleDiscoveryAdapter] }),
] as const;

export type GatewayExecutor = Executor<typeof plugins>;

function buildExecutor(
  env: GatewayEnv,
): Effect.Effect<GatewayExecutor, unknown> {
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? [
          {
            name: GOOGLE_OAUTH_CLIENT,
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            tokenUrl: "https://oauth2.googleapis.com/token",
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            integrations: GOOGLE_INTEGRATIONS.map((integration) =>
              IntegrationSlug.make(integration.slug),
            ),
            // A refresh token is only issued with offline access and an
            // explicit consent prompt; without both, every connection would
            // expire an hour after connecting.
            authorizationExtraParams: {
              access_type: "offline",
              prompt: "consent",
            },
          },
        ]
      : [];

  return createExecutor({
    tenant: TENANT,
    plugins,
    providers: [makeD1SecretProvider(env.DB, env.EXECUTOR_SECRET_KEY)],
    blobs: makeR2BlobStore(env.R2),
    // Server-side calls never wait on a human: tools run under allow
    // policies, and anything that would elicit is answered as accepted.
    onElicitation: "accept-all",
    redirectUri: `${env.PUBLIC_ORIGIN}${GOOGLE_CALLBACK_PATH}`,
    firstPartyOAuthClients: google,
    db: ({ tables }) =>
      Effect.promise(async () => {
        const options = {
          tables,
          namespace: NAMESPACE,
          version: SCHEMA_VERSION,
          provider: "sqlite" as const,
        };
        const schema = createDrizzleRuntimeSchemaFromTables(options);
        const drizzleDb = drizzle(env.DB, { schema });

        await prepareSchema(env.DB, NAMESPACE, {
          tableNames: Object.keys(tables),
          expectedFingerprint: await fingerprintOf(
            createDrizzleRuntimeSchemaSqlFromTables(options),
          ),
          ensureSchema: async () => {
            await ensureDrizzleRuntimeSchemaFromTables(
              { run: (query) => drizzleDb.run(query) },
              options,
            );
            await ensureSecretsTable(env.DB);
          },
        });

        const { db } = createExecutorFumaDb(drizzleDb, {
          ...options,
          // D1 rejects BEGIN/SAVEPOINT and caps bound parameters at 100.
          interactiveTransactions: false,
          maxBoundParameters: 100,
        });
        return { db, close: async () => {} };
      }),
  });
}

// One executor per isolate. It closes over the D1 binding only, and D1 holds
// no per-request socket, so reuse across requests is safe.
let executorPromise: Promise<GatewayExecutor> | null = null;

export function getExecutor(env: GatewayEnv): Promise<GatewayExecutor> {
  executorPromise ??= Effect.runPromise(buildExecutor(env)).catch((error) => {
    executorPromise = null;
    throw error;
  });
  return executorPromise;
}
