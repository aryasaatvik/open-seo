import { env } from "cloudflare:workers";
import { z } from "zod";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { forgetGoogleTools } from "@/server/lib/executor/google";
import { GOOGLE_LINK_ERROR_PARAM } from "@/shared/google-link";
import {
  GOOGLE_ANALYTICS_ADMIN_INTEGRATION,
  GOOGLE_ANALYTICS_DATA_INTEGRATION,
  GOOGLE_SEARCH_CONSOLE_INTEGRATION,
} from "@/shared/integration-addresses";

// The Google connect flow over the integration gateway. The browser lands on
// /api/integrations/google/start, which asks the gateway for Google's consent
// URL and redirects there; Google sends the user back to
// /api/integrations/google/callback, which hands the code to the gateway.
// The gateway mints one org-level connection per Google API. Analytics needs
// two of them (Admin for property discovery, Data for reports), so the "ga4"
// provider walks both consents in a row.

const PROVIDER_INTEGRATIONS = {
  gsc: [GOOGLE_SEARCH_CONSOLE_INTEGRATION],
  ga4: [GOOGLE_ANALYTICS_ADMIN_INTEGRATION, GOOGLE_ANALYTICS_DATA_INTEGRATION],
} as const;

const providerSchema = z.enum(["gsc", "ga4"]);

// Where to send the user afterwards rides in a short-lived cookie: the OAuth
// `state` belongs to the gateway, and Google only returns what it was given.
const FLOW_COOKIE = "openseo_google_connect";
const FLOW_TTL_SECONDS = 10 * 60;
const flowSchema = z.object({
  provider: providerSchema,
  returnTo: z.string().startsWith("/"),
  /** Index into PROVIDER_INTEGRATIONS[provider] of the consent in flight. */
  step: z.number().int().min(0),
});
type Flow = z.infer<typeof flowSchema>;

function flowCookie(flow: Flow | null): string {
  const value = flow ? encodeURIComponent(JSON.stringify(flow)) : "";
  const maxAge = flow ? FLOW_TTL_SECONDS : 0;
  return `${FLOW_COOKIE}=${value}; Path=/api/integrations/google; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

function readFlow(request: Request): Flow | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FLOW_COOKIE}=`));
  if (!cookie) return null;
  try {
    return flowSchema.parse(
      JSON.parse(decodeURIComponent(cookie.slice(FLOW_COOKIE.length + 1))),
    );
  } catch {
    return null;
  }
}

function redirect(location: string, cookie: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "set-cookie": cookie },
  });
}

function failureLocation(flow: Flow, code: string): string {
  const url = new URL(flow.returnTo, "http://placeholder");
  url.searchParams.set(GOOGLE_LINK_ERROR_PARAM, flow.provider);
  url.searchParams.set("error", code);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Only same-origin paths; anything else falls back to the projects list. */
function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/projects";
}

async function beginStep(flow: Flow): Promise<Response> {
  const integration = PROVIDER_INTEGRATIONS[flow.provider][flow.step];
  if (!integration) {
    return redirect(flow.returnTo, flowCookie(null));
  }
  const { authorizationUrl } =
    await env.INTEGRATIONS.googleOAuthStart(integration);
  return redirect(authorizationUrl, flowCookie(flow));
}

export async function handleGoogleConnectStart(
  request: Request,
): Promise<Response> {
  await resolveUserContextFromHeaders(request.headers);
  const url = new URL(request.url);
  const provider = providerSchema.safeParse(url.searchParams.get("provider"));
  if (!provider.success) {
    return new Response("Unknown Google provider", { status: 400 });
  }
  return beginStep({
    provider: provider.data,
    returnTo: safeReturnTo(url.searchParams.get("returnTo")),
    step: 0,
  });
}

export async function handleGoogleConnectCallback(
  request: Request,
): Promise<Response> {
  await resolveUserContextFromHeaders(request.headers);
  const url = new URL(request.url);
  const flow = readFlow(request);
  if (!flow) {
    return redirect("/projects", flowCookie(null));
  }
  const oauthError = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (oauthError || !state || !code) {
    return redirect(
      failureLocation(flow, oauthError ?? "missing_code"),
      flowCookie(null),
    );
  }
  try {
    const connection = await env.INTEGRATIONS.googleOAuthComplete({
      state,
      code,
    });
    forgetGoogleTools(connection.integration);
  } catch (error) {
    console.error("google connect: callback failed", error);
    return redirect(failureLocation(flow, "callback_failed"), flowCookie(null));
  }
  return beginStep({ ...flow, step: flow.step + 1 });
}
