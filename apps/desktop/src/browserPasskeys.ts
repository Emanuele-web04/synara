import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Schema } from "effect";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { getDomain } from "tldts";
import {
  BrowserPasskeyCredential,
  BrowserPasskeyRequest,
  type BrowserPasskeyPrompt,
  type BrowserPasskeyResult,
} from "@synara/contracts";
import { spawnProcess, didProcessFailToSpawn } from "@synara/shared/processRuntime";
import type { BrowserAutomationVisibleRuntime, DesktopBrowserManager } from "./browserManager";
import { BROWSER_IPC_CHANNELS } from "./ipcChannels";
import { stopNativeHelper } from "./stopNativeHelper";

const ErrorCode = Schema.Literals([
  "SecurityError",
  "NotAllowedError",
  "AbortError",
  "NotSupportedError",
]);
const NativeMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("qr"),
    svg: Schema.String.check(Schema.isMaxLength(262144)),
  }),
  Schema.Struct({ type: Schema.Literal("waiting") }),
  Schema.Struct({ type: Schema.Literal("result"), credential: BrowserPasskeyCredential }),
  Schema.Struct({ type: Schema.Literal("error"), code: ErrorCode }),
]);

export function passkeyRelyingParty(origin: string, requested?: string): string {
  const url = new URL(origin);
  const rp = requested ?? url.hostname;
  if (
    url.origin !== origin ||
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) ||
    !/^[a-z0-9.-]+$/.test(rp) ||
    rp.endsWith(".") ||
    !(url.hostname === rp || url.hostname.endsWith(`.${rp}`)) ||
    (rp !== "localhost" && getDomain(rp, { allowPrivateDomains: true }) === null)
  )
    throw new Error("Invalid relying party.");
  return rp;
}

export function validatePasskeyCredential(
  credential: BrowserPasskeyCredential,
  request: BrowserPasskeyRequest,
  origin: string,
  rpId: string,
): void {
  const client = JSON.parse(
    Buffer.from(credential.response.clientDataJSON, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const data = Buffer.from(credential.response.authenticatorData, "base64url");
  const user =
    credential.response.userHandle === null
      ? null
      : Buffer.from(credential.response.userHandle, "base64url");
  if (
    client.type !== "webauthn.get" ||
    client.origin !== origin ||
    client.crossOrigin === true ||
    typeof client.challenge !== "string" ||
    !Buffer.from(client.challenge, "base64url").equals(
      Buffer.from(request.publicKey.challenge, "base64url"),
    ) ||
    credential.id !== credential.rawId ||
    Buffer.from(credential.rawId, "base64url").length === 0 ||
    Buffer.from(credential.response.signature, "base64url").length === 0 ||
    data.length < 37 ||
    (data[32]! & 1) === 0 ||
    !data.subarray(0, 32).equals(createHash("sha256").update(rpId).digest()) ||
    (request.publicKey.userVerification === "required" && (data[32]! & 4) === 0) ||
    (request.publicKey.allowCredentials.length === 0 && (!user || user.length === 0)) ||
    (user !== null && user.length > 64) ||
    (request.publicKey.allowCredentials.length > 0 &&
      !request.publicKey.allowCredentials.some((allowed) =>
        Buffer.from(allowed.id, "base64url").equals(Buffer.from(credential.rawId, "base64url")),
      ))
  )
    throw new Error("Invalid credential response.");
}

interface ActiveRequest {
  readonly contents: WebContents;
  readonly documentUrl: string;
  readonly request: BrowserPasskeyRequest;
  readonly resolve: (result: BrowserPasskeyResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  prompt: BrowserPasskeyPrompt;
  child?: ChildProcessWithoutNullStreams;
  exited: boolean;
  terminal?: BrowserPasskeyResult;
  cancellation?: Promise<void>;
  releaseHumanOperation?: (() => void) | undefined;
}

export class BrowserPasskeys {
  private readonly contents = new Set<WebContents>();
  private active: ActiveRequest | undefined;
  private disposed = false;

  constructor(
    private readonly helperPath: string,
    private readonly notify: () => void,
    private readonly beginHumanOperation?: () => () => void,
  ) {}

  available(): boolean {
    return (
      !this.disposed &&
      ["darwin", "linux"].includes(process.platform) &&
      existsSync(this.helperPath)
    );
  }

  register(runtime: BrowserAutomationVisibleRuntime): () => void {
    const contents = runtime.webContents;
    this.contents.add(contents);
    const cancel = () => {
      if (this.active?.contents === contents) void this.cancel(this.active.prompt.id);
    };
    const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) cancel();
    };
    contents.on("did-start-navigation", navigating);
    contents.on("render-process-gone", cancel);
    contents.on("destroyed", cancel);
    return () => {
      cancel();
      this.contents.delete(contents);
      contents.removeListener("did-start-navigation", navigating);
      contents.removeListener("render-process-gone", cancel);
      contents.removeListener("destroyed", cancel);
    };
  }

  snapshot(): BrowserPasskeyPrompt | null {
    return this.active?.prompt ?? null;
  }

  abortFrom(contents: WebContents, id: string): Promise<void> {
    return this.active?.contents === contents ? this.cancel(id) : Promise.resolve();
  }

  request(event: IpcMainInvokeEvent, raw: unknown): Promise<BrowserPasskeyResult> {
    if (!this.available()) return Promise.resolve({ ok: false, code: "NotSupportedError" });
    if (!this.contents.has(event.sender) || event.senderFrame !== event.sender.mainFrame)
      return Promise.resolve({ ok: false, code: "SecurityError" });
    if (this.active) return Promise.resolve({ ok: false, code: "NotAllowedError" });
    let request: BrowserPasskeyRequest;
    let origin: string;
    let rpId: string;
    try {
      if (JSON.stringify(raw).length > 65_536) throw new Error("Too large.");
      request = Schema.decodeUnknownSync(BrowserPasskeyRequest)(raw);
      origin = new URL(event.senderFrame.url).origin;
      rpId = passkeyRelyingParty(origin, request.publicKey.rpId);
      if (new URL(event.sender.getURL()).origin !== origin) throw new Error("Stale document.");
    } catch {
      return Promise.resolve({ ok: false, code: "SecurityError" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          void this.cancel(request.id);
        },
        Math.min(request.publicKey.timeout ?? 120_000, 120_000),
      );
      this.active = {
        contents: event.sender,
        documentUrl: event.sender.getURL(),
        request,
        resolve,
        timer,
        exited: false,
        prompt: { id: request.id, origin, rpId, phase: "confirm", svg: null },
      };
      this.notify();
    });
  }

  start(id: string): void {
    const active = this.active;
    if (!active || active.prompt.id !== id || active.child || active.cancellation) return;
    if (active.contents.isDestroyed() || active.contents.getURL() !== active.documentUrl) {
      void this.cancel(id);
      return;
    }
    try {
      active.releaseHumanOperation = this.beginHumanOperation?.();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          [
            "PATH",
            "HOME",
            "TMPDIR",
            "TMP",
            "TEMP",
            "LANG",
            "LC_ALL",
            "XDG_RUNTIME_DIR",
            "DBUS_SYSTEM_BUS_ADDRESS",
            "DBUS_SESSION_BUS_ADDRESS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
          ].includes(key),
        ),
      );
      const child = spawnProcess(this.helperPath, [], {
        stdio: "pipe",
        requireExecutable: true,
        env,
      });
      active.child = child;
      active.prompt = { ...active.prompt, phase: "waiting" };
      this.notify();
      let pending = "";
      let received = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 524_288) {
          void this.cancel(id);
          return;
        }
        pending += chunk.toString("utf8");
        while (pending.includes("\n")) {
          const split = pending.indexOf("\n");
          const line = pending.slice(0, split);
          pending = pending.slice(split + 1);
          try {
            const message = Schema.decodeUnknownSync(NativeMessage)(JSON.parse(line));
            if (active.cancellation || active.terminal || this.active !== active) continue;
            if (message.type === "qr")
              active.prompt = { ...active.prompt, phase: "qr", svg: message.svg };
            if (message.type === "waiting")
              active.prompt = { ...active.prompt, phase: "waiting", svg: null };
            if (message.type === "result") {
              validatePasskeyCredential(
                message.credential,
                active.request,
                active.prompt.origin,
                active.prompt.rpId,
              );
              active.terminal = { ok: true, credential: message.credential };
            }
            if (message.type === "error") active.terminal = { ok: false, code: message.code };
            this.notify();
          } catch {
            void this.cancel(id);
          }
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => {
        void this.cancel(id);
      });
      child.on("error", () => {
        if (didProcessFailToSpawn(child)) {
          active.exited = true;
          this.finish(active, { ok: false, code: "NotAllowedError" });
        } else {
          void this.cancel(id);
        }
      });
      child.on("exit", () => {
        active.exited = true;
      });
      child.on("close", (code) => {
        active.exited = true;
        const current =
          !active.contents.isDestroyed() && active.contents.getURL() === active.documentUrl;
        this.finish(
          active,
          current && !active.cancellation && code === 0
            ? (active.terminal ?? { ok: false, code: "NotAllowedError" })
            : { ok: false, code: "AbortError" },
        );
      });
      child.stdin.end(
        JSON.stringify({
          origin: active.prompt.origin,
          publicKey: {
            ...active.request.publicKey,
            rpId: active.prompt.rpId,
            userVerification: active.request.publicKey.userVerification ?? "preferred",
          },
        }),
      );
    } catch {
      if (active.child) void this.cancel(id);
      else this.finish(active, { ok: false, code: "NotAllowedError" });
    }
  }

  cancel(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.prompt.id !== id) return Promise.resolve();
    if (active.cancellation) return active.cancellation;
    active.terminal = { ok: false, code: "AbortError" };
    active.cancellation = (async () => {
      if (active.child) await stopNativeHelper(active.child, () => active.exited);
      this.finish(active, { ok: false, code: "AbortError" });
    })().catch(() => {
      active.resolve({ ok: false, code: "NotAllowedError" });
    });
    return active.cancellation;
  }

  private finish(active: ActiveRequest, result: BrowserPasskeyResult): void {
    if (this.active !== active) return;
    clearTimeout(active.timer);
    this.active = undefined;
    try {
      active.releaseHumanOperation?.();
    } finally {
      active.resolve(result);
      this.notify();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.active) await this.cancel(this.active.prompt.id);
  }
}

export function registerBrowserPasskeyIpc(
  ipcMain: IpcMain,
  manager: DesktopBrowserManager,
  passkeys: BrowserPasskeys,
): void {
  const channels = BROWSER_IPC_CHANNELS.passkeys;
  ipcMain.on(channels.available, (event) => {
    event.returnValue = passkeys.available();
  });
  ipcMain.handle(channels.request, (event, raw) => passkeys.request(event, raw));
  ipcMain.handle(channels.abort, (event, id: unknown) => {
    const prompt = passkeys.snapshot();
    if (typeof id !== "string" || !prompt || event.senderFrame !== event.sender.mainFrame) return;
    return passkeys.abortFrom(event.sender, id);
  });
  const trusted = (event: IpcMainInvokeEvent) =>
    manager.isTrustedRenderer(event.sender.id) && event.senderFrame === event.sender.mainFrame;
  ipcMain.handle(channels.snapshot, (event) => (trusted(event) ? passkeys.snapshot() : null));
  ipcMain.handle(channels.start, (event, id: unknown) => {
    if (trusted(event) && typeof id === "string") passkeys.start(id);
  });
  ipcMain.handle(channels.cancel, (event, id: unknown) => {
    if (trusted(event) && typeof id === "string") return passkeys.cancel(id);
  });
}
