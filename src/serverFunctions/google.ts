import { createServerFn } from "@tanstack/react-start";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { GscService } from "@/server/features/gsc/services/GscService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

/** The organization's Google grants held by the integration gateway.
 *  Project-free, so onboarding and nudges can read it before a project exists. */
export const getGoogleConnectionStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    const [gsc, ga4] = await Promise.all([
      GscService.getGoogleConnection(context),
      Ga4Service.getGoogleConnection(context),
    ]);
    return { gsc, ga4 };
  });
