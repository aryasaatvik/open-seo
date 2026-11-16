// The contract shared by the two email-gated Cloudflare Access boundaries —
// the persistent preview wildcard (alchemy.preview-access.run.ts) and the
// per-stage self-host gate (alchemy.run.ts). Worker naming, the
// WORKERS_SUBDOMAIN shape, the allowed-emails parsing, and the
// policy/application shape define who gets through which hostnames; keep them
// in one place so the two gates cannot drift. The one copy that can't import
// this module is the shell in .github/workflows/pr-preview.yml — its
// `open-seo-<stage>` naming stays comment-synced (and is backstopped by the
// workflow's Access verify step).

import * as Cloudflare from "alchemy/Cloudflare";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const WORKER_PREFIX = "open-seo";

// The one stage that adopts openseo.so's live hosted resources (unsuffixed
// names, app.openseo.so domain, Postgres). Deliberately not "prod" so a
// self-hoster's stage name can't collide with the adoption path.
export const HOSTED_PROD_STAGE = "hosted-prod";

// This fork's single self-host deployment (seo.arya.sh).
export const SELFHOST_STAGE = "selfhost";

// Stages that own the unsuffixed resource names: hosted production and the
// self-host deployment. Every other stage (previews) is suffixed so several
// can coexist on one account.
const UNSUFFIXED_STAGES = new Set([HOSTED_PROD_STAGE, SELFHOST_STAGE]);

export const stageSuffix = (stage: string) =>
  UNSUFFIXED_STAGES.has(stage) ? "" : `-${stage}`;

export const workerName = (stage: string) =>
  `${WORKER_PREFIX}${stageSuffix(stage)}`;

// Matches every preview worker hostname; production's unsuffixed worker does
// not match (Access allows one wildcard per dot-label).
export const previewWildcard = (subdomain: string) =>
  `${WORKER_PREFIX}-*.${subdomain}`;

export const readWorkersSubdomain = ({ required }: { required: boolean }) =>
  Effect.gen(function* () {
    const subdomain = (yield* Config.string("WORKERS_SUBDOMAIN").pipe(
      Config.withDefault(""),
    )).trim();
    if (subdomain.endsWith(".workers.dev") || (!subdomain && !required)) {
      return subdomain;
    }
    return yield* Effect.die(
      new Error(
        `Set WORKERS_SUBDOMAIN to the account's full workers.dev subdomain (shown under Workers & Pages)${required ? "." : ", or leave it unset."}`,
      ),
    );
  });

/** Reads ACCESS_ALLOWED_EMAILS; dies with `remedy` when none are set. */
export const requireAllowedEmails = (remedy: string) =>
  Effect.gen(function* () {
    const emails = (yield* Config.string("ACCESS_ALLOWED_EMAILS").pipe(
      Config.withDefault(""),
    ))
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      return yield* Effect.die(new Error(remedy));
    }
    return emails;
  });

/**
 * The gate itself: an email allow-policy on a self-hosted Access application,
 * plus an optional Service Auth policy for machine clients (Access service
 * tokens, see ACCESS_SERVICE_TOKENS). Both policies are alchemy-owned; the
 * application's policy list is reconciled on every deploy, so a policy added
 * in the dashboard would not survive.
 */
export const emailAccessGate = (options: {
  policyId: string;
  applicationId: string;
  policyName: string;
  applicationName: string;
  domain: string;
  /** A second hostname (a self-host's CUSTOM_DOMAIN) the same app protects. */
  extraDomain?: string;
  emails: string[];
  serviceTokenIds?: string[];
  /** Turn on Access Managed OAuth so MCP clients can sign in. */
  managedOAuth?: boolean;
}) =>
  Effect.gen(function* () {
    const allow = yield* Cloudflare.Access.Policy(options.policyId, {
      name: options.policyName,
      decision: "allow",
      include: options.emails.map((email) => ({ email: { email } })),
    });
    const policies = [allow.policyId];
    if (options.serviceTokenIds?.length) {
      const serviceAuth = yield* Cloudflare.Access.Policy(
        `${options.policyId}ServiceAuth`,
        {
          name: `${options.policyName} (service tokens)`,
          decision: "non_identity",
          include: options.serviceTokenIds.map((tokenId) => ({
            serviceToken: { tokenId },
          })),
        },
      );
      policies.push(serviceAuth.policyId);
    }
    return yield* Cloudflare.Access.Application(options.applicationId, {
      type: "self_hosted",
      name: options.applicationName,
      domain: options.domain,
      // One application (one `aud`) covers both hostnames. `domain` stays the
      // workers.dev hostname so an existing application updates in place.
      destinations: options.extraDomain
        ? [
            { type: "public", uri: options.domain },
            { type: "public", uri: options.extraDomain },
          ]
        : undefined,
      policies,
      // Lets CLI and desktop MCP clients register localhost callbacks.
      // Unset fields (HTTPS redirect URIs, token lifetimes) keep whatever is
      // set in the dashboard.
      oauthConfiguration: options.managedOAuth
        ? {
            enabled: true,
            dynamicClientRegistration: {
              enabled: true,
              allowAnyOnLocalhost: true,
              allowAnyOnLoopback: true,
            },
          }
        : undefined,
    });
  });

export const accessScopeHint =
  " (if this is a permissions error, re-run `pnpm alchemy login deploy/alchemy/alchemy.run.ts --configure`, answer yes to “Customize OAuth scopes?”, and select access:write alongside the defaults)";

/**
 * ACCESS_SERVICE_TOKENS: `<service-token-id>=<email>,...`. Each Access
 * service token (Zero Trust -> Access -> Service Auth) is admitted by a
 * Service Auth policy on the application and acts as the named user inside
 * the app (see src/middleware/ensure-user/cloudflareAccess.ts). The token's
 * client id — what the Access JWT carries as `common_name` — is read here so
 * the env file only needs the token id shown in the dashboard.
 */
export const resolveServiceTokens = (accountId: string) =>
  Effect.gen(function* () {
    const entries = (yield* Config.string("ACCESS_SERVICE_TOKENS").pipe(
      Config.withDefault(""),
    ))
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const tokens: { id: string; clientId: string; email: string }[] = [];
    for (const entry of entries) {
      const [id, email] = entry.split("=").map((part) => part.trim());
      if (!id || !email) {
        return yield* Effect.die(
          new Error(
            `ACCESS_SERVICE_TOKENS entries are <service-token-id>=<email>; got "${entry}".`,
          ),
        );
      }
      const token = yield* ZeroTrust.getAccessServiceTokenForAccount({
        accountId,
        serviceTokenId: id,
      }).pipe(
        Effect.catch((error) =>
          Effect.die(
            new Error(
              `Could not read Access service token ${id}: ${String(error)}${accessScopeHint}`,
            ),
          ),
        ),
      );
      if (!token.clientId) {
        return yield* Effect.die(
          new Error(`Access service token ${id} has no client id.`),
        );
      }
      tokens.push({ id, clientId: token.clientId, email });
    }
    return tokens;
  });
