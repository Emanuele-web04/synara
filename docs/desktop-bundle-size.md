# Desktop bundle size

Size comparisons must use production packaging, not the source checkout or the
unpackaged JavaScript output. Keep the source revisions, lockfile, build version,
platform, architecture, toolchain and signing mode in the evidence.

## Reproduce a measurement

Run on the matching native release host. This example uses Linux x64; the macOS
and Windows variants use `mac`/`dmg` and `win`/`nsis` respectively.

```sh
bun install --frozen-lockfile --ignore-scripts --filter '!@synara/marketing'
bun run dist:desktop:artifact -- --platform linux --target AppImage --arch x64 \
  --build-version 0.8.4 --keep-stage --verbose --output-dir /tmp/synara-size-artifacts
node .github/scripts/measure-bundle-size.mjs "$PWD" /tmp/synara-size-evidence linux
node scripts/verify-packaged-desktop-startup.ts --assets-dir /tmp/synara-size-artifacts \
  --platform linux --arch x64 --version 0.8.4
```

The measurement helper selects the most recent retained stage for that platform.
Run it immediately after the build, without concurrent builds in the same temp
folder. `installed.bytes` sums regular-file lengths without following symlinks;
it includes the ASAR once and its unpacked files once. The logical ASAR inventory
is a separate breakdown, not another amount to add. Installer/ZIP lengths and
SHA-256 hashes are recorded separately. Disk allocation reported by Finder or
`du` can differ because of block sizes, compression, symlinks and hard links.

The read-only **Verify production bundle size** workflow performs native
packaging, records these inventories and launches each packaged app in an
isolated temporary profile. It never publishes, updates a release or uses
signing credentials. Download the evidence before its 14-day artifact expiry.

## Packaging policy

`desktop-package-files.ts` omits dependency maps, declaration variants, verified
compiled packages' TypeScript source copies, native compiler intermediates and
artwork for other platforms. It retains runtime JavaScript, binaries, terminal
helpers, license notices, Chromium locales and application language support.
Never replace the package-specific source list with a blanket `**/src` deletion:
some dependencies execute files from their source directories. Review runtime
exports again when updating a package on that list.

Known glibc Linux builds omit the Claude SDK's musl-only fallback, not its primary
native executable. Unknown libc environments retain both packages. The primary
executable is required by a provider-health path even when regular sessions use
a separately installed CLI.

For dependency-level diagnostic builds, preserve maps and their source files:

```sh
SYNARA_DESKTOP_DEPENDENCY_SOURCEMAP=1 bun run dist:desktop:artifact -- \
  --platform mac --target dmg --arch arm64 --build-version 0.8.4
```

This is independent of `SYNARA_WEB_SOURCEMAP`, which controls first-party web maps.
Normal production builds do not need either kind of source map for execution.

## Public assets

Production builds retain a conservative superset of referenced Central icon
basenames in **both** visual variants. Keep dynamically selected names in literal
mapping tables under `apps/web/src`; the scanner also recognizes `.svg` suffixes
and direct Central asset URLs. It retains a whole variant if no references can
be identified and fails the build on source-read errors. Original icon sets and
the test-only MSW worker remain available in development and browser tests.

Pruning runs sequentially before precompression. Removed icons cannot leave
orphaned gzip/Brotli sidecars, and all retained precompressed delivery paths stay
available. Shipped PNG optimizations preserve pixels, dimensions, alpha, color
profiles and other metadata; do not replace these with lossy conversions or
resampling merely to lower the byte count.
