import "../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ServerBusyNotice } from "./ServerBusyIndicator";

it("explains waiting during an unresponsive server without a blocking dialog", async () => {
  const screen = await render(
    <ServerBusyNotice
      snapshot={{ reason: "unresponsive", pendingRequests: 2, slowRequests: 1, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByRole("status")).toBeVisible();
  await expect.element(screen.getByText("Synara server is busy")).toBeVisible();
  await expect.element(screen.getByText(/2 requests are still waiting/)).toBeVisible();
});

it("distinguishes a recent stall from a still-running request on a responsive server", async () => {
  const screen = await render(
    <ServerBusyNotice
      snapshot={{ reason: "recent-stall", pendingRequests: 0, slowRequests: 0, lastStallMs: 5200 }}
    />,
  );
  await expect.element(screen.getByText("Synara server recovered")).toBeVisible();
  await expect.element(screen.getByText(/5.2 s/)).toBeVisible();
  await screen.rerender(
    <ServerBusyNotice
      snapshot={{ reason: null, pendingRequests: 1, slowRequests: 1, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByText("Some requests are slow")).toBeVisible();
  await screen.rerender(
    <ServerBusyNotice
      snapshot={{ reason: null, pendingRequests: 0, slowRequests: 0, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});
