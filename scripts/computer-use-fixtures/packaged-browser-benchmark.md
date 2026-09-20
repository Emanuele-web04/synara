# Packaged browser benchmark

This runner attaches to one explicitly selected isolated **Synara Cua** package. It does not launch the application, install Chrome, change permissions, borrow account cookies, or select a provider/model for the operator. Run the existing [packaged fixture](packaged-e2e.md) first to establish its isolated instance marker, configured provider, pinned native artifact and focus-observation permissions.

Use the installed `~/Applications/Synara Cua.app` copy prepared by that recipe.
Before attaching or starting a provider turn, the runner refuses temporary app
paths and requires LaunchServices to resolve the bundle ID to the exact selected
copy. Registration is a setup requirement, not proof of native permission grants.

The existing-user-profile task is unsupported. `--task github-running` reports that result without creating a provider thread. `github-isolated` is a separately labeled Chrome comparison; it never represents the existing Dia profile test.

```sh
bun scripts/computer-use-fixtures/packaged-browser-benchmark.ts \
  --task github-isolated --repo OWNER/REPO \
  --bundle "$HOME/Applications/Synara Cua.app" \
  --home /explicit/isolated/synara-home --cdp-port 9332 \
  --focus-probe /explicit/path/focus-probe \
  --provider PROVIDER --model MODEL \
  --observer-dir /explicit/isolated/observer-descriptors \
  --profile-root '/explicit/CuaDriver/BrowserProfiles'
```

Choose the provider/model explicitly. Optional `--model-options` accepts the model options JSON defined by the selected provider's contract. The runner defaults to two sequential fresh threads with new named Chrome profiles. Use `--runs 1` for a single-run smoke or `--runs 2` for the original two-run qualification; no other run count is accepted. A passing smoke does not meet the original two-run qualification. Each run keeps the fixed 120-second budget for GitHub or 900 seconds for `--task newegg`. It revokes Computer and interrupts on budget expiry, unexpected approval, observed focus change, checkout navigation, or a runner termination signal. A failed cleanup stops subsequent runs. A hung or interrupted turn cannot pass, and missing any requested run fails the summary.

Before spending provider tokens, setup checks passive Computer availability and complete focus observation. It accepts an available host whose input listener is intentionally idle. If the fresh isolated provider cache is empty, it waits up to 45 seconds only for the selected provider to appear; a known unavailable or unauthenticated entry still fails. This discovery wait is outside the measured turn. Each owned benchmark thread explicitly receives chat-mode Computer authority, which is revoked at completion; the harness does not depend on plain-text prompts activating `/computer-use`, and it never substitutes a different provider/model.

Before control enable or dispatch, every fresh thread must expose its durable creation event and explicit empty runtime coverage through the authenticated diagnostic route. Null/malformed responses, a prior dispatch or existing provider runtime state fail setup before a paid turn. Runtime retention is already enabled; no extra NDJSON logging or direct database access is needed. Early failures collect terminal evidence after bounded cancellation so available call/usage diagnostics are retained without qualifying an interrupted run.

The observer directory receives `request-synara-bench-UUID.json` immediately before each task. A trusted local operator must supply the exact matching descriptor at the `descriptorPath` in that request after the driver launches its browser:

```json
{
  "profileName": "synara-bench-UUID",
  "profileDirectory": "/explicit/CuaDriver/BrowserProfiles/synara-bench-UUID",
  "browserPid": 12345,
  "endpoint": "http://127.0.0.1:9333"
}
```

Use only the newly created driver-owned Chrome process and the requested profile. The observer verifies the exact profile directory, fresh `DevToolsActivePort`, PID command line and loopback listening socket. It does not scan profiles. Keep the descriptor outside model-visible prompts. The observer uses fixed, read-only page queries; it never navigates, clicks, attaches user sessions, or reads account cookies. An absent descriptor makes task evidence unverified. Observation adds some local CPU and browser work; comparisons must use the same observer cadence and focus sampler.

GitHub verification requires an unchanged public API reference before/after, independently observed inventories of both requested browser pages, and an exact structured answer. Public API failure, dynamic list changes or missed page observation make the outcome unverified. No token or authenticated API fallback is used. The provider must still perform the browser task itself.

Newegg stops at the cart and forbids sign-in, personal/payment details, checkout, order submission and purchases. Account routes are excluded from DOM observation. The read-only validator requires two stable cart observations after the provider turn ends, canonical retailer item IDs, quantities, explicit USD currency, unit prices, subtotal reconciliation and coverage of every rendered cart row. A bare `$` without an observed currency is ambiguous. Unlabeled prices for quantities above one are also ambiguous. Missing/changed/virtualized content, unsupported page markup, discounts that prevent reconciliation and unavailable product specifications remain unverified.

Required category coverage is CPU, motherboard, discrete graphics, desktop memory, internal storage, PSU and case, plus a separate cooler or an explicitly included CPU cooler. Categories come from the same item ID's observed retailer product breadcrumbs; model claims and words in a cart title are insufficient. The historical eight-part baseline is not an exact-count requirement. Taxonomy or specification panels must actually have been rendered during the run; the observer never opens them or performs the provider's shopping task.

Compatibility is reported separately as matched, mismatched or unknown for explicit listed checks: CPU/motherboard socket, RAM DDR standard, case/motherboard form factor, GPU recommended PSU, GPU length, cooler socket and air-cooler height. Observed mismatches, unavailable stock, an incomplete observed component set or a subtotal above $3000 fail. Unknown facts remain unverified. A verified result is limited to the observed cart, merchandise budget and these listed fit checks. It does **not** prove 1440p frame rates, BIOS/QVL, storage lane/slot availability, PSU cables/transients, radiator/RAM clearance, shipping/tax or a successfully assembled machine. Liquid cooling configurations need additional radiator/mount evidence and remain unverified with this narrow checker.

The observer is a measurement tool; prompts and observed checkout interruption are not a transaction prevention boundary. The existing isolated browser may remain open after its Computer control grant is revoked.

The summary records `requestedRuns`, `completedRuns`, `runMode` and `twoRunQualificationPassed`; a one-run smoke always leaves the last field false.

Evidence is written with restricted permissions to `HOME/browser-evidence-TIMESTAMP`. Each run separates task outcome, continuous focus proof, bounded provider diagnostics and mutation audit coverage. Usage is split into input/output/cache counters without adding cached input twice. Mutation refusals are grouped by structured code; read-only refusal coverage is not claimed. Audit counts never prove action delivery or task completion. First-page and terminal timings use monotonic receipt clocks and include polling; exact native click timing remains unverified. Physical Escape, Dock/window flashes, other providers, CPU/RAM and signed-release qualification remain separate gates.
