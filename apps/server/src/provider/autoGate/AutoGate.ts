/**
 * Local Auto-approval gate: scores every escalated action with the on-device
 * ProCreations/auto-0.4b ONNX classifier so "auto" runtime mode can approve
 * routine work without a provider-native auto path. The model is downloaded
 * lazily into the Synara state dir and only runs while the user's
 * `autoEngine: "local"` setting is on.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, appendFile } from "node:fs/promises";

import type { ProviderKind, RuntimeMode } from "@synara/contracts";
import { Effect, Layer, Ref, Semaphore, ServiceMap } from "effect";

import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import {
  selectAcpPermissionOptionId,
  type AcpPermissionPolicyOutcome,
} from "../acp/AcpAdapterSupport";
import {
  autoGateThresholdsForPreset,
  buildGateInputText,
  decideAutoGate,
  isAlwaysPromptToolCall,
  type AutoGateVerdict,
} from "./autoGatePolicy";

export const AUTO_GATE_MODEL_REPO = "ProCreations/auto-0.4b-ONNX";
export const AUTO_GATE_MODEL_FILES = ["model.onnx", "tokenizer.json", "labels.json"] as const;

export class AutoGateError extends Error {
  readonly _tag = "AutoGateError";
  constructor(
    readonly stage: "download" | "load" | "inference",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AutoGateError";
  }
}

export type AutoGateModelState =
  | { readonly state: "not-downloaded" }
  | { readonly state: "downloading"; readonly bytesDone: number }
  | { readonly state: "ready" }
  | { readonly state: "error"; readonly detail: string };

export interface AutoGateStatus {
  readonly model: AutoGateModelState;
  readonly modelDir: string;
  readonly counts: {
    readonly allowed: number;
    readonly denied: number;
    readonly escalated: number;
  };
}

export interface AutoGateVerdictLogEntry {
  readonly provider: ProviderKind;
  readonly verdict: AutoGateVerdict["kind"];
  readonly pDeny: number;
  readonly reason?: string | undefined;
}

export class AutoGateBackend extends ServiceMap.Service<
  AutoGateBackend,
  {
    /** Download (if needed) and load the model. Idempotent and single-flight. */
    readonly ensureReady: Effect.Effect<void, AutoGateError>;
    /** Probability that the proposed action should be denied, in [0, 1]. */
    readonly score: (text: string) => Effect.Effect<number, AutoGateError>;
    readonly modelDir: string;
    readonly statusRef: Ref.Ref<AutoGateModelState>;
  }
>()("synara/AutoGateBackend") {}

const hfTreeUrl = `https://huggingface.co/api/models/${AUTO_GATE_MODEL_REPO}/tree/main`;
const hfResolveUrl = (file: string) =>
  `https://huggingface.co/${AUTO_GATE_MODEL_REPO}/resolve/main/${file}`;

const sha256Hex = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const fileShaIfComplete = (path: string, expected: string): Promise<boolean> =>
  sha256Hex(path)
    .then((sha) => sha === expected)
    .catch(() => false);

const markError =
  (statusRef: Ref.Ref<AutoGateModelState>) =>
  (error: AutoGateError): Effect.Effect<never, AutoGateError> =>
    Ref.set(statusRef, { state: "error", detail: error.message }).pipe(
      Effect.andThen(Effect.fail(error)),
    );

const downloadModelFiles = (
  modelDir: string,
  statusRef: Ref.Ref<AutoGateModelState>,
): Effect.Effect<void, AutoGateError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(hfTreeUrl),
      catch: (cause) => new AutoGateError("download", `model catalog fetch failed: ${cause}`),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new AutoGateError("download", `model catalog HTTP ${response.status}`),
      );
    }
    const entries = yield* Effect.tryPromise({
      try: () => response.json() as Promise<Array<{ path: string; lfs?: { sha256?: string } }>>,
      catch: (cause) => new AutoGateError("download", `model catalog parse failed: ${cause}`),
    });
    const shaByPath = new Map(entries.map((entry) => [entry.path, entry.lfs?.sha256]));

    yield* Effect.tryPromise({
      try: () => mkdir(modelDir, { recursive: true }),
      catch: (cause) => new AutoGateError("download", `model dir failed: ${cause}`),
    });

    let bytesDone = 0;
    for (const file of AUTO_GATE_MODEL_FILES) {
      const target = join(modelDir, file);
      const sha256 = shaByPath.get(file);
      if (
        sha256 !== undefined &&
        (yield* Effect.promise(() => fileShaIfComplete(target, sha256)))
      ) {
        continue;
      }
      const download = yield* Effect.tryPromise({
        try: () => fetch(hfResolveUrl(file)),
        catch: (cause) => new AutoGateError("download", `${file} fetch failed: ${cause}`),
      });
      if (!download.ok || download.body === null) {
        return yield* Effect.fail(new AutoGateError("download", `${file} HTTP ${download.status}`));
      }
      const part = `${target}.part`;
      yield* Effect.tryPromise({
        try: async () => {
          const stream = createWriteStream(part);
          try {
            for await (const chunk of download.body! as unknown as AsyncIterable<Uint8Array>) {
              stream.write(chunk);
              bytesDone += chunk.byteLength;
            }
            await new Promise<void>((resolve, reject) => {
              stream.end(() => resolve());
              stream.on("error", reject);
            });
          } catch (cause) {
            stream.destroy();
            throw cause;
          }
        },
        catch: (cause) => new AutoGateError("download", `${file} write failed: ${cause}`),
      });
      if (sha256 !== undefined && (yield* Effect.promise(() => sha256Hex(part))) !== sha256) {
        return yield* Effect.fail(
          new AutoGateError("download", `${file} checksum mismatch (expected ${sha256})`),
        );
      }
      yield* Effect.tryPromise({
        try: () => rename(part, target),
        catch: (cause) => new AutoGateError("download", `${file} rename failed: ${cause}`),
      });
      yield* Ref.set(statusRef, { state: "downloading", bytesDone });
    }
  });

export const AutoGateBackendLive = Layer.effect(
  AutoGateBackend,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const modelDir = join(config.stateDir, "models", "auto-0.4b");
    const statusRef = yield* Ref.make<AutoGateModelState>({ state: "not-downloaded" });
    const downloadLock = yield* Semaphore.make(1);
    const sessionRef = yield* Ref.make<
      { readonly tokenizer: any; readonly session: any } | undefined
    >(undefined);

    const ensureReady = downloadLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(sessionRef)) !== undefined) {
          return;
        }
        const present = yield* Effect.promise(async () => {
          try {
            await stat(join(modelDir, "model.onnx"));
            await stat(join(modelDir, "tokenizer.json"));
            return true;
          } catch {
            return false;
          }
        });
        if (!present) {
          yield* Ref.set(statusRef, { state: "downloading", bytesDone: 0 });
          yield* downloadModelFiles(modelDir, statusRef).pipe(Effect.catch(markError(statusRef)));
        }
        const loaded = yield* Effect.tryPromise({
          try: async () => {
            const [{ Tokenizer }, ort] = await Promise.all([
              import("tokenizers"),
              import("onnxruntime-node"),
            ]);
            const tokenizer = await Tokenizer.fromFile(join(modelDir, "tokenizer.json"));
            const session = await ort.InferenceSession.create(join(modelDir, "model.onnx"));
            return { tokenizer, session };
          },
          catch: (cause) => new AutoGateError("load", `model load failed: ${cause}`, { cause }),
        }).pipe(Effect.catch(markError(statusRef)));
        yield* Ref.set(sessionRef, loaded);
        yield* Ref.set(statusRef, { state: "ready" });
      }),
    );

    const score = (text: string): Effect.Effect<number, AutoGateError> =>
      Effect.gen(function* () {
        yield* ensureReady;
        const loaded = yield* Ref.get(sessionRef);
        if (loaded === undefined) {
          return yield* Effect.fail(new AutoGateError("load", "model not loaded"));
        }
        const encoding = yield* Effect.tryPromise({
          try: async () => {
            const enc = await loaded.tokenizer.encode(text, undefined, true);
            const ids = enc.getIds() as number[];
            if (ids.length <= 8192) {
              return { ids, mask: enc.getAttentionMask() as number[] };
            }
            // Keep the head (proposed action) and the tail (recent context).
            const head = 4096;
            const tail = 8192 - head;
            return {
              ids: [...ids.slice(0, head), ...ids.slice(ids.length - tail)],
              mask: Array.from({ length: 8192 }, () => 1),
            };
          },
          catch: (cause) => new AutoGateError("inference", `tokenize failed: ${cause}`),
        });
        return yield* Effect.tryPromise({
          try: async () => {
            const { Tensor } = await import("onnxruntime-node");
            const results = await loaded.session.run({
              input_ids: new Tensor(
                "int64",
                BigInt64Array.from(encoding.ids, (v) => BigInt(v)),
                [1, encoding.ids.length],
              ),
              attention_mask: new Tensor(
                "int64",
                BigInt64Array.from(encoding.mask, (v: number) => BigInt(v)),
                [1, encoding.mask.length],
              ),
            });
            const logits = (
              (results.logits ?? results[loaded.session.outputNames[0]!]).data as Float32Array
            ).slice(0, 2);
            const denominator = Math.exp(logits[0]!) + Math.exp(logits[1]!);
            return Math.exp(logits[1]!) / denominator;
          },
          catch: (cause) => new AutoGateError("inference", `inference failed: ${cause}`),
        });
      });

    return AutoGateBackend.of({ ensureReady, score, modelDir, statusRef });
  }),
);

export class AutoGate extends ServiceMap.Service<
  AutoGate,
  {
    /**
     * Resolve an escalated action locally, or return `undefined` so the caller
     * keeps its existing prompt path. Only acts when the thread is in `auto`
     * runtime mode and the engine setting is `local`.
     */
    readonly decide: (input: {
      readonly provider: ProviderKind;
      readonly runtimeMode: RuntimeMode;
      readonly toolCall: { readonly title?: string | undefined; readonly rawInput?: unknown };
      readonly options: ReadonlyArray<{
        readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
        readonly optionId: string;
      }>;
      readonly userRequest?: string | undefined;
      readonly history?: string | undefined;
      readonly logVerdict?: (entry: AutoGateVerdictLogEntry) => Effect.Effect<void>;
    }) => Effect.Effect<AcpPermissionPolicyOutcome | undefined>;
    readonly status: Effect.Effect<AutoGateStatus>;
    /** Downloads the model files and opens the ONNX session, if not done yet. */
    readonly ensureReady: Effect.Effect<void, AutoGateError>;
  }
>()("synara/AutoGate") {}

export const AutoGateLayer = Layer.effect(
  AutoGate,
  Effect.gen(function* () {
    const backend = yield* AutoGateBackend;
    const settings = yield* ServerSettingsService;
    const counts = yield* Ref.make({ allowed: 0, denied: 0, escalated: 0 });

    const status: Effect.Effect<AutoGateStatus> = Effect.map(
      Effect.all({ model: Ref.get(backend.statusRef), counts: Ref.get(counts) }),
      ({ model, counts: c }) => ({ model, modelDir: backend.modelDir, counts: { ...c } }),
    );

    const recordVerdict = (input: {
      readonly provider: ProviderKind;
      readonly verdict: AutoGateVerdict;
      readonly reason?: string | undefined;
      readonly logVerdict?: ((entry: AutoGateVerdictLogEntry) => Effect.Effect<void>) | undefined;
    }) => {
      const entry: AutoGateVerdictLogEntry = {
        provider: input.provider,
        verdict: input.verdict.kind,
        pDeny: input.verdict.pDeny,
        reason: input.reason,
      };
      const telemetry = Effect.promise(() =>
        appendFile(
          join(backend.modelDir, "..", "auto-gate-telemetry.jsonl"),
          JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
        ).catch(() => undefined),
      );
      return telemetry.pipe(Effect.andThen(input.logVerdict?.(entry) ?? Effect.void));
    };

    const decide: Parameters<typeof AutoGate.of>[0]["decide"] = (input) =>
      Effect.gen(function* () {
        const { autoEngine, autoGateThresholdPreset } = yield* settings.getSettings.pipe(
          Effect.catch(() =>
            Effect.succeed({ autoEngine: "native", autoGateThresholdPreset: "balanced" } as const),
          ),
        );
        if (input.runtimeMode !== "auto" || autoEngine !== "local") {
          return undefined;
        }

        const escalate = (reason: string, pDeny = Number.NaN) =>
          Ref.update(counts, (c) => ({ ...c, escalated: c.escalated + 1 })).pipe(
            Effect.andThen(
              recordVerdict({
                provider: input.provider,
                verdict: { kind: "prompt", pDeny, reason: "uncertain-band" },
                reason,
                logVerdict: input.logVerdict,
              }),
            ),
            Effect.as(undefined as AcpPermissionPolicyOutcome | undefined),
          );

        const alwaysPrompt = isAlwaysPromptToolCall(input.toolCall);
        const pDeny = alwaysPrompt
          ? 1
          : yield* backend
              .score(
                buildGateInputText({
                  toolCall: input.toolCall,
                  userRequest: input.userRequest,
                  history: input.history,
                }),
              )
              .pipe(
                // A scoring failure must never silently allow: fail open to the
                // existing approval card.
                Effect.catch(() => escalate("model-error").pipe(Effect.as(Number.NaN))),
              );
        if (Number.isNaN(pDeny)) {
          return undefined;
        }
        const verdict = decideAutoGate({
          pDeny,
          thresholds: autoGateThresholdsForPreset(autoGateThresholdPreset),
          alwaysPrompt,
        });
        if (verdict.kind === "prompt") {
          return yield* escalate(verdict.reason, pDeny);
        }
        const optionId = selectAcpPermissionOptionId(
          verdict.kind === "allow" ? "accept" : "decline",
          input.options,
        );
        if (optionId === undefined) {
          return yield* escalate("no-matching-option", pDeny);
        }
        yield* Ref.update(counts, (c) =>
          verdict.kind === "allow"
            ? { ...c, allowed: c.allowed + 1 }
            : { ...c, denied: c.denied + 1 },
        );
        yield* recordVerdict({
          provider: input.provider,
          verdict,
          logVerdict: input.logVerdict,
        });
        return { outcome: "selected", optionId } satisfies AcpPermissionPolicyOutcome;
      });

    return AutoGate.of({ decide, status, ensureReady: backend.ensureReady });
  }),
);

export const AutoGateLive = AutoGateLayer.pipe(Layer.provide(AutoGateBackendLive));
