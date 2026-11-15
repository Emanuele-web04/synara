import "../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { makeUsageLimitRecovery } from "../../storeTestFixtures";
import { makeQueuedTurn } from "../../composerDraftStoreTestFixtures";

const harness = vi.hoisted(() => ({ supported: true, update: vi.fn() }));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApiServerCapability: () => harness.supported,
  onNativeApiServerCapabilitiesChange: () => () => undefined,
  ensureNativeApi: () => ({ server: { updateSettings: harness.update } }),
}));

import { ComposerCapsuleRow } from "./ComposerCapsule";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerQueuedHeader } from "./ComposerQueuedHeader";
import { ComposerUsageLimitCapsules } from "./ComposerUsageLimitCapsules";

type Props = ComponentProps<typeof ComposerUsageLimitCapsules>;

const clients: QueryClient[] = [];
function mount(overrides: Partial<Props> = {}, settings = DEFAULT_SERVER_SETTINGS_VIEW) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(serverQueryKeys.settings(), settings);
  client.setQueryData(serverQueryKeys.allProviderUsage(), []);
  const props: Props = {
    provider: "claudeAgent",
    instanceId: "claudeAgent",
    rateLimitStatus: null,
    showWarning: true,
    recovery: null,
    onDismissWarning: vi.fn(),
    onCancelRecovery: vi.fn(),
    ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <ComposerCapsuleRow>
        <ComposerUsageLimitCapsules {...props} />
      </ComposerCapsuleRow>
    </QueryClientProvider>,
  );
}

const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const autoResumeChip = () => page.getByTestId("composer-usage-limit-auto-resume");
const limitCapsule = () => page.getByTestId("composer-usage-limit-capsule");

beforeEach(() => {
  harness.supported = true;
  harness.update.mockReset();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  document.body.innerHTML = "";
});

describe("usage-limit capsules", () => {
  it("shows the host deadline and only cancels the wait when asked", async () => {
    const onCancelRecovery = vi.fn();
    await mount({
      recovery: makeUsageLimitRecovery({ resetAt: inOneHour() }),
      onCancelRecovery,
    });
    await expect.element(limitCapsule()).toHaveTextContent("Limit reached");
    await expect.element(autoResumeChip()).toHaveTextContent("Auto-resume");
    expect(onCancelRecovery).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Cancel auto-resume" }).click();
    expect(onCancelRecovery).toHaveBeenCalledOnce();
  });

  it.each(["waiting", "resuming"] as const)(
    "never invents a running turn after the deadline (%s)",
    async (state) => {
      const onCancelRecovery = vi.fn();
      await mount({
        recovery: makeUsageLimitRecovery({ state, resetAt: "2026-01-01T00:00:00.000Z" }),
        onCancelRecovery,
      });
      await expect
        .element(limitCapsule())
        .toHaveTextContent(
          state === "resuming" ? "Continuing on your computer" : "waiting for computer",
        );
      if (state === "resuming") await expect.element(autoResumeChip()).not.toBeInTheDocument();
      expect(onCancelRecovery).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("button", { name: "Resume now" }))
        .not.toBeInTheDocument();
    },
  );

  it("turns the policy on from the chip when no wait is armed", async () => {
    harness.update.mockImplementation(async (patch) => ({
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      ...patch,
    }));
    await mount({ rateLimitStatus: { status: "rejected", resetsAt: inOneHour() } });
    await expect.element(limitCapsule()).toHaveTextContent("Resets in");
    await expect.element(autoResumeChip()).toHaveTextContent("Auto-resume");
    await autoResumeChip().click();
    await vi.waitFor(() =>
      expect(harness.update).toHaveBeenCalledExactlyOnceWith({ autoResumeAfterUsageLimits: true }),
    );
    // The policy cannot arm a turn that already failed; the chip says so instead of pretending.
    await expect.element(autoResumeChip()).toHaveTextContent("Auto-resume unavailable");
  });

  it("hides auto-resume controls on hosts without durable recovery", async () => {
    harness.supported = false;
    await mount({ rateLimitStatus: { status: "rejected", resetsAt: inOneHour() } });
    await expect.element(limitCapsule()).toBeVisible();
    await expect.element(autoResumeChip()).not.toBeInTheDocument();
  });

  it("explains the wait and cancels it from the popover switch", async () => {
    const onCancelRecovery = vi.fn();
    const onChangeModel = vi.fn();
    await mount(
      {
        recovery: makeUsageLimitRecovery({ resetAt: inOneHour() }),
        onCancelRecovery,
        onChangeModel,
      },
      { ...DEFAULT_SERVER_SETTINGS_VIEW, autoResumeAfterUsageLimits: true },
    );
    await limitCapsule().click();
    const popover = page.getByTestId("composer-usage-limit-popover");
    await expect.element(popover).toHaveTextContent("Claude usage limit");
    const always = page.getByRole("switch", { name: "Always resume after limits" });
    expect(always.element().getAttribute("aria-checked")).toBe("true");
    const thisTask = page.getByRole("switch", { name: "Resume this task at reset" });
    expect(thisTask.element().getAttribute("aria-checked")).toBe("true");
    await thisTask.click();
    expect(onCancelRecovery).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Change model" }).click();
    expect(onChangeModel).toHaveBeenCalledOnce();
  });

  it("shows an approaching limit as a dismissible tip only where asked", async () => {
    const onDismissWarning = vi.fn();
    const status = { status: "allowed_warning" as const, utilization: 0.91, resetsAt: inOneHour() };
    const screen = await mount({ rateLimitStatus: status, onDismissWarning });
    const warning = page.getByTestId("composer-usage-limit-warning");
    await expect.element(warning).toHaveTextContent("91% used");
    await expect.element(limitCapsule()).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Dismiss rate limit status" }).click();
    expect(onDismissWarning).toHaveBeenCalledOnce();
    await screen.unmount();
    await mount({ rateLimitStatus: status, showWarning: false });
    await expect.element(page.getByTestId("composer-usage-limit-warning")).not.toBeInTheDocument();
  });
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
