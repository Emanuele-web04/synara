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
- `allowDowngrade` stays `false` on both trains; moving back to stable means
  reinstalling stable.

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

## Data

Beta starts with an empty `~/.synara-beta` home. It does not copy, share, or migrate
stable (`~/.synara`) or Canary (`~/.synara-canary`) data. Both apps can run at the
same time: the server binds an ephemeral port, single-instance locks are scoped per
Electron `userData`, and provider secrets are file-scoped inside each home.
