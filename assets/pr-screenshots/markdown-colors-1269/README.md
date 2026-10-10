# Markdown color evidence

Captured on 2026-10-10 with Chromium 138 at 1280 × 1000. These are real `ThemePackEditor` and `ChatMarkdown` components mounted in a temporary local Vite harness with synthetic sample text.

- `before-main.png`: editor source from immutable main `6f54f53c66348a9a19c65779daaabd96113773eb`, before the additional controls.
- `after-light.png` / `after-dark.png`: independent heading and bold colors changed through the real color pickers.
- `colors-and-reset.webm`: 10.64-second interaction recording, including theme switching and resets.

The capture also asserted persistence after reload, independent color resets, and unchanged ordinary text and code colors. The temporary harness was removed before publication. This component-level evidence does not claim native-window or live-provider qualification.
