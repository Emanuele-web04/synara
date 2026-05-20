import { describe, expect, it } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveHermesAcpSpawn, selectHermesAuthMethodId } from "./hermesAcp.ts";

function initializeResultWithAuthMethods(
  authMethods: ReadonlyArray<Record<string, unknown>>,
): EffectAcpSchema.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods,
  } as EffectAcpSchema.InitializeResponse;
}

describe("resolveHermesAcpSpawn", () => {
  it("launches the public Hermes CLI in ACP mode by default", () => {
    expect(resolveHermesAcpSpawn()).toEqual({
      command: "hermes",
      args: ["acp"],
    });
  });

  it("launches a configured Hermes CLI path in ACP mode", () => {
    expect(resolveHermesAcpSpawn("/custom/bin/hermes")).toEqual({
      command: "/custom/bin/hermes",
      args: ["acp"],
    });
  });

  it("supports direct hermes-acp binaries without adding subcommand args", () => {
    expect(resolveHermesAcpSpawn("/custom/bin/hermes-acp")).toEqual({
      command: "/custom/bin/hermes-acp",
      args: [],
    });
  });
});

describe("selectHermesAuthMethodId", () => {
  it("prefers the agent-managed provider auth method advertised by Hermes", () => {
    expect(
      selectHermesAuthMethodId({
        initializeResult: initializeResultWithAuthMethods([
          {
            id: "minimax",
            name: "minimax runtime credentials",
          },
          {
            id: "hermes-setup",
            name: "Configure Hermes provider",
            type: "terminal",
          },
        ]),
      }),
    ).toBe("minimax");
  });

  it("falls back to the terminal setup method when no provider credentials are advertised", () => {
    expect(
      selectHermesAuthMethodId({
        initializeResult: initializeResultWithAuthMethods([
          {
            id: "hermes-setup",
            name: "Configure Hermes provider",
            type: "terminal",
          },
        ]),
      }),
    ).toBe("hermes-setup");
  });
});
