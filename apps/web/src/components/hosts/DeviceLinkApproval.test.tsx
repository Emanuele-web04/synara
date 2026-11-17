// FILE: DeviceLinkApproval.test.tsx
// Purpose: The code field normalizes what the user types before it reaches
//          state, and renders the code in the mono face.
// Layer: Component rendering tests
// Depends on: DeviceCodeField and React server rendering.

import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stands in for the Base UI input so the test can reach the props
// DeviceCodeField hands it. What is under test is the field's own decisions —
// the normalization it applies and the attributes it sets — not Base UI's
// rendering, and going through the real primitive would only mean asserting
// on someone else's class strings.
const capturedInputProps: ComponentProps<"input">[] = [];
vi.mock("~/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => {
    capturedInputProps.push(props);
    // The handlers are captured above and invoked directly; leaving them
    // attached would make React warn about a value with no onChange.
    const { onChange: _onChange, onKeyDown: _onKeyDown, ...rest } = props;
    return <input {...rest} readOnly />;
  },
}));

const { DeviceCodeField } = await import("./DeviceLinkApproval");

afterEach(() => {
  capturedInputProps.length = 0;
});

/** Renders the field and returns the props it gave the input. */
function renderField(value: string, disabled = false): ComponentProps<"input"> {
  renderToStaticMarkup(
    <DeviceCodeField
      value={value}
      disabled={disabled}
      onValueChange={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
  const props = capturedInputProps.at(-1);
  if (!props) throw new Error("DeviceCodeField rendered no input");
  return props;
}

/** Drives the field's onChange the way a keystroke or a paste would. */
function typeIntoField(raw: string): string {
  const captured: string[] = [];
  renderToStaticMarkup(
    <DeviceCodeField
      value=""
      disabled={false}
      onValueChange={(next) => captured.push(next)}
      onSubmit={vi.fn()}
    />,
  );
  const onChange = capturedInputProps.at(-1)?.onChange;
  if (!onChange) throw new Error("DeviceCodeField rendered no change handler");
  onChange({ target: { value: raw } } as never);
  return captured.at(-1) ?? "";
}

describe("DeviceCodeField input normalization", () => {
  // The alphabet excludes I/O/0/1 precisely because they are the characters
  // people mistype off another screen; a rejected character must disappear as
  // you type rather than fail after you submit and burn a rate-limited attempt.
  it.each([
    ["uppercases what the user types", "abcdefgh", "ABCDEFGH"],
    ["accepts mixed case", "aBcD23gH", "ABCD23GH"],
    ["drops only ambiguous characters", "IO01", ""],
    ["drops ambiguous characters among valid ones", "AIBOC0D1", "ABCD"],
    ["accepts the displayed grouped form when pasted back", "abcd-efgh", "ABCDEFGH"],
    ["stops at the code length", "ABCDEFGHJKLM", "ABCDEFGH"],
  ])("%s", (_name, raw, expected) => {
    expect(typeIntoField(raw)).toBe(expected);
  });
});

describe("DeviceCodeField rendering", () => {
  it("shows the grouped form of a complete code", () => {
    expect(renderField("ABCDEFGH").value).toBe("ABCD-EFGH");
  });

  it("shows partial input as typed", () => {
    expect(renderField("ABC").value).toBe("ABC");
  });
});
