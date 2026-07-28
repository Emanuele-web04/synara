import { runInNewContext } from "node:vm";

import type { BrowserNodeTarget } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { browserTargetLocatorBody } from "./targets";

interface FakeElement {
  readonly localName: string;
  readonly textContent: string;
  readonly children: readonly FakeElement[];
  readonly shadowRoot: null;
  readonly getAttribute: (_name: string) => null;
}

const fakeElement = (
  localName: string,
  textContent: string,
  children: readonly FakeElement[] = [],
): FakeElement => ({
  localName,
  textContent,
  children,
  shadowRoot: null,
  getAttribute: () => null,
});

describe("browser target locator selection", () => {
  it("keeps only the lowest text match instead of matching every ancestor", () => {
    const span = fakeElement("span", "Submit");
    const button = fakeElement("button", "Submit", [span]);
    const body = fakeElement("body", "Submit", [button]);
    const all = [body, button, span];
    const state = {
      currentTarget: null as FakeElement | null,
      generation: 1,
      observe: () => undefined,
    };
    const locator = {
      locator: { kind: "text", text: "Submit", exact: true },
    } as BrowserNodeTarget;
    const result = runInNewContext(`(() => {${browserTargetLocatorBody(locator)}})()`, {
      document: { querySelectorAll: () => all },
      state,
    }) as { count: number };

    expect(result.count).toBe(1);
    expect(state.currentTarget).toBe(span);
  });
});
