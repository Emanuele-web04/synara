import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AmbientRailSlot } from "./AmbientRailSlot";

describe("AmbientRailSlot", () => {
  it("renders children with no offset before measuring", () => {
    const markup = renderToStaticMarkup(
      <AmbientRailSlot envOpen={true}>
        <span>preview</span>
      </AmbientRailSlot>,
    );
    expect(markup).toContain("preview");
    expect(markup).toContain("margin-top:0");
  });

  it("keeps static positioning so the card measures the rail wrapper", () => {
    const markup = renderToStaticMarkup(
      <AmbientRailSlot envOpen={false}>
        <span>preview</span>
      </AmbientRailSlot>,
    );
    expect(markup).not.toContain("position:absolute");
    expect(markup).not.toContain("position:fixed");
  });
});
