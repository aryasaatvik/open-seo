# Topology

Git, Cloudflare, and `.env.selfhost` are the authority. Treat the conventional paths and names below as expectations to verify, not evidence.

## Checkouts and remotes

| Role | Location | Ownership |
| --- | --- | --- |
| Fork history | `~/Developer/open-seo` on `dev` | Fork commits, upgrade rebases, deploys. `origin` = `git@github.com:aryasaatvik/open-seo.git` (default branch `dev`) |
| Upstream mirror | `main` in the same checkout | Fast-forward only to `upstream/main`. Never commit to it |
| Upstream snapshot | `~/Developer/open-seo-worktrees/upstream`, detached | Read-only view of the exact fetched `upstream/main` SHA for diffing |
| Upstream remote | `upstream` = `git@github.com:every-app/open-seo.git` | Fetch only. No PRs, no pushes |

Two checkouts on purpose: there is no separate selfhost worktree because the deployment builds straight from `dev`.

## Fork patch series

The fork carries a short series on top of `upstream/main`. Identify it with:

```bash
git log --oneline upstream/main..dev
git diff upstream/main...dev --stat
```

Current patches, all in the deploy layer. The alchemy stack lives at
`deploy/alchemy/alchemy.run.ts` and `deploy/alchemy/alchemy.access.ts`, and the
template at `deploy/.env.selfhost.example`; nothing is at the repo root.

| Commit subject | Files | What it does |
| --- | --- | --- |
| `fix(selfhost): custom DOMAIN and paid-plan CPU limits` | `deploy/alchemy/alchemy.run.ts`, `deploy/.env.selfhost.example` | Sets `limits.cpuMs = 300_000` on both workers unconditionally (upstream skips it for self-host auth modes). Upstream now owns the hostname var: the fork reads upstream's `CUSTOM_DOMAIN`, and the fork's old `DOMAIN` key is gone |
| `fix(selfhost): drop the workers.dev route when DOMAIN is set` | `deploy/alchemy/alchemy.run.ts` | `url: !customDomain` so the app has no unauthenticated public hostname |
| `fix(selfhost): give the selfhost stage unsuffixed resource names` | `deploy/alchemy/alchemy.access.ts`, `deploy/alchemy/alchemy.run.ts` | `stageSuffix(stage)` returns `""` for `hosted-prod` and `selfhost`; every D1/R2/KV/workflow/Access name uses it |
| `docs(selfhost): add the selfhost upgrade skill` | `.agents/skills/openseo-selfhost-upgrade/**`, `.claude/skills/openseo-selfhost-upgrade` | This skill; upstream already excludes skill helper scripts from knip |
| `fix(selfhost): retain D1, R2, and KV on the selfhost stage` | `deploy/alchemy/alchemy.access.ts`, `deploy/alchemy/alchemy.run.ts` | Exports `SELFHOST_STAGE`; `makeResources` retains the data-bearing resources for `hosted-prod` and `selfhost` |
| `feat(selfhost): admit Access service tokens as aliased users` | `deploy/alchemy/alchemy.access.ts`, `deploy/alchemy/alchemy.run.ts`, `src/middleware/ensure-user/{cloudflareAccess,delegated}.ts`, `src/env.d.ts`, docs | Reads `ACCESS_SERVICE_TOKENS` (`<token-id>=<email>`), adds a `non_identity` policy to the Access application, derives the `ACCESS_SERVICE_TOKEN_ALIASES` worker var; the Access middleware resolves a `common_name`-only JWT through that map to the existing user |
| `fix(mcp): return HTTP errors from the self-hosted /mcp auth step` | `src/server/mcp/transport.ts` | Identity failures on `/mcp` return 401/500 with the guidance message instead of an uncaught exception (edge 1101) |

The last two patches touch `src/`; the conflict policy in `rebase.md` covers them.

## Cloudflare resources (Arya Labs account, stage `selfhost`)

| Kind | Name | Notes |
| --- | --- | --- |
| Worker | `open-seo` | App worker, custom domain `seo.arya.sh`, crons `*/5 * * * *` and `17 3 * * *`, no workers.dev route |
| Worker | `open-seo-audit` | Bound into the app as `AUDIT_ENGINE` |
| D1 | `open-seo-db` | Drizzle SQL from `drizzle/sqlite/`, tracked in table `d1_migrations`. Retained on destroy |
| KV | `open-seo-kv`, `open-seo-oauth-kv` | Retained on destroy |
| R2 | `open-seo-r2` | DataForSEO response cache. Retained on destroy |
| Workflows | `site-audit-workflow`, `rank-check-workflow`, `local-rank-workflow` | Names are alchemy resource ids; a rename orphans the live registration. Upstream adds workflows over time; each new one registers additively on the next deploy |
| Durable Objects | `SAM_CHAT`, audit scratchpad | SQLite-backed, declared in `wrangler.jsonc` migrations |
| Access | app `open-seo`, policies `open-seo users` (allow) and `open-seo users (service tokens)` (Service Auth) | Zero Trust team `aryalabs.cloudflareaccess.com`, emails from `ACCESS_ALLOWED_EMAILS`, token ids from `ACCESS_SERVICE_TOKENS`. One application, one `aud`: upstream's provisioning keeps the workers.dev hostname as the application's primary `domain` and lists `seo.arya.sh` as a second destination. The candidate enables Managed OAuth so MCP clients can register callbacks; this is not a claim about the currently deployed Access configuration. Dashboard edits are overwritten each deploy |
| Access service token | `openseo-executor` (id `38749c3a-97fe-4c02-83c3-68936303d891`, duration forever) | Created via the Cloudflare API, not alchemy. Acts as aryasaatvik@gmail.com. Its secret lives only in Executor's `openseo_mcp` integration headers |
| State | worker `alchemy-state-store` | Alchemy state, profile `default` |

Alchemy pin: `2.0.0-beta.61` from `package.json`, the upstream package. The patched Samva alchemy build is deliberately not used here.

The installed pin is `2.0.0-beta.61`. October deployment evidence records a
credential-layout mismatch: this release expected legacy `~/.alchemy/profiles.json`,
while the machine had migrated to `~/.alchemy/profiles/<profile>/cloudflare.json`.
A missing legacy profile is not proof that credentials are invalid. Before a deploy,
check the installed release's profile lookup and existing provider/account identity,
without printing credential values or overwriting the modern default profile.
Use an isolated, task-scoped compatibility profile only after validating its format
against that installed release; preserve the canonical credential store and remove
only task-owned compatibility artifacts afterward. Re-authenticate only when current
evidence shows the existing grant is unusable. An Alchemy upgrade needs a compatibility
review; a changed version number alone does not prove a state-format migration.

## External accounts

Secrets live only in `.env.selfhost` (gitignored, mode 600). Dates and balances belong in `.scratchpad/selfhost.md`, not here.

| Service | Identity | Wired through |
| --- | --- | --- |
| DataForSEO | account saatvik@aryalabs.ai, prepaid, no auto-recharge | `DATAFORSEO_API_KEY` (base64 `email:api-password`). Self-host mode has no spend guardrail; check with `pnpm billing:usage` |
| OpenRouter | key named `OpenSEO`, personal account | `OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL`. Powers SAM |
| Google | GCP project `openseo-163576` (aryasaatvik@gmail.com), consent screen External, published to Production and unverified, OAuth web client `OpenSEO` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`. Callbacks `https://seo.arya.sh/api/gsc/oauth/callback` and `.../api/ga4/oauth/callback`. Any Google account can connect through the unverified-app interstitial; lifetime cap 100 grants. Branding homepage `https://arya.sh`, privacy URL `https://arya.sh/privacy` (no page exists; only needed if verification is ever submitted) |
| Cloudflare | Arya Labs account, Workers Paid | alchemy profile `default`; Access allowlist `ACCESS_ALLOWED_EMAILS`; machine clients `ACCESS_SERVICE_TOKENS` |
| Executor | `https://executor.arya.sh`, integration `openseo_mcp`, connection `tools.openseo_mcp.org.aryaLabs` | Calls `https://seo.arya.sh/mcp` with `CF-Access-Client-Id` / `CF-Access-Client-Secret` integration headers. Rotate: create a new token, update the headers and `ACCESS_SERVICE_TOKENS`, redeploy, then delete the old token |

## Read-only refresh

When current upstream state is needed:

1. Run preflight.
2. `git fetch origin && git fetch upstream` from the fork checkout.
3. Record `origin/dev` and `upstream/main` as full SHAs.
4. If the upstream worktree is clean, detach it at the new SHA: `git -C ~/Developer/open-seo-worktrees/upstream checkout --detach upstream/main`.
5. Fast-forward `main` only: `git fetch upstream main:main` (fails if it would not fast-forward).
6. Rerun preflight and keep its output in the report.

Refreshing refs is not permission to rebase, push, or deploy.
