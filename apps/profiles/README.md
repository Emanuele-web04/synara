# @synara/profiles

Public profile pages at `/@handle`, rendered by Next.js on Cloudflare Workers
through OpenNext. The existing account API owns identities, handles, avatars,
visibility and usage. This app reads `GET /api/v1/profiles/:handle`; it has no
separate database or authentication system.

## Application activation

The account profile flow is a controlled Beta/development trial. Start the
Synara server with `SYNARA_ACCOUNT_PROFILE_SYNC=1` to enable it. Stable rejects
it even when this variable is set. Without it, the local profile remains
available and account profile RPCs and usage reporting stay disabled. The web
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

| Variable                 | Purpose                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ACCOUNT_API_URL`        | Verified account API origin. The historical deployment defaults to `https://api.synara.vrbty.dev`; the isolated trial deliberately uses a non-routable placeholder until configured. |
| `PROFILES_PUBLIC_ORIGIN` | Public origin used for absolute social preview URLs. The trial points to `https://synara-profiles-trial.synara-orgs.workers.dev`; defaults to `https://trysynara.com` elsewhere.     |
| `PROFILE_PROXY_SECRET`   | Optional shared secret matching the account API; allows per-visitor rate limiting. Set as a Worker secret, never in source.                                                          |
| `PROFILES_ASSET_PREFIX`  | Build-time asset prefix only when marketing proxies profile documents, e.g. `https://trysynara.com/profiles-assets`. Leave unset on the standalone trial.                            |
| `MARKETING_ORIGIN`       | Optional origin for non-profile routes in the historical single-domain deployment. Unset on the trial.                                                                               |

## Local development and verification

```sh
bun run --cwd apps/profiles dev
bun run --cwd apps/profiles test
bun run --cwd apps/profiles typecheck
```

Point `ACCOUNT_API_URL` at an isolated local API. From `apps/profiles`, build
and dry-run the trial without publishing:

```sh
bunx opennextjs-cloudflare build --config wrangler.trial.jsonc
bunx wrangler deploy --config wrangler.trial.jsonc --dry-run
```

If this machine cannot run Turbopack's local build process, the supported
Webpack build can be packaged separately:

```sh
NEXT_PRIVATE_STANDALONE=true bunx next build --webpack
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
bunx opennextjs-cloudflare build --config wrangler.trial.jsonc
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

## Final marketing routing

The marketing Vercel configuration currently points to the former profiles
Vercel origin; it has **not** yet been switched to the new Worker. After the
actual Worker passes live checks, change all three rewrite destinations:

- `/@:handle` → the Worker's `/@:handle`.
- `/@:handle/:path*` → the Worker's `/@:handle/:path*` (including OG images).
- `/profiles-assets/:path*` → the Worker's `/:path*`.

Build the Worker with the corresponding `PROFILES_ASSET_PREFIX` at the same
time. Verify document HTML, CSS/JS, OG images, unknown/private profiles and a
public → private transition at both the Worker and final marketing origins.
Never point routing at an unverified URL. Trial links can be tested directly;
set `VITE_PROFILES_PUBLIC_ORIGIN` to the trial origin when building/running the
web app so its open/copy/share links use that Worker too. The default remains
`trysynara.com` for ordinary builds.

See the [implementation plan](../../docs/implementation/cloudflare-profiles/PLAN.md)
for evidence, remaining dependencies and rollback.
