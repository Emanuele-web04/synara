import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { HermesAdapter, type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { makeHermesAdapterLive } from "./HermesAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function makeMockHermesBinary(input?: { readonly requestLogPath?: string }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hermes-adapter-test-"));
  const binaryPath = path.join(tempDir, "hermes-acp");
  const envPrefix = input?.requestLogPath
    ? `T3_ACP_REQUEST_LOG_PATH=${shellQuote(input.requestLogPath)} `
    : "";
  writeFileSync(
    binaryPath,
    `#!/bin/sh\n${envPrefix}exec bun ${shellQuote(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  chmodSync(binaryPath, 0o755);
  return {
    binaryPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function parseRequestLog(logPath: string): ReadonlyArray<{ method?: string; params?: unknown }> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
}

const testLayer = makeHermesAdapterLive().pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "hermes-adapter-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("HermesAdapterLive", (it) => {
  it.effect("emits ACP plan updates as runtime task updates", () => {
    const mock = makeMockHermesBinary();
    let adapterRef: HermesAdapterShape | undefined;
    return Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      adapterRef = adapter;
      const threadId = ThreadId.makeUnsafe("thread-hermes-plan");
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 8)).pipe(
        Effect.forkScoped,
      );

      yield* adapter.startSession({
        provider: "hermes",
        threadId,
        runtimeMode: "full-access",
        providerOptions: { hermes: { binaryPath: mock.binaryPath } },
      });
      yield* adapter.sendTurn({ threadId, input: "make a plan" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const taskUpdate = events.find((event) => event.type === "turn.tasks.updated");
      assert.equal(taskUpdate?.provider, "hermes");
      assert.equal(taskUpdate?.payload.tasks.length, 2);
      assert.equal(taskUpdate?.payload.tasks[0]?.task, "Inspect mock ACP state");
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => adapterRef?.stopAll().pipe(Effect.ignore) ?? Effect.void),
      ),
      Effect.ensuring(Effect.sync(mock.cleanup)),
    );
  });

  it.effect("sends model switches and image attachments through Hermes ACP", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hermes-adapter-log-"));
    const requestLogPath = path.join(tempDir, "requests.ndjson");
    const mock = makeMockHermesBinary({ requestLogPath });
    let adapterRef: HermesAdapterShape | undefined;
    return Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      adapterRef = adapter;
      const serverConfig = yield* ServerConfig;
      const threadId = ThreadId.makeUnsafe("thread-hermes-attachments");
      const imageAttachment = {
        type: "image" as const,
        id: "thread-hermes-attachments-00000000-0000-4000-8000-000000000001",
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: onePixelPng.byteLength,
      };
      mkdirSync(serverConfig.attachmentsDir, { recursive: true });
      writeFileSync(
        path.join(serverConfig.attachmentsDir, attachmentRelativePath(imageAttachment)),
        onePixelPng,
      );
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 8)).pipe(
        Effect.forkScoped,
      );

      yield* adapter.startSession({
        provider: "hermes",
        threadId,
        runtimeMode: "full-access",
        providerOptions: { hermes: { binaryPath: mock.binaryPath } },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "describe this image",
        attachments: [
          imageAttachment,
          {
            type: "assistant-selection",
            id: "thread-hermes-attachments-00000000-0000-4000-8000-000000000002",
            assistantMessageId: MessageId.makeUnsafe("message-hermes-previous"),
            text: "Prior assistant context",
          },
        ],
        modelSelection: {
          provider: "hermes",
          model: "minimax:MiniMax-M2.7",
        },
      });

      yield* Fiber.join(eventsFiber);

      const requests = parseRequestLog(requestLogPath);
      const setModelRequest = requests.find((request) => request.method === "session/set_model");
      assert.deepEqual(setModelRequest?.params, {
        sessionId: "mock-session-1",
        modelId: "minimax:MiniMax-M2.7",
      });

      const promptRequest = requests.find((request) => request.method === "session/prompt");
      const prompt =
        promptRequest === undefined
          ? undefined
          : (promptRequest.params as { prompt?: ReadonlyArray<Record<string, unknown>> }).prompt;
      assert.equal(prompt?.[0]?.type, "text");
      assert.equal(prompt?.[1]?.type, "image");
      assert.equal(prompt?.[1]?.mimeType, "image/png");
      assert.equal(prompt?.[1]?.data, onePixelPng.toString("base64"));
      assert.equal(prompt?.[2]?.type, "text");
      assert.equal(prompt?.[2]?.text, "Selected assistant message:\nPrior assistant context");
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => adapterRef?.stopAll().pipe(Effect.ignore) ?? Effect.void),
      ),
      Effect.ensuring(Effect.sync(mock.cleanup)),
      Effect.ensuring(Effect.sync(() => rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  it.effect("advertises runtime discovery capabilities that match adapter methods", () =>
    Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      const capabilities = yield* adapter.getComposerCapabilities();
      assert.equal(capabilities.supportsRuntimeModelList, true);
      assert.equal(typeof adapter.listModels, "function");
      assert.equal(typeof adapter.listAgents, "function");
    }),
  );
});
