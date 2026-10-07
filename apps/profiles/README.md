# @synara/profiles

Public profile pages at `/@handle`, rendered by Next.js on Cloudflare Workers
through OpenNext. The existing account API owns identities, handles, avatars,
visibility and usage. This app reads `GET /api/v1/profiles/:handle`; it has no
separate database or authentication system.

## Application activation

The account profile flow is a controlled Beta/development trial. Start the
Synara server with `SYNARA_ACCOUNT_PROFILE_SYNC=1` to enable it. Stable rejects
it even when this variable is set. Without it, the local profile remains
available and account profile RPCs and usage reporting stay disabled. Signed-in
Settings and the sidebar still display the same account identity; editing is
disabled rather than silently saving a photo to the signed-out local profile. The web
UI reads the server's `accountProfileSync` capability; old servers default off.

Opting in starts the existing reporter for signed-in accounts, including the
initial backfill of historical aggregate usage to the account service recorded
at sign-in. Use an isolated Synara home and a test account for qualification.
This is separate from making a profile public: new profiles are private, and
Edit profile controls publication. No chat text is part of the usage buckets.
Remove the variable and restart to disable the trial without deleting data.

## Privacy and rendering

Unknown and private handles both return 404. Publication state is fetched with
`cache: "no-store"` for each request; an upstream outage is an error, not a
missing profile. Social preview responses also use `private, no-store`.
External social services may retain previews they fetched while a profile was
public. The app does not need persistent R2/DO caching for this read path.

## Configuration

| Variable                 | Purpose                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_API_URL`        | Verified account API origin. The historical deployment defaults to `https://api.synara.vrbty.dev`; the isolated trial deliberately uses a non-routable placeholder until configured.                            |
| `PROFILES_PUBLIC_ORIGIN` | Public origin used for absolute social preview URLs. The trial uses `https://trysynara.com`, served through the marketing proxy.                                                                                |
| `PROFILE_PROXY_SECRET`   | Optional shared secret matching the account API; allows per-visitor rate limiting. Set as a Worker secret, never in source.                                                                                     |
| `PROFILES_ASSET_PREFIX`  | Asset prefix for proxied deployments, set at build time for Next.js bundles and at runtime for the favicon. The trial uses `https://www.trysynara.com/profiles-assets`; leave unset for standalone deployments. |
| `MARKETING_ORIGIN`       | Optional origin for non-profile routes in the historical single-domain deployment. Unset on the trial.                                                                                                          |

## Local development and verification

```sh
bun run --cwd apps/profiles dev
bun run --cwd apps/profiles test
bun run --cwd apps/profiles typecheck
```

Point `ACCOUNT_API_URL` at an isolated local API. From `apps/profiles`, build
and dry-run the trial without publishing:

```sh
PROFILES_ASSET_PREFIX=https://www.trysynara.com/profiles-assets bunx opennextjs-cloudflare build --config wrangler.trial.jsonc
bunx wrangler deploy --config wrangler.trial.jsonc --dry-run
```

If this machine cannot run Turbopack's local build process, the supported
Webpack build can be packaged separately:

```sh
PROFILES_ASSET_PREFIX=https://www.trysynara.com/profiles-assets NEXT_PRIVATE_STANDALONE=true bunx next build --webpack
bunx opennextjs-cloudflare build --skipNextBuild --config wrangler.trial.jsonc
```

## Trial deployment

`wrangler.trial.jsonc` names a separate `synara-profiles-trial` Worker with
`workers_dev` enabled, no custom-domain route and no dependency on Dylan's
R2 bucket. First authenticate, verify the selected account, check whether that
Worker already exists, and replace the `ACCOUNT_API_URL` placeholder with the
matching account service. Then, from `apps/profiles`:

```sh
bunx wrangler whoami
bunx wrangler secret put PROFILE_PROXY_SECRET --config wrangler.trial.jsonc
PROFILES_ASSET_PREFIX=https://www.trysynara.com/profiles-assets bunx opennextjs-cloudflare build --config wrangler.trial.jsonc
bunx opennextjs-cloudflare deploy --config wrangler.trial.jsonc
```

The secret command is needed only when the matching API uses that secret.
The manual **Deploy Profiles** workflow deploys this same trial configuration;
it requires an explicit HTTPS account API origin plus repository/environment
`CLOUDFLARE_API_TOKEN` and `SYNARA_PROFILE_PROXY_SECRET` secrets. The account ID
is pinned to Synara, and the workflow installs `PROFILE_PROXY_SECRET` from the
same repository secret used by the API workflow. It uses the verified Webpack
build followed by OpenNext packaging. Application release tags do not deploy profiles.

`wrangler.jsonc` retains Dylan's historical `synara-profiles` deployment,
`synara.vrbty.dev` custom domain and cache bindings for reference/compatibility.
The existing `deploy` script still targets that configuration; use it only
when ownership and that destination are confirmed. Do not remove existing
Durable Object migrations or data as part of the trial.

## Public links from the apps

Desktop exposes **View public profile** in the account menu and **Open profile**
in Settings → Profile. They share `publicProfileUrl`, also used by Copy/Share;
`VITE_PROFILES_PUBLIC_ORIGIN` overrides the default `https://trysynara.com`.
Only explicitly public account profiles expose an opening/sharing action.
The account API reserves lowercase handles through its existing PostgreSQL
unique constraint, including concurrent claims and private profiles. A
`409 handle_taken` is shown against the onboarding handle field; a private
profile's public 404 does not mean its handle is available.

## Current branded routing

The 2026-10-08 layout/social-links update is live on Synara Orgs: account API
`32df5e8e-42f7-40de-8a8d-2cf33d9f8146` and profiles
`a96a0193-b61c-4ff3-bfb7-bba8d05b9271`, built from `19d2595`.
Drizzle migration `0019_profile_social_links` adds a nullable JSONB column;
the matching SQL-file hash and journal timestamp are registered once in the
Drizzle ledger. Existing profiles retain their avatar, theme and usage. The
API returns `socialLinks: null` until the owner saves links in an updated app.

The live page includes the left rail, share control, model-share ring,
hourly arc and weekly chart. Verification covered the canonical URL,
heatmap count/date readouts and Escape dismissal, no console errors, and
390px mobile layout without horizontal overflow. Social-link writes were
verified by API integration tests against a disposable Postgres database;
the owner's personal links were not changed for deployment verification.

For subsequent deployments to this same verified destination, retain the
existing proxy secret and explicitly override the trial API placeholder.
From `apps/profiles` after the API and schema are ready:

```sh
PROFILES_ASSET_PREFIX=https://www.trysynara.com/profiles-assets NEXT_PRIVATE_STANDALONE=true bunx next build --webpack
bunx opennextjs-cloudflare build --skipNextBuild --config wrangler.trial.jsonc
bunx wrangler deploy --config wrangler.trial.jsonc --var ACCOUNT_API_URL:https://synara-account-api-trial.synara-orgs.workers.dev
```

The 2026-10-07 profile update is deployed on Synara Orgs: account API version
`55d349a9-48ad-47ea-923e-a5980d07c425` and profiles version
`877cee19-6383-4306-8781-7db26d27a295`. API startup applied Drizzle migration
`0018_profile_theme_accent`; its nullable light/dark columns preserve existing
profiles. A normal desktop profile save and theme changes publish the accent
pair. Older desktop server bundles must be rebuilt to carry the new field.
Profiles without a saved pair retain the avatar-color fallback.

The follow-up profiles version `aea37178-a6df-47d0-b858-9df1d6dca5d6` adds
immediate heatmap tooltips using the shared activity grid and chart tooltip.
Cells expose token counts and dates on pointer entry, tap or keyboard focus;
Escape dismisses the readout. Dates use the charts' English/UTC formatting to
avoid server/browser locale mismatches.

Live verification covered desktop save → public API → light/dark page colors,
same-origin JavaScript assets, and value/date hover readouts for daily tokens,
daily prompts and hourly prompts. The public profile remains opt-in.

As of 2026-10-07, the live marketing project is **dpcode-website** on Vercel,
not this checkout's `apps/marketing`. Two project-level rewrites serve profiles
from Cloudflare without sending the browser to workers.dev:

- **Synara public profile links** (`afea1383-b1c5-4103-9a73-e02827960732`):
  `/@handle` (also URL-encoded `%40`) and its subpaths, including social previews.
  It respects the origin's cache policy; profile HTML and previews remain private/no-store.
- **Synara public profile assets** (`4324d500-9080-4a34-a8cb-654c36b71e31`):
  `/profiles-assets/_next/static/*` and `/profiles-assets/favicon.ico` map to the
  corresponding paths at the Worker root.

Both rules only match `trysynara.com` and `www.trysynara.com`. The website's
existing apex-to-www redirect remains, so the final URL is
`https://www.trysynara.com/@handle`. The root, install page, marketing assets and
other project domains are unaffected. No DNS or security-policy change is needed.

The **Deploy Profiles** workflow sets `PROFILES_ASSET_PREFIX` during the build;
`wrangler.trial.jsonc` carries the same prefix at runtime and the branded public
origin. Keep the build prefix and routing rules aligned. The Worker URL remains
available directly, with its assets loaded through the branded asset path.
`apps/marketing/vercel.json` describes a different deployment and is not the
configuration for this live website.

For a full rollback, first restore **Synara public profile links** to its former
307 redirect and publish in Vercel CDN → Routing Rules. Then restore the previous
Worker version before disabling the asset rewrite; the new Worker needs that
rewrite even when opened directly. The previous Worker version was
`dd981474-7d2c-4145-a71c-60923ad64fe4` (standalone assets, Worker public origin).

Verify profile HTML, every CSS/JS URL, favicon, avatar, social preview, an unknown
handle, the website root and install page after each routing cutover. Confirm the
profile response retains `private, no-store` and the other project domains do not
serve profiles. A public-to-private transition needs a dedicated test profile;
do not change a user's publication setting merely to run a smoke test.

See the [implementation plan](../../docs/implementation/cloudflare-profiles/PLAN.md)
for evidence, remaining dependencies and rollback.
