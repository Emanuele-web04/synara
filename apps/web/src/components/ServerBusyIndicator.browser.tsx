import "../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ServerBusyNotice, ServerBusyRailButton } from "./ServerBusyIndicator";
import { emitWsTransportState } from "../wsTransportEvents";
import { publishServerBusySnapshot } from "../serverBusyState";

it("explains waiting during an unresponsive server", async () => {
  const screen = await render(
    <ServerBusyNotice
      snapshot={{ reason: "unresponsive", pendingRequests: 2, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByText("Synara server is busy")).toBeVisible();
  await expect.element(screen.getByText(/2 requests are still waiting/)).toBeVisible();
});

it("reports a recent stall and stays silent for requests on a responsive server", async () => {
  const screen = await render(
    <ServerBusyNotice
      snapshot={{ reason: "recent-stall", pendingRequests: 0, lastStallMs: 5200 }}
    />,
  );
  await expect.element(screen.getByText("Synara server recovered")).toBeVisible();
  await expect.element(screen.getByText(/5.2 s/)).toBeVisible();
  await screen.rerender(
    <ServerBusyNotice snapshot={{ reason: null, pendingRequests: 14, lastStallMs: null }} />,
  );
  await expect.element(screen.getByText("Synara server recovered")).not.toBeInTheDocument();
});

it("uses one reconnecting state when the socket actually closes", async () => {
  const screen = await render(
    <ServerBusyNotice
      reconnecting
      snapshot={{ reason: null, pendingRequests: 2, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByText("Reconnecting to Synara server")).toBeVisible();
  await expect.element(screen.getByText(/resume automatically/)).toBeVisible();
  await expect.element(screen.getByText("Synara server is busy")).not.toBeInTheDocument();
});

it("shows a rail dot with the details on hover, and follows transport recovery", async () => {
  publishServerBusySnapshot({ reason: "unresponsive", pendingRequests: 1, lastStallMs: null });
  emitWsTransportState("connecting");
  const screen = await render(<ServerBusyRailButton />);
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  emitWsTransportState("open");
  const dot = screen.getByRole("button", { name: /Synara server is busy/ });
  await expect.element(dot).toBeVisible();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Synara server is busy");
  await dot.hover();
  await expect.element(screen.getByText(/The server is not answering/)).toBeVisible();
  emitWsTransportState("connecting");
  await expect
    .element(screen.getByRole("button", { name: /Reconnecting to Synara server/ }))
    .toBeVisible();
  publishServerBusySnapshot({ reason: null, pendingRequests: 3, lastStallMs: null });
  emitWsTransportState("open");
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  emitWsTransportState("disposed");
});
