// Tool addresses inside the embedded Executor. Shared by the integrations
// worker (which registers the tools) and the app's clients (which call them),
// so the two can never disagree on a name.

export const DATAFORSEO_INTEGRATION = "dataforseo_api";
export const GOOGLE_SEARCH_CONSOLE_INTEGRATION = "google_search_console";
export const GOOGLE_ANALYTICS_DATA_INTEGRATION = "google_analytics_data";
export const GOOGLE_ANALYTICS_ADMIN_INTEGRATION = "google_analytics_admin";

// Every connection is org-owned. Credentials the deployment itself holds
// (DataForSEO) live in one connection named `default`; a Google grant is named
// after the OpenSEO organization that consented, so an address built for one
// organization can never reach another's credential.
const CONNECTION_OWNER = "org";
export const CONNECTION_NAME = "default";

// Executor splits addresses on dots and this deployment never mints names
// outside this set, so anything else is a bug upstream of the gateway.
const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function organizationConnectionName(organizationId: string): string {
  if (!CONNECTION_NAME_PATTERN.test(organizationId)) {
    throw new Error(
      `Organization id cannot name a gateway connection: ${organizationId}`,
    );
  }
  return organizationId;
}

/**
 * DataForSEO tool name for an API path. The trimmed spec stamps each operation
 * with `x-executor-toolPath` computed by this same rule, so the app can address
 * a tool from the path it already uses: `/v3/serp/google/organic/live/advanced`
 * becomes `serp.google.organic.live.advanced`. Path parameters are dropped from
 * the name and passed as arguments instead.
 */
export function dataforseoToolName(path: string): string {
  return path
    .replace(/^\/v3\//, "")
    .replace(/\{[^}]+\}/g, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .join(".");
}

export function toolAddress(
  integration: string,
  tool: string,
  connectionName = CONNECTION_NAME,
): string {
  return `tools.${integration}.${CONNECTION_OWNER}.${connectionName}.${tool}`;
}

export function dataforseoToolAddress(path: string): string {
  return toolAddress(DATAFORSEO_INTEGRATION, dataforseoToolName(path));
}
