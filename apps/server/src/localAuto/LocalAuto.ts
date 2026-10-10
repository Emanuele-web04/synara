import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { LOCAL_AUTO_REVISION, type LocalAutoManageInput, LocalAutoStatus } from "@synara/contracts";
import { resolveWindowsPowerShellExecutable } from "@synara/shared/platformEnvironment";
import { spawnProcess } from "@synara/shared/processRuntime";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config";
import { signalOwnedChildProcess } from "../platform/processTreeController";
import { runProcess } from "../processRunner";
import { LOCAL_AUTO_WORKER } from "./workerSource";

const UV_VERSION = "0.12.13";
const INSTALLER_HASHES = {
  sh: "e7265962d703f3ca66b3e90fae8fcdc6d4e4b587027e9479ccc29b25c3f68d4e",
  ps1: "6a749fe05b2617ede62127832d6f4c37e7b406740c7bc0dc62fe77f5e5ebdb20",
};
const NOT_INSTALLED: LocalAutoStatus = {
  phase: "not-installed",
  detail: "Install once. Reviews run locally.",
  device: null,
  maxTokens: null,
};
export interface LocalAutoDecision {
  readonly decision: "approve" | "deny" | "ask";
  readonly pDeny?: number;
  readonly reason?: string;
}

export function parseDecision(value: unknown): LocalAutoDecision {
  if (typeof value !== "object" || value === null) return { decision: "ask" };
  const result = value as Record<string, unknown>;
  if (result.decision === "ask")
    return { decision: "ask", reason: "Local review needs manual approval." };
  if (
    typeof result.pDeny !== "number" ||
    !Number.isFinite(result.pDeny) ||
    result.pDeny < 0 ||
    result.pDeny > 1
  )
    return { decision: "ask" };
  const decision = result.pDeny >= 0.5 ? "deny" : "approve";
  return result.decision === decision ? { decision, pDeny: result.pDeny } : { decision: "ask" };
}

// One worker and one in-flight inference per server. Requests never use a shell,
// an HTTP listener, or command-line arguments to transport private context.
export class LocalAutoRuntime {
  status: LocalAutoStatus = { ...NOT_INSTALLED };
  private installation: AbortController | undefined;
  private installJob: Promise<void> | undefined;
  private worker: ChildProcessWithoutNullStreams | undefined;
  private pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly python: string;
  private readonly script: string;

  constructor(private readonly root: string) {
    this.python = join(
      root,
      "venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    this.script = join(root, "worker.py");
    this.env = {
      ...process.env,
      UV_UNMANAGED_INSTALL: join(root, "bin"),
      UV_PYTHON_INSTALL_DIR: join(root, "python"),
      UV_CACHE_DIR: join(root, "cache"),
      HF_HOME: join(root, "huggingface"),
      HF_HUB_CACHE: join(root, "huggingface", "hub"),
      KERNELS_CACHE: join(root, "huggingface", "hub"),
      TORCH_HOME: join(root, "cache", "torch"),
      TRITON_CACHE_DIR: join(root, "cache", "triton"),
      CUDA_CACHE_PATH: join(root, "cache", "cuda"),
      HF_HUB_OFFLINE: "0",
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
      TOKENIZERS_PARALLELISM: "false",
      PYTHONNOUSERSITE: "1",
      PYTHONUNBUFFERED: "1",
    };
    delete this.env.PYTHONPATH;
    delete this.env.PYTHONHOME;
    delete this.env.HF_TOKEN;
    delete this.env.LOCAL_KERNELS;
  }

  async initialize() {
    try {
      const receipt = JSON.parse(await readFile(join(this.root, "installed.json"), "utf8"));
      if (receipt.revision === LOCAL_AUTO_REVISION)
        this.status = Schema.decodeUnknownSync(LocalAutoStatus)(receipt.status);
    } catch {
      /* Missing/invalid receipt is not an installation. */
    }
  }

  async manage(input: LocalAutoManageInput): Promise<LocalAutoStatus> {
    if (input.action === "cancel") {
      this.installation?.abort();
      await this.installJob;
    } else if (input.action === "install" && !this.installJob && this.status.phase !== "ready") {
      this.stopWorker();
      const controller = new AbortController();
      this.installation = controller;
      this.status = {
        ...NOT_INSTALLED,
        phase: "installing",
        detail: "Preparing the local runtime…",
      };
      this.installJob = this.install(controller.signal)
        .catch((error: unknown) => {
          this.status = {
            ...NOT_INSTALLED,
            phase: controller.signal.aborted ? "not-installed" : "error",
            detail: controller.signal.aborted
              ? "Installation cancelled. You can retry anytime."
              : `Installation failed. ${error instanceof Error ? error.message.slice(-600) : "Please retry."}`,
          };
        })
        .finally(() => {
          this.installJob = undefined;
          this.installation = undefined;
        });
    }
    return this.status;
  }

  private async install(signal: AbortSignal) {
    if (process.platform === "darwin" && process.arch === "x64")
      throw new Error(
        "Current PyTorch wheels require Apple Silicon on macOS. Intel CPUs are supported on Windows and Linux.",
      );
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const extension = process.platform === "win32" ? "ps1" : "sh";
    const response = await fetch(
      `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-installer.${extension}`,
      { signal },
    );
    if (!response.ok) throw new Error(`Runtime download failed (${response.status}).`);
    const installer = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(installer).digest("hex") !== INSTALLER_HASHES[extension])
      throw new Error("Runtime installer checksum mismatch.");
    const installerPath = join(this.root, `install-uv.${extension}`);
    await writeFile(installerPath, installer, { mode: 0o600 });
    const execute = (command: string, args: string[], timeoutMs = 20 * 60_000) =>
      runProcess(command, args, {
        cwd: this.root,
        env: this.env,
        signal,
        timeoutMs,
        maxBufferBytes: 256 * 1024,
        outputMode: "truncate",
      });
    await execute(
      extension === "sh" ? "sh" : resolveWindowsPowerShellExecutable(this.env),
      extension === "sh"
        ? [installerPath]
        : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath],
    );
    const uv = join(this.root, "bin", process.platform === "win32" ? "uv.exe" : "uv");
    this.status = { ...this.status, detail: "Installing Python and inference libraries…" };
    await execute(uv, [
      "venv",
      "--allow-existing",
      "--no-config",
      "--python",
      "3.12",
      "--managed-python",
      join(this.root, "venv"),
    ]);
    const dependencies = [
      "pip",
      "install",
      "--no-config",
      "--python",
      this.python,
      "--only-binary",
      ":all:",
      "torch==2.13.0",
      "transformers==5.16.1",
      "kernels==0.16.1",
    ];
    try {
      await execute(uv, [...dependencies, "--torch-backend", "auto"]);
    } catch (error) {
      if (signal.aborted) throw error;
      // Drivers without a matching wheel still have a supported CPU path.
      await execute(uv, [...dependencies, "--torch-backend", "cpu"]);
    }
    await writeFile(this.script, LOCAL_AUTO_WORKER, { mode: 0o600 });
    this.status = { ...this.status, detail: "Downloading Auto 0.4b 2 and checking this device…" };
    const result = await execute(this.python, ["-I", this.script, this.root, "--install"]);
    const info = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null");
    const status = Schema.decodeUnknownSync(LocalAutoStatus)({
      phase: "ready",
      detail: "Ready for local tool reviews",
      device: info.device,
      maxTokens: info.maxTokens,
    });
    if (signal.aborted) throw new Error("Cancelled");
    await writeFile(
      join(this.root, "installed.json"),
      JSON.stringify({ revision: LOCAL_AUTO_REVISION, status }),
      { mode: 0o600 },
    );
    this.status = status;
  }

  private receive(signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, value?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending = undefined;
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        finish(new Error("Local review cancelled"));
        this.stopWorker();
      };
      const timer = setTimeout(() => {
        finish(new Error("Local review timed out"));
        this.stopWorker();
      }, 90_000);
      this.pending = { resolve: (value) => finish(null, value), reject: (error) => finish(error) };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async classify(text: string, signal: AbortSignal): Promise<LocalAutoDecision> {
    if (
      this.status.phase !== "ready" ||
      Buffer.byteLength(text) > 2 * 1024 * 1024 ||
      signal.aborted
    )
      return { decision: "ask" };
    clearTimeout(this.idleTimer);
    let starting = !this.worker;
    try {
      if (!this.worker) {
        // Rewrite the bundled worker after application upgrades, using only
        // installed weights and cached kernels during inference.
        await writeFile(this.script, LOCAL_AUTO_WORKER, { mode: 0o600 });
        const worker = spawnProcess(this.python, ["-I", this.script, this.root], {
          cwd: this.root,
          env: { ...this.env, HF_HUB_OFFLINE: "1" },
          stdio: "pipe",
        });
        this.worker = worker;
        const ready = this.receive(signal);
        const lines = createInterface({ input: worker.stdout });
        lines.on("line", (line) => {
          try {
            this.pending?.resolve(JSON.parse(line));
          } catch {
            this.pending?.reject(new Error("Invalid classifier response"));
          }
        });
        worker.stderr.resume();
        worker.stdin.on("error", () => this.stopWorker());
        worker.on("error", () => this.stopWorker());
        worker.on("exit", () => {
          if (this.worker === worker) this.stopWorker();
          lines.close();
        });
        const info = (await ready) as { device: string; maxTokens: number };
        this.status = Schema.decodeUnknownSync(LocalAutoStatus)({
          ...this.status,
          device: info.device,
          maxTokens: info.maxTokens,
        });
      }
      starting = false;
      const reply = this.receive(signal);
      this.worker?.stdin.write(`${JSON.stringify({ text })}\n`);
      return parseDecision(await reply);
    } catch {
      this.stopWorker();
      if (starting && !signal.aborted)
        this.status = {
          ...NOT_INSTALLED,
          phase: "error",
          detail: "The local runtime could not start. Reinstall Auto to repair it.",
        };
      return { decision: "ask", reason: "Local review unavailable. Review this request manually." };
    } finally {
      this.idleTimer = setTimeout(() => this.stopWorker(), 5 * 60_000);
      this.idleTimer.unref();
    }
  }

  private stopWorker() {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = undefined;
    this.pending?.reject(new Error("Local classifier stopped"));
    this.pending = undefined;
    if (worker) signalOwnedChildProcess(worker, "SIGKILL");
  }

  async dispose() {
    this.installation?.abort();
    this.stopWorker();
    await this.installJob;
  }
}

export class LocalAuto extends ServiceMap.Service<
  LocalAuto,
  {
    readonly manage: (input: LocalAutoManageInput) => Effect.Effect<LocalAutoStatus, Error>;
    readonly classify: (text: string) => Effect.Effect<LocalAutoDecision>;
  }
>()("synara/LocalAuto") {}

export const LocalAutoLive = Layer.effect(
  LocalAuto,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const runtime = new LocalAutoRuntime(join(config.stateDir, "local-auto"));
    yield* Effect.promise(() => runtime.initialize());
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
    const semaphore = yield* Semaphore.make(1);
    return {
      manage: (input: LocalAutoManageInput) =>
        Effect.tryPromise({
          try: () => runtime.manage(input),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
      classify: (text: string) =>
        semaphore.withPermits(1)(Effect.promise((signal) => runtime.classify(text, signal))),
    };
  }),
);
