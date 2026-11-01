import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { makeUsageLimitRecovery } from "../../storeTestFixtures";
import { makeQueuedTurn } from "../../composerDraftStoreTestFixtures";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerQueuedHeader } from "./ComposerQueuedHeader";
import { ComposerUsageLimitRecovery } from "./ComposerUsageLimitRecovery";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("host-owned recovery capsule", () => {
  it("shows the host deadline and only sends cancellation when requested", async () => {
    const onCancel = vi.fn();
    const recovery = makeUsageLimitRecovery({
      resetAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await render(<ComposerUsageLimitRecovery recovery={recovery} onCancel={onCancel} />);
    expect(page.getByTestId("composer-usage-limit-recovery").element().textContent).toContain(
      "Usage limit · resumes at",
    );
    expect(onCancel).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Cancel auto-resume" }).click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each(["waiting", "resuming"] as const)(
    "never invents a running turn after the deadline (%s)",
    async (state) => {
      const onCancel = vi.fn();
      await render(
        <ComposerUsageLimitRecovery
          recovery={makeUsageLimitRecovery({ state, resetAt: "2026-01-01T00:00:00.000Z" })}
          onCancel={onCancel}
        />,
      );
      expect(page.getByTestId("composer-usage-limit-recovery").element().textContent).toContain(
        state === "resuming" ? "Continuing on your computer" : "waiting for computer",
      );
      expect(onCancel).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("button", { name: "Resume now" }))
        .not.toBeInTheDocument();
    },
  );
});

it("keeps queued follow-ups editable while disabling Resume and Steer during a host wait", async () => {
  const recovery = makeUsageLimitRecovery();
  await render(
    <ComposerColumnFrame>
      <ComposerQueuedHeader
        queuedTurns={[makeQueuedTurn("held-draft")]}
        pause={{ reason: "usage-limit", turnId: recovery.turnId }}
        onResume={vi.fn()}
        onEditPaused={vi.fn()}
        onSteer={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        resumeDisabled
      />
    </ComposerColumnFrame>,
  );
  expect(
    (page.getByRole("button", { name: "Resume", exact: true }).element() as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (page.getByRole("button", { name: "Steer", exact: true }).element() as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (page.getByRole("button", { name: "Edit", exact: true }).element() as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
