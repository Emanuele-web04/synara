import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { emitWsTransportState } from "../../wsTransportEvents";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerTransportNotice } from "./ComposerTransportNotice";

describe("composer transport notice", () => {
  afterEach(() => emitWsTransportState("open"));

  it("renders a delayed live status from transport events and removes it on recovery", async () => {
    emitWsTransportState("open");
    const screen = await render(
      <ComposerColumnFrame>
        <ComposerTransportNotice />
        <textarea aria-label="Message" defaultValue="Keep my draft" />
      </ComposerColumnFrame>,
    );
    try {
      emitWsTransportState("connecting");
      expect(screen.container.querySelector('[role="status"]')).toBeNull();
      await expect
        .element(page.getByRole("status"), { timeout: 4000 })
        .toHaveTextContent("Reconnecting to Synara…");
      expect(screen.container.querySelector("button")).toBeNull();
      await expect
        .element(page.getByRole("textbox", { name: "Message" }))
        .toHaveValue("Keep my draft");
      emitWsTransportState("open");
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("replays a closed transport to a newly mounted composer", async () => {
    emitWsTransportState("closed");
    const screen = await render(
      <ComposerColumnFrame>
        <ComposerTransportNotice />
      </ComposerColumnFrame>,
    );
    try {
      await expect
        .element(page.getByRole("status"), { timeout: 4000 })
        .toHaveTextContent("Reconnecting to Synara…");
    } finally {
      await screen.unmount();
    }
  });
});
