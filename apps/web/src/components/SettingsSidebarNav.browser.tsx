// FILE: SettingsSidebarNav.browser.tsx
// Purpose: Pin that settings search only offers rows the panel actually draws on
//          this machine, which takes real typing to observe.
// Layer: Browser component test
//
// The search context has to come from somewhere, and for a long time it came
// from nowhere: the prop existed, nothing supplied it, so the default was used
// and `computerBackendIsVisibleDesktop` was permanently false. The result was
// the one row the mechanism was written for being offered on exactly the
// backends whose panel hides it.

import type { ComputerStatusResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

function status(visibleDesktop: boolean): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability: { kind: "available", backend: "mac" },
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop,
    },
    provisionable: true,
  };
}

async function searchFor(query: string, cached: ComputerStatusResult) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.computerStatus(), cached);
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <SettingsSidebarNav activeSection="general" onBack={vi.fn()} onSelectSection={vi.fn()} />
    </QueryClientProvider>,
  );
  await screen.getByLabelText("Search settings").fill(query);
  return screen;
}

it("offers the Computer pane auto-open row only where the panel draws it", async () => {
  const offered = await searchFor("open automatically", status(false));
  await expect.poll(() => offered.getByText("Open automatically").elements().length).toBe(1);
  await offered.unmount();

  // A visible desktop is the one the user is already sitting at, so the server
  // never asks Synara to open a pane and the panel hides the switch. A result
  // here deep-links to an anchor that is not on the page.
  const hidden = await searchFor("open automatically", status(true));
  // The other match for this query proves the search ran at all, so the
  // assertion below is an absence rather than an empty render.
  await expect.poll(() => hidden.getByText("Open by default").elements().length).toBe(1);
  expect(hidden.getByText("Open automatically").elements()).toHaveLength(0);
  await hidden.unmount();
});
