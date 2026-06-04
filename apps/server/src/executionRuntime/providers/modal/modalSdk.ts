/**
 * modalSdk - minimal local typing + guarded loader for the `modal` JS SDK.
 *
 * The `modal` package (libmodal's JavaScript client) is an optional dependency:
 * it is only needed for the real (credentialed) backend's ingress path, where a
 * live Modal sandbox exposes an encrypted tunnel. To keep `bun typecheck` green
 * without the package installed, this module declares the slice of the SDK the
 * real backend uses locally rather than importing its types, and loads the
 * runtime module through a dynamic import whose specifier is hidden from the type
 * checker (under `moduleResolution: Bundler` a literal `import("modal")` of a
 * missing package fails typecheck). When the package is not installed,
 * {@link loadModalSdk} fails loudly so a credentialed run surfaces the missing
 * dependency instead of silently degrading.
 *
 * To run the real ingress path, install the dependency in `apps/server`:
 *
 *   bun add modal
 *
 * @module modal/modalSdk
 */

/** Construction options for the `modal` client (credentials carry the auth). */
export interface ModalSdkClientOptions {
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly environment?: string;
}

/** A single tunnel exposed on a sandbox port: `url()` returns the public URL. */
export interface ModalSdkTunnel {
  url(): string;
}

/** A live sandbox handle, narrowed to the ingress operations the backend uses. */
export interface ModalSdkSandbox {
  readonly sandboxId: string;
  /** Tunnels keyed by the container port they forward to (`*.modal.run`). */
  tunnels(): Promise<Record<number, ModalSdkTunnel>>;
  /** `null` while running; the exit code once the sandbox has finished. */
  poll(): Promise<number | null>;
  terminate(): Promise<unknown>;
}

/** The `sandboxes` namespace, narrowed to the lookup the backend needs. */
export interface ModalSdkSandboxes {
  fromId(sandboxId: string): Promise<ModalSdkSandbox>;
}

/** The `ModalClient` instance surface the backend touches. */
export interface ModalSdkClient {
  readonly sandboxes: ModalSdkSandboxes;
}

export interface ModalSdk {
  /** Construct a credentialed client. */
  makeClient(options: ModalSdkClientOptions): ModalSdkClient;
}

/** Optional override for tests: supply a stub SDK without installing the package. */
export type ModalSdkLoader = () => Promise<ModalSdk>;

/**
 * The optional dependency's module specifier. Kept in a variable so the bare
 * string is never seen by `tsc` in an `import()` position; under
 * `moduleResolution: Bundler` a literal `import("modal")` of a missing package
 * fails typecheck. The runtime import is real; only static type resolution is
 * bypassed.
 */
const MODAL_MODULE = "modal";

const importModal = (): Promise<unknown> => import(MODAL_MODULE);

/** The `ModalClient` constructor shape the runtime module is expected to export. */
type ModalClientCtor = new (options: {
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly environment?: string;
}) => ModalSdkClient;

/**
 * Load the `modal` runtime module and adapt its `ModalClient` constructor into
 * the {@link ModalSdk} factory shape. Rejects with a clear message when the
 * package is not installed (or is missing the expected export) so a credentialed
 * run fails loudly rather than silently.
 */
export const loadModalSdk: ModalSdkLoader = () =>
  importModal().then((module): ModalSdk => {
    const candidate = module as { readonly ModalClient?: unknown };
    if (typeof candidate.ModalClient !== "function") {
      throw new Error(
        "`modal` loaded but did not export a `ModalClient` constructor; the installed version is incompatible.",
      );
    }
    const Ctor = candidate.ModalClient as ModalClientCtor;
    return {
      makeClient: (options) =>
        new Ctor({
          tokenId: options.tokenId,
          tokenSecret: options.tokenSecret,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
        }),
    };
  });
