// FILE: useThreadErrorToast.test.ts
// Purpose: Guards the thread error toast payload and its quarantine recovery action.
// Layer: Chat status presentation tests
// Depends on: the toast option builder and the provider-delivery block format.

import { ThreadId } from "@synara/contracts";
import { formatProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { describe, expect, it } from "vitest";

import {
  buildThreadErrorToastOptions,
  decideThreadErrorToastAction,
  threadErrorToastId,
} from "./useThreadErrorToast";

const threadId = ThreadId.makeUnsafe("11111111-1111-4111-8111-111111111111");

const blockedError = formatProviderDeliveryBlockDetail(
  "External provider command claim expired without a durable acceptance result; execution was not replayed.",
);

function build(error: string, unblocking = false) {
  return buildThreadErrorToastOptions({
    error,
    threadId,
    unblocking,
    onClose: () => {},
    onUnblock: () => {},
  });
}

describe("buildThreadErrorToastOptions", () => {
  it("renders a persistent error toast scoped to its thread", () => {
    const options = build("The provider rejected the prompt.");

    expect(options.id).toBe(threadErrorToastId(threadId));
    expect(options.type).toBe("error");
    expect(options.title).toBe("The provider rejected the prompt.");
    expect(options.timeout).toBe(0);
    expect(options.data).toMatchObject({
      copyText: "The provider rejected the prompt.",
      threadId,
    });
  });

  it("offers the unblock action for a provider-delivery quarantine", () => {
    expect(build(blockedError).actionProps).toMatchObject({ children: "Unblock thread" });
  });

  it("disables the action while unblocking", () => {
    expect(build(blockedError, true).actionProps).toMatchObject({
      children: "Unblocking…",
      disabled: true,
    });
  });

  it("hides the action for unrelated thread errors", () => {
    expect(build("The provider rejected the prompt.").actionProps).toBeUndefined();
  });
});

describe("decideThreadErrorToastAction", () => {
  const error = "Provider adapter request failed (grok): connect ETIMEDOUT";

  it("keeps the hydrated stored error off the toast surface", () => {
    expect(
      decideThreadErrorToastAction({ previous: undefined, error, liveToastOpen: false }),
    ).toBe("none");
  });

  it("toasts when the stored error changes under a mounted thread", () => {
    expect(
      decideThreadErrorToastAction({ previous: "an earlier failure", error, liveToastOpen: false }),
    ).toBe("toast");
    expect(
      decideThreadErrorToastAction({ previous: null, error, liveToastOpen: false }),
    ).toBe("toast");
  });

  it("does not re-toast the same stored value on re-render", () => {
    expect(
      decideThreadErrorToastAction({ previous: error, error, liveToastOpen: false }),
    ).toBe("none");
  });

  it("refreshes in place while a live toast is already open", () => {
    expect(
      decideThreadErrorToastAction({ previous: error, error, liveToastOpen: true }),
    ).toBe("refresh");
  });
});
