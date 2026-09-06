# Rebase and promotion

## Prepare a candidate

1. Preflight must be clean. Fetch and record `origin/dev` and `upstream/main` full SHAs.
2. Branch from the captured `dev` SHA: `git switch -c sync/upstream-YYYY-MM-DD`. Leave `dev` itself alone until promotion.
3. Rebase onto the captured upstream SHA with rerere for this command only:

```bash
git -c rerere.enabled=true rebase <upstream-sha>
```

4. Resolve conflicts commit by commit using the policy below. After the rebase, confirm the series is intact:

```bash
git log --oneline <upstream-sha>..HEAD
git range-diff <upstream-sha> <old-dev-sha> HEAD
git diff <upstream-sha>...HEAD --stat
```

Every commit in the range must carry the `selfhost` scope. A commit that became empty means upstream adopted the change; drop it and note that in the report.

## Conflict policy

Resolve by intent, not by side. The fork's intent is narrow: one paid-plan deployment with unsuffixed names, a custom hostname, and no public workers.dev copy.

| Fork patch | Keep when | Reapply through |
| --- | --- | --- |
| `stageSuffix` and unsuffixed names | Upstream still suffixes non-prod resources by stage | Whatever helper upstream now uses to build names. The requirement is that stage `selfhost` yields the exact names in `topology.md`, otherwise alchemy creates new empty resources and orphans the populated ones |
| `DOMAIN` custom hostname | Upstream has no equivalent var | Upstream's current `domain:` prop on the app worker and the Access application's `domain`. If upstream adds its own custom-domain var, adopt it, drop the fork var, and update `.env.selfhost` in the same change |
| `url: !customDomain` | Upstream still exposes workers.dev for self-host | The worker's current route or `url` option |
| Unconditional `limits.cpuMs` | Upstream still gates it on `authMode` | The current `limits` prop. If upstream adds a plan flag, set it instead |
| Retain on `selfhost` | Upstream still retains only `hosted-prod` | Whatever predicate upstream passes to `RemovalPolicy.retain` in `makeResources`. D1, R2, and KV must stay retained; workers may be deleted |
| Service-token aliases | Upstream has no machine-client path for `cloudflare_access` | `emailAccessGate` (second policy) and `resolveSelfHostAccess` in alchemy; the `common_name` branch in `resolveCloudflareAccessContext` and `resolveSharedWorkspaceContextByEmail`. If upstream adds its own service-token support, adopt it and migrate `ACCESS_SERVICE_TOKENS` in the same change |
| `/mcp` error mapping | Upstream still lets identity errors escape `handleSelfHostedOpenSeoMcpRequest` | `responseForAppError` around the identity resolution |

Rules:

- Prefer upstream's current alchemy structure, binding names, and Access provisioning. Port the fork behavior onto it rather than restoring old structure.
- Take upstream for anything under `src/`, `drizzle/`, `wrangler.jsonc`, docs, and tests, except the two application patches above (`src/middleware/ensure-user/*`, `src/server/mcp/transport.ts`) and their test.
- Never resolve with blanket `ours` or `theirs`.
- Never hand-edit `pnpm-lock.yaml` conflicts. Take upstream's lockfile and run `pnpm install --frozen-lockfile`; the fork adds no dependencies.
- Search for leftover markers before building: `rg -n '^(<<<<<<<|=======|>>>>>>>)' --glob '!pnpm-lock.yaml'`.

Stop for a decision when upstream changed the stage model, Access provisioning, the D1 migration table, `AUTH_MODE` semantics, or the OAuth callback paths.

## Gates

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm test
node scripts/selfhost-deploy-preflight.mjs
```

`pnpm ci:check` is the full upstream gate and also runs prettier, knip, and the plugin-skill sync. Run it when the rebase touched more than the alchemy files. Report a failing suite as a failure; do not skip it silently.

Also read the upstream range for deployment-relevant changes and list them in the report:

```bash
git log --oneline <old-merge-base>..<upstream-sha> -- alchemy.run.ts alchemy.access.ts .env.selfhost.example drizzle wrangler.jsonc scripts/selfhost-deploy-preflight.mjs docs/SELF_HOSTING_CLOUDFLARE.md
```

New keys in `.env.selfhost.example` need a decision before deploy because a missing key deploys as empty.

## Promote

Promotion rewrites `dev`. Immediately before it:

1. `git fetch origin` and confirm `origin/dev` still equals the captured old SHA. Stop if it moved.
2. Create a backup ref: `git branch backup/dev-YYYY-MM-DD <old-dev-sha>` and push it when authorized.
3. Confirm the candidate tree equals the reviewed tree (`git rev-parse HEAD^{tree}`).
4. Push with an exact lease:

```bash
git push --force-with-lease=refs/heads/dev:<old-dev-sha> origin <candidate-sha>:refs/heads/dev
```

5. Move the local branch: `git switch dev && git reset --keep <candidate-sha>` (fails rather than discarding local changes), then `git branch -D sync/upstream-YYYY-MM-DD`.
6. Fast-forward `main`: `git fetch upstream main:main`.
7. Rerun preflight and confirm `dev`, `origin/dev`, and the candidate SHA agree.

Report old SHA, new SHA, backup ref, dropped or rewritten commits, and gate results.
