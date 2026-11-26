// Adapted to Synara's shared browser from BetterWright's full-stack-e2e-review
// workflow: https://github.com/BetterWright/betterwright/tree/main/skills/full-stack-e2e-review
export const SYNARA_E2E_REVIEW_GUIDANCE = `
When the user explicitly requests an E2E/end-to-end test or review, follow this workflow. A discussion about E2E testing is not a request to run it.
1. Read repository instructions; identify the exact feature, running target, test fixtures and allowed side effects. Build a short journey matrix with passed, failed, blocked or not-applicable outcomes. Do not seed/reset production or shared data.
2. Use the provider-native subagent/Task capability to delegate a bounded E2E verification lane. Give it exact URLs, fixtures, roles, steps, expected outcomes, prohibited side effects and required screenshot evidence. Use a subagent, not a new Synara task. If native delegation is unavailable, say so and test directly; never pretend a subagent ran.
3. One agent owns the shared embedded browser at a time. While the child tests, the parent can inspect code or run local tests, but must not drive that browser concurrently. All tabs share the user's login session; test different identities sequentially with test accounts, never assume tab isolation.
4. Use browser_* for real visible interactions, one focused action per call. Verify state after each important action, persistence after reload, negative/permission cases, loading/error recovery and desktop/mobile layout where relevant. Use the project's test runner for durable E2E tests and viewport matrices, not shell-launched replacements for the embedded browser. Respect repository restrictions on commands. A screenshot or passing unit suite alone is not an E2E pass.
5. Inspect final-state screenshots; use browser_screenshot kind:proof for important completed flows. Do not capture exposed secrets. Child returns scope, exact commands and counts, findings, proof paths and untested areas. Wait for the child, verify its evidence, fix authorized failures and rerun affected paths.
iOS apps (device_* tools; the same delegation, proof and reporting rules apply):
- Build the exact scheme with the project's own tooling, then device_install and device_launch with restart: true, so the run starts from a known process. Pass test flags through launch environment.
- Remove nondeterminism first: device_configure for appearance, Dynamic Type, location and privacy grants, so no permission prompt interrupts a journey. Answer prompts it cannot pre-grant (notifications, camera) with device_tap.
- One owner drives the simulator at a time, like the browser. Prefer identifier taps over labels, which change with locale and copy, and coordinates last.
- Every input returns the settled screen: read the asserted text, values and toggle states from it. screenChanged: false means the step did nothing; settled: false means it is still loading, so device_wait for the expected element rather than repeating the input.
- Check persistence with device_launch restart: true, and failures with device_logs (unified log, print output, crash reports) before concluding.
- Capture device_screenshot proof: true for completed journeys and embed its artifactPath.
6. Finish with a completion report in this chat: outcome, journeys tested, commands/results, bugs fixed or remaining, and explicit limitations. Embed inspected proof images using ![Result description](/absolute/artifactPath.png). Report failures and blocked steps honestly; never present simulated or untested flows as verified.
`;
