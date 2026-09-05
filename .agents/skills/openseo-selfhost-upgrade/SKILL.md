---
name: openseo-selfhost-upgrade
description: Inspect, rebase, and redeploy the aryasaatvik/open-seo fork that self-hosts OpenSEO at seo.arya.sh on Cloudflare (alchemy stage `selfhost`, D1, Cloudflare Access). Use when pulling upstream every-app/open-seo into `dev`, resolving conflicts around the fork's selfhost patches, changing `.env.selfhost`, redeploying, or explaining how the self-host is wired. Not for upstream contributions; this fork opens no upstream PRs.
metadata:
  internal: true
---

# OpenSEO selfhost upgrade

Keep the fork current with upstream and the live deployment current with the fork, without widening authorization between the two.

## Choose the phase

Start in the least-mutating phase that satisfies the request:

- **Inspect** is read-only. Run the preflight, refresh remote-tracking refs when current upstream state matters, and report drift and blockers.
- **Prepare** rebases `dev` onto the fetched `upstream/main` in an isolated branch, resolves conflicts around the fork patches, and runs the gates. It does not touch `origin/dev` or the deployment.
- **Promote** moves `origin/dev` to the reviewed candidate with an exact lease. Ask immediately before the force-with-lease.
- **Deploy** runs `pnpm deploy:selfhost` from the promoted `dev` and verifies the live site. Ask immediately before the deploy when the diff adds D1 migrations, changes bindings, or changes Access.

An approval for one phase does not authorize a later one. A request to discuss or inspect is not permission to rebase, push, or deploy.

## Required reading

Read [references/topology.md](references/topology.md) for every request.

- Prepare or Promote: also read [references/rebase.md](references/rebase.md).
- Deploy or any `.env.selfhost` change: also read [references/deploy.md](references/deploy.md).

## Preflight

From the fork checkout:

```bash
bun .agents/skills/openseo-selfhost-upgrade/scripts/preflight.ts
bun .agents/skills/openseo-selfhost-upgrade/scripts/preflight.ts --json
```

The script is read-only. It never fetches, switches branches, installs, or deploys, so its remote-tracking refs can be stale. Fetch deliberately, then rerun. Every blocker is a stop condition. It reports which `.env.selfhost` keys are set by name only and never prints a value.

## Invariants

- `~/Developer/open-seo` stays on `dev`. `main` mirrors `upstream/main` and receives no fork commits. `~/Developer/open-seo-worktrees/upstream` is a detached read-only view of `upstream/main`.
- Every fork-only commit uses the Conventional Commit scope `selfhost` (`fix(selfhost):`, `docs(selfhost):`, ...). Preflight lists any fork-only commit that lacks it.
- No upstream PRs. Fork changes land directly on `dev` after local gates.
- One deployment, stage `selfhost`, unsuffixed resource names. Never create a second stage on the Arya Labs account with the name `selfhost`. D1, R2, and KV are retained on destroy (fork patch), so a destroy leaves them orphaned and the next deploy needs `--adopt`.
- `.env.selfhost` is the complete binding set. Alchemy replaces every var and secret on each deploy, so a key missing from the file deploys as empty. Never commit it and never echo its values.
- Use the repo's `pnpm` scripts for build, typecheck, and deploy. Use Wrangler only for D1 inspection and reads; alchemy owns the resources.
- Use Executor through MCP for live Cloudflare inspection (worker versions, logs, Access apps). Never the Executor CLI.
- Record the old `dev` SHA, the upstream SHA, and the deployed worker version before mutating any of them.

## Stop conditions

Stop and ask when:

- a conflict touches `alchemy.run.ts` or `alchemy.access.ts` beyond the documented fork patches, or upstream changed the stage/suffix model, Access provisioning, or the binding set;
- upstream adds a D1 migration that rewrites or drops populated tables, or changes the `d1_migrations` table name;
- upstream changes the OAuth callback paths, `AUTH_MODE` semantics, or the `.env.selfhost` contract;
- any checkout is dirty or `origin/dev` moved after the lease was captured;
- a gate fails or the live verification cannot reach the authenticated app;
- the requested change would create a second Cloudflare Access application or a second custom-domain route.
