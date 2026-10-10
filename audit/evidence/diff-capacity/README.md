# Checkpoint diff capacity recovery

Synthetic browser fixtures from `apps/web/src/components/DiffPanel.capacity.browser.tsx`.
No live workspace, provider, or conversation data is used.

| Before (`8599826d`)               | After, waiting for capacity                | After, automatically recovered          |
| --------------------------------- | ------------------------------------------ | --------------------------------------- |
| ![Raw capacity error](before.png) | ![Muted delayed status](after-delayed.png) | ![Recovered patch](after-recovered.png) |

The baseline browser test shows the raw red capacity error in the Last turn view.
The same API rejection with the fix shows a muted status and automatically loads
the patch after the mock stops rejecting, without a reload, focus, or reconnect.
Separate browser cases cover All turns and retaining parsed and raw patches while
a refresh is delayed or in flight.

## Regression evidence

- Before implementation: `providerReactQuery.test.ts` had 7 failing capacity
  regressions and 12 passing existing tests.
- With the baseline production files restored temporarily, all 4 new browser
  regressions failed because the delayed status was absent. The sources were
  restored to the fixed implementation after that run.
- After implementation: 47 focused unit tests and 6 browser tests passed.
- Workspace formatting, lint, and typecheck passed. Lint reported 520 warnings
  and zero errors; typecheck completed all 7 workspace tasks.

Commands run from the worktree root with Bun 1.4.2:

```powershell
bun run --cwd apps/web test -- src/lib/providerReactQuery.test.ts
bun run --cwd apps/web test -- src/lib/providerReactQuery.test.ts src/lib/expensiveReadRetry.test.ts src/components/DiffPanel.logic.test.ts
$env:VITEST_BROWSER_API_PORT = '51274'
bun run --cwd apps/web test:browser -- src/components/DiffPanel.capacity.browser.tsx --testTimeout 10000
bun run --cwd apps/web test:browser -- src/components/DiffPanel.capacity.browser.tsx src/components/DiffPanel.browser.tsx src/components/WorkspaceFilePreview.capacity.browser.tsx
bun fmt . '!output/**' '!tmp/**'
bun lint
bun typecheck
```

The 10-second browser timeout was used only for the expected baseline failures.
Port 51274 avoids an existing listener on the default browser-test port. Formatting
excluded two preexisting, untracked artifact folders unrelated to this change.
