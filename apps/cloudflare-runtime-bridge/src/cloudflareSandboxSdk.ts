/**
 * cloudflareSandboxSdk - minimal local typing + guarded loader for
 * `@cloudflare/sandbox`.
 *
 * `@cloudflare/sandbox` is an optional dependency: it is only needed when the
 * bridge is deployed against the real Sandbox runtime. To keep this package's
 * `tsc --noEmit` green without the SDK (and without vendoring
 * `@cloudflare/workers-types`), this module declares the slice of the SDK the
 * real runtime adapter uses locally rather than importing its types, and loads
 * the runtime module through a dynamic import whose specifier is hidden from the
 * type checker (under `moduleResolution: Bundler` a literal
 * `import("@cloudflare/sandbox")` of a missing package fails typecheck). When the
 * package is not installed, {@link loadCloudflareSandboxSdk} fails loudly so a
 * misconfigured deploy surfaces the missing dependency instead of silently
 * degrading.
 *
 * To run the real workspace flavor, the deployed Worker must depend on the SDK
 * and export its Durable Object class:
 *
 *   npm add @cloudflare/sandbox
 *   // workerEntry.ts: export { Sandbox } from "@cloudflare/sandbox";
 *
 * @module cloudflareSandboxSdk
 */

/** A single streamed output event from a managed process. */
export interface CloudflareSdkProcessEvent {
  readonly channel?: "stdout" | "stderr";
  readonly data: string;
}

/** A managed background process started with `startProcess`. */
export interface CloudflareSdkProcess {
  readonly id: string;
  kill(signal?: string): Promise<unknown>;
}

export interface CloudflareSdkExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CloudflareSdkExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface CloudflareSdkStartProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly onOutput?: (channel: "stdout" | "stderr", data: string) => void;
  readonly onExit?: (code: number | null) => void;
}

/** A live sandbox handle, narrowed to the operations the bridge runtime uses. */
export interface CloudflareSdkSandbox {
  exec(command: string, options?: CloudflareSdkExecOptions): Promise<CloudflareSdkExecResult>;
  startProcess(
    command: string,
    options?: CloudflareSdkStartProcessOptions,
  ): Promise<CloudflareSdkProcess>;
  readFile(path: string): Promise<{ readonly content: string | Uint8Array } | string | Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<unknown>;
  exposePort(
    port: number,
    options?: { readonly name?: string },
  ): Promise<{ readonly url: string } | string>;
  destroy(): Promise<unknown>;
}

/**
 * The SDK surface the loader exposes: `getSandbox` resolves a sandbox handle from
 * the bound Durable Object namespace and an instance id.
 */
export interface CloudflareSandboxSdk {
  getSandbox(
    binding: unknown,
    id: string,
    options?: { readonly normalizeId?: boolean },
  ): CloudflareSdkSandbox;
}

/** Optional override for tests: supply a stub SDK without installing the package. */
export type CloudflareSandboxSdkLoader = () => Promise<CloudflareSandboxSdk>;

/**
 * The optional dependency's module specifier. Kept in a variable so the bare
 * string is never seen by `tsc` in an `import()` position; under
 * `moduleResolution: Bundler` a literal `import("@cloudflare/sandbox")` of a
 * missing package fails typecheck. The runtime import is real; only static type
 * resolution is bypassed.
 */
const CLOUDFLARE_SANDBOX_MODULE = "@cloudflare/sandbox";

const importCloudflareSandbox = (): Promise<unknown> => import(CLOUDFLARE_SANDBOX_MODULE);

/**
 * Load the `@cloudflare/sandbox` runtime module, narrowed to
 * {@link CloudflareSandboxSdk}. Rejects with a clear message when the package is
 * not installed (or is missing the expected export) so a misconfigured deploy
 * fails loudly rather than silently.
 */
export const loadCloudflareSandboxSdk: CloudflareSandboxSdkLoader = () =>
  importCloudflareSandbox().then((module): CloudflareSandboxSdk => {
    const candidate = module as { readonly getSandbox?: unknown };
    if (typeof candidate.getSandbox !== "function") {
      throw new Error(
        "`@cloudflare/sandbox` loaded but did not export a `getSandbox` function; the installed version is incompatible.",
      );
    }
    return candidate as CloudflareSandboxSdk;
  });
