# Release Checklist

This document covers build-only native validation and publishing desktop releases from one tag.

## What the workflow does

- Triggers:
  - Manual dispatch defaults to build-only validation and uploads workflow artifacts without publishing anything.
  - A pushed tag matching `v*.*.*` publishes after successful builds.
  - Manual publication requires the explicit `publish_release=true` input.
- Runs quality gates first: lint, typecheck, test. Narrow `native`, `icon`, and
  `js` validation stages cannot publish and omit these full-suite gates.
- Builds portable JavaScript once, verifies its source/lockfile/settings and
  output checksums on each consumer, and stages native dependencies per platform.
- Builds four artifacts in parallel:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one versioned GitHub Release with all produced files.
  - Versions with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - A `beta` prerelease identifier (`vX.Y.Z-beta.N`) selects the beta lane: the desktop artifact builds with `--flavor beta`, updater manifests publish under the `beta` channel, and the release never becomes Latest, never bumps `main` versions, and never touches the npm `latest` dist-tag. See [Beta channel](beta.md).
  - Stable clean-lane releases are GitHub Latest; the 0.4.x compatibility release remains historical.
- Publishes default `latest*.yml` metadata plus byte-identical `synara*.yml` aliases on every stable release so existing packaged binaries keep working.
- Keeps the historical 0.4.x compatibility release unchanged; current stable payloads stay on their own GitHub Latest release.
- Publishes prerelease installers only on their versioned GitHub prerelease; prereleases never replace the stable `synara` update manifests.
- Publishes the CLI package (`apps/server`, npm package `@synara/cli`) with OIDC trusted publishing.
- Published macOS artifacts must be signed. Windows publication currently uses
  an explicit version-scoped unsigned exception; otherwise Azure signing is
  required. Build-only runs may produce unsigned artifacts when signing secrets
  are unavailable.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Background checks run on startup delay + interval.
  - New updates are prepared/downloaded in the background after detection; install/restart stays manual.
  - The desktop UI shows a rocket update button while preparing and switches to an install action once the update is ready.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository visibility: public. The authenticated private-repository provider does not honor custom channel filenames.
- Runtime channel: `synara` for stable builds, `beta` for beta builds (resolved by `desktopUpdateChannel` in `packages/shared/src/desktopIdentity.ts`). Stable clean-lane releases publish both `latest` and `synara` metadata; beta releases publish `beta` channel aliases of the same default `latest` manifests, and beta builds run with `allowPrerelease=true` so they follow their own prerelease feed.
- Repository slug source:
  - `SYNARA_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required Synara release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - `synara-mac.yml`, `synara.yml`, and `synara-linux.yml` metadata
  - every stable release includes both `synara-mac.yml`, `synara.yml`, `synara-linux.yml` and `latest-mac.yml`, `latest.yml`, `latest-linux.yml`
  - `*.blockmap` files, except the macOS update `.zip.blockmap` removed after zip repack
- Enforced upgrade path:
  - Stable clean Synara releases are created with `make_latest=true` and carry both six-manifest filenames in the versioned release.
  - The historical 0.4.x compatibility release remains available for predecessor migration and is never overwritten by a clean-lane release.
  - Clean releases do not mirror payloads onto the historical compatibility release, so the 0.4.x line remains immutable.
  - Clean-release publication fails closed if either the default Latest manifests or the dedicated `synara` aliases are missing.
- Production desktop builds omit web/server/desktop source maps by default to keep update payloads small. Set `SYNARA_WEB_SOURCEMAP=1`, `SYNARA_SERVER_SOURCEMAP=1`, or `SYNARA_DESKTOP_SOURCEMAP=1` only for a diagnostic release that needs them.
- macOS metadata note:
  - Installed macOS apps persist alternate icon choices using `NSWorkspace` custom-icon metadata, and reapply the saved choice on launch after an update. Default removes the override so the bundled icon follows system appearance. This requires a writable app bundle; development Electron bundles are not customized.
  - Custom icons leave signed `Contents` unchanged, but add Finder metadata that `codesign --verify --strict` rejects on a customized installation. Validate pristine distribution artifacts with the strict checks below. A local notarized app copy retained normal signature verification and Gatekeeper acceptance after customization; signed release/update testing must still cover this path.
  - The build initially emits `latest-mac.yml` for both Intel and Apple Silicon.
  - The workflow merges the per-arch macOS metadata, then keeps the merged manifest as `latest-mac.yml` and copies it to `synara-mac.yml` for stable releases.
  - The desktop build script repacks the macOS update `.zip` with `ditto`, verifies Electron framework symlinks, extracts the zip, validates the extracted app signature, patches the matching `latest-mac*.yml` hash/size, and removes the stale `.zip.blockmap`.
  - macOS updater downloads intentionally use the full zip payload so Squirrel.Mac installs the exact signed archive validated by release build.
- Local smoke test:
  - Run `bun run release:smoke:mac-update -- --skip-build --build-version 0.1.5` on macOS after local desktop/server/web dist files exist.
  - The smoke builds a mock update artifact, validates manifest hash/size, serves a HEAD-only local endpoint, confirms the manifest and zip are addressable without downloading the zip body, then cleans up its temp output.
  - Boolean env flags for release scripts accept `true/false`, `1/0`, `yes/no`, and `on/off`; CLI flags are still preferred for repeatable local commands.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow publishes the CLI with `bun publish` from `apps/server` after bumping
the package version to the release tag version.

Checklist:

1. Confirm the npm account controls the `@synara` scope and can publish `@synara/cli`.
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - set `apps/server/package.json` version to `X.Y.Z`
   - build web + server
   - run `bun publish --access public`

## Synara notes

- Every stable versioned release must include both the default `latest` updater metadata and the dedicated `synara` aliases alongside its installers.
- The published release title should read `Synara vX.Y.Z`.
- By default, the first-party desktop release path does not require CLI publish or post-release version-bump automation.
- Optional jobs stay disabled unless repository variables enable them:
  - `SYNARA_PUBLISH_CLI=1`
  - `SYNARA_FINALIZE_RELEASE=1`

## 1) Build-only native CI validation

Use this before publication to validate the real native macOS, Linux, and Windows build matrix. Build-only mode produces workflow artifacts and local updater metadata without creating a tag, GitHub Release, npm publication, or version-bump commit, or changing public updater feeds.

1. Push the release-candidate branch so GitHub Actions can check it out.
2. Start the workflow in build-only mode:
   - `gh workflow run release.yml --ref BRANCH -f version=X.Y.Z -f publish_release=false`
3. Wait for `.github/workflows/release.yml` to finish.
4. Confirm preflight and all four native matrix builds pass.
5. Download the workflow artifacts and sanity-check installation on each OS.

To publish from a manual dispatch instead of a tag push, pass `publish_release=true`. This is intentionally opt-in.

For one-platform qualification, add `-f platform=mac-arm64`, `mac-x64`,
`linux-x64`, or `win-x64`. `-f stage=artifact` (the default) still runs quality
gates, packaging, provenance checks, and isolated startup smoke for that platform.
For a narrower diagnosis:

```bash
gh workflow run release.yml --ref BRANCH -f version=X.Y.Z -f publish_release=false -f platform=linux-x64 -f stage=native
gh workflow run release.yml --ref BRANCH -f version=X.Y.Z -f publish_release=false -f platform=mac-arm64 -f stage=icon
gh workflow run release.yml --ref BRANCH -f version=X.Y.Z -f publish_release=false -f stage=js
gh workflow run release.yml --ref BRANCH -f version=X.Y.Z -f publish_release=false -f stage=preflight
```

`stage=preflight` runs only the quality gates (lint, typecheck and every test
package, with the server suite in three shards) on Ubuntu runners. Use it to
measure or debug the gates without native builds, packaging or publication.

For a paired cold Cua build comparison, add `-f cua_benchmark_baseline=FULL_COMMIT`
to a single-Mac `stage=native` invocation. The baseline must use the same Cua
source/version/native revision/compiler. This experiment bypasses artifact caches,
builds baseline then candidate on the same runner with separate empty Cargo/target
directories, and uploads Cargo timing reports, native linkage and isolated daemon
probe results. It checks that only the baseline emits the unused SDK dynamic
library. No app packaging or publication runs; the native job is capped at 25 minutes.
Validate both archived inputs locally before considering a CI dispatch:

```bash
node scripts/benchmark-cua-build.ts FULL_COMMIT /tmp/cua-benchmark-inputs --prepare-only
```

This preparation check includes the license, patch checksum and instrumentation
for both snapshots and performs no native compilation or network operation.
The [first paired attempt](release-build-optimization.md#sdk-only-follow-up-attempt)
failed before reaching the candidate and does not establish an SDK build speedup.

`native` verifies the pinned Cua artifact/source path only; `icon` compiles the
macOS catalog only; `js` builds and records portable outputs only. These stages
do not qualify an installer or provider runtime. Publication rejects any scope
other than `platform=all, stage=artifact` and still requires every desktop gate.
Server tarball preparation runs alongside desktop jobs; publication waits for both.

### Release build caches and measurements

See [build optimization evidence](release-build-optimization.md) for the measured
baseline, signed Intel CI comparison, local measurements, remaining validation,
and timing interpretation.

`.github/workflows/cua-release-cache.yml` builds a credential-free Cua cache on
relevant changes to `main`, with a default-branch guard. To warm an evicted cache
or validate a runner-image update, dispatch it on the default branch:

```bash
gh workflow run cua-release-cache.yml --ref main
```

Release tags restore only exact keys. GitHub scopes caches by ref: a cache made
on one release tag cannot seed the next tag, whereas the default-branch cache is
visible to release jobs. PR workflows do not populate this cache. Keys cover the
pinned release manifest, all patches, provisioning/validation/cache logic, actual
Rust/compiler/OS/architecture/Xcode/SDK identity, Linux development packages, and
build flags. Arbitrary compiler overrides/wrappers are rejected. Signing keys,
certificates, signed release bundles and user state are never cached.

Each restore checks the build key, existing executable provenance/checksum and
Mach-O/ELF identity, plus all Linux sidecar checksums. Non-exact matches are
discarded before a source build. A corrupt exact hit fails instead of silently
substituting a different binary. Delete that cache entry in GitHub Actions and
rerun the producer, or intentionally bump the `cua-v1` key schema when invalidating
the whole cache. Never edit provenance to make a hit pass. Packaging re-signs a
separate staged copy, preserving cached bytes.

Portable outputs are same-run artifacts, never cross-release caches. Import
rejects archive links and unexpected paths before extraction into an isolated
directory, verifies the complete file inventory, source, lockfile and build
settings, then copies only the two allowed output roots. Frozen production
installs, dependency patches and native ABI checks still run on each platform.

The Intel Mac job no longer retries the whole artifact command. Diagnose the
failed stage and rerun only its platform. With `--keep-stage` (used by CI), the
logged stage directory retains Apple submission IDs and exact payload hashes
for same-run recovery; it is not uploaded or persisted across runners. A failed
wait does not cancel Apple's processing. With the same credentials in the
environment, resume finalization without re-signing the app:

```bash
node scripts/notarize-mac-app.ts /PATH/TO/STAGE/app/dist/mac-arm64/Synara.app
node scripts/finalize-mac-dmg.ts /PATH/TO/STAGE/app/dist
```

The first command is for an interrupted app notarization stage; DMG finalization
requires an already-created signed DMG. Changed payloads reject saved state;
remove only the matching stale `.app-notary-*` or `.notary-state` entry before
submitting changed bytes. Recovery checks Apple's status and retains signature,
stapling, Gatekeeper and final update-ZIP validation. Startup smoke and release
provenance checks must still pass before publication.

### macOS release toolchains

Both native macOS release runners use macOS 15. Native helpers and the pinned
Cua apple-metal bridge build with Xcode 16.4's macOS 15 SDK. A separate macOS 26
job compiles the architecture-independent Icon Composer catalog with Xcode 26.3
from the same release checkout and passes it through a required workflow artifact.
`SYNARA_MAC_ICON_CATALOG` points packaging at that catalog; a missing file fails
the build. This avoids Apple's AssetRuntime framework crash on macOS 15 without
changing the native SDK. Local builds without that variable compile icons with
the selected Xcode on the local host.

An older `actool` can exit successfully without creating `Assets.car`; that is a
packaging failure, not permission to silently omit the Liquid Glass icon.

### Linux native build dependencies

The release job installs the Cua driver's OpenSSL, X11, XCB, xkbcommon and
Wayland development libraries before provisioning. This matches the build
prerequisites in `cua-linux-check.yml`; it does not qualify Linux Computer Use
as a supported 0.9.0 feature.

### Local DMG appearance validation

On an Apple Silicon Mac, build the DMG and macOS update ZIP in `release/` with:

```bash
SYNARA_DESKTOP_UPDATE_REPOSITORY=Emanuele-web04/synara bun run dist:desktop:dmg:arm64
```

Use `dist:desktop:dmg:x64` on Intel. The updater repository setting is needed for
ZIP manifest finalization outside GitHub Actions. The build passes
`--publish never` to electron-builder and defaults to unsigned; release signing,
notarization, and updater settings remain controlled by the existing release flow.

The Dmgly layout lives in `scripts/lib/desktop-platform-build-config.ts` and uses
`apps/desktop/resources/dmgly/assets/dmg-background.png`. The packaging script
copies this resources directory into its staging app, keeping the background path
valid there. `scripts/lib/desktop-runtime-resources.ts` excludes the `dmgly`
directory from the runtime resource copy on every platform, so installer artwork
and the reference icon stay out of the installed app and update ZIP. The supplied
642×406 PNG is a 1× background with its text and arrow
already baked in. Do not add duplicate text or arrows. It has no baked label
backgrounds. The exported `app-icon.png` is retained alongside it as a reference;
the app continues to use the existing production ICNS generation pipeline.

Mount the resulting DMG in Finder and check the 642×406 window, 128px icons,
and icon centers at (172, 135) for `Synara.app` and (514, 241) for `Applications`.
Verify both real filename labels remain readable and unclipped. Finder renders
the app icon and Applications link, so their appearance can differ from Dmgly's
preview; Retina displays also scale the supplied 1× background. Local Finder
preferences can override the DMG's saved hidden path/status bars, reducing the
visible background and requiring scrolling to reveal the Applications label.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create `Developer ID Application` certificate.
3. Export certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. In App Store Connect, create an API key (Team key).
7. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
   - `APPLE_TEAM_ID`: Developer Team ID embedded in the signed application
8. Re-run a tag release and confirm macOS artifacts are signed/notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 3) Azure Trusted Signing setup (Windows)

The current Windows release policy publishes x64 installers unsigned under an
explicit version-scoped exception. Before pushing the release tag, set the
repository Actions variable `SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE` to the exact
version without the `v` prefix (for example, `0.8.4`). The workflow checks equality
with the resolved release version before packaging; do not use a permanent broad
opt-out. Packaging, source provenance, startup smoke, and artifact upload must
still pass. Missing Azure credentials are expected for this unsigned path.

Without the matching exception, published Windows installers must be signed with
Azure Trusted Signing, and the workflow fails closed when a required signing
value is absent. A requested signed release requires all of the following secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`
- `AZURE_TRUSTED_SIGNING_SUBJECT_DN`

Signing checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
   - Full certificate subject distinguished name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a build-only workflow and confirm the Windows installer is signed.

For a signed release, run a build-only workflow and verify the generated
installer's Authenticode identity matches both the configured publisher name and
full subject distinguished name.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Run the build-only native CI validation for the release-candidate branch and version.
3. Bump app version as needed.
4. Run `node scripts/resolve-release-update-policy.ts X.Y.Z` and confirm it reports the expected lane, `make_latest`, and `mirror_to_stable_channel` values before creating the tag.
5. Create release tag: `vX.Y.Z`.
6. Push tag.
7. Verify workflow steps:
   - preflight, quality gates and all three server test shards pass
   - all matrix builds pass
   - release job uploads expected files
8. For a stable clean-lane release, confirm the new versioned release is GitHub Latest, contains all three default `latest` manifests plus all three `synara` aliases, and left the historical compatibility release unchanged.
9. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets are populated and non-empty.
- Published Windows build rejected before packaging:
  - For the unsigned release policy, check that `SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE` matches the exact version without `v`.
  - For a signed release, check all eight Azure ATS, identity, and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Re-check certificate/profile names and tenant/client credentials.
