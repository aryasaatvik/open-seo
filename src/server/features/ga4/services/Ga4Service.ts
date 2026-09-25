import { AppError } from "@/server/lib/errors";
import {
  GoogleNotConnectedError,
  googleConnectionStatus,
} from "@/server/lib/executor/google";
import { createGa4AdminClient } from "@/server/lib/ga4Client";
import { Ga4AdminApiError, Ga4TokenError } from "@/server/lib/ga4Errors";
import {
  Ga4ConnectionRepository,
  type Ga4Connection,
} from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import {
  GOOGLE_ANALYTICS_ADMIN_INTEGRATION,
  GOOGLE_ANALYTICS_DATA_INTEGRATION,
} from "@/shared/integration-addresses";

async function getConnection(projectId: string): Promise<Ga4Connection | null> {
  return Ga4ConnectionRepository.getByProjectId(projectId);
}

/** GA4 needs both the Admin API (property discovery) and the Data API
 *  (reports). Both grants come from one consent flow; "connected" means both
 *  are present in the gateway for this organization and were made by the same
 *  Google account, so a property picked through Admin is one Data can read. */
async function getGoogleConnection(input: { organizationId: string }) {
  const [admin, data] = await Promise.all([
    googleConnectionStatus(
      input.organizationId,
      GOOGLE_ANALYTICS_ADMIN_INTEGRATION,
    ),
    googleConnectionStatus(
      input.organizationId,
      GOOGLE_ANALYTICS_DATA_INTEGRATION,
    ),
  ]);
  const sameAccount =
    admin.email === null || data.email === null || admin.email === data.email;
  return {
    connected: admin.connected && data.connected && sameAccount,
    email: admin.email ?? data.email,
  };
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof Ga4TokenError ||
    error instanceof GoogleNotConnectedError ||
    (error instanceof Ga4AdminApiError && error.status === 401)
  );
}

async function listProperties(input: { organizationId: string }) {
  const google = await getGoogleConnection(input);
  if (!google.connected) {
    return {
      requiresReconnect: true,
      propertiesUnavailable: false,
      email: null,
      properties: [],
    };
  }
  try {
    const properties = await createGa4AdminClient(input).listProperties();
    return {
      requiresReconnect: false,
      propertiesUnavailable: false,
      email: google.email,
      properties,
    };
  } catch (error) {
    const reconnect = requiresReconnect(error);
    if (!reconnect) {
      console.error("ga4.property_discovery_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        status: error instanceof Ga4AdminApiError ? error.status : undefined,
      });
    }
    return {
      requiresReconnect: reconnect,
      propertiesUnavailable: !reconnect,
      email: google.email,
      properties: [],
    };
  }
}

async function setProperty(input: {
  projectId: string;
  organizationId: string;
  propertyId: string;
}): Promise<Ga4Connection> {
  const client = createGa4AdminClient(input);
  const properties = await client.listProperties();
  if (
    !properties.some((property) => property.propertyId === input.propertyId)
  ) {
    throw new AppError(
      "NOT_FOUND",
      "That Google Analytics property isn't available on the connected Google account.",
    );
  }

  const property = await client.getProperty(input.propertyId);
  return Ga4ConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    propertyId: property.name,
    propertyDisplayName: property.displayName,
    propertyTimeZone: property.timeZone,
    propertyCurrencyCode: property.currencyCode,
  });
}

/** Unbind the property from the project. The Google grant itself stays in the
 *  gateway for the other projects that use it. */
async function disconnect(input: { projectId: string }): Promise<void> {
  await Ga4ConnectionRepository.deleteByProjectId(input.projectId);
}

export const Ga4Service = {
  getConnection,
  getGoogleConnection,
  listProperties,
  setProperty,
  disconnect,
};
