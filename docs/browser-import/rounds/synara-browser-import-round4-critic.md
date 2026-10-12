# Synara browser import — Round 4 critic

## Verdict: REVISE

- The duplicate policy matches Cedar's host-plus-username identity and chooses the newest usable row.
- The count and row read share a SQLite transaction snapshot; rows are streamed, and the 50,000-row cap is checked before reading password blobs.
- PBKDF2 is derived once per profile.
- The implementation has no production caller, Keychain acquisition, vault write path, or user-facing consent/import flow. Users cannot import passwords yet.

**Single biggest remaining gap:** production integration for password import, including secure key acquisition and no-overwrite vault persistence.

## Files inspected

- `apps/desktop/src/browserAutomation/chromiumPasswordReader.ts`
- `apps/desktop/src/browserAutomation/chromiumPasswordReader.test.ts`
- `apps/desktop/src/browserAutomation/chromiumProfileInventory.ts`
- `apps/desktop/src/browserAutomation/browserVault.ts`
- `apps/desktop/src/browserVaultIpc.ts`
- `apps/web/src/components/BrowserVault.tsx`
- `apps/web/src/components/BrowserCookieImport.tsx`
- `packages/contracts/src/browserVault.ts`
- Cedar `Sources/Search/Import.swift`
- Cedar `Sources/Search/Vault.swift`

## Verification

The critic did not run a live-browser test. In the implementation environment, the focused reader test passed (3 tests), and changed-file formatting passed. Desktop typecheck remains blocked by missing installed `undici` types.
