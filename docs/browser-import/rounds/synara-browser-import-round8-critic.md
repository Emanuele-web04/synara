# Synara browser import — Round 8 critic

**Final verdict: ACCEPT** for the existing-installation announcement slice.

The final review confirmed:

- The installation-scoped onboarding signal prevents a step seen on installation A from suppressing the prompt on installation B.
- Discovery results are checked against the active installation, and the A→B test uses the production `server/config` query key.
- Provisional onboarding preserves announcement eligibility until the browser-import step is actually shown.
- The prompt routes through the existing shared sheet and into General Settings, where the shared Browser Import panel is mounted.

The first review returned `REVISE`: it identified provisional onboarding auto-close and an async negative test that could assert too early. The implementation added a step-specific acknowledgment, startup/discovery gating, awaited profile discovery, and lifecycle tests. A second review requested installation identity on the onboarding acknowledgment; the signal now stores the installation key, with an A→B transition test. Final review found no blocking issues.

Review was static; the critic did not edit code or execute tests.
