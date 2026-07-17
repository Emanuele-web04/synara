import { afterEach, describe, expect, it } from "vitest";

import { isEditableEventTarget } from "./editableEventTarget";

class MockElement {
  closestResult: MockElement | null = null;
  closest(_selector: string): MockElement | null {
    return this.closestResult;
  }
}

class MockHTMLElement extends MockElement {
  isContentEditable = false;
}

const originalElement = globalThis.Element;
const originalHTMLElement = globalThis.HTMLElement;

function stubDom(): void {
  globalThis.Element = MockElement as unknown as typeof Element;
  globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
}

afterEach(() => {
  if (originalElement === undefined) {
    delete (globalThis as { Element?: typeof Element }).Element;
  } else {
    globalThis.Element = originalElement;
  }
  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

function makeEvent(target: unknown): globalThis.KeyboardEvent {
  return { target } as unknown as globalThis.KeyboardEvent;
}

describe("isEditableEventTarget", () => {
  it("returns false when the target is not an Element", () => {
    stubDom();
    expect(isEditableEventTarget(makeEvent(null))).toBe(false);
    expect(isEditableEventTarget(makeEvent({}))).toBe(false);
  });

  it("returns true when the target itself matches input/textarea/select", () => {
    stubDom();
    const input = new MockHTMLElement();
    input.closestResult = input;
    expect(isEditableEventTarget(makeEvent(input))).toBe(true);
  });

  it("returns true for a descendant of an input-like ancestor (e.g. an option inside a select)", () => {
    stubDom();
    const select = new MockHTMLElement();
    const option = new MockHTMLElement();
    option.closestResult = select;
    expect(isEditableEventTarget(makeEvent(option))).toBe(true);
  });

  it("returns true for a contenteditable element with no input/textarea/select ancestor", () => {
    stubDom();
    const editable = new MockHTMLElement();
    editable.isContentEditable = true;
    expect(isEditableEventTarget(makeEvent(editable))).toBe(true);
  });

  it("returns false for a plain, non-editable HTMLElement", () => {
    stubDom();
    const button = new MockHTMLElement();
    expect(isEditableEventTarget(makeEvent(button))).toBe(false);
  });

  it("returns false for an Element that is not an HTMLElement (e.g. SVGElement)", () => {
    stubDom();
    const svg = new MockElement();
    expect(isEditableEventTarget(makeEvent(svg))).toBe(false);
  });
});
