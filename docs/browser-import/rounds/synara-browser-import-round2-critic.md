# Round 2 critic — REQUEST CHANGES

Reviewed the uncommitted browser inventory slice in `/Users/user/.codex/worktrees/browser-cookie-import/synara` on 2026-10-12. Review was read-only: no repository files changed. Temporary synthetic probe and this report are under `/private/tmp`.

**Single biggest remaining gap:** the production integration passes Synara's browser-engine state directory as the OS user home, so the shipped IPC would search the wrong browser-data tree. Passing unit tests currently miss this integration failure.

## Required findings

### P1 — Inventory uses the engine home instead of the user's home

- Changed location: `apps/desktop/src/browserAutomation/browserCookieImport.ts:48-49`.
- Call chain: preload `preload.ts:362-363` → channel `ipcChannels.ts:105` → `browserVaultIpc.ts:64` → `BrowserCookieImport.inventoryChromiumProfiles()` → `listChromiumProfileInventory(this.home)`.
- `main.ts:5514-5515` constructs `BrowserCookieImport` with `Path.join(BASE_DIR, "browser-engine")`. That parameter is the BetterWright engine state home, as its existing use in `new BetterWright({home: this.home})` confirms.
- Inventory instead interprets its parameter as an OS home, constructing `<home>/Library/Application Support/<browser>` and `<home>/Applications` (`chromiumProfileInventory.ts:66-67,228-230`). Installed `/Applications` browsers consequently appear with `no_profiles`, and applications installed only in the actual `~/Applications` disappear.
- Fix by separating engine storage home from source-user home, or letting inventory use `homedir()`. Add a boundary test through the BrowserCookieImport method; tests that invoke the standalone function with the desired fixture root do not cover this defect.

### P2 — Opera's current Default profile layout is never inspected

- Location: `chromiumProfileInventory.ts:116-123`.
- Opera and Opera GX are both forced into root-only discovery. Current Opera has a `Default` profile below its user-data directory. Apple's browser integration registry identifies Opera's extensions at `Application Support/com.operasoftware.Opera/Default/Extensions`; GX's entry remains at the root. Source: https://raw.githubusercontent.com/apple/password-manager-resources/main/quirks/web-browser-extension-distribution-information.json (Opera lines 428-460).
- Synthetic fixture with a valid `com.operasoftware.Opera/Default/Cookies` SQLite database returns `[{id:"opera",profileStatus:"no_profiles",profiles:[]}]` under both Node and Electron. No live Opera installation was available.
- The legacy assumption was copied from `/Users/user/cedar/Sources/Search/Import.swift`; source parity does not make it current. Handle modern nested layout and legacy root fallback without mixing duplicate/stale stores. Add an independent modern-layout fixture; current tests build the catalog's assumed layout and repeat the defect.

### P2 — One inaccessible store rejects all browser inventory; one inaccessible profile erases healthy peers

- Locations: `chromiumProfileInventory.ts:132-139,191-196,239-245,270`.
- Reproduced case A: Chrome Default has readable root `Cookies`, but its `Network` directory denies access. `hasProfileStore` returns early because root Cookies exists. Later `cookieStore` throws EACCES while examining `Network/Cookies`; uncaught Promise rejection aborts the entire inventory, losing every other browser and the readable password count. The IPC converts it to a generic vault error.
- Reproduced case B: Chrome Default is readable, but sibling `Profile 1` denies access. Discovery returns `profileStatus:"unavailable",profiles:[]`, discarding Default too.
- Results reproduced in both Node and Electron with disposable chmod fixtures. `installed()` also propagates non-ENOENT lookup errors, so a denied app-root lookup can abort the whole scan (static finding, not separately reproduced).
- Preserve per-browser/profile/store results; represent inaccessible parts as unavailable, avoid discarding healthy peers, and test EACCES at each boundary.

### P2 — Third-party notice is absent from the packaged app staging tree

- Changed file: `THIRD_PARTY_NOTICES.md:5-26`; packaging evidence: `scripts/build-desktop-artifact.ts:1197-1203,1248-1255,1307-1311` and `scripts/lib/desktop-runtime-resources.ts`.
- The notice reproduces the correct Office Commun copyright and full MIT text from Cedar's LICENSE. However, packaging stages desktop dist, desktop resources, server dist, and explicitly generated package/dependency content; it does not copy this new repository-root notice. Runtime-resource staging only copies desktop resources. `rg 'THIRD_PARTY_NOTICES|Office Commun' apps/desktop scripts packages` returned no references.
- `desktop-bundle-files.ts` starts with `**/*`, but this only packages the staged tree, so it cannot include an unstaged repository-root file.
- Stage the notice into the shipped app and assert its presence in artifact verification. The notice currently also describes password decryption/import records beyond this inventory-only change; qualify provenance precisely or update it as those ports land. No signed or packaged artifact was built in this review.

## Catalog, counts, contracts, runtime assessment

- Data-root cross-check: Chromium's official user-data documentation supports Chrome channels and Chromium roots: https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md . Apple's browser registry supports the catalog roots for Chrome channels, Edge, Brave, Arc, Dia, Vivaldi, Helium, Comet, Chromium-compatible builds, and the Opera distinction above.
- Expected macOS bundle IDs: Chrome `com.google.Chrome`; Beta `.beta`; Dev `.dev`; Canary `.canary`; Edge `com.microsoft.edgemac`; Brave `com.brave.Browser`; Arc `company.thebrowser.Browser`; Dia `company.thebrowser.dia`; Vivaldi `com.vivaldi.Vivaldi`; Opera `com.operasoftware.Opera`; GX `com.operasoftware.OperaGX`; Chromium `org.chromium.Chromium`; Helium `net.imput.helium`; Comet `ai.perplexity.comet`. These match Apple's registry. Aside was verified directly as `at.studio.AsideBrowser` in `/Applications/Aside.app/Contents/Info.plist`.
- Locally present conventional bundles verified: Google Chrome 154.0.8037.98, Helium 0.19.2.1, Aside 1.0.928.1. Aside and Helium data roots with Default folders exist. Chrome data root exists but no Default folder; no private profile names, credentials, or browser database contents were inspected.
- Catalog detection does not actually use bundle IDs. Any directory with the expected `.app` filename qualifies, and renamed apps, app symlinks, or apps elsewhere are omitted. Standard `/Applications` and `~/Applications` locations are supported after the home bug is fixed. This is an explicit detection limitation, not proof that all catalog apps were tested live.
- Cookie count counts all rows, including expired cookies; it is a stored-row count, not a count of usable sessions. Password count excludes blocklisted and empty encrypted values, but is not a count of successfully decryptable/importable passwords. These semantics should remain explicit when UI is added. Other stores such as account-scoped credentials are not covered.
- Only Cookies or Login Data qualifies a profile. A profile containing only bookmarks/history is omitted. This is acceptable only as the declared credentials-inventory slice; it does not yet satisfy the full sessions/bookmarks/history/passwords importer.
- Guest/System profile directories are excluded and symlink leaf/profile entries are rejected by lstat/Dirent checks. No claim of full ancestor-symlink containment was established.
- `readLocalState` falls back on malformed JSON. `isDefault` uses first last-used/active entry, so absent Local State yields no default even for a lone Default profile (seen in probe). Define whether this means recommended/last-used or actual Default directory before UI depends on it.
- Browser inventory IDs are deliberately separate from import-capable `BrowserCookieSource`, which avoids silently widening import authorization. Caller still needs a future capability model to determine supported import categories. Shared schemas contain data only.
- IPC uses the existing trusted-renderer/main-frame check and cleanup loop. Static wiring is complete. Existing IPC test does not invoke or specifically test authorization for the new inventory method; BrowserCookieImport tests likewise do not cover the new integration call.
- `DatabaseSync(...,{readOnly:true,timeout:100})` is supported by installed Electron 43.4.1 / Node 24.18.1 / SQLite 3.53.1. Both query smoke and inventory synthetic probe succeed under `ELECTRON_RUN_AS_NODE=1`. This establishes installed runtime API compatibility, not packaged GUI end-to-end behavior or all supported platforms.
- WAL probe held an open writer with committed rows in WAL; inventory counted two rows correctly and the main DB SHA-256 was unchanged. It did not decrypt credentials. Auxiliary WAL/SHM metadata immutability was not claimed. Existing busy-lock test passed.
- Synchronous SQLite work runs on Electron's main thread. The 100 ms busy timeout is per store and does not bound query CPU duration; many profiles/locked stores can accumulate delay. No realistic-volume latency benchmark was run.

## Exact checks and results

| Check | Result |
| --- | --- |
| `git status --short`, `git diff --stat`, `git diff` | Inspected eight changed/untracked files; final status unchanged by reviewer |
| `bun run --cwd apps/desktop test src/browserAutomation/chromiumProfileInventory.test.ts src/browserVaultIpc.test.ts src/browserAutomation/browserCookieImport.test.ts` | First sandbox attempt failed: `listen EPERM: operation not permitted 127.0.0.1`; authorized normal-permission retry passed: 3 files, 29 tests, 1.29 s |
| `/opt/homebrew/bin/node /private/tmp/synara-round2-probe.mjs` | Exit 0; reproduced Opera false no_profiles, EACCES global rejection, inaccessible peer erasure; WAL count 2 and DB unchanged |
| `ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /private/tmp/synara-round2-probe.mjs` | Exit 0; same four outcomes |
| Electron `-e` version/SQLite read-only timeout query | Exit 0; SELECT returned 1; Electron 43.4.1 / Node 24.18.1 / SQLite 3.53.1 |
| Root notice vs Cedar LICENSE | Copyright/full MIT text match; no staging reference found |
| App Info.plist and data-root existence checks | Chrome/Helium/Aside conventional app paths verified; only path existence inspected |

Electron commands emitted a macOS `task_name_for_pid` codesign diagnostic but exited 0. Direct TS probes emitted MODULE_TYPELESS_PACKAGE_JSON warnings. These were not query failures.

Not run by reviewer: workspace fmt/lint/typecheck/full tests, application build, signed package, full preload-to-main runtime invocation, actual browser import/decryption. Parent can report its independent final checks separately. No unsupported claim that fixtures prove live browser imports.

## Files inspected

Repository paths relative to `/Users/user/.codex/worktrees/browser-cookie-import/synara`:

- `AGENTS.md`, `CONTRIBUTING.md`, `.mise.toml`, root `package.json`.
- `apps/desktop/package.json`, `apps/desktop/tsdown.config.mts`.
- `apps/desktop/src/browserAutomation/chromiumProfileInventory.ts` (full), `chromiumProfileInventory.test.ts` (full), `browserCookieImport.ts` (full).
- `apps/desktop/src/browserVaultIpc.ts` (full), `browserVaultIpc.test.ts` (full), `ipcChannels.ts` (changed sections), `preload.ts` (changed sections), `main.ts` (construction call chain).
- `packages/contracts/src/browserVault.ts` (changed schema/interface sections).
- `THIRD_PARTY_NOTICES.md` (full).
- `scripts/build-desktop-artifact.ts` (staging/config sections and searches), `scripts/lib/desktop-platform-build-config.ts` (config/file-list sections), `scripts/lib/desktop-bundle-files.ts` (full), `scripts/lib/desktop-runtime-resources.ts` (full).
- `patches/betterwright@2.7.3.patch` (catalog search hits).

External/local reference files: `/Users/user/cedar/Sources/Search/Import.swift` (catalog/import sections), `/Users/user/cedar/LICENSE` (full); `/Applications/Google Chrome.app/Contents/Info.plist`, `/Applications/Helium.app/Contents/Info.plist`, `/Applications/Aside.app/Contents/Info.plist` (identity/version only); `/Users/user/.codex/memories/MEMORY.md` (browser-import acceptance/history lines 25-38, used only for context). BrowserCookieImport.test.ts was executed as part of focused checks; not fully read.

## Visual assessment

Visual/screenshots compared: **none**. Backend inventory is not wired into UI. **Visual ranking: not applicable.** No visual acceptance or finished onboarding claim is warranted.

Verdict: **REQUEST CHANGES**, primarily because production inventory is pointed at the wrong home, with reproduced error-isolation and Opera-layout defects in addition.
