import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { GscService } from "@/server/features/gsc/services/GscService";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const setSiteSchema = projectScopedSchema.extend({
  siteUrl: z.string().min(1),
});

export const getGscConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [connection, google] = await Promise.all([
      GscService.getConnection(context.projectId),
      GscService.getGoogleConnection(),
    ]);
    return {
      connected: Boolean(connection),
      // The org-level Google grant exists; a property may still need picking.
      googleConnected: google.connected,
      siteUrl: connection?.siteUrl ?? null,
      connectedByEmail: google.email,
      connectedAt: connection?.createdAt ?? null,
    };
  });

export const listGscSites = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [siteList, connection] = await Promise.all([
      GscService.listSites(),
      GscService.getConnection(context.projectId),
    ]);
    return {
      requiresReconnect: siteList.requiresReconnect,
      email: siteList.email,
      sites: siteList.sites.map((site) => ({
        siteUrl: site.siteUrl,
        permissionLevel: site.permissionLevel,
        selectable: site.permissionLevel !== "siteUnverifiedUser",
        isSelected: connection?.siteUrl === site.siteUrl,
      })),
    };
  });

export const setGscSite = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setSiteSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const connection = await GscService.setSite({
      projectId: context.projectId,
      organizationId: context.organizationId,
      siteUrl: data.siteUrl,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "gsc:property_select",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, site_url: data.siteUrl },
      }),
    );
    return { connected: true as const, siteUrl: connection.siteUrl };
  });

export const disconnectGsc = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await GscService.disconnect({ projectId: context.projectId });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "gsc:disconnect",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return { connected: false as const };
  });
