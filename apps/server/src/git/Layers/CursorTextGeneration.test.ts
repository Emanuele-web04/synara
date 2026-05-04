import * as os from "node:os";
import * as path from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { TextGeneration } from "../Services/TextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const CursorTextGenerationTestLayer = CursorTextGenerationLive.pipe(
  Layer.provideMerge(NodeServices.layer),
);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  const binDir = path.join(dir, "bin");
  const agentPath = path.join(binDir, "agent");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec bun ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effect: (agentPath: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "dpcode-cursor-text-acp-"));
      return {
        tempDir,
        agentPath: makeAcpAgentWrapper(tempDir, env),
      };
    }),
    ({ agentPath }) => effect(agentPath),
    ({ tempDir }) =>
      Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }),
  );
}

function waitForFileContent(filePath: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return readFileSync(filePath, "utf8");
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGenerationLive", (it) => {
  it.effect("uses ACP model config options instead of raw CLI model ids", () => {
    const requestLogDir = mkdtempSync(path.join(os.tmpdir(), "dpcode-cursor-text-log-"));
    const requestLogPath = path.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify cursor acp model config path",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-text-generation",
            stagedSummary: "M apps/server/src/git/Layers/CursorTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/git/Layers/CursorTextGeneration.ts b/apps/server/src/git/Layers/CursorTextGeneration.ts",
            modelSelection: {
              provider: "cursor",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "xhigh",
                fastMode: true,
                contextWindow: "1m",
              },
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify cursor acp model config path");

          const requests = readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });

          expect(
            requests.find((request) => request.method === "initialize")?.params
              ?.clientCapabilities,
          ).toHaveProperty("_meta.parameterizedModelPicker");
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "gpt-5.4",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "reasoning" &&
                request.params?.value === "extra-high",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "context" &&
                request.params?.value === "1m",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "fast" &&
                request.params?.value === "true",
            ),
          ).toBe(true);

          rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("accepts json objects with extra assistant text around them", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-noisy-json",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.subject).toBe("Update README dummy comment with attribution and date");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("generates diff summaries through Cursor ACP text generation", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          summary: "## Summary\n- Route git summaries through Cursor.",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateDiffSummary({
            cwd: process.cwd(),
            patch: "diff --git a/file.ts b/file.ts",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.summary).toBe("## Summary\n- Route git summaries through Cursor.");
        }),
    ),
  );

  it.effect("closes the ACP child process after text generation completes", () => {
    const exitLogDir = mkdtempSync(path.join(os.tmpdir(), "dpcode-cursor-text-exit-log-"));
    const exitLogPath = path.join(exitLogDir, "exit.log");

    return withFakeAcpAgent(
      {
        T3_ACP_EXIT_LOG_PATH: exitLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: '"Trim reconnect spinner status after resume."',
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status");

          const exitLog = yield* waitForFileContent(exitLogPath);
          expect(exitLog).toContain("exit:0");

          rmSync(exitLogDir, { recursive: true, force: true });
        }),
    );
  });
});
