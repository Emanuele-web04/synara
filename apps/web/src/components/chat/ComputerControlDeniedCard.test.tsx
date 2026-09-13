// FILE: ComputerControlDeniedCard.test.tsx
// Purpose: Keeps the denial card's Enable wiring truthful: the button only
// shows while control is off, and the card flips to a confirmation once on.
// Layer: Chat transcript UI regression test

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputerControlDeniedCard } from "./ComputerControlDeniedCard";

describe("ComputerControlDeniedCard", () => {
  it("offers Enable only while control is off, and says what it does", () => {
    const markup = renderToStaticMarkup(
      <ComputerControlDeniedCard toolName="computer_click" onEnable={() => undefined} />,
    );

    expect(markup).toContain("Computer control is off for this chat");
    expect(markup).toContain("computer_click");
    expect(markup).toContain(">Enable<");
    // Enable stages a /computer-use draft the user still sends; the copy must
    // not promise control is already on.
    expect(markup).toContain("Choose Enable to draft a /computer-use request");
  });

  it("hides Enable without a handler instead of rendering a dead button", () => {
    const markup = renderToStaticMarkup(<ComputerControlDeniedCard toolName="computer_click" />);

    expect(markup).toContain("Computer control is off for this chat");
    expect(markup).not.toContain(">Enable<");
  });

  it("flips to a confirmation with no Enable once control is on", () => {
    const markup = renderToStaticMarkup(
      <ComputerControlDeniedCard
        toolName="computer_click"
        computerControlEnabled
        onEnable={() => undefined}
      />,
    );

    expect(markup).toContain("Computer control is on for this chat");
    expect(markup).toContain("send a fresh message to continue");
    expect(markup).not.toContain(">Enable<");
  });
});
