import "../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ServerBusyIndicator, ServerBusyNotice } from "./ServerBusyIndicator";
import { emitWsTransportState } from "../wsTransportEvents";
import { publishServerBusySnapshot } from "../serverBusyState";

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
  await expect.element(screen.getByText("Synara server is busy")).toBeVisible();
  await screen.rerender(
    <ServerBusyNotice
      snapshot={{ reason: null, pendingRequests: 0, slowRequests: 0, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});

it("uses one reconnecting state when the socket actually closes", async () => {
  const screen = await render(
    <ServerBusyNotice
      reconnecting
      snapshot={{
        reason: null,
        pendingRequests: 2,
        slowRequests: 1,
        lastStallMs: null,
      }}
    />,
  );
  await expect.element(screen.getByRole("status")).toBeVisible();
  await expect.element(screen.getByText("Reconnecting to Synara server")).toBeVisible();
  await expect.element(screen.getByText(/resume automatically/)).toBeVisible();
  await expect.element(screen.getByText("Synara server is busy")).not.toBeInTheDocument();
});

it("follows actual transport recovery without showing reconnecting during initial startup", async () => {
  publishServerBusySnapshot({
    reason: null,
    pendingRequests: 1,
    slowRequests: 1,
    lastStallMs: null,
  });
  emitWsTransportState("connecting");
  const screen = await render(<ServerBusyIndicator />);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  emitWsTransportState("open");
  await expect.element(screen.getByText("Synara server is busy")).toBeVisible();
  emitWsTransportState("connecting");
  await expect.element(screen.getByText("Reconnecting to Synara server")).toBeVisible();
  await expect.element(screen.getByText(/You can keep working/)).not.toBeInTheDocument();
  publishServerBusySnapshot({
    reason: null,
    pendingRequests: 0,
    slowRequests: 0,
    lastStallMs: null,
  });
  emitWsTransportState("open");
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  emitWsTransportState("disposed");
});
