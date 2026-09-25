import { env as workerEnv } from "cloudflare:workers";
import { count } from "drizzle-orm";
import { version } from "../../../package.json";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getAuthMode } from "@/lib/auth-mode";
import { runSelfhostChecks } from "@/lib/selfhost-preflight";
import { invokeTool } from "@/server/lib/executor/client";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  DATAFORSEO_INTEGRATION,
  dataforseoToolAddress,
} from "@/shared/integration-addresses";

// "error" blocks core functionality; "warn" degrades a feature.
type SetupCheck = {
  status: "ok" | "warn" | "error";
  detail?: string;
};

type SelfHostSetupStatus = {
  version: string;
  authMode: string;
  checks: Record<string, SetupCheck>;
};

// The same env vars the Docker preflight validates; /api/health re-runs the
// shared checks against runtime env so the two reports can never drift.
const CHECK_ENV_VARS = [
  "AUTH_MODE",
  "TEAM_DOMAIN",
  "POLICY_AUD",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "BETTER_AUTH_SECRET",
  "OPENROUTER_API_KEY",
] as const;

const LEVEL_TO_STATUS = {
  ok: "ok",
  info: "ok",
  warn: "warn",
  fail: "error",
} as const;

// The integration gateway: the embedded Executor must be reachable, hold the
// DataForSEO connection, and be able to call DataForSEO with it. The account
// endpoint is free and proves the stored credential renders and authenticates.
async function checkIntegrations(): Promise<SetupCheck> {
  try {
    const connections = await workerEnv.INTEGRATIONS.listConnections();
    if (
      !connections.some(
        (connection) => connection.integration === DATAFORSEO_INTEGRATION,
      )
    ) {
      return {
        status: "error",
        detail:
          "The gateway has no DataForSEO connection — check DATAFORSEO_API_KEY.",
      };
    }
    const result = await invokeTool<{ status_code?: number }>(
      dataforseoToolAddress("/v3/appendix/user_data"),
      {},
    );
    if (!result.ok) {
      return {
        status: "error",
        detail: `DataForSEO rejected the stored credential (${result.error.code}${result.error.status ? ` ${result.error.status}` : ""}).`,
      };
    }
    return {
      status: "ok",
      detail: `${connections.length} connection${connections.length === 1 ? "" : "s"}`,
    };
  } catch (error) {
    console.error("health check: integration gateway failed", error);
    return {
      status: "error",
      detail: "Integration gateway unreachable — check server logs.",
    };
  }
}

async function checkDatabase(): Promise<SetupCheck> {
  try {
    await db.select({ value: count() }).from(projects);
    return { status: "ok" };
  } catch (error) {
    // This endpoint is unauthenticated: never surface raw driver messages
    // (they can name hosts and DB users). The real error goes to the logs.
    console.error("health check: database query failed", error);
    return {
      status: "error",
      detail: "Database query failed — check server logs.",
    };
  }
}

export async function getSelfHostSetupStatus(options?: {
  skipDatabaseCheck?: boolean;
}): Promise<SelfHostSetupStatus> {
  const env = Object.fromEntries(
    await Promise.all(
      CHECK_ENV_VARS.map(
        async (name) => [name, await getOptionalEnvValue(name)] as const,
      ),
    ),
  );

  const checks: Record<string, SetupCheck> = {};
  for (const item of runSelfhostChecks(env)) {
    checks[item.key] = {
      status: LEVEL_TO_STATUS[item.level],
      detail: item.message,
    };
  }
  checks.database = options?.skipDatabaseCheck
    ? { status: "ok" }
    : await checkDatabase();
  checks.integrations = options?.skipDatabaseCheck
    ? { status: "ok" }
    : await checkIntegrations();

  return { version, authMode: getAuthMode(env.AUTH_MODE), checks };
}

// Compact "which checks are unhealthy" list for telemetry: check keys with
// their status, no free-text details (details can name env vars; keep events
// to enumerable values only).
export async function getSetupIssueSummary(): Promise<string[]> {
  const status = await getSelfHostSetupStatus({ skipDatabaseCheck: true });
  return Object.entries(status.checks)
    .filter(([, check]) => check.status !== "ok")
    .map(([key, check]) => `${key}:${check.status}`);
}
