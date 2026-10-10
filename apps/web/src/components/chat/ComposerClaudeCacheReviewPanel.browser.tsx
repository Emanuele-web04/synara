import { MessageId, type PendingClaudeCacheReview } from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ComposerClaudeCacheReviewPanel } from "./ComposerClaudeCacheReviewPanel";

function makeReview(overrides: Partial<PendingClaudeCacheReview> = {}): PendingClaudeCacheReview {
  return {
    reviewId: "review-1",
    messageId: MessageId.makeUnsafe("saved-message-1"),
    sourceEventSequence: 1,
    assessment: {
      observedAt: "2026-09-16T10:00:00.000Z",
      state: "likely-expired",
      source: "session-start",
      contextTokens: 887_036,
    },
    status: "pending",
    createdAt: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("ComposerClaudeCacheReviewPanel", () => {
  it("confirms an already requested native compact without offering a second compaction", async () => {
    const review = makeReview();
    const onRespond = vi.fn(async () => undefined);
    const screen = await render(
      <ComposerClaudeCacheReviewPanel
        review={review}
        isCompactionRequest
        compactDisabledReason={null}
        onRespond={onRespond}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: /^Compact, then send/ }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: /^Compact this conversation/ }).click();
      expect(onRespond).toHaveBeenCalledExactlyOnceWith(review, "continue");
    } finally {
      await screen.unmount();
    }
  });

  it("submits only the existing review once while waiting for durable state", async () => {
    const review = makeReview();
    const onRespond = vi.fn(async () => undefined);
    const screen = await render(
      <ComposerClaudeCacheReviewPanel
        review={review}
        compactDisabledReason={null}
        onRespond={onRespond}
      />,
    );
    try {
      await page.getByRole("button", { name: /^Continue with full context/ }).click();
      expect(onRespond).toHaveBeenCalledExactlyOnceWith(review, "continue");
      await expect
        .element(page.getByRole("button", { name: /^Continue with full context/ }))
        .toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: /^Compact, then send/ }))
        .toBeDisabled();
      await expect.element(page.getByRole("button", { name: /^Cancel this send/ })).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("preserves the held message and makes a rejected choice retryable", async () => {
    const review = makeReview();
    const onRespond = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValue(undefined);
    const screen = await render(
      <ComposerClaudeCacheReviewPanel
        review={review}
        compactDisabledReason={null}
        onRespond={onRespond}
      />,
    );
    try {
      await page.getByRole("button", { name: /^Compact, then send/ }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Connection unavailable");
      await expect.element(page.getByRole("button", { name: /^Compact, then send/ })).toBeEnabled();
      await page.getByRole("button", { name: /^Compact, then send/ }).click();
      expect(onRespond).toHaveBeenNthCalledWith(1, review, "compact");
      expect(onRespond).toHaveBeenNthCalledWith(2, review, "compact");
    } finally {
      await screen.unmount();
    }
  });

  it.each(["responding"] as const)(
    "leaves progress to the transcript during %s",
    async (status) => {
      const screen = await render(
        <ComposerClaudeCacheReviewPanel
          review={makeReview({ status })}
          compactDisabledReason={null}
          onRespond={vi.fn()}
        />,
      );
      try {
        await expect
          .element(page.getByRole("region", { name: "Claude cache review" }))
          .not.toBeInTheDocument();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("disables every response while the request status is uncertain", async () => {
    const onRespond = vi.fn();
    const previousBridge = window.desktopBridge;
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const reportIssue = vi.fn(async () => "12345678-1234-4234-8234-123456789012");
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        betaDiagnostics: { reportIssue, getReportStatus: async () => "queued" },
      },
    });
    const screen = await render(
      <ComposerClaudeCacheReviewPanel
        review={makeReview({ status: "uncertain" })}
        compactDisabledReason={null}
        onRespond={onRespond}
      />,
    );
    try {
      for (const label of [
        /^Continue with full context/,
        /^Compact, then send/,
        /^Cancel this send/,
      ]) {
        await expect.element(page.getByRole("button", { name: label })).toBeDisabled();
      }
      await expect.element(page.getByText("Report queued locally", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Copy diagnostic ID", exact: true }).click();
      expect(writeText).toHaveBeenCalledExactlyOnceWith("12345678-1234-4234-8234-123456789012");
      expect(reportIssue).toHaveBeenCalledExactlyOnceWith({
        code: "claude.cache.uncertain",
        reason: "unknown",
      });
      expect(onRespond).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      Object.defineProperty(window, "desktopBridge", { configurable: true, value: previousBridge });
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("keeps a rejected choice diagnostic when the earlier review report arrives late", async () => {
    const previousBridge = window.desktopBridge;
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    let resolveEarlier!: (id: string) => void;
    const earlier = new Promise<string>((resolve) => {
      resolveEarlier = resolve;
    });
    const reportIssue = vi.fn().mockReturnValueOnce(earlier).mockResolvedValue("newer-choice-id");
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { betaDiagnostics: { reportIssue, getReportStatus: async () => "queued" } },
    });
    const screen = await render(
      <ComposerClaudeCacheReviewPanel
        review={makeReview({ status: "failed", error: "Compaction failed" })}
        compactDisabledReason={null}
        onRespond={vi.fn().mockRejectedValue(new Error("Choice request failed"))}
      />,
    );
    try {
      await expect.poll(() => reportIssue.mock.calls.length).toBe(1);
      await page.getByRole("button", { name: /^Continue with full context/ }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Choice request failed");
      await expect
        .element(page.getByRole("button", { name: "Copy diagnostic ID", exact: true }))
        .toBeVisible();
      resolveEarlier("older-review-id");
      await earlier;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await page.getByRole("button", { name: "Copy diagnostic ID", exact: true }).click();
      expect(writeText).toHaveBeenCalledExactlyOnceWith("newer-choice-id");
    } finally {
      resolveEarlier("older-review-id");
      await screen.unmount();
      Object.defineProperty(window, "desktopBridge", { configurable: true, value: previousBridge });
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("supports a failed review without offering unavailable compaction", async () => {
    const review = makeReview({ status: "failed", error: "Compaction did not complete." });
    const onRespond = vi.fn(async () => undefined);
    const screen = await render(
      <ComposerClaudeCacheReviewPanel
        review={review}
        compactDisabledReason="Compaction is unavailable for this Claude session."
        onRespond={onRespond}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: /^Compact, then send/ }))
        .toBeDisabled();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Compaction did not complete.");
      await page.getByRole("button", { name: /^Cancel this send/ }).click();
      expect(onRespond).toHaveBeenCalledExactlyOnceWith(review, "cancel");
    } finally {
      await screen.unmount();
    }
  });
});
