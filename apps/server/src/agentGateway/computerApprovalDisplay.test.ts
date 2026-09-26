import { describe, expect, it } from "vitest";

import { computerApprovalDisplayArgs } from "./computerApprovalDisplay.ts";

describe("computerApprovalDisplayArgs", () => {
  it("shows step types without persisting nested typed values or credentials", () => {
    const display = computerApprovalDisplayArgs({
      app: "Safari",
      steps: [
        { type: "type_text", text: "private typed text" },
        { type: "set_value", value: "private value" },
        { type: "click", x: 8, y: 12 },
      ],
      headers: { Authorization: "Bearer private-token" },
      prompt_text: "private prompt",
    });

    expect(JSON.parse(display)).toEqual({
      app: "Safari",
      steps: { count: 3, types: ["type_text", "set_value", "click"] },
    });
    expect(display).not.toMatch(/private|Bearer|Authorization/);
  });
});
