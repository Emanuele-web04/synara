# PR #1114 live verification evidence

Captured on a headless VPS running KasmVNC (`:1`, 1920x1080), real Electron
desktop build (`dist-electron/main.js`) against the Vite dev server, fixture
site served at `http://127.0.0.1:8471/`. Interactions were driven through the
app's own `desktopBridge` IPC surface plus CDP trusted input on the managed
guest pages.

| File | What it shows |
| --- | --- |
| `00-first-run.png` | App booted on the desktop, onboarding visible. |
| `01-embedded-preview.png` | Fixture page rendered inside the embedded BrowserPanel. |
| `02-popup-tabs.png` | `window.open` popup materialized as a second in-window browser tab. |
| `03-vault-save-prompt.png` | "Save password?" prompt after a real login submit (origin + username only). |
| `04-vault-metadata.png` | Vault list — metadata-only row (origin, username, "Saved by you"), no secret fields. |
| `05-vault-gate.png` | Per-login reveal gated behind the master-password input. |
| `08-vault-revealed.png` | Reveal succeeded after entering the master password. |
| `06-floating-preview.png` | Floating browser preview card (noninteractive) after the dock pane is closed. |
| `07-floating-expanded.png` | "Open browser in sidebar" expands back to the docked live browser with both tabs. |
| `10-cookie-after-restart.png` | Session cookie absent after restart — see below. |
| `live-interaction-flow.mp4` | 65s recording: unlock vault → open in-window popup → submit login → save prompt → Save → vault lists the new login. |
| `session-restore-gate.log` | `Secure session restoration is unavailable` — the `safeStorage` backend on this Linux box is `basic_text`, so session-cookie restore is gated off by design (mirrors the repo's `session-restore-smoke.ts` production gate). |
| `agent-e2e-run.gif` / `agent-e2e-run.mp4` | End-to-end agent run: OpenCode `muse-spark-1.3-contributor-free` driving the embedded browser on real apple.com — built a 20-item shopping bag (2 accessory lines × qty 10, badge 20, total $940.00) via `browser_*` tools, verified by re-querying the live page. |
| `agent-floating-apple.png` / `agent-floating-apple-2.png` | Agent-controlled browser visible in the floating preview while the agent browsed product pages. |
| `agent-final-report.png` | The agent's final report in the transcript (checks, limitations, proof screenshots) with the live bag page in the floating preview. |

Verified via API state (not just screenshots): `vault.snapshot()` reported the
pending prompt and saved credentials; `reveal` denied while locked and with a
wrong password, succeeded with the master password; `browser.getState` showed
the popup tab and suspended/live transitions; the floating card's
`data-floating-browser-*` DOM and dock reopen were checked programmatically.
