import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "@/server/lib/errors";
import { validateTeamDomain } from "@/shared/selfhost-checks";
import { classifyAccessVerificationError } from "./accessTokenErrors";
import {
  resolveSharedWorkspaceContext,
  resolveSharedWorkspaceContextByEmail,
} from "./delegated";
import type { EnsuredUserContext } from "./types";

const jwksByTeamDomain = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function getJwks(teamDomain: string) {
  const existing = jwksByTeamDomain.get(teamDomain);
  if (existing) {
    return existing;
  }

  const jwks = createRemoteJWKSet(
    new URL(`${teamDomain}/cdn-cgi/access/certs`),
  );

  jwksByTeamDomain.set(teamDomain, jwks);

  return jwks;
}

function getValidatedTeamDomain(teamDomain: string) {
  const result = validateTeamDomain(teamDomain);

  if (!result.ok) {
    throw new AppError("AUTH_CONFIG_MISSING", result.message);
  }

  return result.origin;
}

export async function resolveCloudflareAccessContext(
  headers: Headers,
): Promise<EnsuredUserContext> {
  const teamDomain = env.TEAM_DOMAIN
    ? getValidatedTeamDomain(env.TEAM_DOMAIN)
    : null;
  const policyAud = env.POLICY_AUD?.trim() || null;

  if (!teamDomain || !policyAud) {
    const missing = [
      teamDomain ? null : "TEAM_DOMAIN",
      policyAud ? null : "POLICY_AUD",
    ]
      .filter(Boolean)
      .join(" and ");
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      `Missing Cloudflare Access configuration: set ${missing} on the deployment. See docs/SELF_HOSTING_CLOUDFLARE.md.`,
    );
  }

  const token = headers.get("cf-access-jwt-assertion");

  if (!token) {
    // With Access enabled in front of the deployment, every request carries
    // this header — its absence means Access is not actually protecting the
    // route, which is a setup problem, not a signed-out user.
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "No Cloudflare Access token on the request. Cloudflare Access is not enabled in front of this deployment — add an Access application covering this hostname in Zero Trust, or set AUTH_MODE=local_noauth if you intend to run without auth on a private network.",
    );
  }

  // Only the token verification itself is classified — anything thrown past
  // this block (user resolution, DB access) is an app fault, and classifying
  // it here would mislabel a DB outage as an auth-config problem.
  let payload: JWTPayload;
  try {
    const jwks = getJwks(teamDomain);
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: policyAud,
    }));
  } catch (error) {
    // The classified AppError carries operator guidance; log the raw jose
    // error too, since it is the only place the underlying cause survives.
    console.error("Cloudflare Access token verification failed:", error);

    throw classifyAccessVerificationError(error);
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const userEmail = typeof payload.email === "string" ? payload.email : null;

  if (userId && userEmail) {
    return resolveSharedWorkspaceContext(userId, userEmail);
  }

  // Access service tokens (CF-Access-Client-Id/-Secret) are verified by Access
  // like a login, but the JWT carries only `common_name` (the token's client
  // id). ACCESS_SERVICE_TOKEN_ALIASES maps a client id to the email of the
  // user the token acts as, so a machine client (Executor) works inside that
  // user's workspace. Unmapped tokens are rejected even if Access let them in.
  const commonName =
    typeof payload.common_name === "string" ? payload.common_name : null;
  const aliasEmail = commonName
    ? serviceTokenAliasEmail(env.ACCESS_SERVICE_TOKEN_ALIASES, commonName)
    : null;

  if (!aliasEmail) {
    throw new AppError("UNAUTHENTICATED");
  }

  return resolveSharedWorkspaceContextByEmail(aliasEmail);
}

// `<client-id>=<email>,<client-id>=<email>`; the deploy derives it from
// ACCESS_SERVICE_TOKENS (token ids) so operators never copy client ids.
export function serviceTokenAliasEmail(
  aliases: string | undefined,
  commonName: string,
): string | null {
  for (const entry of (aliases ?? "").split(",")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const clientId = entry.slice(0, separator).trim();
    const email = entry.slice(separator + 1).trim();
    if (clientId && email && clientId === commonName) return email;
  }
  return null;
}
