# Thread title refresh

Automatic title refresh is off by default. In Settings → Behavior, choose **Off**,
**Suggested**, or **Automatic** under Thread titles. A project or thread can
choose an override; **Inherit** uses the next broader setting. Both Stable and
Beta keep this policy and its state in their own data home.

Suggested mode displays a candidate above the composer for explicit acceptance
or dismissal. Automatic mode can rename a settled conversation after at least
five new user turns and ten minutes since its previous attempt. The default rate
limit is three attempts per hour. A manual rename pins the title, and a rename
made while generation is running takes precedence over the late result.

Refresh uses the existing configured text-generation provider and account
routing. It does not select a new provider or model. The prompt contains bounded,
quoted reference text from the title and recent user intent; recognized sensitive
patterns use the shared redactor. These values remain untrusted data and cannot
authorize tools or override approval and filesystem boundaries. Automatic refresh
does not fall back to broader assistant or tool content when bounded intent is
unavailable. Redaction is pattern-based and is not a guarantee that arbitrary
private text can be recognized.

The additive migration preserves existing titles and starts with no automatic
refresh policy on legacy projects or threads. Signed desktop and live-provider
behavior require separate validation; source and fixture checks do not prove it.

During onboarding, title refresh remains Off unless the user explicitly selects Suggested or Automatic. Manual renames clear pending candidates and pin the title. Explicit regeneration releases the pin even when the generated title is unchanged. Background generation runs in the reactor scope without blocking terminal event delivery; shutdown cancels it. Automatic generation rechecks effective policy after completion and discards results after opting out.
