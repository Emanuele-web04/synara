import { describe, expect, it } from "vitest";

import { toolParamsDisplayFromToolInput } from "./toolParamsDisplay";

describe("toolParamsDisplayFromToolInput", () => {
  it("flattens a tool input into name/value rows with non-strings serialised", () => {
    expect(
      toolParamsDisplayFromToolInput({
        app: "kcalc",
        args: ["--hidpi"],
        headless: false,
        target: { x: 1, y: 2 },
      }),
    ).toEqual([
      { name: "app", value: "kcalc" },
      { name: "args", value: '["--hidpi"]' },
      { name: "headless", value: "false" },
      { name: "target", value: '{"x":1,"y":2}' },
    ]);
  });

  it("answers nothing for an absent or empty input", () => {
    expect(toolParamsDisplayFromToolInput(undefined)).toBeUndefined();
    expect(toolParamsDisplayFromToolInput({})).toBeUndefined();
  });

  it("falls back to String() for a value JSON cannot serialise", () => {
    expect(toolParamsDisplayFromToolInput({ big: 10n })).toEqual([{ name: "big", value: "10" }]);
  });
});
