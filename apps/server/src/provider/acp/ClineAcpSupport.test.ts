import type * as Acp from "@agentclientprotocol/sdk";
import { Effect } from "effect";
import { describe, expect, it, vi, afterEach } from "vitest";

import { AcpRequestError } from "./AcpErrors.ts";
import type { AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";
import {
  buildClineAcpSpawnInput,
  clineDefaultModel,
  configureClineSession,
  mapClineModels,
  parseClineResumeCursor,
} from "./ClineAcpSupport.ts";

const modelOption: Acp.SessionConfigOption = {
  id: "model",
  category: "model",
  name: "Model",
  type: "select",
  currentValue: "upstream/Model-A",
  options: [
    { value: "upstream/Model-A", name: "Model A" },
    { value: "upstream/Model-B", name: "Model B" },
  ],
};
const startResult: AcpSessionRuntimeStartResult = {
  sessionId: "cline-session",
  initializeResult: { protocolVersion: 1 },
  modelConfigId: "model",
  sessionSetupMethod: "new",
  sessionSetupResult: { sessionId: "cline-session", configOptions: [modelOption] },
};

afterEach(() => vi.unstubAllEnvs());

describe("Cline ACP integration contract", () => {
  it("launches ACP with an unmodified executable argument and no auto-approval", () => {
    const spawn = buildClineAcpSpawnInput(
      { binaryPath: "C:\\Program Files\\Cline\\cline.cmd" },
      "/project",
    );
    expect(spawn.command).toBe("C:\\Program Files\\Cline\\cline.cmd");
    expect(spawn.args).toEqual(["--acp", "--auto-approve", "false"]);
    expect(spawn.cwd).toBe("/project");
  });
  it("passes Cline authentication without leaking Synara control credentials", () => {
    vi.stubEnv("CLINE_API_KEY", "test-cline-key");
    vi.stubEnv("SYNARA_AUTH_TOKEN", "test-control-secret");
    const spawn = buildClineAcpSpawnInput(undefined, "/project");
    expect(spawn.env?.CLINE_API_KEY).toBe("test-cline-key");
    expect(spawn.env?.SYNARA_AUTH_TOKEN).toBeUndefined();
  });
  it("merges the runtime catalog without inventing models or effort settings", () => {
    const models = mapClineModels(startResult);
    expect(models.map((m) => m.slug)).toEqual(["default", "upstream/Model-A", "upstream/Model-B"]);
    expect(models[0]?.name).toBe("Cline configured model (Model A)");
    expect(
      models.every(
        (m) => m.supportedReasoningEfforts?.length === 0 && m.optionDescriptors?.length === 0,
      ),
    ).toBe(true);
  });
  it("supports grouped ACP model choices", () => {
    const grouped: AcpSessionRuntimeStartResult = {
      ...startResult,
      sessionSetupResult: {
        sessionId: "cline-session",
        configOptions: [
          {
            ...modelOption,
            options: [
              {
                group: "host",
                name: "Host",
                options: [{ value: "Vendor/MixedCase", name: "Mixed Case" }],
              },
            ],
          },
        ],
      },
    };
    expect(mapClineModels(grouped).map((m) => m.slug)).toEqual(["Vendor/MixedCase"]);
  });
  it("does not fabricate a catalog for unauthenticated or empty discovery", () => {
    expect(mapClineModels({ ...startResult, sessionSetupResult: { sessionId: "empty" } })).toEqual(
      [],
    );
  });
  it("preserves provider-owned configured model IDs", () => {
    expect(clineDefaultModel(startResult)).toBe("upstream/Model-A");
  });
  it.each([undefined, "plan"] as const)(
    "sets approval, model and native mode before a %s turn",
    async (interactionMode) => {
      const calls: unknown[] = [];
      const runtime = {
        awaitLoadReplayReady: Effect.sync(() => {
          calls.push("replay-ready");
        }),
        getConfigOptions: Effect.succeed([modelOption]),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([id, value]);
            return { configOptions: [modelOption] };
          }),
        setMode: (id: string) =>
          Effect.sync(() => {
            calls.push(["mode", id]);
            return {};
          }),
      };
      await Effect.runPromise(
        configureClineSession({
          runtime,
          model: "default",
          defaultModel: "upstream/Model-A",
          ...(interactionMode ? { interactionMode } : {}),
        }),
      );
      expect(calls).toEqual([
        "replay-ready",
        ["auto_approve", false],
        ["model", "upstream/Model-A"],
        ["mode", interactionMode === "plan" ? "plan" : "act"],
      ]);
    },
  );
  it("fails closed when auto-approval cannot be disabled", async () => {
    const mode = vi.fn(() => Effect.succeed({}));
    const setConfig = vi.fn(() =>
      Effect.fail(
        new AcpRequestError({ code: -32602, errorMessage: "Unknown auto_approve option" }),
      ),
    );
    await expect(
      Effect.runPromise(
        configureClineSession({
          runtime: {
            awaitLoadReplayReady: Effect.void,
            getConfigOptions: Effect.succeed([modelOption]),
            setConfigOption: setConfig,
            setMode: mode,
          },
          model: "default",
          defaultModel: "upstream/Model-A",
        }),
      ),
    ).rejects.toThrow("Unknown auto_approve");
    expect(setConfig).toHaveBeenCalledTimes(1);
    expect(mode).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { sessionId: "id" },
    { schemaVersion: 2, sessionId: "id" },
    { schemaVersion: 1, sessionId: " " },
  ])("rejects malformed resume cursor %j", (cursor) => {
    expect(parseClineResumeCursor(cursor)).toBeUndefined();
  });
  it("accepts only versioned nonempty session cursors", () => {
    expect(parseClineResumeCursor({ schemaVersion: 1, sessionId: "saved" })).toEqual({
      sessionId: "saved",
    });
  });
});
