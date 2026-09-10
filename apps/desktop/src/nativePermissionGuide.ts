import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DesktopPermissionSetupState } from "@synara/contracts";

/** Presentation only. This child never decides whether a permission was granted. */
export class NativePermissionGuide {
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing: Promise<void> | undefined;
  private lastState = "";
  constructor(
    private readonly options: {
      helperPath: string;
      appPath: string;
      appName: string;
      onAction: (action: "close" | "retry" | "reveal") => void;
      onError: (message: string) => void;
    },
  ) {}

  show(state: DesktopPermissionSetupState): void {
    if (this.closing) return;
    if (!this.child) {
      const child = spawn(
        this.options.helperPath,
        [
          "--permission-guide",
          "--app-path",
          this.options.appPath,
          "--app-name",
          this.options.appName,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child = child;
      this.lastState = "";
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 4096) {
          child.kill("SIGTERM");
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (this.child === child && ["close", "retry", "reveal"].includes(event.action))
              this.options.onAction(event.action);
          } catch {
            /* Ignore diagnostics; native events are bounded JSON. */
          }
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.once("error", (error) => this.options.onError(error.message));
      child.once("close", () => {
        if (this.child === child) {
          const wasClosing = Boolean(this.closing);
          this.child = undefined;
          this.closing = undefined;
          if (!wasClosing) this.options.onAction("close");
        }
      });
    }
    const encoded = JSON.stringify(state) + "\n";
    if (encoded !== this.lastState) {
      this.lastState = encoded;
      this.child.stdin.write(encoded);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.closing = new Promise<void>((resolve, reject) => {
      const terminate = setTimeout(() => child.kill("SIGTERM"), 500);
      const kill = setTimeout(() => child.kill("SIGKILL"), 1_500);
      const deadline = setTimeout(
        () => reject(new Error("The permission guide did not close.")),
        2_500,
      );
      child.once("close", () => {
        clearTimeout(terminate);
        clearTimeout(kill);
        clearTimeout(deadline);
        resolve();
      });
      child.stdin.end("close\n");
    }).finally(() => {
      if (!this.child) this.closing = undefined;
    });
    return this.closing;
  }
}
