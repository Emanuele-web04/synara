# Mermaid Markdown evidence

Captured in Chromium 138.0.7204.0 using the actual shared `ChatMarkdown` component and a synthetic README workflow. The temporary capture controls switch the original component from main `6f54f53c66348a9a19c65779daaabd96113773eb`, the changed component, app theme, and in-thread find. They are not product controls and are not shipped.

- `before-main.png`: the original component displays the Mermaid source.
- `after-light.png` / `after-dark.png`: the changed component renders the same source using the active theme.
- `render-theme-find.webm`: recorded transition from source to diagram, theme change, and source highlighting during find. Five matches were observed; no page errors occurred.

The code card retains its existing source-copy action. Rendering waits for a settled message; incomplete/invalid diagrams retain the source. These are component/browser observations, not a packaged Electron or live provider session. CI uses its own pinned Chromium version.
