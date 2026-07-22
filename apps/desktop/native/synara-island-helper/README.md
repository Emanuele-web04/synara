# Synara native island helper

Native macOS presentation surface for Synara's live coding-agent state.

## Visual contract

The design is a synthesis of three fixed references:

- Apple's compact Now Playing panel supplies the neutral smoked-glass material, shallow silhouette, soft lower bloom, and restrained silver rim.
- Liquid Siri's orb supplies only a faint refractive/spectral edge treatment. It must never become a rainbow decoration or fake album art.
- The coding-agent notch supplies the information hierarchy: one quiet context line above one luminous status pixel and one prominent activity line.

The island is not a music player and must not grow into a generic gray modal. Live activity stays at `392 x 104`; approval is the only deeper surface. The desktop behind the island remains legible through native material, while the edge is slightly darker and more optically dense than the center.

## Runtime behavior

Electron starts the helper with `--stdio-jsonl` and sends bounded protocol-v1 snapshots. The helper remains hidden until it receives live activity or approval and acknowledges the exact rendered revision. Rich modes that are not yet native, plus the tiny idle/recent-threads affordance, remain on the React fallback.

Supported deterministic preview states are `compact`, `activity`, `approval`, and `expanded`:

```sh
node apps/desktop/native/synara-island-helper/build.mjs
open "apps/desktop/native/synara-island-helper/build/Synara Island Preview.app" --args --preview activity
```

Desktop development and release packaging use `apps/desktop/scripts/build-island-helper.mjs`, which builds the current architecture or a universal binary and signs it at the appropriate boundary.
