# Account API on Cloudflare

The trial uses `synara-account-api-trial` in the Synara Orgs account
`56e5b3e566be2fc8ade9b7d0eadf5e35`. Its deployed trial origin is
`https://synara-account-api-trial.synara-orgs.workers.dev`. Live startup and hosted
profile privacy checks passed on 2026-09-29; real login and private-profile
creation from the isolated app are also verified.
See [qualification evidence](../../../docs/implementation/cloudflare-profiles/READINESS.md).

A Worker routes to one Cloudflare Container running the existing API Dockerfile.
PostgreSQL remains on Supabase; WorkOS remains the identity provider. Container
disk is disposable and stores no account state. The single named instance keeps
the existing in-memory rate limiter shared across requests; process restarts
still reset its counters. It sleeps after 30 minutes idle, so the next request
can cold-start. Cleanup runs while the API process is awake and again at startup.
Before expanding this trial to multiple instances, address shared rate limiting
and concurrent startup migrations. Containers has separate runtime charges.

## Prepare

1. Use the existing Supabase project `Synara` (`ubdkfrnaqfbdymgipddq`), as
   selected by the operator. Account migrations 0000–0015 were bootstrapped
   through MCP on 2026-09-28, with the Drizzle journal preserved. The existing
   advertising tables and Data API configuration must remain intact.
   Inbox migrations 0016–0017 were applied on 2026-10-07 with their original
   Drizzle hashes/timestamps and the same dedicated owner. RLS stays enabled
   with no grants to `anon` or `authenticated`.
   Verify the project's direct or session-pooler
   connection URL using the [database instructions](../README.md#supabase-postgresql-with-workos).
   Do not use a transaction pooler for startup migrations. Keep verified TLS.
   The verified trial session-pooler host is
   `aws-0-eu-central-1.pooler.supabase.com:5432`. Append both
   `sslmode=verify-full` and
   `sslrootcert=/app/apps/api/cloudflare/certs/supabase-root-2021.crt` to its URL.
   The Dockerfile copies this public CA with the API sources; see
   [certificate provenance](certs/README.md).
   A dedicated database role must own the account tables and Drizzle journal,
   have USAGE/CREATE on their schemas and CONNECT/CREATE on the database.
   Drizzle checks schema-creation permission even when the schema exists.
   Do not grant that role access to the advertising tables.
2. Enable WorkOS Magic Auth for email-code login. For desktop social login,
   register `http://127.0.0.1:*/callback` as an allowed redirect URI. This is a
   local native-app callback, not a callback on the public API origin. Do not
   enable the development identity provider.
3. Store `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and
   `API_SIGNING_KEY` as Worker secrets. The signing key must be a stable,
   base64url-encoded 32-byte Ed25519 seed, not a per-deploy value.
4. Authenticate Wrangler with write access to Workers, Containers/registry and
   Durable Objects in the Synara Orgs account. MCP authorization is separate from
   Wrangler deployment credentials.

From `apps/api`, `bunx wrangler secret put NAME` accepts a secret interactively.
Never put secret values in command arguments or tracked files. Public origins
are already set in `wrangler.jsonc`. The container forces production WorkOS mode,
port 8788 and one trusted proxy hop.

Optional Worker secrets are forwarded only by explicit name:
`API_SIGNING_KEY_PREVIOUS`, `PROFILE_PROXY_SECRET`, and the existing `S3_*`
avatar configuration, plus `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TUNNEL_DOMAIN` and `REMOTE_TEST_USER_IDS`
for remote access. Configure the complete avatar set or leave all of it
unset; the API rejects a partial set. The deployed trial now has all five
required S3 settings as secrets and a bucket-scoped R2 token. Restart the API
Container after changing runtime storage settings; updating Worker secrets
alone does not reconfigure an already running API process. Confirm with an
authenticated upload.

For remote access, set all four `CLOUDFLARE_*` runtime bindings together, or
leave all four unset. A partial tunnel configuration prevents API startup.
The runtime API token must grant Tunnel Edit for the selected account and DNS
Edit for the selected zone; it is separate from Wrangler's deployment login.
It stays in Worker secrets and the API Container, never in the desktop app.
Set `REMOTE_TEST_USER_IDS` to the comma-separated WorkOS IDs of the enrolled
test users; an empty list denies remote access. Restart the Container after
changing these bindings so the API loads them. See the
[remote setup checklist](../../../docs/implementation/cloudflare-remote/READINESS.md)
for DNS prerequisites and the two-Mac test. Forwarding these optional bindings
does not provision a tunnel or enroll anyone by itself.

## Verify and deploy

From the repository root:

```sh
bun run --cwd apps/api typecheck
bun run --cwd apps/api test cloudflare/worker.test.ts
```

With Docker running, `bun run --cwd apps/api cf:deploy` builds the existing
Dockerfile for Cloudflare and deploys the Worker and Container. The build context
is the repository root. The dependency stage runs on the builder’s native
architecture, installs only the API’s production dependency graph, and selects
optional packages for the target CPU. The final image remains Linux amd64 on
Cloudflare. Account migrations execute before the API listens;
review pending migrations and the target database before the first deployment.

Alternatively, use the manual **Verify and deploy account API to Cloudflare**
GitHub Actions workflow. Pull requests touching the API trigger verification
without deployment secrets. The manual button becomes available only once the
workflow exists on the repository's default branch. With `deploy` unchecked,
it runs API tests, builds the Linux image and boots it against disposable
PostgreSQL. The smoke check reads a missing profile through the real API. Its
placeholder WorkOS configuration does not verify real login.

For publication, configure these repository secrets and run with `deploy` checked:

| GitHub secret                 | Destination                          |
| ----------------------------- | ------------------------------------ |
| `CLOUDFLARE_API_TOKEN`        | Cloudflare deployment authentication |
| `SYNARA_API_DATABASE_URL`     | Worker `DATABASE_URL`                |
| `SYNARA_API_WORKOS_API_KEY`   | Worker `WORKOS_API_KEY`              |
| `SYNARA_API_WORKOS_CLIENT_ID` | Worker `WORKOS_CLIENT_ID`            |
| `SYNARA_API_SIGNING_KEY`      | Worker `API_SIGNING_KEY`             |
| `SYNARA_PROFILE_PROXY_SECRET` | Both Workers' `PROFILE_PROXY_SECRET` |

The workflow must pass the container checks before its deployment job starts.
It never runs on an application release tag. It deploys the same checked-out
revision that was verified. After provisioning, confirm API readiness and
complete real login, private-profile, public-profile and revocation checks.
Then run **Deploy Profiles** with the verified API origin above.

The two workflows install the same `PROFILE_PROXY_SECRET` for per-visitor
public-profile rate limits. Direct/manual deployments may omit it, but then
profile reads share upstream per-IP rate limits. Neither workflow invents a
public user profile. Follow the [operator checklist](../../../docs/implementation/cloudflare-profiles/SETUP-IT.md)
to configure, deploy and test the whole trial.

## Verification limits

`wrangler deploy --dry-run --containers-rollout=none` validates and bundles the
ingress Worker only. It does not build, run or publish the container. Full local
dry runs require Docker; the GitHub workflow is the alternative when Docker is
unavailable on the developer's machine. Mocked ingress tests do not verify live
Cloudflare startup, Supabase TLS or WorkOS authentication.

References: [Containers deployment](https://developers.cloudflare.com/containers/get-started/),
[runtime secrets](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).

## Previous-account compatibility

The migration retained old API traffic through `wrangler.legacy.jsonc`, which
streams requests to the new API and preserves client rate limits with a shared
`MIGRATION_PROXY_SECRET`. Keep that secret installed on both API Workers; it
is consumed at the ingress and is never forwarded into the Container. Normal
deployments use `wrangler.jsonc`, targeting Synara Orgs. The legacy config retains
the original Container class/image for recovery but does not route traffic to it.
Do not restore that API against the old avatar bucket after new writes begin.

The live deployment is configured through Wrangler. GitHub deployment secrets
have not yet been configured, so the Actions deployment path remains unverified.
