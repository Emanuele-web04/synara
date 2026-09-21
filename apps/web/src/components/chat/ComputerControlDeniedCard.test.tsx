// FILE: ComputerControlDeniedCard.test.tsx
// Purpose: Keeps the denial card's Enable wiring truthful: the button only
// shows while control is off, and the card flips to a confirmation once on.
// Layer: Chat transcript UI regression test

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputerControlDeniedCard } from "./ComputerControlDeniedCard";

describe("ComputerControlDeniedCard", () => {
  it("offers Enable only while control is off, and points at Settings", () => {
    const markup = renderToStaticMarkup(<ComputerControlDeniedCard onEnable={() => undefined} />);

    expect(markup).toContain("Computer control is off");
    expect(markup).toContain("Turn it on in Settings to let the agent use the desktop.");
    expect(markup).toContain(">Enable<");
    expect(markup).not.toContain("/computer-use");
  });

  it("hides Enable without a handler instead of rendering a dead button", () => {
    const markup = renderToStaticMarkup(<ComputerControlDeniedCard />);

    expect(markup).toContain("Computer control is off");
    expect(markup).toContain("Turn it on in Settings to let the agent use the desktop.");
    expect(markup).not.toContain(">Enable<");
  });

  it("flips to a confirmation with no Enable once control is on", () => {
    const markup = renderToStaticMarkup(
      <ComputerControlDeniedCard computerControlEnabled onEnable={() => undefined} />,
    );

    expect(markup).toContain("Computer control is on for this chat");
    expect(markup).toContain("send a fresh message to continue");
    expect(markup).not.toContain(">Enable<");
  });
});
