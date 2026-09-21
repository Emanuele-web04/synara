// FILE: ComposerPendingApprovalPanel.browser.tsx
// Purpose: Browser regression coverage for the detached approval decision card.
// Layer: Chat composer UI browser test
// Depends on: ComposerPendingApprovalPanel and vitest-browser-react.

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

const APPROVAL_REQUEST_ID = ApprovalRequestId.makeUnsafe("approval-test-1");
const LIFECYCLE_GENERATION = "generation-test-1";

type ApprovalResponder = (
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  lifecycleGeneration?: string,
  requestKind?: ProviderRequestKind,
) => Promise<void>;

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: APPROVAL_REQUEST_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    requestKind: "command",
    createdAt: "2026-07-03T01:00:00.000Z",
    detail: 'Bash: {"command":"bun run test"}',
    ...overrides,
  };
}

async function mountApprovalPanel(input?: {
  approval?: PendingApproval;
  isResponding?: boolean;
  onRespond?: ApprovalResponder;
}) {
  const onRespond =
    input?.onRespond ??
    vi.fn(
      async (
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
        _lifecycleGeneration?: string,
        _requestKind?: ProviderRequestKind,
      ) => undefined,
    );
  let approval = input?.approval ?? makeApproval();
  let isResponding = input?.isResponding ?? false;
  const renderPanel = () => (
    <ComposerPendingApprovalPanel
      approval={approval}
      pendingCount={1}
      isResponding={isResponding}
      onRespond={onRespond}
    />
  );
  const screen = await render(renderPanel());

  return {
    onRespond,
    rerender: async (update: { approval?: PendingApproval; isResponding?: boolean }) => {
      approval = update.approval ?? approval;
      isResponding = update.isResponding ?? isResponding;
      await screen.rerender(renderPanel());
    },
    cleanup: async () => {
      await screen.unmount();
    },
  };
}

describe("ComposerPendingApprovalPanel", () => {
  it("explains task consent and keeps it separate from provider session approval", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({
        requestKind: "tool",
        approvalScope: "computer-task",
        toolName: "computer_click",
      }),
    });
    try {
      await expect.element(page.getByText(/^Allow Computer for this task\?/)).toBeInTheDocument();
      await expect.element(page.getByText(/Stop cancels access/)).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /Always allow this session/ }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: /Allow Computer for this task/ }).click();
      expect(mounted.onRespond).toHaveBeenCalledExactlyOnceWith(
        APPROVAL_REQUEST_ID,
        "accept",
        LIFECYCLE_GENERATION,
        "tool",
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it.each([
    ["Approve once", "accept"],
    ["Always allow this session", "acceptForSession"],
    ["Decline", "decline"],
    ["Cancel turn", "cancel"],
  ] as const)("sends %s as an approval decision", async (label, decision) => {
    const mounted = await mountApprovalPanel();

    try {
      await page.getByRole("button", { name: new RegExp(label, "u") }).click();

      expect(mounted.onRespond).toHaveBeenCalledTimes(1);
      expect(mounted.onRespond).toHaveBeenCalledWith(
        APPROVAL_REQUEST_ID,
        decision,
        LIFECYCLE_GENERATION,
        "command",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the request kind prompt and parsed command detail", async () => {
    const requestKind: ProviderRequestKind = "command";
    const mounted = await mountApprovalPanel({
      approval: makeApproval({ requestKind }),
    });

    try {
      await expect.element(page.getByText("Approve this command?")).toBeInTheDocument();
      await expect.element(page.getByText("bun run test")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides session approval when the provider cannot persist it", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({ sessionApprovalAvailable: false }),
    });

    try {
      await expect.element(page.getByRole("button", { name: /Approve once/u })).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /Always allow this session/u }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits a request only once while its first response is still pending", async () => {
    let resolveResponse: (() => void) | undefined;
    const pendingResponse = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const onRespond = vi.fn(() => pendingResponse);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = page.getByRole("button", { name: /Approve once/u });
      await approve.click();
      await approve.click();

      expect(onRespond).toHaveBeenCalledTimes(1);
    } finally {
      resolveResponse?.();
      await pendingResponse;
      await mounted.cleanup();
    }
  });

  it("shares the same synchronous claim between keyboard and click", async () => {
    let resolveResponse: (() => void) | undefined;
    const pendingResponse = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const onRespond = vi.fn(() => pendingResponse);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = document.querySelector<HTMLButtonElement>("button");
      expect(approve).not.toBeNull();
      approve!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      approve!.click();

      expect(onRespond).toHaveBeenCalledTimes(1);
    } finally {
      resolveResponse?.();
      await pendingResponse;
      await mounted.cleanup();
    }
  });

  it("allows a retry after the response callback rejects", async () => {
    const onRespond = vi
      .fn<ApprovalResponder>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(undefined);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = page.getByRole("button", { name: /Approve once/u });
      await approve.click();
      await expect.poll(() => onRespond.mock.calls.length).toBe(1);
      await approve.click();

      expect(onRespond).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("allows one new submission when a newer durable attempt becomes retryable", async () => {
    const onRespond = vi.fn<ApprovalResponder>().mockResolvedValue(undefined);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = page.getByRole("button", { name: /Approve once/u });
      await approve.click();
      await approve.click();
      expect(onRespond).toHaveBeenCalledTimes(1);

      await mounted.rerender({
        approval: makeApproval({ responseAttemptKey: "response-attempt-2" }),
      });
      await approve.click();
      await approve.click();

      expect(onRespond).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });
});
