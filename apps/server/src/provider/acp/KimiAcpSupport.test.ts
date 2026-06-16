import { Effect } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  buildKimiModelDescriptorsFromConfigOptions,
  resolveKimiAcpAuthMethodId,
  resolveKimiAcpModelValue,
} from "./KimiAcpSupport.ts";

// Model config shape captured verbatim from a live `kimi acp` session/new response.
const KIMI_MODEL_CONFIG = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "kimi-code/kimi-for-coding",
    options: [{ value: "kimi-code/kimi-for-coding", name: "K2.7 Code" }],
  },
] as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

function initializeWithAuthMethods(ids: ReadonlyArray<string>): EffectAcpSchema.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("buildKimiAcpSpawnInput", () => {
  it("builds the default Kimi ACP command", () => {
    expect(buildKimiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured Kimi binary path", () => {
    expect(buildKimiAcpSpawnInput({ binaryPath: "/usr/local/bin/kimi" }, "/tmp/project")).toEqual({
      command: "/usr/local/bin/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("ignores a blank binary path and falls back to `kimi`", () => {
    expect(buildKimiAcpSpawnInput({ binaryPath: "  " }, "/tmp/project")).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("resolveKimiAcpAuthMethodId", () => {
  it("prefers the advertised `login` auth method", async () => {
    await expect(
      Effect.runPromise(resolveKimiAcpAuthMethodId(initializeWithAuthMethods(["oauth", "login"]))),
    ).resolves.toBe("login");
  });

  it("falls back to the first advertised method when `login` is absent", async () => {
    await expect(
      Effect.runPromise(resolveKimiAcpAuthMethodId(initializeWithAuthMethods(["oauth"]))),
    ).resolves.toBe("oauth");
  });

  it("defaults to `login` when the agent advertises no auth methods", async () => {
    await expect(
      Effect.runPromise(resolveKimiAcpAuthMethodId(initializeWithAuthMethods([]))),
    ).resolves.toBe("login");
  });
});

describe("buildKimiModelDescriptorsFromConfigOptions", () => {
  // Shape captured verbatim from a live `kimi acp` session/new response.
  const liveConfigOptions = [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "kimi-code/kimi-for-coding",
      options: [{ value: "kimi-code/kimi-for-coding", name: "K2.7 Code" }],
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: "on",
      options: [{ value: "on", name: "Thinking On" }],
    },
  ] as unknown as Parameters<typeof buildKimiModelDescriptorsFromConfigOptions>[0];

  it("returns the live model name keyed by the bare managed-model slug", () => {
    expect(buildKimiModelDescriptorsFromConfigOptions(liveConfigOptions)).toEqual([
      { slug: "kimi-for-coding", name: "K2.7 Code" },
    ]);
  });

  it("returns no descriptors when there is no model config option", () => {
    const noModel = [
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue: "on",
        options: [{ value: "on", name: "Thinking On" }],
      },
    ] as unknown as Parameters<typeof buildKimiModelDescriptorsFromConfigOptions>[0];
    expect(buildKimiModelDescriptorsFromConfigOptions(noModel)).toEqual([]);
  });
});

describe("resolveKimiAcpModelValue", () => {
  it("maps a bare slug to Kimi's full ACP model value", () => {
    expect(resolveKimiAcpModelValue(KIMI_MODEL_CONFIG, "kimi-for-coding")).toBe(
      "kimi-code/kimi-for-coding",
    );
  });

  it("returns an exact ACP value unchanged", () => {
    expect(resolveKimiAcpModelValue(KIMI_MODEL_CONFIG, "kimi-code/kimi-for-coding")).toBe(
      "kimi-code/kimi-for-coding",
    );
  });

  it("passes an unsupported value through so the runtime can reject it", () => {
    expect(resolveKimiAcpModelValue(KIMI_MODEL_CONFIG, "made-up-model")).toBe("made-up-model");
  });

  it("returns undefined when the session exposes no model picker", () => {
    expect(
      resolveKimiAcpModelValue([] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>, "kimi"),
    ).toBeUndefined();
  });
});

describe("applyKimiAcpModelSelection", () => {
  const makeRuntime = (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    calls: Array<string>,
  ) => ({
    getConfigOptions: Effect.succeed(configOptions),
    setModel: (value: string) =>
      Effect.sync(() => {
        calls.push(`model:${value}`);
      }),
    setConfigOption: (id: string, value: string | boolean) =>
      Effect.sync(() => {
        calls.push(`config:${id}=${String(value)}`);
        return { configOptions: [] };
      }),
  });

  it("applies the resolved managed-model value via setModel", async () => {
    const calls: Array<string> = [];
    await Effect.runPromise(
      applyKimiAcpModelSelection({
        runtime: makeRuntime(KIMI_MODEL_CONFIG, calls),
        model: "kimi-for-coding",
        mapError: (context) => context,
      }),
    );
    // The bare Synara slug is resolved to Kimi's full ACP value before applying.
    expect(calls).toEqual(["model:kimi-code/kimi-for-coding"]);
  });

  it("does nothing when the session exposes no model picker", async () => {
    const calls: Array<string> = [];
    await Effect.runPromise(
      applyKimiAcpModelSelection({
        runtime: makeRuntime([], calls),
        model: "kimi-for-coding",
        mapError: (context) => context,
      }),
    );
    expect(calls).toEqual([]);
  });
});
