// FILE: ThreadErrorBanner.test.tsx
// Purpose: Guards the thread error banner's provider-quarantine recovery action.
// Layer: Component rendering tests
// Depends on: the banner component and React server rendering.

import { formatProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

const blockedError = formatProviderDeliveryBlockDetail(
  "External provider command claim expired without a durable acceptance result; execution was not replayed.",
);

describe("ThreadErrorBanner", () => {
  it("offers the unblock action for a provider-delivery quarantine", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={blockedError} onDismiss={() => {}} onUnblock={() => {}} />,
    );

    expect(markup).toContain("Unblock thread");
    expect(markup).toContain("Dismiss error");
  });

  it("disables the action while unblocking", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={blockedError} onUnblock={() => {}} unblocking />,
    );

    expect(markup).toContain("Unblocking");
    expect(markup).toContain("disabled");
  });

  it("hides the action for unrelated thread errors", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="The provider rejected the prompt."
        onDismiss={() => {}}
        onUnblock={() => {}}
      />,
    );

    expect(markup).toContain("The provider rejected the prompt.");
    expect(markup).not.toContain("Unblock thread");
  });

  it("renders nothing without an error", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} onUnblock={() => {}} />)).toBe("");
  });
});
