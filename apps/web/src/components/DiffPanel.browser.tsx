import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memo, useState, type ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadId } from "@synara/contracts";
import { DIFF_RENDER_MODE_STORAGE_KEY } from "../diffRenderMode";
import { useDiffRenderModeStore } from "../diffRenderModeStore";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => null,
}));

vi.mock("../hooks/useDiffRouteSearch", () => ({
  useDiffRouteSearch: () => ({}),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => undefined,
  ensureNativeApi: () => {
    throw new Error("This diff preference test must not call the server.");
  },
  readNativeApiServerCapability: () => false,
  onNativeApiServerCapabilitiesChange: () => () => undefined,
}));

import DiffPanel from "./DiffPanel";

const MemoizedDiffPanel = memo(DiffPanel);
const PANEL_STATE = { panel: "diff", diffTurnId: null, diffFilePath: null } as const;

function DiffPanelHarness({ threadId }: { threadId?: ThreadId }) {
  const [open, setOpen] = useState(true);
  const [options, setOptions] = useState<ReactNode>(null);

  return (
    <>
      <button onClick={() => setOpen((previous) => !previous)}>
        {open ? "Close panel" : "Open panel"}
      </button>
      {options}
      {open ? (
        <MemoizedDiffPanel
          {...(threadId ? { threadId } : {})}
          hideHeader
          queriesEnabled={false}
          panelState={PANEL_STATE}
          onEditorDiffOptionsChange={setOptions}
        />
      ) : null}
    </>
  );
}

function mountPanel(threadId?: ThreadId) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DiffPanelHarness {...(threadId ? { threadId } : {})} />
    </QueryClientProvider>,
  );
}

async function openOptions() {
  await page.getByRole("button", { name: "Diff options", exact: true }).click();
  await userEvent.keyboard("{ArrowDown}");
}

beforeEach(() => {
  localStorage.clear();
  useDiffRenderModeStore.setState({ modeByThreadId: {} });
});

afterEach(() => {
  useDiffRenderModeStore.setState({ modeByThreadId: {} });
  localStorage.clear();
});

it("keeps each thread's layout separate from the existing default across remounts", async () => {
  localStorage.setItem(DIFF_RENDER_MODE_STORAGE_KEY, JSON.stringify("stacked"));
  const threadA = ThreadId.makeUnsafe("diff-layout-a");
  const threadB = ThreadId.makeUnsafe("diff-layout-b");
  const first = await mountPanel(threadA);
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Split diff", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  expect(localStorage.getItem(DIFF_RENDER_MODE_STORAGE_KEY)).toBe(JSON.stringify("stacked"));
  await first.unmount();
  const second = await mountPanel(threadB);
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await second.unmount();
  const reopened = await mountPanel(threadA);
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Split diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await reopened.unmount();
});

it("remembers stacked and split diff choices after closing and remounting the panel", async () => {
  const screen = await mountPanel();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Split diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }).click();
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.getByRole("button", { name: "Open panel", exact: true }).click();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await screen.unmount();

  const reopened = await mountPanel();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Split diff", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.getByRole("button", { name: "Open panel", exact: true }).click();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Split diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await reopened.unmount();
});
