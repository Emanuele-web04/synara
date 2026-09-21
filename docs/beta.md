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
- Beta builds follow the `beta` updater channel with `allowPrerelease=true` and pick
  the newest release that carries `beta-mac.yml`, `beta.yml`, or `beta-linux.yml`
  manifests.
- Beta releases publish `beta-*.yml` manifests only; the `synara` and `latest`
  aliases stay on stable releases. A beta release can never be offered to a stable
  install, and a stable release never carries beta manifests.
- The desktop additionally gate-checks every candidate's version against its
  lane (`isUpdateVersionAllowedForFlavor`): beta installs accept only
  `*-beta.*` versions and production installs accept only stable versions.
  This matters because electron-updater's GitHub provider falls back to
  `latest-mac.yml` when the channel manifest is absent — without the gate, a
  beta install could be offered a stable build, and installing it would
  silently swap the app to the other flavor and home directory. Crossing lanes
  always happens by installing the other app, never by update.
- `allowDowngrade` stays `false` on both trains; moving back to stable means
  reinstalling stable.
- Pending-update caches are scoped per flavor (`~/Library/Caches/synara-desktop-beta-updater`
  on macOS), so a downloaded beta update never collides with stable's pending
  update state.

## Cutting a beta release

Beta releases ride the same `release.yml` workflow. The lane is selected entirely by
the tag shape: a version whose first prerelease identifier is `beta` resolves to the
beta channel and the beta desktop flavor; every other suffix keeps today's behavior.

1. Ensure `main` is green and run the build-only validation for the release candidate:
   - `gh workflow run release.yml --ref BRANCH -f version=X.Y.Z-beta.1 -f publish_release=false`
2. Create and push the tag:
   - `git tag vX.Y.Z-beta.N <commit>` and `git push upstream vX.Y.Z-beta.N`
   - The base `X.Y.Z` should sit at or ahead of the latest stable version so beta
     builds sort semantically as prereleases of the next stable.
   - `N` starts at `1` and increments per beta cut on the same base version.
3. The workflow publishes a GitHub **prerelease** named `Synara vX.Y.Z-beta.N` with
   beta installers, `beta-*.yml` manifests, and blockmaps. It is never marked Latest,
   never bumps package versions on `main`, and never publishes the npm `latest`
   dist-tag.
4. Manual `workflow_dispatch` with `version=X.Y.Z-beta.N` plus `publish_release=true`
   works the same way; the tag is created on the workflow commit.

### Signing

Beta builds use the same signing setup as stable. Publishing requires the macOS
signing/notarization secrets, and Windows uses Azure Trusted Signing or the same
version-scoped unsigned exception (`SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE` set to the
exact `X.Y.Z-beta.N` version without the `v`).

## Building a beta artifact locally

```bash
bun run dist:desktop:artifact -- --platform mac --target dmg --arch arm64 --flavor beta
```

`--flavor` accepts `production` (default), `canary`, or `beta`, and the
`SYNARA_DESKTOP_FLAVOR` env var is equivalent. The packaged `package.json` embeds the
resolved flavor (`synaraFlavor`), so a packaged build cannot silently lose its
identity at runtime; on packaged builds the embedded value wins over the env var.

## Joining beta from stable

The stable app offers a one-click handoff under **Settings → General → Synara Beta**:

- **Get Synara Beta** opens the public download page when no beta install is
  detected.
- **Copy my data and open** writes a marker at
  `~/.synara-beta/import-requested.json` and launches the beta app. On its next
  startup the beta server consumes the marker, snapshots stable's database,
  copies settings and provider secrets, then deletes the marker. The snapshot
  uses `VACUUM INTO` when the source is quiescent; while stable is running it
  holds `state.sqlite` under `PRAGMA locking_mode = EXCLUSIVE`, so the importer
  falls back to a file-level copy of the database and its WAL/SHM sidecars and
  vacuums that staged copy into a checkpointed snapshot. Either way the result
  is a consistent point-in-time copy and the outcome is written to
  `~/.synara-beta/import-result.json` so the stable settings card can report
  success or the failure reason.
- **Open Beta** launches the installed beta app without touching data.
- The import button is disabled while a beta server is running so an in-flight
  beta never reads a half-written snapshot; quit beta first, then import.
- Launch/import are refused unless the running app is a production-flavor build.

The marker format lives in `packages/shared/src/betaChannel.ts`
(`BetaImportRequest`, `BetaImportResult`); the desktop side is
`apps/desktop/src/betaChannel.ts` and the consuming import is
`apps/server/src/betaImport.ts`.

The import copies settings, provider secrets, and a database snapshot. It never
copies logs, diagnostics queues, runtime files, other import markers, database
sidecars (`state.sqlite-wal`/`-shm`/`-journal`), or `*.lifecycle-lock`
directories — a leaked lock directory would make beta refuse to start while the
stable process is alive. It never writes into the stable home except the one
marker file.

## Diagnostics

Beta builds ship always-on diagnostics; stable builds contain no sender code at
all. See [diagnostics.md](diagnostics.md) for exactly what is collected, what is
never collected, and how the Cloudflare ingest works.

## Data

Without an explicit import, beta starts with an empty `~/.synara-beta` home. It
does not copy, share, or migrate stable (`~/.synara`) or Canary
(`~/.synara-canary`) data on its own. Both apps can run at the same time: the
server binds an ephemeral port, single-instance locks are scoped per Electron
`userData`, and provider secrets are file-scoped inside each home.
