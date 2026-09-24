# Synara Beta

Synara Beta is a packaged prerelease flavor of the desktop app. It is a separate
application that installs and updates side-by-side with stable Synara, and it never
shares stable's data directory or update feed.

## Identity

- App name: `Synara Beta`
- Bundle ID: `com.emanueledipietro.synara.beta`
- Desktop origin: `synara-beta://app`
- Synara data: `~/.synara-beta`
- Electron profile: `synara-beta`
- Executable: `synara-beta` (Linux AppImage bundle), `Synara Beta.app`, `Synara Beta.exe`
- Windows installer GUID: `a8e63b48-d4f3-4db5-9e12-368107afe65d` (separate Add/Remove
  Programs entry; the stable GUID is unchanged)

## How it differs from Canary

Canary is a local source build managed by `bun run canary:*` scripts and updates only
through those scripts. Beta is a packaged release artifact: it is built, signed, and
published by the same release workflow as stable, and it updates through
`electron-updater` like the production app.

## Update channel isolation

- Stable builds follow the `synara` updater channel with `allowPrerelease=false` and
  only ever read the repository's GitHub Latest release.
- Beta builds follow the `beta` updater channel with `allowPrerelease=true`.
  electron-updater's GitHub provider reads the releases atom feed and takes the
  newest release that is not tagged for a custom channel — so if a stable
  release is newer than the latest beta tag, beta installs see "no update"
  until the next beta release is cut. Always cut a new beta right after each
  stable release.
- Beta releases carry `beta-mac.yml`, `beta.yml`, and `beta-linux.yml`
  manifests. The `latest-*.yml` files are uploaded on beta releases too, but
  they are inert there: stable installs only read them from the Latest
  release, which beta tags never become. A beta release can never be offered
  to a stable install, and a stable release never carries beta manifests.
- The desktop additionally gate-checks every candidate's version against its
  lane (`isUpdateVersionAllowedForFlavor`): beta installs accept only
  `*-beta.*` versions and production installs accept only stable versions.
  This matters because electron-updater's GitHub provider falls back to
  `latest-mac.yml` when the channel manifest is absent — without the gate, a
  beta install could be offered a stable build, and installing it would
  silently swap the app to the other flavor and home directory. Crossing lanes
  always happens by installing the other app, never by update.
- `allowDowngrade` stays `false` on both trains; moving back to stable happens
  by opening the stable app (see [Leaving beta](#leaving-beta)), never by update.
- Pending-update caches are scoped per flavor (`~/Library/Caches/synara-desktop-beta-updater`
  on macOS), so a downloaded beta update never collides with stable's pending
  update state.

## Cutting a beta release

Beta releases ride the same `release.yml` workflow. The lane is selected entirely by
the tag shape: a version whose first prerelease identifier is `beta` resolves to the
beta channel and the beta desktop flavor; every other suffix keeps today's behavior.

1. Ensure `main` is green and run the build-only validation for the release candidate:
   - `gh workflow run release.yml --ref BRANCH -f version=X.Y.Z-beta.1 -f publish_release=false`
2. Commit the version on top of the target commit (normally current `main`),
   and push only the tag. Release preflight
   (`scripts/verify-release-source-provenance.ts`) requires the four release
   `package.json` versions to equal the tag version, but beta version commits
   never land on `main`, so `main` keeps the stable version:
   - `git switch --detach upstream/main`
   - `node scripts/update-release-package-versions.ts X.Y.Z-beta.N`, then commit
   - `git tag vX.Y.Z-beta.N` and `git push upstream vX.Y.Z-beta.N`
   - The base `X.Y.Z` should sit at or ahead of the latest stable version so beta
     builds sort semantically as prereleases of the next stable.
   - `N` starts at `1` and increments per beta cut on the same base version.
3. The workflow publishes a GitHub **prerelease** named `Synara vX.Y.Z-beta.N` with
   beta installers, `beta-*.yml` manifests, and blockmaps. It is never marked Latest,
   never bumps package versions on `main`, and never publishes the npm `latest`
   dist-tag.
4. To re-run publication by hand, dispatch the workflow on the existing tag
   (`gh workflow run release.yml --ref vX.Y.Z-beta.N -f version=X.Y.Z-beta.N -f publish_release=true`).
   Publishing from a branch ref is refused by preflight.
5. Always cut a new beta right after each stable release. The GitHub provider
   picks the newest non-custom-channel release in the feed, so a newer stable
   tag shadows every older beta until a fresh beta prerelease out-sorts it.
   With the repository variable `SYNARA_AUTO_BETA=1`, the release workflow does
   this automatically after each stable publish: it tags a version commit made
   on top of the stable commit as `vX.Y.(Z+1)-beta.1` (skipped when any beta
   for that base already exists, or when the release just published is not the
   highest stable tag — a re-release of an old line does not cut a beta).
   Later betas on the same base stay manual.

### Signing

Beta builds use the same signing setup as stable. Publishing requires the macOS
signing/notarization secrets, and Windows uses Azure Trusted Signing or the same
version-scoped unsigned exception (`SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE` set to the
exact `X.Y.Z-beta.N` version without the `v`). The exception matches one exact
version, so the automatic post-stable beta needs Azure signing or the variable
set to that beta version, otherwise its Windows build blocks publication.

## Building a beta artifact locally

```bash
bun run dist:desktop:artifact -- --platform mac --target dmg --arch arm64 --flavor beta
```

`--flavor` accepts `production` (default), `canary`, `cua`, or `beta`, and the
`SYNARA_DESKTOP_FLAVOR` env var is equivalent. The packaged `package.json` embeds the
resolved flavor (`synaraDesktopFlavor`), so a packaged build cannot silently lose its
identity at runtime; on packaged builds the embedded value wins over the env var.

## Joining beta from stable

The stable app offers a one-click handoff under **Settings → General → Synara Beta**:

- **Install Synara Beta** (macOS) downloads the newest `v*-beta.N` release's
  `beta-mac.yml`, picks the zip for the current architecture, verifies its
  sha512, unpacks it with `ditto`, checks the bundle id is
  `com.emanueledipietro.synara.beta`, and verifies the code signature is valid
  and signed by the same team id as the running app (`codesign --verify
--deep --strict` plus a `TeamIdentifier` match; skipped when the running
  build is itself unsigned). Only then is `Synara Beta.app` moved into
  `/Applications` — then opened. On other platforms the card opens the public
  download page instead.
- **Copy my data and open** installs first when needed, then writes a marker at
  `~/.synara-beta/import-requested.json` and launches the beta app. On its next
  startup the beta server consumes the marker, snapshots stable's database,
  copies settings and provider secrets, then deletes the marker. The snapshot
  uses `VACUUM INTO` when the source is quiescent; while stable is running it
  holds `state.sqlite` under `PRAGMA locking_mode = EXCLUSIVE`, so the importer
  falls back to a file-level copy of the database and its WAL, retried until no
  checkpoint or WAL restart landed mid-copy (it fails rather than import a torn
  pair), and vacuums that staged copy into a checkpointed snapshot. Either way
  the result is a consistent point-in-time copy and the outcome is written to
  `~/.synara-beta/import-result.json` so the stable settings card can report
  success or the failure reason.
- Only a packaged beta (`SYNARA_DESKTOP_BUNDLE_ID` is the beta bundle id)
  consumes the marker, and only from stable's data folder (`SYNARA_STABLE_HOME`
  handed over by stable, else `~/.synara`). A stray marker in any other home
  is ignored.
- If stable's database has migrations newer than the installed beta knows, the
  import fails with "Update Synara Beta" instead of leaving beta unable to
  start. Any leftover beta `state.sqlite-wal`/`-shm`/`-journal` is removed
  before the snapshot is swapped in, so an old WAL cannot replay over it.
- **Open Beta** launches the installed beta app without touching data.
- The import button is disabled while a beta server is running so an in-flight
  beta never reads a half-written snapshot; quit beta first, then import.
- Launch/import are refused unless the running app is a production-flavor build.
- On macOS the beta app is spawned by executable path
  (`Synara Beta.app/Contents/MacOS/Synara Beta`) with a sanitized environment:
  stable's `SYNARA_HOME`, `SYNARA_DESKTOP_SMOKE_USER_DATA`, and server auth
  variables are stripped, and beta gets `SYNARA_BETA_HOME` (plus
  `SYNARA_DESKTOP_SMOKE_USER_DATA` when `SYNARA_BETA_USER_DATA` is set).

The marker format lives in `packages/shared/src/betaChannel.ts`
(`BetaImportRequest`, `BetaImportResult`); the desktop side is
`apps/desktop/src/betaChannel.ts`, the download/install flow is
`apps/desktop/src/betaInstaller.ts`, and the consuming import is
`apps/server/src/betaImport.ts`.

### Local demo

Everything about the install location and data home can be redirected with
environment variables, so a demo never touches a real `~/.synara`,
`~/Library/Application Support/synara`, or `/Applications`:

- `SYNARA_BETA_FEED_URL` — base URL serving `beta-mac.yml` and the files it
  lists (for example a local static server). Without it, the newest GitHub
  `v*-beta.N` release is used.
- `SYNARA_BETA_INSTALL_DIR` — directory the app bundle is moved into and
  probed in first (default `/Applications`).
- `SYNARA_BETA_HOME` — overrides `~/.synara-beta` everywhere it is resolved:
  stable's import marker path, the beta app's own base dir, and the
  running-server probe.
- `SYNARA_BETA_USER_DATA` — Electron `userData` dir handed to the launched
  beta (only honored on the beta and cua flavors and source builds).
- `SYNARA_HOME` / `HOME` — stable's data dir (beta ignores `SYNARA_HOME`, so a
  globally exported value can never point beta at stable's data) and the
  `userData` base, respectively; overriding `HOME` isolates the Electron profile exactly like
  `scripts/verify-packaged-desktop-startup.ts` does.

The import copies settings, provider secrets, and a database snapshot. It never
copies logs, diagnostics queues, runtime files, other import markers, database
sidecars (`state.sqlite-wal`/`-shm`/`-journal`), or `*.lifecycle-lock`
directories — a leaked lock directory would make beta refuse to start while the
stable process is alive. Nothing is ever written into the stable home: the
marker and the result both live in the beta home.

## Leaving beta

Beta shows **Switch back to Synara** under **Settings → General**. It opens
stable and quits beta; on macOS it can also move `Synara Beta.app` to the Trash
(checked by default). Stable was never changed by the switch, so it opens with
the chats and settings it had before.

- Beta data is never copied back. Beta can carry database migrations and data
  for features stable does not have yet, so a copy could fail or corrupt
  stable's `state.sqlite`. The dialog says so plainly. `~/.synara-beta` is
  kept, so reinstalling beta picks up where the user left off.
- Stable is found through `SYNARA_STABLE_EXECUTABLE`, which stable sets on the
  beta it launches (with `SYNARA_STABLE_HOME` for its data dir), then through
  `/Applications/Synara.app`, `~/Applications/Synara.app`, or the stable NSIS
  uninstall key on Windows. When none is found the card offers the stable
  download page instead.
- Stable is spawned with beta's per-process overrides stripped
  (`SYNARA_DESKTOP_SMOKE_USER_DATA`, server auth variables) and `SYNARA_HOME`
  restored from `SYNARA_STABLE_HOME` when stable handed one over. An already
  running stable just comes to the front through its single-instance lock.
- The Trash step only runs for a packaged bundle named `Synara Beta.app`, so a
  source or dev build can never trash Electron itself.

## Beta-only features

`packages/shared/src/betaFeatures.ts` holds `BETA_ONLY_FEATURES`, the single
list of features that ship in Beta but not in Stable. `isBetaFeatureEnabled`
turns a listed feature off only for the `production` desktop flavor; Beta,
Cua, Canary, development, and non-desktop hosts keep it.

To put a feature behind the list:

- Add its name to `BETA_ONLY_FEATURES`.
- Gate it on the server, which is authoritative: resolve the host flavor with
  `desktopFlavorFromBundleId(process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV])` and
  refuse the capability there, not just in the UI.
- Hide it on the web with `COMPUTER_USE_ENABLED`-style constants built from
  `desktopFlavorFromProtocol(window.location.protocol, import.meta.env.DEV)` —
  hide entry points rather than disabling them, and coerce any persisted or
  replayed value to off so stale state cannot re-arm the feature.
- Keep any migrations or persisted fields additive and inert on Stable; a
  user's stored preference must survive a Beta → Stable round trip untouched.

Promote a feature to Stable by deleting its entry; every gate resolves itself.

Computer Use is currently the only entry. On Stable the server reports the
computer backend as unavailable with a Beta pointer, the desktop never starts
the CUA driver host, and the web hides every surface.

## Diagnostics

Beta builds ship always-on diagnostics — crash reports plus anonymous usage
counts (which providers are used, how many chats and turns) — while stable
builds contain no sender code at all. See [diagnostics.md](diagnostics.md) for
exactly what is collected, what is never collected, and how the Cloudflare
ingest works.

## Data

Without an explicit import, beta starts with an empty `~/.synara-beta` home. It
does not copy, share, or migrate stable (`~/.synara`) or Canary
(`~/.synara-canary`) data on its own. Both apps can run at the same time: the
server binds an ephemeral port, single-instance locks are scoped per Electron
`userData`, and provider secrets are file-scoped inside each home.
