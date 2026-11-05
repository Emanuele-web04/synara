import http from "node:http";
import type { Duplex } from "node:stream";
import { signDpopProof } from "@synara/shared/deviceKey";
import {
  remoteResourcePresentationUrl,
  remoteResourceRoute,
  REMOTE_RESOURCE_PATH,
} from "@synara/shared/remoteResources";
import type { RemoteResourceReference } from "@synara/contracts";
import { openRemoteTlsChannel, type DialIdentity, type RemoteChannelInput } from "./dialer";
import { proxyResourceRequest, resourceRequestHeaders } from "../remoteTransport/resourceProxy";

/** One small keepalive pool per authorized host credential, never per renderer. */
export class RemoteResourcePool {
  readonly #agent = new http.Agent({
    keepAlive: true,
    maxSockets: 2,
    maxTotalSockets: 2,
    maxFreeSockets: 2,
    scheduling: "fifo",
    timeout: 30_000,
  });
  readonly #lifetime = new AbortController();
  readonly #active = new Set<http.ServerResponse>();
  readonly #expiry: NodeJS.Timeout;
  #pending = 0;
  #transfers = 0;
  readonly #waiting: Array<() => void> = [];
  constructor(
    readonly input: RemoteChannelInput & {
      readonly identity: DialIdentity;
      readonly credential: string;
      readonly credentialExpiresAtSeconds: number;
    },
  ) {
    this.#agent.createConnection = (_options, callback) => {
      void openRemoteTlsChannel({
        ...input,
        signal: input.signal
          ? AbortSignal.any([input.signal, this.#lifetime.signal])
          : this.#lifetime.signal,
      }).then(
        ({ socket }) => {
          if (this.#lifetime.signal.aborted) {
            socket.destroy();
            callback?.(new Error("Remote resource pool closed"), undefined as unknown as Duplex);
          } else callback?.(null, socket);
        },
        (error: Error) => callback?.(error, undefined as unknown as Duplex),
      );
      return undefined as unknown as Duplex;
    };
    this.#expiry = setTimeout(
      () => this.close(),
      Math.max(1, input.credentialExpiresAtSeconds * 1000 - Date.now()),
    );
    this.#expiry.unref();
  }
  get closed(): boolean {
    return this.#lifetime.signal.aborted;
  }
  close(): void {
    if (this.closed) return;
    this.#lifetime.abort();
    clearTimeout(this.#expiry);
    for (const response of this.#active) response.destroy();
    this.#active.clear();
    this.#agent.destroy();
  }
  private acquire(response: http.ServerResponse): Promise<() => void> {
    if (this.closed || response.destroyed)
      return Promise.reject(new Error("Remote transfer cancelled"));
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        response.off("close", cancel);
      };
      const cancel = () => {
        const index = this.#waiting.indexOf(start);
        if (index >= 0) this.#waiting.splice(index, 1);
        cleanup();
        reject(new Error("Remote resource queue cancelled"));
      };
      const start = () => {
        cleanup();
        this.#transfers++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.#transfers--;
          this.#waiting.shift()?.();
        });
      };
      if (this.#transfers < 2) start();
      else {
        this.#waiting.push(start);
        response.once("close", cancel);
        timer = setTimeout(cancel, 30_000);
        timer.unref();
      }
    });
  }
  async forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    reference: RemoteResourceReference,
  ): Promise<void> {
    if (this.closed || reference.environmentId !== this.input.anchor.environmentId)
      throw new Error("Remote resource authorization expired");
    if (this.#pending >= 32) throw new Error("Remote resource request limit exceeded");
    const route = remoteResourceRoute(reference.resource);
    if (request.method !== route.method) throw new Error("Wrong resource method");
    const headers = resourceRequestHeaders(request.headers, route.maxBodyBytes);
    this.#pending++;
    this.#active.add(response);
    let released = false;
    let permit: (() => void) | undefined;
    const release = () => {
      if (!released) {
        released = true;
        this.#pending--;
        this.#active.delete(response);
        permit?.();
      }
    };
    response.once("close", release);
    try {
      // Node Agent does not count asynchronous createConnection attempts until
      // their callbacks return. Bound admission before dialing as well as sockets.
      permit = await this.acquire(response);
      if (released) {
        permit();
        throw new Error("Remote resource cancelled");
      }
      const encoded = JSON.stringify(reference);
      const dpop = await signDpopProof({
        key: this.input.identity.key,
        publicJwk: this.input.identity.publicJwk,
        method: route.method,
        url: remoteResourcePresentationUrl(reference.environmentId, encoded),
        accessToken: this.input.credential,
      });
      if (this.closed || response.destroyed) throw new Error("Remote resource cancelled");
      proxyResourceRequest({
        request,
        response,
        maxBodyBytes: route.maxBodyBytes,
        target: {
          hostname: "remote.invalid",
          port: 80,
          agent: this.#agent,
          method: route.method,
          path: `${REMOTE_RESOURCE_PATH}?${new URLSearchParams({ reference: encoded })}`,
          headers: { ...headers, authorization: `DPoP ${this.input.credential}`, dpop },
        },
        onDone: release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}
