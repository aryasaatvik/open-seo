# Deploy

Deploy only from a clean `dev` that equals `origin/dev`.

## `.env.selfhost` contract

The file is the whole binding set. Alchemy sets every var and secret from it on each deploy and clears anything absent. Before a deploy, diff the key list against the example without exposing values:

```bash
diff <(rg -o '^[A-Z_]+' .env.selfhost | sort) <(rg -o '^#? ?[A-Z_]+(?==)' .env.selfhost.example | tr -d '# ' | sort)
```

Keys currently set: `DATAFORSEO_API_KEY`, `ACCESS_ALLOWED_EMAILS`, `DOMAIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `OPENROUTER_API_KEY`, `OPENSEO_TELEMETRY_DISABLED`, `ACCESS_SERVICE_TOKENS` (the `openseo-executor` Access service token, acting as the admin user). Preflight reports this list by name.

Rules:

- Rotating `BETTER_AUTH_SECRET` invalidates stored Google tokens. Users reconnect GSC and GA4 afterwards.
- Changing `ACCESS_ALLOWED_EMAILS` is the only supported way to change who can sign in. Dashboard edits are overwritten.
- Changing `DOMAIN` moves the custom-domain route and the Access application together. The old hostname stops serving.
- `ACCESS_SERVICE_TOKENS` maps token ids to an email that must already have a `user` row (signed in once). A wrong email fails at request time on `/mcp` with `AUTH_CONFIG_MISSING`, not at deploy.
- Never paste a value into a chat message, log, or commit. `.logs/` is gitignored but still on disk.

## Migration gate

Before deploying, list the D1 migrations the deploy will apply:

```bash
git diff --name-only <deployed-sha>..HEAD -- drizzle/
wrangler d1 migrations list DB --remote
```

Alchemy applies `drizzle/*.sql` in order during the deploy and records them in `d1_migrations`. There is no automatic backup. When a migration rewrites or drops a populated table, export first:

```bash
wrangler d1 export open-seo-db --remote --output .logs/d1-backup-YYYY-MM-DD.sql
```

Ask before deploying such a migration. Additive migrations need no export but still get named in the report.

## Deploy

```bash
pnpm deploy:selfhost --yes 2>&1 | tee .logs/deploy-selfhost-YYYY-MM-DD.log
```

The script runs the repo preflight, `vite build --mode selfhost`, `tsc --noEmit`, then `alchemy deploy --env-file .env.selfhost --stage selfhost`. Expect around twenty resources reported as created or updated. Anything reported as replaced or deleted for D1, KV, R2, or a workflow is a stop condition: the names in `topology.md` must stay stable.

Record the SHA deployed and the worker version alchemy prints.

## Verify

1. `https://seo.arya.sh/api/health` returns OK through Cloudflare Access (the browser session or a service token; an unauthenticated curl gets the Access login page, which is correct).
2. Through Executor MCP, `tools.openseo_mcp.org.aryaLabs.whoami` returns aryasaatvik@gmail.com in self-hosted mode. This proves the service-token policy, the alias var, and the `/mcp` route together.
3. The dashboard loads, GSC and GA4 still show connected, and the Chat tab (SAM) answers.
4. No `AUTH_CONFIG_MISSING` errors in the worker's recent logs. That error means requests reached the worker without an Access JWT, so the Access application or route is wrong.
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
pnpm alchemy destroy --env-file .env.selfhost --stage selfhost --yes
```

D1, R2, and KV are retained: destroy forgets them from state and leaves them on the account. The next deploy must adopt them by name or it fails on the existing names:

```bash
node scripts/selfhost-deploy-preflight.mjs && vite build --mode selfhost && pnpm alchemy deploy --env-file .env.selfhost --stage selfhost --adopt --yes
```

Export D1 first anyway. A destroy plus deploy is how the stage was renamed to unsuffixed names on 2026-09-05, before retain was in place and while the database was still empty.
