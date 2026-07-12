/**
 * Optional integration check against a real `cursor-agent acp` install.
 * Enable with: SYNARA_CURSOR_ACP_PROBE=1 bun run test --filter CursorAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

function flattenSelectOptionValues(
  option: Extract<EffectAcpSchema.SessionConfigOption, { type: "select" }> | undefined,
): ReadonlyArray<string> {
  return (
    option?.options.flatMap((entry) =>
      "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
    ) ?? []
  );
}

describe.runIf(process.env.SYNARA_CURSOR_ACP_PROBE === "1")("Cursor ACP CLI probe", () => {
  it.effect("initialize and authenticate against real cursor-agent acp", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "synara-probe", version: "0.0.0" },
          authMethodId: "cursor_login",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("session/new returns configOptions with a model selector", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;
      console.log("session/new result:", JSON.stringify(result, null, 2));

      expect(typeof started.sessionId).toBe("string");

      const configOptions = result.configOptions;
      console.log("session/new configOptions:", JSON.stringify(configOptions, null, 2));

      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find((opt) => opt.category === "model");
        const parameterizedOptions = configOptions.filter(
          (opt) =>
            opt.category === "thought_level" ||
            opt.category === "model_option" ||
            opt.category === "model_config",
        );
        console.log("Model config option:", JSON.stringify(modelConfig, null, 2));
        console.log(
          "Parameterized model config options:",
          JSON.stringify(parameterizedOptions, null, 2),
        );
        expect(modelConfig).toBeDefined();
        expect(typeof modelConfig?.id).toBe("string");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "cursor_login",
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "synara-probe", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("session/set_config_option switches the model in-session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      const newResult = started.sessionSetupResult;

      const configOptions = newResult.configOptions;
      let modelConfigId = "model";
      let targetModelValue = "gpt-5.4";
      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find((opt) => opt.category === "model");
        if (typeof modelConfig?.id === "string") {
          modelConfigId = modelConfig.id;
        }
        if (modelConfig?.type === "select") {
          targetModelValue =
            flattenSelectOptionValues(modelConfig).find(
              (value) => value !== modelConfig.currentValue,
            ) ?? modelConfig.currentValue;
        }
      }

      const setResult: EffectAcpSchema.SetSessionConfigOptionResponse =
        yield* runtime.setConfigOption(modelConfigId, targetModelValue);

      console.log("session/set_config_option result:", JSON.stringify(setResult, null, 2));

      if (Array.isArray(setResult.configOptions)) {
        const modelConfig = setResult.configOptions.find((opt) => opt.category === "model");
        if (modelConfig?.type === "select") {
          expect(modelConfig.currentValue).toBe(targetModelValue);
        }
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "cursor_login",
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "synara-probe", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
