# Release Checklist

This document covers publishing desktop releases from one tag and targeted
build-only diagnosis. An ordinary release uses one publication run after its
version, release notes and lockfile are final.

## What the workflow does

- Triggers:
  - Manual dispatch defaults to build-only validation and uploads workflow artifacts without publishing anything.
  - A pushed tag matching `v*.*.*` publishes after successful builds.
  - Manual publication requires the explicit `publish_release=true` input.
- Runs lint, typecheck and every test in parallel with native preparation and
  packaging. Packaging starts after exact-source preflight and its portable
  JavaScript, Cua and icon inputs are ready; it does not wait for `quality` or
  `server_tests`. Both GitHub and npm publication depend directly on successful
  `quality`, all `server_tests` shards and native artifact jobs. No tests are
  removed. Narrow `native`, `icon`, and `js` validation stages cannot publish and
  omit these full-suite gates.
- Builds portable JavaScript once, verifies its source/lockfile/settings and
  output checksums on each consumer, and stages native dependencies per platform.
- Builds four platform legs in parallel:
  - macOS `arm64` DMG
  - macOS `x64` DMG, cross-built on the same Apple Silicon runner type as
    `arm64` (the Intel runner took 15-20 minutes for the same work). Every
    Mach-O in the app must carry the `x86_64` slice. A short `qualify_intel`
    job then downloads it and runs the startup smoke on `macos-15-intel`:
    under Rosetta 2 the app took 135 seconds to over 180 seconds to start.
  - Linux `x64` AppImage, `.deb`, and `.rpm` (one electron-builder pass)
  - Windows `x64` NSIS installer
- Each platform calls `release-platform.yml` with one native job that builds,
  signs/notarizes where required, records verified provenance, runs Defender on
  Windows and packaged startup smoke, then uploads the qualified `desktop-*`
  artifact on the same runner. A first successful attempt creates no candidate
  checkpoint and needs no second runner or candidate upload/download.
- If a later step fails after provenance has been validated, the failure handler
  rechecks the candidate's integrity before retaining
  `candidate-desktop-PLATFORM-ARCH` for 30 days. A retry of the same run and SHA
  can restore that verified candidate and skip packaging; see
  [release recovery](#resume-a-failed-release) for the limits.
- Stable macOS DMG names `Synara-${version}-${arch}.dmg` are the proposed Homebrew Cask download contract. Its renderer shares the production macOS artifact identity from `scripts/lib/desktop-artifact-identity.ts`; Beta, Canary and Cua keep their distinct identities and filenames.
- Publishes one versioned GitHub Release with all produced files.
  - Versions with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - A `beta` prerelease identifier (`vX.Y.Z-beta.N`) selects the beta lane: the desktop artifact builds with `--flavor beta`, updater manifests publish under the `beta` channel, and the release never becomes Latest, never bumps `main` versions, and never touches the npm `latest` dist-tag. See [Beta channel](../BETA.md).
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
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - `synara-mac.yml`, `synara.yml`, and `synara-linux.yml` metadata
  - every stable release includes both `synara-mac.yml`, `synara.yml`, `synara-linux.yml` and `latest-mac.yml`, `latest.yml`, `latest-linux.yml`
  - `*.blockmap` files, except the macOS update ZIP, which uses a full-archive payload
- Linux package formats:
  - the AppImage is the only Linux updater payload; `latest-linux.yml` and `synara-linux.yml` describe it
  - `.deb` and `.rpm` are package-manager installs and are never mirrored to the pinned updater feed
  - packaging, provenance and startup use the same strict Linux target declaration
  - provenance requires one nonempty payload per requested format and verifies the sole Linux
    updater manifest against the AppImage's exact version, filename, SHA-512 and size
  - startup checks every requested format from its own temporary payload and user-data tree;
    Debian/RPM metadata, desktop registration and archive paths are checked before launch
- Enforced upgrade path:
  - Stable clean Synara releases are created with `make_latest=true` and carry both six-manifest filenames in the versioned release.
  - The historical 0.4.x compatibility release remains available for predecessor migration and is never overwritten by a clean-lane release.
  - Clean releases do not mirror payloads onto the historical compatibility release, so the 0.4.x line remains immutable.
  - Clean-release publication fails closed if either the default Latest manifests or the dedicated `synara` aliases are missing.
- Production desktop builds omit web/server/desktop source maps by default to keep update payloads small. Set `SYNARA_WEB_SOURCEMAP=1`, `SYNARA_SERVER_SOURCEMAP=1`, or `SYNARA_DESKTOP_SOURCEMAP=1` only for a diagnostic release that needs them.
- macOS metadata note:
  - Installed macOS apps persist alternate icon choices using `NSWorkspace` custom-icon metadata, and reapply the saved choice on launch after an update. Default removes the override so the bundled icon follows system appearance. This requires a writable app bundle; development Electron bundles are not customized.
  - Custom icons leave signed `Contents` unchanged, but add Finder metadata that `codesign --verify --strict` rejects on a customized installation. Validate pristine distribution artifacts with the strict checks below. A local notarized app copy retained normal signature verification and Gatekeeper acceptance after customization; signed release/update testing must still cover this path.
  - The DMG release path asks electron-builder for the DMG only. After notarization,
    the finalizer creates the updater ZIP once with `ditto` and writes its
    `latest-mac.yml` hash/size for each architecture; there is no preliminary ZIP
    or ZIP blockmap to generate and discard.
  - The workflow merges the per-arch macOS metadata, then keeps the merged manifest as `latest-mac.yml` and copies it to `synara-mac.yml` for stable releases.
  - Finalization verifies Electron framework symlinks, extracts the ZIP and
    validates the extracted app signature before accepting the updater artifact.
    Retained older stages with existing metadata are updated to the final ZIP
    bytes, and any stale `.zip.blockmap` is removed.
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
  - `SYNARA_AUTO_BETA=1` — tag the next `vX.Y.(Z+1)-beta.1` on the stable commit after each stable publish (see [BETA.md](../BETA.md)).

## 1) Build-only native CI validation

Use build-only mode when investigating a native failure or qualifying changes to
packaging, signing or the release workflow. It is not a prerequisite for every
release: a full build-only run followed by a tag run builds the installers twice.
The tag run already performs the publication gates. Build-only artifacts are not
automatically promoted into a later tag run.

Build-only mode produces workflow artifacts and local updater metadata without
creating a tag, GitHub Release, npm publication, or version-bump commit, or changing
public updater feeds. Finalize the candidate version and lockfile first, then use
the smallest platform and stage that can answer the diagnostic question.

1. Push the release-candidate branch so GitHub Actions can check it out.
2. Start the workflow in build-only mode:
   - `gh workflow run release.yml --ref BRANCH -f version=X.Y.Z -f publish_release=false`
3. Wait for `.github/workflows/release.yml` to finish.
4. Confirm preflight and all four native matrix builds pass.
5. Download the workflow artifacts and sanity-check installation on each OS.
   Linux must include both `.AppImage` and `.deb`; extraction/startup smoke does
   not replace an actual package-manager install, desktop launch and removal check.

To publish from a manual dispatch instead of a tag push, select the existing
release tag and pass `publish_release=true`. Publishing from a branch is refused.
Use only one publication trigger; do not dispatch again after pushing a tag that
already started the workflow.
The public updater repository lookup runs only when publication is enabled;
build-only validation does not need that GitHub API check.

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
Server tarball preparation starts after exact-source preflight and portable
JavaScript, independently of quality checks and server tests. GitHub publication
still waits for the tarball, every desktop job and both test gates.

### Release build caches and measurements

See [build optimization evidence](release-build-optimization.md) for the measured
baseline, signed Intel CI comparison, local measurements, remaining validation,
and timing interpretation.

`.github/workflows/cua-release-cache.yml` builds a credential-free Cua cache on
relevant changes to `main` and daily, with a default-branch guard. Each successful
producer also retains the verified unsigned directory as a workflow artifact for
30 days, outside the Actions cache quota. Daily preparation detects runner image,
SDK and library drift even when source files are unchanged. To warm new inputs
before a release, dispatch it on the default branch:

```bash
gh workflow run cua-release-cache.yml --ref main
```

Release tags restore only exact keys. GitHub scopes caches by ref: a cache made
on one release tag cannot seed the next tag, whereas the default-branch cache is
visible to release jobs. On an exact cache miss, consumers look for the exact
fingerprint in retained artifacts from a successful run of this producer on the
default branch in the same repository. Forks, PR events, other workflows, expired
artifacts and partial keys cannot supply binaries. Missing/stale artifacts compile
pinned source; unavailable trust metadata and corrupt selected artifacts fail
closed. PR workflows do not populate this cache. Keys cover the
pinned release manifest, all patches, provisioning/validation/cache logic, actual
Rust/compiler/OS/architecture/Xcode/SDK identity, Linux development packages, and
build flags. Arbitrary compiler overrides/wrappers are rejected. Signing keys,
certificates, signed release bundles and user state are never cached.

Each restore checks the build key, existing executable provenance/checksum and
Mach-O/ELF identity, plus all Linux sidecar checksums. Non-exact matches are
discarded before a source build. A corrupt exact hit fails instead of silently
substituting a different binary. Delete that cache entry (and any corrupt retained
artifact with the same key) in GitHub Actions and
rerun the producer, or intentionally bump the `cua-v1` key schema when invalidating
the whole cache. Never edit provenance to make a hit pass. Packaging re-signs a
separate staged copy, preserving cached bytes.

Release native preparation starts after exact-source preflight alongside quality
checks, portable JavaScript and icon compilation. The packaging jobs download
only their platform's prepared artifact from the same run, recompute the build
environment key, and repeat executable/provenance verification. Missing artifacts
or runner drift fail instead of falling back to unrelated binaries. These temporary
handoff artifacts expire after 30 days; signing credentials are passed only to the
packaging step. Once preflight and the required prepared inputs pass, packaging
can run while quality and server tests are still in progress. This can spend
native compute on a candidate whose tests later fail. Both GitHub and npm
publication wait directly for the full quality/server-test gates and successful
native qualification; no tests or release acceptance gates are skipped.

When deploying changes to the cache/provenance logic, run the producer on `main`
after merge and before the next release: the exact fingerprint changes with that
logic, so an unmerged candidate cannot reuse the old producer's artifacts. Native
preparation within its own run still works and can be validated before merge.

Portable outputs are same-run artifacts, never cross-release caches. Import
rejects archive links and unexpected paths before extraction into an isolated
directory, verifies the complete file inventory, source, lockfile and build
settings, then copies only the two allowed output roots. Frozen production
installs, dependency patches and native ABI checks still run on each platform.

The macOS jobs no longer retry the whole artifact command. Diagnose the
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

Mac application bundles declare `LSMinimumSystemVersion` 13.0 through electron-builder's
`mac.minimumSystemVersion`. The bundled Claude and Cua executables require macOS 13;
the application manifest must not advertise Electron's lower deployment target as the
requirement for the complete bundle. This applies to signed, unsigned and local ad-hoc
packages, including DMG and update ZIP payloads.

The [read-only v1.0.1 inspection](https://github.com/Emanuele-web04/synara/actions/runs/38163962883)
found app/Electron metadata at 12.0 and bundled Claude/Cua at 13.0 on both architectures.
The [actual Homebrew audit](https://github.com/Emanuele-web04/synara/actions/runs/38166229495)
rejected a cask requiring 13 because the old app plist still declares 12. This source fix
does not modify signed historical releases. Recheck a newly built and published DMG's
plist and native payload before refreshing the cask; the old audit failure remains
unresolved until a matching release is available. Metadata inspection and macOS 15
startup checks do not establish runtime behavior on macOS 13.

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

### Linux package build dependencies

The `linux-x64` leg additionally builds `.deb` and `.rpm` through electron-builder's
fpm target. It needs `rpmbuild` (the `rpm` package) for the RPM, and `libcrypt.so.1`
for the bundled fpm Ruby. Native startup verification uses `rpm2cpio` and `cpio` to
inspect and extract the RPM without installing it. The workflow installs those tools and `libcrypt1` explicitly so
the build does not depend on what the runner image happens to carry. On a local Arch
or Fedora host the equivalents are `rpm` and `libxcrypt-compat`.

Two package-metadata rules are enforced by the builder itself, not by this repository:
a `.deb`/`.rpm` build fails without a project `homepage` and a maintainer email, which
is why `DESKTOP_PACKAGE_AUTHOR_EMAIL` and `DESKTOP_PACKAGE_HOMEPAGE` exist in
`scripts/build-desktop-artifact.ts`. That email is written into the `.deb` control
file and the RPM maintainer field, so it must stay a real contactable address.

electron-builder treats `deb`/`rpm` as auto-update-capable targets by default. Their
target-level `publish: null` settings alone do not prevent a mixed-target build
from adding package-manager files to `latest-linux.yml`. After packaging,
`scripts/lib/linux-appimage-update-feed.ts` verifies the real AppImage hash,
size, and version, rejects unknown update entries, and retains only the AppImage
in the updater manifest. Release artifact provenance independently verifies that
manifest before publication. Synara's gate in `getAutoUpdateDisabledReason`
additionally requires `process.env.APPIMAGE` on Linux, so package-manager installs
have in-app updates disabled.
Users download a newer Deb/RPM and install it again; these installers do not configure an apt/dnf repository.

Before release, qualify actual installation, launch, upgrade and removal on disposable Debian/Ubuntu
and Fedora systems, including Stable/Beta coexistence. The extraction/startup gate above does not
execute package scripts and cannot replace those checks. Arch/Omarchy windowed verification remains
separate below. Record the exact packages, source and hosts with any outstanding checks.

### Arch / Omarchy release checklist

The AppImage is the supported Arch install. There is no Arch CI, and no attempt is made to emulate
Arch on the Ubuntu runner: these checks are manual, run by the person cutting the release on an
Omarchy/Arch host with the new `Synara-<version>-x86_64.AppImage`.

1. Mount check: `./Synara-<version>-x86_64.AppImage --appimage-mount` prints a `/tmp/.mount_Synara*`
   path. FUSE 2 (`fuse2` package) is the supported setup on Arch/Omarchy.
2. Fallback check when FUSE is unavailable:
   `./Synara-<version>-x86_64.AppImage --appimage-extract-and-run` starts the app.
3. Windowed launch: open the app, create a project, and run one basic flow. A headless Wayland
   session is not a substitute for this step — if no graphical session is available, record the
   release as unverified rather than as passing.
4. Desktop integration: confirm the app appears in the launcher and reports a sane window title under
   the compositor in use (Hyprland on Omarchy).
5. Update path: the AppImage updates itself in-app; do not expect the package managers to own a
   `.deb`/`.rpm` install on Arch.

If a step fails, capture the app log and the `~/.config/Synara` state before reporting it, and see
the user-facing FUSE fallback in `apps/marketing/content/docs/troubleshooting/desktop-and-updates.mdx`.

### Local DMG appearance validation

On an Apple Silicon Mac, build the DMG and macOS update ZIP in `release/` with:

```bash
SYNARA_DESKTOP_UPDATE_REPOSITORY=Emanuele-web04/synara bun run dist:desktop:dmg:arm64
```

`dist:desktop:dmg:x64` builds the Intel app; on Apple Silicon, add the
`x86_64-apple-darwin` Rust target for Cua, and launching it needs Rosetta 2. The updater repository setting is needed for
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

Before startup smoke and artifact upload, the Windows job scans each final
installer with Microsoft Defender. The guard enables protection and removes
the hosted image's exclusions inside that disposable runner, updates security
intelligence, verifies the actual file is not excluded, and requires an explicit
clean scan plus unchanged installer bytes. If the configured update source returns
definitions older than 24 hours, it retries Microsoft's direct MMPC source.
An older local timestamp then requires the installed version to match the latest
version fetched from Microsoft's security intelligence page; unavailable or
ambiguous vendor data fails closed. Missing signatures or Defender's own
out-of-date status also block the scan. Detection, remediation, stale
intelligence, a missing file, or a scan error blocks publication. Scan evidence
is retained as `windows-defender-x64`, including on failure. Cloud participation
and sample-submission settings are not changed. This server scan does not replace
Windows 11 browser-download qualification.

Signing, provenance, and startup smoke alone do not establish Microsoft Defender
acceptance. For a reported antivirus block, collect the exact artifact hash,
engine/definition versions, and detected component before changing packaging;
see [Windows Defender investigation and qualification](windows-defender-1376.md).

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

1. Inspect the checkout and current `main` CI results; preserve unrelated work.
   Select the release source before checks. Follow [BETA.md](../BETA.md) for the
   separate Beta version commit; Beta package versions must not land on `main`.
2. Finalize the version with `node scripts/update-release-package-versions.ts X.Y.Z`,
   then finish the changelog, in-app notes and documentation. Confirm the four
   release package versions and `bun.lock` match. Prepare website copy in parallel.
3. Use the Node and Bun versions in `.mise.toml`, with frozen dependencies. On
   the finished candidate, run the required local `bun run fmt:check`,
   `bun run lint`, `bun run typecheck`, `bun run release:smoke`, and affected
   Vitest tests. Include `bun run windows-runtime:check`, `bun run migrations:check`
   and relevant browser/native checks when their boundaries change.
   The single tag workflow supplies the final full workspace test suite through
   `quality` plus all three `server_tests` shards, and the desktop build through
   `build_portable` and the native platform jobs. Do not require an additional
   local full `bun run test` or `bun run build` solely as a release prerequisite.
   Keep these CI results pending until the exact candidate SHA passes; a previous
   `main` commit, another release SHA or focused rerun is not equivalent proof.
   Full local tests/builds remain useful for diagnosis, unavailable CI or an
   explicitly requested local check. When marketing or its build inputs change,
   verify `bun run build:marketing` separately unless equivalent successful CI
   proof exists for that exact candidate; it is not part of the desktop payload.
   Retain commands, candidate SHA and results; do not restart completed checks
   merely to resume the release conversation. Packaging can overlap these CI
   checks; a failed quality gate or server shard blocks both GitHub and npm
   publication through their direct dependencies.
4. Run `node scripts/resolve-release-update-policy.ts X.Y.Z` and confirm the lane,
   `make_latest`, and `mirror_to_stable_channel` values. Before any publication
   trigger, configure the exact Windows unsigned exception or verify the requested
   signing setup. Diagnose a known signing, Defender or runner failure before
   starting another complete release run.
5. Commit the candidate, record its full SHA, and create `vX.Y.Z` on that commit.
   Push the branch when appropriate, then push the tag **once**. Do not add a
   disposable full build-only run or a second publication dispatch. The tag
   workflow validates the exact candidate and builds the installers.
6. Record the workflow run ID, attempt, completed gates, artifact identities and
   next action in the release's local checkpoint. Keep progress bookkeeping
   outside tracked release inputs. Monitor the existing run through preflight,
   quality gates, server shards, packaging, verification and publication; use the
   recovery procedure below when a stage fails.
7. Confirm the versioned release is public with all expected installers, manifests
   and provenance. Stable must be GitHub Latest and carry all three `latest`
   manifests plus byte-identical `synara` aliases; Beta must remain a prerelease
   with its own feed. Verify the historical compatibility release is unchanged.
8. Verify public downloads and the authorized website deployment. Report packaged
   startup proof separately from manual installation, installed-app updates and
   live-provider behavior; do not claim checks that were not performed.

9. Refresh the proposed Homebrew Cask source with `bun run homebrew:cask -- --from-github --write`. Review the generated version, both architecture digests and the actual DMGs' minimum macOS requirement before proposing a cask update. The renderer accepts only complete published Stable releases with canonical asset names and download URLs; it rejects drafts, prereleases, missing or duplicate assets, and mixed manual/API inputs before writing.

### Homebrew Cask maintenance

`packaging/homebrew/Casks/synara.rb` is the source for a submission to [homebrew/cask](https://github.com/Homebrew/homebrew-cask). Checking it into this repository does not make `brew install --cask synara` available: upstream acceptance is a separate step. Keep the public download page on the working DMG path until the official cask resolves.

The checked-in v1.0.1 cask requires macOS Ventura (13). The [read-only inspection of both published DMGs](https://github.com/Emanuele-web04/synara/actions/runs/38163962883) found macOS 12.0 for the application and Electron, but their bundled Claude and Cua executables carry a 13.0 Mach-O deployment target. The cask keeps the higher floor for the complete bundle; this metadata inspection does not establish runtime behavior on the oldest supported OS. Recheck the packaged binaries when refreshing the cask, rather than inferring its requirement from the app plist alone.

The renderer prints the cask unless `--write` is supplied. For manually verified release hashes, use:

```bash
bun run homebrew:cask -- --version X.Y.Z --sha256-arm64 ARM64_SHA256 --sha256-x64 X64_SHA256
```

After acceptance, Homebrew's `livecheck` detects newer GitHub Latest versions; it does not itself publish this repository's cask changes. Submit or review the corresponding Homebrew cask updates and keep the Stable DMG filename contract unchanged. `auto_updates true` preserves Synara's own updater. The `uninstall quit:` action requests a normal quit, and optional `zap` paths cover only Stable data, including its updater cache.

### Resume a failed release

- Read the failed job's error before changing source or starting another run.
  Preserve the version, tag, source SHA and existing successful results when the
  failure is transient or limited to runner state.
- For an unchanged candidate, resume the original workflow with
  `gh run rerun RUN_ID --failed`. This retains successful jobs. If GitHub refuses
  a rerun while the workflow is active, let the other jobs finish; do not cancel
  their work and dispatch a second full run.
- Build and qualification share one native job and runner. A successful first
  attempt uploads only the qualified `desktop-*` artifact, without retaining a
  separate candidate. If Defender, startup or a later step fails after provenance
  was validated, the failure handler rechecks file integrity and signing policy
  before uploading `candidate-desktop-PLATFORM-ARCH` for 30 days. A failed
  integrity check must not preserve the candidate as reusable.
- On a retry of the same run and source SHA, the native job looks for that
  retained candidate and verifies its source, version, lockfile, flavor, file
  inventory/digests and signing policy before skipping packaging. Qualification
  runs again; successful platforms remain complete. This is same-run recovery,
  not cross-run promotion or a cache of signing credentials.
- A corrupt candidate or an artifact API error fails closed; neither is treated
  as a cache miss. An absent or expired candidate requires packaging again.
  Crashes or cancellations that prevent the failure handler from uploading a
  validated checkpoint cannot resume from that runner's local files. Signing or
  Apple notarization failures before validated provenance also require packaging
  again. The local `--keep-stage` recovery described above does not persist Apple
  wait state onto a replacement runner.
- A source correction changes the candidate. Run the checks affected by that
  correction, commit it and follow the unpublished-tag correction policy before
  triggering its publication. Artifacts and test results from a different SHA
  are not automatically reusable; never rewrite provenance to claim otherwise.
- Do not move a tag that already produced a public release without explicit
  authorization. For a correction to an unpublished tag, first verify its remote
  target and release status, then use a guarded push and record the old/new SHAs.
- A failed full suite remains a failed full suite even when focused reruns pass.
  Record both outcomes; do not repeat unrelated passed stages to conceal or
  replace the original result.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets are populated and non-empty.
- Published Windows build rejected before packaging:
  - For the unsigned release policy, check that `SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE` matches the exact version without `v`.
  - For a signed release, check all eight Azure ATS, identity, and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Re-check certificate/profile names and tenant/client credentials.
