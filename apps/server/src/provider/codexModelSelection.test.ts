import { describe, expect, it } from "vitest";

import { selectAvailableCodexModel } from "./codexModelSelection.ts";

describe("selectAvailableCodexModel", () => {
  it("keeps a requested slug the catalog advertises", () => {
    const selection = selectAvailableCodexModel({
      requested: "gpt-5.5",
      available: ["gpt-5.5", "gpt-5.3-codex"],
    });
    expect(selection).toEqual({ model: "gpt-5.5", fellBack: false });
  });

  it("falls back to the preferred default when the request is absent", () => {
    const selection = selectAvailableCodexModel({
      requested: "gpt-9-imaginary",
      available: ["gpt-5.5", "gpt-5.3-codex"],
      preferredFallback: "gpt-5.5",
    });
    expect(selection).toEqual({ model: "gpt-5.5", fellBack: true });
  });

  it("falls back to the first advertised slug when the default is also absent", () => {
    const selection = selectAvailableCodexModel({
      requested: "gpt-9-imaginary",
      available: ["gpt-5.3-codex", "gpt-5.1"],
      preferredFallback: "gpt-5.5",
    });
    expect(selection).toEqual({ model: "gpt-5.3-codex", fellBack: true });
  });

  it("trusts the request when the catalog is empty (codex did not advertise one)", () => {
    const selection = selectAvailableCodexModel({
      requested: "gpt-9-imaginary",
      available: [],
      preferredFallback: "gpt-5.5",
    });
    expect(selection).toEqual({ model: "gpt-9-imaginary", fellBack: false });
  });

  it("leaves an unset request unset", () => {
    expect(selectAvailableCodexModel({ requested: null, available: ["gpt-5.5"] })).toEqual({
      model: null,
      fellBack: false,
    });
    expect(selectAvailableCodexModel({ requested: "   ", available: ["gpt-5.5"] })).toEqual({
      model: null,
      fellBack: false,
    });
  });
});
