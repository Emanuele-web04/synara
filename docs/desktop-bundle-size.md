# Desktop bundle size

Size comparisons must use production packaging, not the source checkout or the
unpackaged JavaScript output. Keep the source revisions, lockfile, build version,
platform, architecture, toolchain and signing mode in the evidence.

## Reproduce a measurement

Run from a clean commit on the matching native release host. This Bash example
uses Linux x64; the macOS and Windows variants use `mac`/`dmg` and `win`/`nsis`
respectively, with the matching architecture. Choose one build version and use
it consistently for the build, measurement and startup check.

Prepare the native prerequisites from the [release guide](release.md) first:
the pinned Rust toolchain and Linux native development libraries, or the macOS
15/Xcode 16.4 build host with a same-source Icon Composer catalog compiled on
macOS 26. Linux startup checks also require Xvfb and the desktop runtime libraries.
The workflow below provisions these requirements explicitly.

```sh
bun install --frozen-lockfile --ignore-scripts --filter '!@synara/marketing'
node --test .github/scripts/measure-bundle-size.test.mjs
audit_version=0.8.4
audit_source_commit="$(git rev-parse HEAD)"
audit_lockfile_sha256="$(node --input-type=module -e 'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; console.log(createHash("sha256").update(readFileSync("bun.lock")).digest("hex"));')"
audit_temp="$(node --input-type=module -e 'import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; console.log(mkdtempSync(join(tmpdir(), "synara-bundle-audit-")));')"
SYNARA_DESKTOP_SIGNED=false TMPDIR="$audit_temp" TMP="$audit_temp" TEMP="$audit_temp" \
  bun run dist:desktop:artifact -- --platform linux --flavor production --target AppImage --arch x64 \
  --build-version "$audit_version" --source-commit "$audit_source_commit" \
  --lockfile-sha256 "$audit_lockfile_sha256" --keep-stage --verbose \
  --output-dir "$audit_temp/artifacts"
node .github/scripts/measure-bundle-size.mjs --source "$PWD" --output "$audit_temp/evidence" \
  --stage-parent "$audit_temp" --platform linux --flavor production --arch x64 --version "$audit_version"
node scripts/verify-packaged-desktop-startup.ts --assets-dir "$audit_temp/artifacts" \
  --platform linux --arch x64 --version "$audit_version"
```

Use a new temporary parent for every build. All three temp variables point the
builder at that parent on native macOS, Linux and Windows. The measurement helper
requires exactly one retained `synara-desktop-FLAVOR-PLATFORM-stage-*` directory
there. Missing or ambiguous candidates fail; it never selects by modification
time or searches the global temp directory. Staged package metadata must match
the checkout's full commit and lockfile digest, the requested flavor and version,
and the packaged directory must match the requested platform and architecture.
The builder's explicit provenance flags also reject a dirty source checkout.

`bundle-size.json` records the selected stage, requested target and host/toolchain
metadata. `installed.bytes` sums regular-file lengths without following symlinks;
it includes the ASAR once and its unpacked files once. The logical ASAR inventory
is a separate breakdown, not another amount to add. Installer/ZIP lengths and
SHA-256 hashes are recorded separately. Disk allocation reported by Finder or
`du` can differ because of block sizes, compression, symlinks and hard links.

The read-only **Verify production bundle size** workflow performs native
packaging at the exact workflow SHA, records source/tree/lock/target provenance
and these inventories, then launches each packaged app in an isolated temporary
profile. Its four native hosts are macOS arm64, macOS x64, Linux x64 and Windows
x64. A separate macOS 26 job compiles the production icon; consumers verify its
source commit and SHA-256 before packaging with the macOS 15 native toolchain.
It never publishes, updates a release or uses signing credentials. Download
the evidence before its 14-day artifact expiry. A failed build, measurement or
startup check remains a failed qualification; retained logs are evidence of that
failure, not a successful size comparison.

## Packaging policy

`desktop-bundle-files.ts` omits dependency maps, declaration variants, selected
compiled-package TypeScript source files, native compiler intermediates and
artwork for other platforms. It retains runtime JavaScript, binaries, terminal
helpers, license notices, Chromium locales and application language support.
Never replace the package-specific source list with a blanket `**/src` deletion:
some dependencies execute files from their source directories. Review runtime
exports again when updating a package on that list.

Known glibc Linux builds omit the Claude SDK's musl-only fallback, not its primary
native executable. Unknown libc environments retain both packages. The primary
executable is required by a provider-health path even when regular sessions use
a separately installed CLI.

For dependency-level diagnostic builds, preserve maps and their source files by
setting one or more of the supported variables:

```sh
SYNARA_WEB_SOURCEMAP=1 bun run dist:desktop:artifact -- \
  --platform mac --target dmg --arch arm64 --build-version 0.8.4
```

`SYNARA_WEB_SOURCEMAP`, `SYNARA_SERVER_SOURCEMAP`, and
`SYNARA_DESKTOP_SOURCEMAP` control dependency diagnostics. Normal production
builds do not need source maps for execution.

## Public assets

Production builds retain a conservative superset of referenced Central icon
basenames in **both** visual variants. Keep dynamically selected names in literal
mapping tables under `apps/web/src` and shared source roots. The scanner
recognizes basename literals and `.svg` suffixes; it does not claim to scan
arbitrary URLs. It retains a whole variant if no references can be identified,
and fails the build on source-read errors. Original icon sets and the test-only
MSW worker remain available in development and browser tests.

Pruning runs sequentially before precompression. Removed icons cannot leave
orphaned gzip/Brotli sidecars, and all retained precompressed delivery paths stay
available. PNG assets in this branch are retained as supplied by current main;
no pixel-equivalence or optimization claim is made without independent proof.
