# Public profiles qualification — 2026-09-29

The operator has selected the personal Cloudflare account, now renamed
**Synara Orgs**, as the destination for these services and Beta diagnostics.
See [the account migration plan](ACCOUNT-MIGRATION.md). The deployments below
now serve API, profiles, avatars and diagnostics from Synara Orgs. Old API
requests are forwarded there, and old profile links redirect to the new origin.

## Before and after

| Area                 | Baseline                                                            | Current behavior                                                                                                      |
| -------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Account profile flow | Disabled in UI and server                                           | Dylan's existing flow enabled only on opted-in non-Stable servers; authoritative server capability gates mutations    |
| Usage reporting      | Inert                                                               | Existing reporter starts only with `SYNARA_ACCOUNT_PROFILE_SYNC=1`, including its existing aggregate-history backfill |
| Publication          | API default private; onboarding claimed public                      | Private default retained and explained; owner explicitly publishes                                                    |
| Public reads         | 15-second stale cache                                               | Fresh publication check for every request; no persistent profile cache                                                |
| Social preview       | Shared image caching                                                | `private, no-store`, absolute trial origin, generic card after revocation                                             |
| Hosting              | Historical Dylan configuration, no services in the selected account | Separate API Container and OpenNext profiles Worker deployed in Synara Orgs                                           |
| Database             | Existing sponsor project                                            | 15 RLS-enabled account tables and dedicated account role alongside unchanged sponsor tables                           |
| Marketing routing    | Former Vercel destination                                           | Unchanged; live qualification uses workers.dev                                                                        |

The existing editor, onboarding, identity provider, reporter and API are reused.
No new profile UI or parallel authentication system was introduced.

## Live deployment

Cloudflare account Synara Orgs: `56e5b3e566be2fc8ade9b7d0eadf5e35`.

| Service     | Origin                                                   | Deployed version                       |
| ----------- | -------------------------------------------------------- | -------------------------------------- |
| Account API | https://synara-account-api-trial.synara-orgs.workers.dev | `d6b248d5-b0aa-42da-9b3d-3d3ebd95f428` |
| Profiles    | https://synara-profiles-trial.synara-orgs.workers.dev    | `dd981474-7d2c-4145-a71c-60923ad64fe4` |

Both workers.dev routes are enabled; preview URLs are disabled and read back
from Cloudflare. The profiles Worker has the full OpenNext code and assets,
its self-service binding, the real API origin and the shared proxy secret.
The checked-in trial config retains its fail-closed `account-api.invalid`
placeholder; this deployment supplied the verified origin explicitly.

The API uses one `basic` Container with a 30-minute idle timeout. Cloudflare
application ID: `a03cd1e4-61b9-4923-aeed-4dca7a1d6ccc`. Deployed amd64 image:
`sha256:cc29bdc4ac33d31dc64b5f093d13b6a1de0f8e9fb6775d8fda5ea3fdffe079d4`.
Real Cloudflare startup completed and health returned 200. `/api/v1/instance`
reports `authMode: workos`; unauthenticated `/api/v1/me` returns 401.

The original Dockerfile built and ran on native Linux arm64 against disposable
PostgreSQL 17. Local amd64 QEMU execution crashed in Bun, so the published image
used a temporary native dependency stage targeting Linux x64, then the same
amd64 runtime. Its actual Cloudflare execution is now verified. This operator
workaround did not change repository dependency versions or disable TLS.
The GitHub workflow has not run, and no commit, push or merge is claimed.

## Database and credentials

The existing Supabase Synara project (`ubdkfrnaqfbdymgipddq`) contains all 16
API migrations and their original Drizzle hashes. The bootstrap preserved the
nine advertising tables' schema, grants and policies (catalog fingerprint
`b24284f605b060db3f8cb9d3dd7a4e7c`). Account tables have default-deny RLS and
no access for Data API roles; the sponsor Data API stays enabled.

After explicit operator approval, `synara_account_api_database_role` created
a dedicated LOGIN role owning the 15 account tables and Drizzle schema/journal.
It has database CONNECT/CREATE and public-schema USAGE/CREATE for migrations,
but no superuser, role creation, database creation, replication or RLS-bypass
attributes. All nine sponsor tables deny it SELECT/INSERT/UPDATE/DELETE.
The existing shared PostgreSQL password was not reset.

The API connects through the session pooler on port 5432 using `verify-full`
and the public Supabase Root 2021 CA bundled in the image. The client TLS socket
verified both chain and hostname. Live migration replay was a no-op with 16
journal entries. The certificate is public trust material, not a private key.

Cloudflare secret-name/type inspection confirms API bindings `DATABASE_URL`,
`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `API_SIGNING_KEY` and
`PROFILE_PROXY_SECRET`; the profiles Worker has only the shared proxy secret.
No secret values are included in these documents or passed to the browser build.
Scans of modified repository files and public browser assets found no task
secret literals, WorkOS secret keys or private-key blocks. This is scoped
verification, not a claim about all historical repository commits.

WorkOS Synara's Project / Staging has Magic Auth enabled, credentials installed,
and loopback redirects `http://127.0.0.1/callback` (default) and
`http://127.0.0.1:*/callback`. The operator completed a real login and profile onboarding in the isolated
Synara app. The authenticated UI shows the saved profile; live API/page reads
return 404 while it is private. The login method was not independently observed.
Wrangler OAuth is authenticated for both the source and Synara Orgs accounts.

## Live privacy evidence

A synthetic profile containing no personal data was inserted using the dedicated
role, exercised through the actual hosted services, and removed in `finally`:

- Private API and profile page: 404; identity absent from HTML.
- Public API and profile page: 200; synthetic identity present; internal user ID absent from the API payload.
- Public CSS and OG image: 200. HTML and OG responses disallow storage.
- After setting private again: API/page 404, identity absent, OG byte-for-byte
  equal to the initial generic card, still `private, no-store`.
- Unauthenticated owner endpoint: 401. Unknown profile page: 404.
- Cleanup confirmed the exact synthetic fixture was removed.

This verifies hosted database reads, rendering and privacy revocation. It does
not substitute for WorkOS login, saving a profile through the app, usage sync,
session refresh or logout/re-login.

## Local verification

- Final whole-workspace `bun run test`: all 12 tasks passed against fresh isolated
  PostgreSQL (324 API, 4,257 web and 6,758 server tests among the suites).
- Focused final rerun: five ingress Worker tests and four profile-fetch tests passed.
- Formatting passed; lint: zero errors and 792 existing warnings; typecheck:
  13/13 tasks passed. Both deployment workflows passed Actionlint.
- Next Webpack standalone build, OpenNext bundle and actual uploads passed.
  The Webpack path is the verified path; no successful Turbopack claim is made.
- Earlier test failures from reused database fixtures and concurrent migration
  initialization were resolved using a fresh, pre-migrated disposable database.
  No automated destructive suite was pointed at Supabase.

## Remaining acceptance

Real login, profile creation and publication from the app are verified; the
operator confirmed the public page and the public API returns 200. Complete
aggregate usage sync, avatar replacement/removal and logout/re-login using the
isolated test home in [SETUP-IT.md](SETUP-IT.md). The marketing domain and remote
tunnel credentials/entitlement enrollment are not configured.
The profiles trial does not make remote access operational. Stable stays gated.

## Initial avatar storage configuration — 2026-09-29

This section records the original deployment; the migration evidence below
supersedes its account and storage URL.

Created the dedicated Standard R2 bucket `synara-profile-avatars-trial` in the
Synara account (default jurisdiction, Eastern Europe location). After explicit
operator approval, enabled its trial public URL:
`https://pub-d8104f3d8e5542bcaea593e6f1966a5c.r2.dev`. The existing backup and
diagnostics buckets were not changed. R2 MCP access returned authentication
error 10000; configuration was completed through the authenticated dashboard.

An account-owned token has Object Read & Write access to only this bucket,
with no administrative bucket permissions. Its S3 credentials and the other
three settings were saved together as encrypted API Worker secrets:
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_BUCKET`,
`S3_PUBLIC_BASE_URL`. Region defaults to `auto`. No credential values were
written into the checkout, container image or browser bundle.

The API Container needed a restart to load the new settings; updating Worker
secrets alone did not replace the running API process. Rollout
`342d37f0-50e4-4db6-a866-b0dae8219671` reached container application version 2
with the same verified image. An authenticated empty avatar request changed
from storage-not-configured 503 to expected empty-image validation 400, without
modifying the user's avatar. The operator then successfully uploaded an image through Synara. The public
profile API returned its URL on the configured R2 host; the image returned
HTTP 200, `image/webp`, 3,884 bytes. Browser verification showed the new avatar
on the public profile. Replacement and removal are not yet live-qualified.

Avatars are public objects reachable by their direct URL, including when a
profile is later hidden; existing immutable object caching can retain copies.
The operator explicitly approved this behavior. Use this bucket only for
avatars. The r2.dev endpoint is for the trial, not the final production domain.

## Synara Orgs migration verification — 2026-09-29

API traffic cut over at 02:14 CEST, followed by the profile redirect. The same
Supabase database and WorkOS project are used. The existing signed-in session
returned 200 from both API origins before cutover. The new Container rollout
`d36e182a-6b35-4774-bcad-137a2e81ae31` completed on application version 2.

The destination avatar bucket uses
`https://pub-bd3c9d90310d42a0a7133fd8b9b56af1.r2.dev`. The operator explicitly
approved creating its account-owned, single-bucket Object Read & Write token.
Its five S3 settings are encrypted Worker secrets; private recovery copies are
outside Git. A brief source API pause allowed a final copy of the one avatar
(3,884 bytes), with equal SHA-256, HTTP and custom metadata. The actual API
storage adapter authenticated an S3 PUT of those identical bytes successfully;
this checks storage writes without changing the user's picture. A new upload
through the application's UI has not been repeated after this migration.

The new public page and Open Graph image return 200 and `no-store`. Their avatar
and social-preview URLs use the destination hosts. Unknown handles return 404;
unauthenticated owner API reads return 401. The old profile URL returns 308 to
the new origin, including path and query. Chrome followed that redirect and
rendered the existing profile and avatar. The prior private/public/revocation
exercise above was on the original deployment and was not repeated here.

The legacy API bridge streams bodies and preserves authentication. It uses a
shared migration secret to authenticate the original client IP for rate limits;
untrusted relay headers are discarded. It never follows upstream redirects.
Both old and new API URLs return the same destination avatar URL. Deployment
configs and GitHub workflow account IDs now target Synara Orgs. Explicit
`wrangler.legacy.jsonc` configs retain the old compatibility endpoints.

GitHub currently has no Cloudflare or account-API deployment secrets in this
repository. The live migration used Wrangler; CI deployment is not configured
or verified. No Synara release, commit, push or merge was performed for this
migration. Usage totals still read zero; diagnostics history is separate and
remains behind its private dashboard.

The operator subsequently selected the available `synara-orgs.workers.dev`
subdomain (`synara.workers.dev` was occupied). Final origins above use this
branded suffix. Account renaming invalidates the intermediate personal-label
Workers URLs; the original source-account compatibility URLs remain valid.
The second Container rollout `22a86b13-c53c-4eec-bb69-f51c73109a25` completed.
All four Workers passed live HTTPS checks after certificate propagation;
profile HTML, avatar and social preview are verified on the final hosts.
The source and destination deployment metadata is saved in the private backup.

After the final rollout, the existing authenticated session returned 200 from
`https://synara-account-api-trial.synara-orgs.workers.dev/api/v1/me`, preserving
the handle and destination avatar URL. Browser verification on the final origins
showed the profile with its photo and an authenticated diagnostics dashboard
with the migrated history (79 installs and 12 issues; live totals can change).
Both tabs were left open for the operator. HTTPS certificate validation was
kept enabled throughout the subdomain propagation window.

## October 8 — Editable profiles and an independent accent

- The desktop editor reuses the existing photo/source, social links and theme color picker. Name, handle, initials color, visibility and the new profile accent save through the account API. The iPhone/iPad profile page now opens a native editor using the same API, with PhotosPicker, ColorPicker and HEX inputs. Public profiles retain Open profile online and Share profile; private profiles remain private until the owner changes visibility.
- `accentColor` is optional/nullable. A custom HEX takes priority over `themeAccent` on the public page and share cards. `null` restores automatic theme colors; omission preserves a stored choice, including writes from older clients. Desktop background theme sync leaves custom colors alone.
- Handle renames send `previousHandle`; the API compares it against the current handle and the upsert condition prevents stale writes. The existing unique index rejects occupied handles with `409 handle_taken`. Changing a handle changes its public URL; the old URL returns 404 and the old handle becomes claimable. No redirect aliases were introduced.
- Additive migration `0020_profile_accent_color.sql` adds `profiles.accent_color` with `IF NOT EXISTS`. API startup applies the migration. No sponsor tables, credentials, RLS policies or usage counters are changed by this migration.
- Deployed in Synara Orgs: API Worker `b63854c4-ae5d-4ea5-91d7-b6d58fce84a3` (Container image `152ba61832da4c3560df46a1668a7b6408da9491417c50fdc7112ec815a3a973`); profiles Worker `34b4de16-aac0-4aa9-a3d8-53c8770f9475`. Live public API returns 200 and includes `accentColor`; the branded profile route remains available.
- A concurrent rename to the same new handle now checks the upsert's `RETURNING` result. A rejected compare-and-set cannot report success or schedule avatar cleanup, even when the winner chose the same handle. A deterministic PostgreSQL row-lock regression reproduces the previous false-success response.
- Focused verification: 344 API tests against disposable PostgreSQL; 22 profiles tests; 27 web unit tests; 9 theme-sync browser tests; workspace typecheck, lint, formatting and migration lineage checks. The new API regressions fail on the previous implementation. Native verification is recorded in the mobile handoff. The broad workspace suite passed 10 of 11 packages; one unrelated ProviderCommandReactor restart-recovery test failed, then passed in a targeted rerun. The full suite was not rerun after that targeted pass.
