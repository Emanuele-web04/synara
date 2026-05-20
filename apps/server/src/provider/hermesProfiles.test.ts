import { describe, expect, it } from "vitest";

import {
  parseHermesProfileListOutput,
  parseHermesProfileShowOutput,
  toHermesProfileAgents,
} from "./hermesProfiles.ts";

describe("parseHermesProfileListOutput", () => {
  it("parses profile table rows", () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
 ◆default         deepseek-v4-flash            stopped      —            —
   work           gpt-5.4                      stopped      dev          —
`;

    expect(parseHermesProfileListOutput(output)).toEqual([
      { name: "default", model: "deepseek-v4-flash", isActive: true },
      { name: "work", model: "gpt-5.4", isActive: false },
    ]);
  });
});

describe("parseHermesProfileShowOutput", () => {
  it("parses profile show details", () => {
    const output = `
Profile: default
Path:    /Users/user/.hermes
Model:   deepseek-v4-flash (opencode-go)
Gateway: stopped
`;

    expect(parseHermesProfileShowOutput(output)).toEqual({
      name: "default",
      path: "/Users/user/.hermes",
      model: "deepseek-v4-flash",
    });
  });
});

describe("toHermesProfileAgents", () => {
  it("maps profiles to provider agent descriptors", () => {
    expect(
      toHermesProfileAgents([
        { name: "default", model: "deepseek-v4-flash", alias: "main", isActive: true },
      ]),
    ).toEqual([
      {
        name: "default",
        displayName: "main",
        model: "deepseek-v4-flash",
        description: "hermes-active-profile",
      },
    ]);
  });
});
