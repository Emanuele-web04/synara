# Synara browser import — Round 7 critic

**Verdict:** ACCEPT for the Round 7 UI and vault-access slice only.

## Final recheck

No remaining P0, P1, or P2 issue was identified in the current diff.

- Vault state subscribes to `api.onChanged`; request sequencing prevents stale snapshots from overwriting newer protection state; password import remains disabled until vault protection has been checked.
- Session refresh retains prior selection values and clears the previous consent.
- The prior issues were addressed: inline vault setup/unlock, persistent Settings panel state and navigation blocking, a desktop-only explanation on web, an explicit Safari Settings test flow, and inventory retry states.
- Added UI tests cover inline vault setup, external unlock notification, and refresh after consent.

## Earlier findings and response

The first review returned REVISE:

1. First-run password import could not set up or unlock Saved Logins. Reused the existing `BrowserVaultMaster` control and added an access-state gate.
2. Leaving Settings categories discarded progress while the import loop continued. Kept General mounted but hidden and blocked navigation during active imports.
3. Browser import rendered nothing in ordinary web mode. Added a desktop capability explanation.
4. A Safari browser test still depended on automatic startup presentation. Updated it to open the manual Settings entry.
5. Discovery errors had no retry path. Added refresh and distinct loading, empty, and failure states.

The second review found stale protection state after unlock through another control, and refresh retaining consent while reselecting profiles. Added vault-change subscription and stale-response protection; refresh now preserves choices and resets consent.

## Evidence and limitations

- `git diff --check` passed.
- The implementer reported web typecheck, 21 onboarding logic tests, and 33 browser UI tests passing. The critic inspected the added tests but did not rerun them.
- The 33 browser tests used the installed Google Chrome binary in an isolated Playwright context because the configured Playwright headless-shell executable was missing.
- No live Synara import, actual browser profile, Cedar screenshot, or Synara screenshot was tested or compared in this review. Visual ranking: not performed.

## Files inspected

- `apps/web/src/components/BrowserImportPanel.tsx`
- `apps/web/src/components/BrowserSessionImport.tsx`
- `apps/web/src/components/BrowserPasswordImport.tsx`
- `apps/web/src/components/BrowserVaultMaster.tsx`
- `apps/web/src/components/BrowserVault.tsx`
- `apps/web/src/components/BrowserVault.browser.tsx`
- `apps/web/src/components/SafariAccessOnboarding.tsx`
- `apps/web/src/components/SafariAccessOnboarding.browser.tsx`
- `apps/web/src/onboarding/OnboardingDialog.tsx`
- `apps/web/src/onboarding/logic.ts`
- `apps/web/src/onboarding/OnboardingStepFooter.tsx`
- `apps/web/src/routes/_chat.settings.tsx`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/nativeApi.ts`
- `apps/web/src/wsNativeApi.ts`
- `apps/desktop/src/browserAutomation/browserPasswordImport.ts`
- `apps/desktop/src/browserAutomation/browserVault.ts`

## Biggest remaining objective gap

There is no one-time import prompt for existing users. Browser discovery and password counts also remain incomplete across the requested browser and OS matrix.
