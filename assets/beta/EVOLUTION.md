# Synara Beta icon — evolution

The full journey, v8 to v47. One labeled sheet: `icon-evolution.png`
(all builds under the macOS dock mask, 96px — icons are judged at dock
size, never in close-up).

## Eras

- **v8–v13 (badge era).** Black or white Y with a BETA pill or badge.
  Dropped: the mark should stand alone, no text.
- **v14–v19 (badge tests).** Smaller badge variants. Same verdict.
- **v21–v32 (blueprint era).** White mark on the blue tile with full
  blueprint linework: grid, axes, diagonals, circles, squircle, sparkles.
  Clutter won over clarity; lines turned to haze at 16px.
- **v33–v42 (glass era).** Opaque glass mark with outline ring, quieter
  wireframe, deeper tile, bigger mark (+15%), optical centering, crown
  glow. Contrast climbed 1.50 → 2.26. A mid-process dip (v33, mark
  brightness 209) was found by pixel scan and recovered.
- **v43–v47 (clean glass).** Linework removed, translucent frosted mark,
  brighter crown, side sculpt. Contrast 2.30. Kept as reference for the
  next pass — not shipped.

## Shipped: v38

Picked from the sheet at dock size. Monotonic 4-stop tile gradient (no
center band line), quiet wireframe (grid + guide circle + squircle),
glass Y with bevel and inner glow. Verified: mark core lum 251,
tile-by-mark lum 125, contrast 2.01, smooth fade scan, legible 16–48px
ladders, sits well next to the App Store and Xcode tiles.

## Regenerate

Channel note: the upstream port sets `markScale = 1.00` so the mark
footprint matches the stable tile glyph at dock size, and draws an
inset 820px tile with transparent margin (macOS does not mask
third-party bundle art). Regenerate after any recipe change:

```console
swift assets/beta/generate-beta-icon.swift
```

Writes `beta-macos-1024.png`; derived sizes and ICOs follow the same
recipe (see PR #65). One file serves light and dark.
