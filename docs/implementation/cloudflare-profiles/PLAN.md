# Cloudflare public profiles — implementation and rollout

## Outcome and baseline

Preserve Dylan's existing account/profile model, editor, usage reporter and
OpenNext page (`/@handle`). Complete a controlled activation and verify that a
profile is public only after its owner publishes it. This is separate from
Cloudflare Tunnel remote connections.

Baseline: `6a8e648` on `codex/cloudflare-remote-mvp`. Dylan's profiles app and
Cloudflare configuration are retained. Profile consumers and server mutations
are disabled; the marketing rewrites still target the former Vercel origin.
Existing API/schema and remote-readiness working-tree changes belong to other
work and are outside this change.

## Ordered execution

1. **Trace the existing lifecycle.** Check onboarding, immutable handles,
   account mutations, usage reporting, public/private API responses, shared
   UI and Worker configuration. Reuse these implementations; no new database
   or authentication system. Record defects and external dependencies.
2. **Enable a controlled application trial.** Keep Stable disabled via the
   shared Beta feature list. Require `SYNARA_ACCOUNT_PROFILE_SYNC=1` on the
   server, advertise availability in its execution descriptor, and use that
   capability in the existing UI. Gate reporter startup and mutations using
   the same policy. Existing credentials alone must not activate reporting.
   Pass the opt-in through Turbo and set `VITE_PROFILES_PUBLIC_ORIGIN` when
   building/running the trial app so open/copy/share links reach the trial Worker.
   Explain that trial activation uploads aggregate historical usage to the
   signed-in account service; private/public controls page visibility.
3. **Preserve privacy through rendering.** Correct onboarding's claim that a
   new private profile is public. Fetch current publication state on each
   public request, and prevent shared caching of social preview responses.
   Verify private/unknown 404, public rendering and upstream error behavior.
4. **Prepare Cloudflare delivery.** Retain the historical Dylan config. Add an
   isolated workers.dev trial configuration without his custom domain or
   shared avatar bucket. Build OpenNext and validate a deployment dry run.
   Keep deployment manual. Do not change marketing routing until the actual
   Worker URL and asset paths have passed the live checks.
5. **Verify locally.** Focused feature-policy/account/profile tests, API
   lifecycle tests against isolated PostgreSQL where available, OpenNext build
   and dry run, then workspace formatting, lint, typecheck and tests. Record
   failures and distinguish mocks/emulation from live Cloudflare evidence.
6. **Deploy the account API first.** The user confirmed there is no hosted API.
   Host the existing `apps/api` Dockerfile on Cloudflare Containers, behind
   its own ingress Worker. Keep PostgreSQL on Supabase and identity on WorkOS.
   Use the required settings listed below; verify
   migrations, public instance metadata and real login before connecting the
   profiles Worker. Keep the development identity provider off in production.
7. **Authenticated Worker rollout.** Identify the connected Cloudflare account and
   existing resources; select a dedicated trial Worker. Configure its account
   API URL and optional shared proxy secret without exposing credentials.
   Deploy, create a synthetic test profile in the matching account service,
   verify private → public → private, HTML/CSS and OG image. Only then update
   marketing rewrites and the production asset prefix together, if that
   destination is selected. No production data or resources are overwritten.

## Success criteria

- Stable and non-opted-in servers neither report usage nor allow profile RPCs;
  their UI does not offer account profile editing/onboarding.
- Opted-in Beta/development servers reuse the existing account/profile flow.
- New profiles remain private; publishing and hiding changes subsequent page
  and preview requests. External social crawlers can retain their own copies.
- Worker build/dry run pass; deployment ownership, API URL and live route tests
  are recorded before claiming the public service is operational.

## Dependencies, delivery and rollback

The Synara account (`9f9caeb268766deda99bc580c775d50c`) now hosts
`synara-account-api-trial` and `synara-profiles-trial` on workers.dev.
The API runs in Cloudflare Containers; PostgreSQL remains in the existing
Supabase Synara project (`ubdkfrnaqfbdymgipddq`) alongside unchanged advertising
tables. WorkOS Staging provides identity. Railway is excluded.

The bootstrap, dedicated database role, verified TLS connection, runtime
secrets, API startup and hosted synthetic privacy lifecycle have passed.
WorkOS real login and app-driven publication/usage sync remain acceptance
steps. The final marketing destination and avatar storage are not configured.
Deployment versions and detailed evidence are in [READINESS.md](READINESS.md).

Keep this as a reviewable profiles change on the existing development branch;
do not merge, release or silently enable production. For rollback, remove the
server opt-in and restart: saved profile/usage data remains intact. Roll back
the Worker to its previous version and restore marketing rewrites together
with their asset prefix if those are later changed. Do not delete buckets,
profiles, credentials or migrations as part of rollback.

## Status

- [x] Baseline and lifecycle traced; private-by-default API confirmed.
- [x] Controlled app activation and focused tests.
- [x] Public page privacy and isolated deployment recipe.
- [x] Local verification with recorded evidence.
- [x] Authenticated Cloudflare resource inventory.
- [x] Account API deployment and verified Supabase connection.
- [x] Trial Worker deployment with the verified API origin.
- [x] Hosted synthetic private/public/private lifecycle and fixture cleanup.
- [ ] Real login, app-driven lifecycle and selected final routing.

Detailed before/after and verification evidence: [READINESS.md](READINESS.md).
