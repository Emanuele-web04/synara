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

  it.each(["responding", "compacting", "uncertain"] as const)(
    "disables every response during %s",
    async (status) => {
      const onRespond = vi.fn();
      const screen = await render(
        <ComposerClaudeCacheReviewPanel
          review={makeReview({ status })}
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
        expect(onRespond).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

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
