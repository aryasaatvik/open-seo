# Deploy

Deploy only from a clean `dev` that equals `origin/dev`.

## `.env.selfhost` contract

The file is the whole binding set. Alchemy sets every var and secret from it on each deploy and clears anything absent. Before a deploy, diff the key list against the example without exposing values:

```bash
diff <(rg -o '^[A-Z_]+' .env.selfhost | sort) <(rg -o '^#? ?[A-Z_]+(?==)' deploy/.env.selfhost.example | tr -d '# ' | sort)
```

Keys currently set: `DATAFORSEO_API_KEY`, `ACCESS_ALLOWED_EMAILS`, `CUSTOM_DOMAIN` (renamed from the old `DOMAIN` key before deployment), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `OPENROUTER_API_KEY`, `OPENSEO_TELEMETRY_DISABLED`, `ACCESS_SERVICE_TOKENS` (the `openseo-executor` Access service token, acting as the admin user). Preflight reports the actual key list by name; this list is not proof the key transition has already happened.

`AUTH_MODE` stays unset here on purpose: unset means `cloudflare_access`, the mode this deployment uses. The upstream template now ships `AUTH_MODE=password` for new installs, so copying it over would switch sign-in and cut every existing user off from their records — never adopt that line on this deployment. `DOMAIN` was renamed to `CUSTOM_DOMAIN` upstream; alchemy ignores unknown keys, so a leftover `DOMAIN` deploys a workers.dev hostname with no error. The helper preflight treats a leftover `DOMAIN` as a blocker.

Rules:

- Rotating `BETTER_AUTH_SECRET` invalidates stored Google tokens. Users reconnect GSC and GA4 afterwards.
- Changing `ACCESS_ALLOWED_EMAILS` is the only supported way to change who can sign in. Dashboard edits are overwritten.
- Changing `CUSTOM_DOMAIN` moves the custom-domain route and the Access application's destination together. The old hostname stops serving.
- `ACCESS_SERVICE_TOKENS` maps token ids to an email that must already have a `user` row (signed in once). A wrong email fails at request time on `/mcp` with `AUTH_CONFIG_MISSING`, not at deploy.
- Never paste a value into a chat message, log, or commit. `.logs/` is gitignored but still on disk.

## Migration gate

Before deploying, list the D1 migrations the deploy will apply:

```bash
git diff --name-only <deployed-sha>..HEAD -- drizzle/
wrangler d1 migrations list DB --remote
```

Alchemy applies `drizzle/sqlite/*.sql` in order during the deploy and records them in `d1_migrations`. There is no automatic backup. When a migration rewrites or drops a populated table, export first:

```bash
wrangler d1 export open-seo-db --remote --output .logs/d1-backup-YYYY-MM-DD.sql
```

Ask before deploying such a migration. For this upgrade, take a fresh export and verify a local restore before deployment, including the API-key metadata backfill. An older rehearsal is evidence of migration compatibility, not a current recovery point.

## Deploy

```bash
pnpm deploy:selfhost --yes 2>&1 | tee .logs/deploy-selfhost-YYYY-MM-DD.log
```

The script runs the repo preflight, `build:report-widgets`, `vite build --mode selfhost`, `tsc --noEmit`, then `alchemy deploy deploy/alchemy/alchemy.run.ts --env-file .env.selfhost --stage selfhost`. Expect around twenty resources reported as created or updated. Anything reported as replaced or deleted for D1, KV, R2, or a workflow is a stop condition: the names in `topology.md` must stay stable.

Record the SHA deployed and the worker version alchemy prints.

## Verify

1. `https://seo.arya.sh/api/health` returns OK through Cloudflare Access (the browser session or a service token; an unauthenticated curl gets the Access login page, which is correct).
2. Through Executor MCP, `tools.openseo_mcp.org.aryaLabs.whoami` returns aryasaatvik@gmail.com in self-hosted mode. This proves the service-token policy, the alias var, and the `/mcp` route together.
3. The dashboard loads, GSC and GA4 still show connected, and the Chat tab (SAM) answers.
4. No `AUTH_CONFIG_MISSING` errors in the worker's recent logs. Check its message: possible causes include a missing Access JWT, invalid team/audience configuration, or a service-token alias whose email has no user row.
5. Both crons are still attached to the `open-seo` worker.
6. When the release touched audits or rank tracking, trigger one small audit and check that the `open-seo-audit` worker and the site-audit workflow ran.

Use Executor through MCP for worker versions, logs, and Access application readback.

## Rollback

Alchemy has no rollback command. Roll back by deploying the previous SHA:

```bash
git switch --detach <previous-sha> && pnpm deploy:selfhost --yes
```

D1 migrations already applied stay applied. If a migration must be reversed, restore from the export taken in the migration gate. Never `alchemy destroy --stage selfhost` as a rollback step; it deletes the workers, Access application, and workflows, and orphans the data resources.

## Destroy

Only for a deliberate teardown or rename, with the user's explicit yes in this session:

```bash
pnpm alchemy destroy deploy/alchemy/alchemy.run.ts --env-file .env.selfhost --stage selfhost --yes
```

D1, R2, and KV are retained: destroy forgets them from state and leaves them on the account. The next deploy must adopt them by name or it fails on the existing names:

```bash
node scripts/selfhost-deploy-preflight.mjs && pnpm build:report-widgets && vite build --mode selfhost && pnpm alchemy deploy deploy/alchemy/alchemy.run.ts --env-file .env.selfhost --stage selfhost --adopt --yes
```

Export D1 first anyway. A destroy plus deploy is how the stage was renamed to unsuffixed names on 2026-09-05, before retain was in place and while the database was still empty.
