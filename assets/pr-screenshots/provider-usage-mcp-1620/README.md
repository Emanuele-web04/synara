# Provider usage permission evidence

Issue: [#1620](https://github.com/Emanuele-web04/synara/issues/1620).

## Captured states

| Asset                                              | Observed behavior                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Before](before-main.png)                          | Original advanced permissions have no provider usage control.                                            |
| [After, default off](after-default-off.png)        | The new **Read provider usage** control starts off and explains that it covers accounts across projects. |
| [Granted connection](after-permission-granted.png) | The created connection displays **Read usage for all provider accounts** in its permissions.             |
| [Interaction](permission-interaction.mp4)          | 6.92 seconds: off → on → off → on → create connection → inspect its permission summary.                  |

The capture asserted the actual `createExternalMcpIntegration` arguments emitted by the production
component. Before and after default creation both sent exactly `projects:read`, `tasks:create`,
`tasks:wait`, and `tasks:read`. Selecting the usage switch added only `usage:read`. Page errors: zero.

## Source and method

- Before: `bbc773f8312fc891c1770c9105695eef285b64bf`. Its settings panel blob
  `20b7b94efbc1369b81a2105139196cd90252ace8` is identical to main
  `6f54f53c66348a9a19c65779daaabd96113773eb`.
- After: `048f1eed44a9748a65d44918087a6e28b921393c`, panel blob
  `cb2541a06f9f68f91f4fd7762a53ecabe88d053e`.
- The later permission-summary correction for integrations with only read scopes preserves the
  captured default and opted-in task permissions. Its existing unit case also verifies that a
  usage-only grant does not claim any task access.
- Actual `ExternalMcpSettingsPanel`, setup helper, shared controls, theme, and CSS, rendered with
  the repository's Vite configuration in test mode, including the React compiler. The original
  component and helper were copied temporarily, with only their local import path redirected.
- Temporary native API fixture supplied an empty integration list and recorded creation requests.
  The visible pairing code and application path are fixture values. This proves the UI grant
  flow; external authorization, auditing, rate limits, and cache access are covered by the
  existing external gateway fixture.
- Chromium **138.0.7204.0**, Linux, light theme, viewport **1280 × 900**. This differs from the
  Chromium 151 version requested by the CI browser installation.
- PNGs are direct browser screenshots. The H.264 MP4 uses 43 native CDP screencast frames and their
  recorded timestamps, encoded at 24 fps with the system FFmpeg. No audio.

All temporary source, fixture, and capture-runner files were removed after the capture. Main was
read only. All three screenshots and the clip's start, toggle, and final frames were inspected.
