/**
 * The on-disk twin of a path inside an Electron `app.asar` archive.
 *
 * Electron patches Node's `fs` so that a path under `app.asar/` reads as if
 * the archive were a directory, which is why `existsSync` and `readFile` on
 * such a path succeed. Nothing else sees that illusion: a spawned `python3`
 * or `bash` handed the same path is reading the real filesystem, where
 * `app.asar` is one file. electron-builder's `asarUnpack` keeps copies of the
 * listed files as real files under the sibling `app.asar.unpacked/` tree, and
 * this rewrites a path to that copy. A path that is not inside an archive is
 * returned as is, which keeps the callers the same in a checkout.
 */
const ASAR_SEGMENT = /(^|[\\/])app\.asar(?=[\\/])/;

export function asarUnpackedPath(path: string): string {
  return path.replace(ASAR_SEGMENT, "$1app.asar.unpacked");
}
