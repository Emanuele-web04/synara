/**
 * vercelSandboxSdk - minimal local typing + guarded loader for `@vercel/sandbox`.
 *
 * `@vercel/sandbox` is an optional dependency: it is only needed for the real
 * (credentialed) client. To keep `bun typecheck` green without the package
 * installed, this module declares the slice of the SDK the real client uses
 * locally rather than importing its types, and loads the runtime module through
 * a dynamic import whose specifier is hidden from the type checker (the `Bundler`
 * resolution would otherwise fail on a missing module). When the package is not
 * installed, {@link loadVercelSandboxSdk} fails loudly so a credentialed run
 * surfaces the missing dependency instead of silently degrading.
 *
 * To run against the real provider, install the dependency in `apps/server`:
 *
 *   bun add @vercel/sandbox
 *
 * @module vercelSandbox/vercelSandboxSdk
 */

/** A single structured log entry from a detached command's `logs()` iterable. */
export interface VercelSdkLogEntry {
  readonly stream: "stdout" | "stderr";
  readonly data: string | Uint8Array;
}

/** Writable-ish stdin handle a detached command exposes (Node `Writable`). */
export interface VercelSdkWritable {
  write(chunk: string | Uint8Array): unknown;
  end(): unknown;
}

/** A detached command handle returned by `runCommand({ detached: true })`. */
export interface VercelSdkCommand {
  readonly stdin?: VercelSdkWritable | null;
  logs(): AsyncIterable<VercelSdkLogEntry>;
  wait(): Promise<{ readonly exitCode: number }>;
  kill(): Promise<unknown>;
}

/** A finished (blocking) command result. */
export interface VercelSdkFinishedCommand {
  readonly exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

export interface VercelSdkRunCommandInput {
  readonly cmd: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly detached?: boolean;
}

/** Source the sandbox is seeded from (git clone is the common case). */
export interface VercelSdkGitSource {
  readonly type: "git";
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly revision?: string;
  readonly depth?: number;
}

export interface VercelSdkSnapshotSource {
  readonly type: "snapshot";
  readonly snapshotId: string;
}

export interface VercelSdkCreateInput {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly runtime?: string;
  readonly ports?: ReadonlyArray<number>;
  /** Initial wall-clock timeout in milliseconds. */
  readonly timeout?: number;
  readonly resources?: { readonly vcpus?: number };
  readonly source?: VercelSdkGitSource | VercelSdkSnapshotSource;
}

/** A live sandbox instance handle. */
export interface VercelSdkSandbox {
  readonly sandboxId: string;
  runCommand(input: VercelSdkRunCommandInput): Promise<VercelSdkCommand | VercelSdkFinishedCommand>;
  /** Resolve the public URL for a declared port. */
  domain(port: number): string;
  writeFiles(
    files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>,
  ): Promise<unknown>;
  readFile(input: {
    readonly path: string;
  }): Promise<Uint8Array | { stream(): AsyncIterable<Uint8Array> } | string>;
  mkDir?(path: string): Promise<unknown>;
  createSnapshot(): Promise<{ readonly snapshotId: string }>;
  /** Extend the wall-clock timeout by the given milliseconds. */
  extendTimeout?(timeoutMs: number): Promise<unknown>;
  stop(): Promise<unknown>;
}

/** Static constructor surface exposed by the `Sandbox` export. */
export interface VercelSdkSandboxStatic {
  create(input: VercelSdkCreateInput): Promise<VercelSdkSandbox>;
  get(input: {
    readonly sandboxId: string;
    readonly token: string;
    readonly teamId: string;
    readonly projectId: string;
  }): Promise<VercelSdkSandbox>;
}

export interface VercelSandboxSdk {
  readonly Sandbox: VercelSdkSandboxStatic;
}

/** Optional override for tests: supply a stub SDK without installing the package. */
export type VercelSandboxSdkLoader = () => Promise<VercelSandboxSdk>;

/**
 * The optional dependency's module specifier. Kept in a variable so the bare
 * string is never seen by `tsc` in an `import()` position; under
 * `moduleResolution: Bundler` a literal `import("@vercel/sandbox")` of a missing
 * package fails typecheck. The runtime import is real; only the static type
 * resolution is bypassed.
 */
const VERCEL_SANDBOX_MODULE = "@vercel/sandbox";

const importVercelSandbox = (): Promise<unknown> => import(VERCEL_SANDBOX_MODULE);

/**
 * Load the `@vercel/sandbox` runtime module, narrowed to {@link VercelSandboxSdk}.
 * Rejects with a clear message when the package is not installed so a
 * credentialed run fails loudly rather than silently.
 */
export const loadVercelSandboxSdk: VercelSandboxSdkLoader = () =>
  importVercelSandbox().then((module): VercelSandboxSdk => {
    const candidate = module as { readonly Sandbox?: unknown };
    if (candidate.Sandbox === undefined) {
      throw new Error(
        "@vercel/sandbox loaded but did not export `Sandbox`; the installed version is incompatible.",
      );
    }
    return candidate as VercelSandboxSdk;
  });
