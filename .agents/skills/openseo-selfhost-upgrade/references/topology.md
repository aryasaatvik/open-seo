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

Current patches, all in the deploy layer:

| Commit subject | Files | What it does |
| --- | --- | --- |
| `fix(selfhost): custom DOMAIN and paid-plan CPU limits` | `alchemy.run.ts`, `.env.selfhost.example` | Reads optional `DOMAIN`; binds the app worker and the Access application to it; sets `limits.cpuMs = 300_000` on both workers unconditionally (upstream skips it under `cloudflare_access` for free-plan users) |
| `fix(selfhost): drop the workers.dev route when DOMAIN is set` | `alchemy.run.ts` | `url: !customDomain` so the app has no unauthenticated public hostname |
| `fix(selfhost): give the selfhost stage unsuffixed resource names` | `alchemy.access.ts`, `alchemy.run.ts` | `stageSuffix(stage)` returns `""` for `hosted-prod` and `selfhost`; every D1/R2/KV/workflow/Access name uses it |
| `docs(selfhost): add the selfhost upgrade skill` | `.agents/skills/openseo-selfhost-upgrade/**`, `.claude/skills/openseo-selfhost-upgrade`, `knip.jsonc` | This skill; knip excludes skill helper scripts |
| `fix(selfhost): retain D1, R2, and KV on the selfhost stage` | `alchemy.access.ts`, `alchemy.run.ts` | Exports `SELFHOST_STAGE`; `makeResources` retains the data-bearing resources for `hosted-prod` and `selfhost` |

Application code is unpatched. If a future patch has to touch `src/`, add it to this table and to the conflict policy in `rebase.md`.

## Cloudflare resources (Arya Labs account, stage `selfhost`)

| Kind | Name | Notes |
| --- | --- | --- |
| Worker | `open-seo` | App worker, custom domain `seo.arya.sh`, crons `*/5 * * * *` and `17 3 * * *`, no workers.dev route |
| Worker | `open-seo-audit` | Bound into the app as `AUDIT_ENGINE` |
| D1 | `open-seo-db` | Drizzle SQL from `drizzle/`, tracked in table `d1_migrations`. Retained on destroy |
| KV | `open-seo-kv`, `open-seo-oauth-kv` | Retained on destroy |
| R2 | `open-seo-r2` | DataForSEO response cache. Retained on destroy |
| Workflows | `site-audit-workflow`, `rank-check-workflow` | Names are alchemy resource ids; a rename orphans the live registration |
| Durable Objects | `ONBOARDING_CHAT`, `SAM_CHAT`, audit scratchpad | SQLite-backed, declared in `wrangler.jsonc` migrations |
| Access | app `open-seo`, policy `open-seo users` | Zero Trust team `aryalabs.cloudflareaccess.com`, emails from `ACCESS_ALLOWED_EMAILS`. Dashboard edits are overwritten each deploy |
| State | worker `alchemy-state-store` | Alchemy state, profile `default` |

Alchemy pin: `2.0.0-beta.61` from `package.json`, the upstream package. The patched Samva alchemy build is deliberately not used here.

## External accounts

Secrets live only in `.env.selfhost` (gitignored, mode 600). Dates and balances belong in `.scratchpad/selfhost.md`, not here.

| Service | Identity | Wired through |
| --- | --- | --- |
| DataForSEO | account saatvik@aryalabs.ai, prepaid, no auto-recharge | `DATAFORSEO_API_KEY` (base64 `email:api-password`). Self-host mode has no spend guardrail; check with `pnpm billing:usage` |
| OpenRouter | key named `OpenSEO`, personal account | `OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL`. Powers SAM |
| Google | GCP project `openseo-163576` (aryasaatvik@gmail.com), consent screen External/Testing, OAuth web client `OpenSEO` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`. Callbacks `https://seo.arya.sh/api/gsc/oauth/callback` and `.../api/ga4/oauth/callback`. New Google accounts must be added as test users first |
| Cloudflare | Arya Labs account, Workers Paid | alchemy profile `default`; Access allowlist `ACCESS_ALLOWED_EMAILS` |

## Read-only refresh

When current upstream state is needed:

1. Run preflight.
2. `git fetch origin && git fetch upstream` from the fork checkout.
3. Record `origin/dev` and `upstream/main` as full SHAs.
4. If the upstream worktree is clean, detach it at the new SHA: `git -C ~/Developer/open-seo-worktrees/upstream checkout --detach upstream/main`.
5. Fast-forward `main` only: `git fetch upstream main:main` (fails if it would not fast-forward).
6. Rerun preflight and keep its output in the report.

Refreshing refs is not permission to rebase, push, or deploy.
