import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerRunningAgentsCapsule } from "./ComposerRunningAgentsCapsule";

describe("ComposerRunningAgentsCapsule", () => {
  it("names how many agents are running", () => {
    expect(renderToStaticMarkup(<ComposerRunningAgentsCapsule count={1} />)).toContain(
      "1 agent running",
    );
    expect(renderToStaticMarkup(<ComposerRunningAgentsCapsule count={3} />)).toContain(
      "3 agents running",
    );
  });

  it("is a button only when there is a card to show", () => {
    expect(renderToStaticMarkup(<ComposerRunningAgentsCapsule count={2} />)).not.toContain(
      "<button",
    );
    expect(
      renderToStaticMarkup(<ComposerRunningAgentsCapsule count={2} onShow={() => {}} />),
    ).toContain("<button");
  });
});
