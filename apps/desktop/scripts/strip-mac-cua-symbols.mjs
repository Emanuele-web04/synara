// Build proc-macro dylibs without stripping to support the pinned Rust SDK.
// Strip only the final linked executable before signing and hashing it.
export function stripMacCuaSymbols(binary, run) {
  run("strip", [binary]);
}
