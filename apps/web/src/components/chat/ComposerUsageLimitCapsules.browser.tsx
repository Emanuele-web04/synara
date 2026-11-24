import "../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { RateLimitStatus } from "~/lib/rateLimitStatus";
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
import {
  ComposerUsageLimitCapsules,
  ComposerUsageLimitCard,
  usageLimitCardKey,
} from "./ComposerUsageLimitCapsules";

type Recovery = ReturnType<typeof makeUsageLimitRecovery>;
interface SceneProps {
  rateLimitStatus?: RateLimitStatus | null;
  recovery?: Recovery | null;
  instanceId?: string;
  showWarning?: boolean;
  onCancelRecovery?: () => void;
  onDismissWarning?: () => void;
  onChangeModel?: () => void;
}

/** Mirrors ChatView: the card opens per limit episode and collapses into the capsule row. */
function Scene({
  rateLimitStatus = null,
  recovery = null,
  instanceId = "claudeAgent",
  showWarning = true,
  onCancelRecovery = () => undefined,
  onDismissWarning = () => undefined,
  onChangeModel,
}: SceneProps) {
  const inputs = { rateLimitStatus, recovery };
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  const key = usageLimitCardKey("thread-1", inputs);
  const cardOpen = key !== null && key !== collapsedKey;
  return (
    <ComposerColumnFrame>
      <ComposerCapsuleRow>
        <ComposerUsageLimitCapsules
          {...inputs}
          showWarning={showWarning}
          cardOpen={cardOpen}
          onOpenCard={() => setCollapsedKey(null)}
          onDismissWarning={onDismissWarning}
          onCancelRecovery={onCancelRecovery}
        />
      </ComposerCapsuleRow>
      {cardOpen ? (
        <ComposerUsageLimitCard
          {...inputs}
          provider="claudeAgent"
          instanceId={instanceId}
          onCollapse={() => setCollapsedKey(key)}
          onCancelRecovery={onCancelRecovery}
          onChangeModel={onChangeModel}
        />
      ) : null}
    </ComposerColumnFrame>
  );
}

const clients: QueryClient[] = [];
function mount(
  props: SceneProps = {},
  settings = DEFAULT_SERVER_SETTINGS_VIEW,
  usage: ReadonlyArray<ServerProviderUsageSnapshot> = [],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(serverQueryKeys.settings(), settings);
  client.setQueryData(serverQueryKeys.allProviderUsage(), usage);
  return render(
    <QueryClientProvider client={client}>
      <Scene {...props} />
    </QueryClientProvider>,
  );
}

const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const limited = (): RateLimitStatus => ({ status: "rejected", resetsAt: inOneHour() });
const card = () => page.getByTestId("composer-usage-limit-card");
const limitCapsule = () => page.getByTestId("composer-usage-limit-capsule");
const autoResumeChip = () => page.getByTestId("composer-usage-limit-auto-resume");
const switchNamed = (name: string) => page.getByRole("switch", { name });

beforeEach(() => {
  harness.supported = true;
  harness.update.mockReset();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  document.body.innerHTML = "";
});

describe("usage-limit card", () => {
  it("opens on its own, collapses into a capsule, and reopens from it", async () => {
    await mount({ rateLimitStatus: limited() });
    await expect.element(card()).toHaveTextContent("Claude usage limit reached");
    await expect.element(card()).toHaveTextContent("Resets in");
    await expect.element(limitCapsule()).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Collapse usage limit details" }).click();
    await expect.element(card()).not.toBeInTheDocument();
    await expect.element(limitCapsule()).toHaveTextContent("Limit reached");
    await limitCapsule().click();
    await expect.element(card()).toBeVisible();
  });

  it("uses the limited account's usage windows while its settings are unavailable", async () => {
    const usage = (instanceId: string, window: string): ServerProviderUsageSnapshot => ({
      provider: "claudeAgent",
      instanceId,
      updatedAt: new Date().toISOString(),
      limits: [{ window, usedPercent: 64, resetsAt: inOneHour() }],
      usageLines: [],
      source: "test",
    });
    const instanceId = "claude-alternate";
    await mount({ rateLimitStatus: limited(), instanceId }, DEFAULT_SERVER_SETTINGS_VIEW, [
      usage("claudeAgent", "Default Account Window"),
      usage(instanceId, "Limited Account Window"),
    ]);
    await expect.element(card()).toHaveTextContent("Limited Account Window");
    await expect.element(card()).not.toHaveTextContent("Default Account Window");
  });

  it("shows an armed wait and cancels it only when asked", async () => {
    const onCancelRecovery = vi.fn();
    await mount(
      {
        rateLimitStatus: limited(),
        recovery: makeUsageLimitRecovery({ resetAt: inOneHour() }),
        onCancelRecovery,
      },
      { ...DEFAULT_SERVER_SETTINGS_VIEW, autoResumeAfterUsageLimits: true },
    );
    await expect.element(card()).toHaveTextContent("Synara will continue this task");
    const thisTask = switchNamed("Resume this task at reset");
    expect(thisTask.element().getAttribute("aria-checked")).toBe("true");
    expect(onCancelRecovery).not.toHaveBeenCalled();
    await thisTask.click();
    expect(onCancelRecovery).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Collapse usage limit details" }).click();
    await expect.element(autoResumeChip()).toHaveTextContent("Auto-resume");
    await page.getByRole("button", { name: "Cancel auto-resume" }).click();
    expect(onCancelRecovery).toHaveBeenCalledTimes(2);
  });

  it.each(["waiting", "resuming"] as const)(
    "never invents a running turn after the deadline (%s)",
    async (state) => {
      const onCancelRecovery = vi.fn();
      await mount({
        recovery: makeUsageLimitRecovery({ state, resetAt: "2026-01-01T00:00:00.000Z" }),
        onCancelRecovery,
      });
      await expect.element(card()).not.toBeInTheDocument();
      await expect
        .element(limitCapsule())
        .toHaveTextContent(
          state === "resuming" ? "Continuing on your computer" : "waiting for computer",
        );
      expect(onCancelRecovery).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("button", { name: "Resume now" }))
        .not.toBeInTheDocument();
    },
  );

  it("turns the policy on from the card without claiming this task is armed", async () => {
    harness.update.mockImplementation(async (patch) => ({
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      ...patch,
    }));
    await mount({ rateLimitStatus: limited() });
    const thisTask = switchNamed("Resume this task at reset");
    expect(thisTask.element().getAttribute("aria-disabled")).toBe("true");
    const always = switchNamed("Always resume after limits");
    expect(always.element().getAttribute("aria-checked")).toBe("false");
    await always.click();
    await vi.waitFor(() =>
      expect(harness.update).toHaveBeenCalledExactlyOnceWith({ autoResumeAfterUsageLimits: true }),
    );
    await vi.waitFor(() => expect(always.element().getAttribute("aria-checked")).toBe("true"));
    // The policy cannot arm a turn that already failed; the card and chip say so.
    await expect.element(card()).toHaveTextContent("wasn't set up to resume automatically");
    await page.getByRole("button", { name: "Collapse usage limit details" }).click();
    await expect.element(autoResumeChip()).toHaveTextContent("Auto-resume unavailable");
  });

  it("offers the policy as a chip when collapsed and the host supports recovery", async () => {
    harness.update.mockImplementation(async (patch) => ({
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      ...patch,
    }));
    await mount({ rateLimitStatus: limited() });
    await page.getByRole("button", { name: "Collapse usage limit details" }).click();
    await autoResumeChip().click();
    await vi.waitFor(() =>
      expect(harness.update).toHaveBeenCalledExactlyOnceWith({ autoResumeAfterUsageLimits: true }),
    );
  });

  it("hides auto-resume controls on hosts without durable recovery but keeps Change model", async () => {
    harness.supported = false;
    const onChangeModel = vi.fn();
    await mount({ rateLimitStatus: limited(), onChangeModel });
    await expect.element(card()).toBeVisible();
    await expect.element(switchNamed("Always resume after limits")).not.toBeInTheDocument();
    await page.getByRole("button", { name: /Change model/ }).click();
    expect(onChangeModel).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Collapse usage limit details" }).click();
    await expect.element(autoResumeChip()).not.toBeInTheDocument();
  });

  it("shows an approaching limit as a dismissible tip only where asked", async () => {
    const onDismissWarning = vi.fn();
    const status = { status: "allowed_warning" as const, utilization: 0.91, resetsAt: inOneHour() };
    const screen = await mount({ rateLimitStatus: status, onDismissWarning });
    const warning = page.getByTestId("composer-usage-limit-warning");
    await expect.element(warning).toHaveTextContent("91% used");
    await expect.element(card()).not.toBeInTheDocument();
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
