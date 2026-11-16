# Prepare and promote

## Prepare a candidate

1. Preflight must be clean. Fetch and record `origin/dev` and `upstream/main` full SHAs.
2. Branch from the captured `dev` SHA: `git switch -c sync/upstream-YYYY-MM-DD`. Leave `dev` itself alone until promotion.
3. Merge the pinned upstream SHA into the branch. The fork keeps its history: a merge commit, never a rebase or a forced rewrite.

```bash
git merge --no-ff <upstream-sha> -m "chore(selfhost): update to upstream vX.Y.Z"
```

4. Resolve conflicts inside that merge commit, using the policy below. The merge commit is the record of how the fork reconciled upstream, so it holds the conflict resolutions and nothing else.
5. Commit follow-up reconciliation (skill paths, helper allowlist, docs) as separate `docs(selfhost):`/`fix(selfhost):` commits after the merge. Never fold them into the merge commit, and never leave them staged in it.
6. After the merge, confirm the fork series is intact:

```bash
git log --oneline <upstream-sha>..HEAD
git diff <upstream-sha>...HEAD --stat
git log --oneline --first-parent <old-dev-sha>..HEAD
```

New fork commits use the `selfhost` scope. Preserve existing history, including the known older `fix(mcp)` commit; do not rewrite it merely to satisfy the scope convention. A preserved-history merge does not drop old commits that upstream has superseded.

## Conflict policy

Resolve by intent, not by side. The fork's intent is narrow: one paid-plan deployment with unsuffixed names, a custom hostname, and no public workers.dev copy.

| Fork patch | Keep when | Reapply through |
| --- | --- | --- |
| `stageSuffix` and unsuffixed names | Upstream still suffixes non-prod resources by stage | Whatever helper upstream now uses to build names. The requirement is that stage `selfhost` yields the exact names in `topology.md`, otherwise alchemy creates new empty resources and orphans the populated ones |
| Custom hostname | Upstream has no equivalent var | Upstream now owns `CUSTOM_DOMAIN`; the fork reads it and the old `DOMAIN` key is gone. If upstream renames it again, adopt the new name and migrate `.env.selfhost` in the same change |
| `url: !customDomain` | Upstream still exposes workers.dev for self-host | The worker's current route or `url` option |
| Unconditional `limits.cpuMs` | Upstream still gates it on the auth mode | The current `limits` prop. If upstream adds a plan flag, set it instead |
| Retain on `selfhost` | Upstream still retains only `hosted-prod` | Whatever predicate upstream passes to `RemovalPolicy.retain` in `makeResources`. D1, R2, and KV must stay retained; workers may be deleted |
| Service-token aliases | Upstream has no machine-client path for `cloudflare_access` | `emailAccessGate` (second policy) in `deploy/alchemy/alchemy.access.ts` and `resolveSelfHostAccess` in `deploy/alchemy/alchemy.run.ts`; the `common_name` branch in `resolveCloudflareAccessContext` and `resolveSharedWorkspaceContextByEmail`. If upstream adds its own service-token support, adopt it and migrate `ACCESS_SERVICE_TOKENS` in the same change |
| Managed OAuth | Upstream provisions it for self-host Access | Pass `managedOAuth: true` through the fork's `emailAccessGate` call; keep one application and one `aud` |
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
pnpm ci:check
pnpm build:report-widgets && pnpm exec vite build --mode selfhost
```

The helper `preflight.ts` inspects canonical `dev`, `origin/dev`, and the canonical env file; it does not validate the isolated candidate. Run it for layout/deployment readiness, and inspect the candidate explicitly with the pinned-upstream diff and gates above. An expected legacy-domain blocker during preparation is not proof the candidate build failed.

`pnpm ci:check` is the full upstream gate and also runs prettier, knip, and the plugin-skill sync. The selfhost build is the production build the deploy runs, report widgets included. Report a failing suite as a failure; do not skip it silently.

Also read the upstream range for deployment-relevant changes and list them in the report:

```bash
git log --oneline <old-merge-base>..<upstream-sha> -- deploy/alchemy deploy/.env.selfhost.example drizzle wrangler.jsonc scripts/selfhost-deploy-preflight.mjs docs/SELF_HOSTING_CLOUDFLARE.md
```

New keys in `deploy/.env.selfhost.example` need a decision before deploy because a missing key deploys as empty.

## Promote

Promotion moves `origin/dev` to the reviewed candidate. It does not deploy: the live worker keeps running the previously deployed SHA until a separate deploy runs, so a promoted candidate and the deployed state are different facts and the report names both.

Immediately before promotion:

1. `git fetch origin` and confirm `origin/dev` still equals the captured old SHA. Stop if it moved.
2. Create a backup ref: `git branch backup/dev-YYYY-MM-DD <old-dev-sha>` and push it when authorized.
3. Confirm the candidate tree equals the reviewed tree (`git rev-parse HEAD^{tree}`).
4. Push with an exact lease:

```bash
git merge-base --is-ancestor <old-dev-sha> <candidate-sha>
git push origin <candidate-sha>:refs/heads/dev
```

5. From the clean canonical checkout on `dev`, run `git merge --ff-only <candidate-sha>`. Remove only the task-owned candidate branch/worktree after the reviewed work is preserved and no uncommitted reconciliation changes remain.
6. Fast-forward `main`: `git fetch upstream main:main`.
7. Rerun preflight and confirm `dev`, `origin/dev`, and the candidate SHA agree.

Report old SHA, new SHA, backup ref, dropped or rewritten commits, gate results, and the SHA the live worker still runs.
