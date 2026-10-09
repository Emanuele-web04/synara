import "../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ServerConnectionRailButton } from "./ServerConnectionIndicator";
import { emitWsTransportState } from "../wsTransportEvents";

it("shows a rail dot only while an established connection is reconnecting", async () => {
  emitWsTransportState("connecting");
  const screen = await render(<ServerConnectionRailButton />);
  // Initial startup is not a reconnect.
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  emitWsTransportState("open");
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  emitWsTransportState("connecting");
  const dot = screen.getByRole("button", { name: /Reconnecting to Synara server/ });
  await expect.element(dot).toBeVisible();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  await dot.hover();
  await expect.element(screen.getByText(/resume automatically/)).toBeVisible();
  emitWsTransportState("open");
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  emitWsTransportState("disposed");
});
