// FILE: DiffPanel.capacity.browser.tsx
// Purpose: Browser regressions for checkpoint diff recovery after RPC backpressure.
// Layer: Focused component integration tests

import "../index.css";

import { TurnId, type NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { providerQueryKeys } from "~/lib/providerReactQuery";
import { useStore } from "../store";
import type { SplitViewPanePanelState } from "../splitViewStore";
import { makeState, makeThread } from "../storeTestFixtures";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
}));

vi.mock("../hooks/useDiffRouteSearch", () => ({
  useDiffRouteSearch: () => ({}),
}));

import DiffPanel from "./DiffPanel";

const CAPACITY_MESSAGE = "WebSocket expensive-read request capacity exceeded.";
const TURN_ID = TurnId.makeUnsafe("turn-capacity");
const THREAD = makeThread({
  turnDiffSummaries: [
    {
      turnId: TURN_ID,
      checkpointTurnCount: 2,
      completedAt: "2026-09-12T00:00:00.000Z",
      files: [],
    },
  ],
});
const PATCH =
  "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
const initialStore = useStore.getState();
let screen: Awaited<ReturnType<typeof render>> | undefined;
let queryClient: QueryClient | undefined;

function capacityError() {
  return Object.assign(new Error(CAPACITY_MESSAGE), {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 250,
  });
}

function DiffPanelHarness() {
  const [panelState, setPanelState] = useState<
    Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">
  >({
    panel: "diff",
    diffTurnId: TURN_ID,
    diffFilePath: null,
  });
  return (
    <div style={{ width: 900, height: 600 }}>
      <DiffPanel
        threadId={THREAD.id}
        panelState={panelState}
        onUpdatePanelState={(patch) => setPanelState((previous) => ({ ...previous, ...patch }))}
      />
    </div>
  );
}

async function mountPanel(getDiff: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("nativeApi", {
    orchestration: { getTurnDiff: getDiff, getFullThreadDiff: getDiff },
    git: {
      listBranches: vi.fn().mockResolvedValue({ isRepo: true, branches: [] }),
      status: vi.fn().mockResolvedValue({
        branch: "main",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        upstreamBranch: null,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      workingTreeDiffStats: vi.fn().mockResolvedValue({ fileCount: 0 }),
      onActionProgress: () => () => undefined,
    },
  } as unknown as NativeApi);
  useStore.setState(makeState(THREAD));
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
  queryClient = client;
  screen = await render(
    <QueryClientProvider client={client}>
      <DiffPanelHarness />
    </QueryClientProvider>,
  );
  return client;
}

function expectNoHardCapacityError() {
  const viewport = document.querySelector(".diff-panel-viewport");
  expect(viewport).not.toBeNull();
  expect(viewport?.textContent).not.toContain(CAPACITY_MESSAGE);
  expect(viewport?.textContent).not.toContain("No patch available for this selection.");
  expect(viewport?.querySelector('[class*="text-red-"]')).toBeNull();
}

afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  queryClient?.clear();
  queryClient = undefined;
  useStore.setState(initialStore);
  vi.unstubAllGlobals();
  localStorage.clear();
});

it.each(["Last turn", "All turns"])(
  "automatically recovers a saturated %s diff without a hard error or manual reload",
  async (scope) => {
    const getDiff = vi.fn().mockRejectedValue(capacityError());
    const client = await mountPanel(getDiff);
    if (scope === "All turns") {
      await page.getByRole("button", { name: "Choose diff source", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "All turns", exact: true }).click();
    }

    await expect.element(page.getByText("Diff refresh delayed.", { exact: true })).toBeVisible();
    expectNoHardCapacityError();
    await vi.waitFor(() => {
      const activeQuery = client
        .getQueryCache()
        .findAll({ queryKey: providerQueryKeys.all })
        .find((query) => query.isActive());
      expect(activeQuery?.state.errorUpdateCount).toBeGreaterThanOrEqual(2);
    });
    expectNoHardCapacityError();

    getDiff.mockResolvedValue({ diff: PATCH });
    await expect.element(page.getByText("export const value = 2;", { exact: true })).toBeVisible();
    expectNoHardCapacityError();
    expect(document.body.textContent).not.toContain("Diff refresh delayed.");
    expect(document.body.textContent).not.toContain("Refreshing diff...");
  },
);

it.each(["files", "raw"])(
  "keeps the last-good %s patch visible during delayed and in-flight refreshes",
  async (kind) => {
    const previousPatch = kind === "files" ? PATCH : "Previous raw patch";
    const previousText = kind === "files" ? "export const value = 2;" : previousPatch;
    const getDiff = vi
      .fn()
      .mockResolvedValueOnce({ diff: previousPatch })
      .mockRejectedValue(capacityError());
    const client = await mountPanel(getDiff);
    await expect.element(page.getByText(previousText, { exact: true })).toBeVisible();

    await client.invalidateQueries({ queryKey: providerQueryKeys.all });
    await expect.element(page.getByText("Diff refresh delayed.", { exact: true })).toBeVisible();
    await expect.element(page.getByText(previousText, { exact: true })).toBeVisible();
    expectNoHardCapacityError();

    let resolveRefresh!: (value: { diff: string }) => void;
    const refreshed = new Promise<{ diff: string }>((resolve) => {
      resolveRefresh = resolve;
    });
    getDiff.mockImplementation(() => refreshed);
    await expect.element(page.getByText("Refreshing diff...", { exact: true })).toBeVisible();
    await expect.element(page.getByText(previousText, { exact: true })).toBeVisible();
    expectNoHardCapacityError();

    resolveRefresh({ diff: "Recovered raw patch" });
    await expect.element(page.getByText("Recovered raw patch", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Diff refresh delayed.");
    expect(document.body.textContent).not.toContain("Refreshing diff...");
    expectNoHardCapacityError();
  },
);
