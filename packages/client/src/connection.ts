import type {
  AuthWebSocketTokenResult,
  CompanionClientDescriptor,
  CompanionError,
  CompanionErrorCode,
  CompanionHello,
  CompanionShellStreamItem,
  CompanionThreadStreamItem,
} from "@synara/contracts";
import {
  COMPANION_PROTOCOL_VERSION,
  COMPANION_RPC_METHODS,
  COMPANION_WS_AUTH_PROTOCOL_PREFIX,
  COMPANION_WS_PATH,
  COMPANION_WS_PROTOCOL,
} from "@synara/contracts";

import type { CompanionAuthRequestOptions } from "./auth";
import { CompanionHttpError } from "./auth";
import { CompanionSequenceTracker } from "./sequence";
import type {
  CompanionRequestInput,
  CompanionRequestMap,
  CompanionRequestMethod,
  CompanionRequestOutput,
  CompanionStreamHandlers,
  CompanionStreamInput,
  CompanionStreamItem,
  CompanionStreamMap,
  CompanionStreamMethod,
  CompanionTransport,
  CompanionTransportFactory,
  CompanionTransportSubscription,
} from "./transport";

export type CompanionConnectionStatus =
  | "stopped"
  | "disconnected"
  | "authenticating"
  | "connecting"
  | "syncing"
  | "ready";

export class CompanionClientError extends Error {
  override readonly name = "CompanionClientError";

  constructor(
    readonly code: CompanionErrorCode | "SequenceGap" | "Stopped",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface CompanionConnectionState {
  readonly status: CompanionConnectionStatus;
  readonly attempt: number;
  readonly hello: CompanionHello | null;
  readonly error: CompanionClientError | null;
}

export interface CompanionTokenProvider {
  issueWebSocketToken(options?: CompanionAuthRequestOptions): Promise<AuthWebSocketTokenResult>;
}

export interface CompanionScheduler {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export interface CompanionBackoffOptions {
  readonly initialMs?: number;
  readonly maximumMs?: number;
  readonly jitterRatio?: number;
}

export interface CreateCompanionConnectionOptions {
  readonly baseUrl: string;
  readonly client: CompanionClientDescriptor;
  readonly tokenProvider: CompanionTokenProvider;
  readonly transportFactory: CompanionTransportFactory;
  readonly bearerToken?: () => string | undefined;
  readonly scheduler?: CompanionScheduler;
  readonly backoff?: CompanionBackoffOptions;
}

export interface CompanionManagedSubscription {
  unsubscribe(): Promise<void>;
}

interface RegisteredSubscription {
  readonly id: number;
  readonly method: CompanionStreamMethod;
  readonly input: CompanionStreamInput<CompanionStreamMethod>;
  readonly handlers: CompanionStreamHandlers<CompanionStreamItem<CompanionStreamMethod>>;
  readonly sequence: CompanionSequenceTracker;
  active: CompanionTransportSubscription | null;
}

const defaultScheduler: CompanionScheduler = {
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  random: Math.random,
};

const WEBSOCKET_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const companionAuthWebSocketProtocol = (token: string): string => {
  const protocol = `${COMPANION_WS_AUTH_PROTOCOL_PREFIX}${token}`;
  if (!WEBSOCKET_PROTOCOL_TOKEN.test(protocol)) {
    throw new CompanionClientError(
      "ValidationFailed",
      "The server issued a WebSocket credential that cannot be sent safely.",
      false,
    );
  }
  return protocol;
};

export const companionWebSocketUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else {
    throw new CompanionClientError(
      "ValidationFailed",
      "The Synara host URL must use HTTP or HTTPS.",
      false,
    );
  }
  url.pathname = COMPANION_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const isCompanionError = (value: unknown): value is CompanionError => {
  if (typeof value !== "object" || value === null) return false;
  return "_tag" in value && "message" in value && "retryable" in value;
};

const normalizeError = (error: unknown): CompanionClientError => {
  if (error instanceof CompanionClientError) return error;
  if (error instanceof CompanionHttpError) {
    return new CompanionClientError(error.code, error.message, error.retryable);
  }
  if (isCompanionError(error)) {
    return new CompanionClientError(error._tag, error.message, error.retryable);
  }
  return new CompanionClientError(
    "HostUnavailable",
    "The connection to the Synara host was lost.",
    true,
  );
};

const isTerminalError = (error: CompanionClientError): boolean =>
  error.code === "ProtocolMismatch" ||
  error.code === "SessionExpired" ||
  error.code === "Unauthenticated" ||
  (error.code === "ValidationFailed" && !error.retryable);

const streamSequence = (
  item: CompanionShellStreamItem | CompanionThreadStreamItem,
): { readonly sequence: number; readonly snapshot: boolean; readonly resync: boolean } => {
  if (item.kind === "snapshot") {
    return { sequence: item.snapshot.snapshotSequence, snapshot: true, resync: false };
  }
  return {
    sequence: item.sequence,
    snapshot: false,
    resync: item.kind === "resync-required",
  };
};

export class CompanionConnection {
  private readonly listeners = new Set<(state: CompanionConnectionState) => void>();
  private readonly subscriptions = new Map<number, RegisteredSubscription>();
  private readonly scheduler: CompanionScheduler;
  private readonly websocketUrl: string;
  private readonly initialBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private readonly jitterRatio: number;
  private stateValue: CompanionConnectionState = {
    status: "stopped",
    attempt: 0,
    hello: null,
    error: null,
  };
  private runController: AbortController | null = null;
  private runTask: Promise<void> | null = null;
  private transport: CompanionTransport | null = null;
  private nextSubscriptionId = 1;

  constructor(private readonly options: CreateCompanionConnectionOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.websocketUrl = companionWebSocketUrl(options.baseUrl);
    this.initialBackoffMs = Math.max(1, options.backoff?.initialMs ?? 1_000);
    this.maximumBackoffMs = Math.max(
      this.initialBackoffMs,
      options.backoff?.maximumMs ?? 30_000,
    );
    this.jitterRatio = Math.min(1, Math.max(0, options.backoff?.jitterRatio ?? 0.2));
  }

  get state(): CompanionConnectionState {
    return this.stateValue;
  }

  onState(listener: (state: CompanionConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.runTask !== null) return;
    const controller = new AbortController();
    this.runController = controller;
    this.setState({ status: "disconnected", attempt: 0, hello: null, error: null });
    const task = this.run(controller.signal);
    this.runTask = task;
    void task.finally(() => {
      if (this.runTask === task) this.runTask = null;
      if (this.runController === controller) this.runController = null;
    });
  }

  async stop(): Promise<void> {
    const task = this.runTask;
    this.runController?.abort(new CompanionClientError("Stopped", "Connection stopped.", false));
    await this.transport?.close("client-stopped").catch(() => undefined);
    if (task !== null) await task.catch(() => undefined);
    await this.closeActiveSubscriptions();
    this.transport = null;
    this.setState({ status: "stopped", attempt: 0, hello: null, error: null });
  }

  async waitUntilReady(signal?: AbortSignal): Promise<CompanionHello> {
    if (this.stateValue.status === "ready" && this.stateValue.hello !== null) {
      return this.stateValue.hello;
    }
    if (this.stateValue.status === "stopped" && this.stateValue.error !== null) {
      throw this.stateValue.error;
    }
    return new Promise<CompanionHello>((resolve, reject) => {
      let remove = (): void => undefined;
      const abort = (): void => {
        remove();
        reject(signal?.reason ?? new CompanionClientError("Stopped", "Connection stopped.", false));
      };
      remove = this.onState((state) => {
        if (state.status === "ready" && state.hello !== null) {
          remove();
          signal?.removeEventListener("abort", abort);
          resolve(state.hello);
        } else if (state.status === "stopped") {
          remove();
          signal?.removeEventListener("abort", abort);
          reject(
            state.error ?? new CompanionClientError("Stopped", "Connection stopped.", false),
          );
        }
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
    });
  }

  request<Method extends Exclude<CompanionRequestMethod, typeof COMPANION_RPC_METHODS.hello>>(
    method: Method,
    input: CompanionRequestInput<Method>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CompanionRequestOutput<Method>> {
    const transport = this.transport;
    if (this.stateValue.status !== "ready" || transport === null) {
      return Promise.reject(
        new CompanionClientError(
          "HostUnavailable",
          "Synara is not connected. Commands are not queued offline.",
          true,
        ),
      );
    }
    return transport.request(method, input, options);
  }

  subscribe<Method extends CompanionStreamMethod>(
    method: Method,
    input: CompanionStreamInput<Method>,
    handlers: CompanionStreamHandlers<CompanionStreamItem<Method>>,
  ): CompanionManagedSubscription {
    const id = this.nextSubscriptionId++;
    const registered: RegisteredSubscription = {
      id,
      method,
      input,
      handlers,
      sequence: new CompanionSequenceTracker(),
      active: null,
    } as RegisteredSubscription;
    this.subscriptions.set(id, registered);
    if (this.stateValue.status === "ready" && this.transport !== null) {
      void this.activateSubscription(registered, this.transport).catch((error) => {
        this.forceReconnect(normalizeError(error));
      });
    }
    return {
      unsubscribe: async () => {
        const current = this.subscriptions.get(id);
        this.subscriptions.delete(id);
        if (current?.active !== null && current?.active !== undefined) {
          await current.active.close().catch(() => undefined);
        }
      },
    };
  }

  private async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        this.setState({
          status: "authenticating",
          attempt,
          hello: null,
          error: null,
        });
        const bearerToken = this.options.bearerToken?.();
        const token = await this.options.tokenProvider.issueWebSocketToken({
          ...(bearerToken === undefined ? {} : { bearerToken }),
          signal,
        });
        this.setState({ status: "connecting", attempt, hello: null, error: null });
        const transport = await this.options.transportFactory.connect({
          url: this.websocketUrl,
          protocols: [COMPANION_WS_PROTOCOL, companionAuthWebSocketProtocol(token.token)],
          signal,
        });
        if (signal.aborted) {
          await transport.close("client-stopped").catch(() => undefined);
          break;
        }
        this.transport = transport;
        const hello = await transport.request(
          COMPANION_RPC_METHODS.hello,
          {
            protocolVersion: COMPANION_PROTOCOL_VERSION,
            client: this.options.client,
          },
          { signal },
        );
        if (hello.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
          throw new CompanionClientError(
            "ProtocolMismatch",
            `This client supports Companion Protocol v${COMPANION_PROTOCOL_VERSION}.`,
            false,
          );
        }
        this.setState({ status: "syncing", attempt, hello, error: null });
        await this.activateSubscriptions(transport);
        attempt = 0;
        this.setState({ status: "ready", attempt, hello, error: null });
        const closed = await transport.closed;
        if (!signal.aborted) {
          throw new CompanionClientError(
            "HostUnavailable",
            closed.reason === undefined
              ? "The connection to the Synara host closed."
              : `The connection to the Synara host closed: ${closed.reason}`,
            true,
          );
        }
      } catch (cause) {
        await this.cleanupTransport();
        if (signal.aborted) break;
        const error = normalizeError(cause);
        if (isTerminalError(error)) {
          this.setState({ status: "stopped", attempt, hello: null, error });
          return;
        }
        attempt += 1;
        this.setState({ status: "disconnected", attempt, hello: null, error });
        try {
          await this.scheduler.sleep(this.backoffDelay(attempt), signal);
        } catch {
          break;
        }
      }
    }
    await this.cleanupTransport();
    this.setState({ status: "stopped", attempt: 0, hello: null, error: null });
  }

  private backoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.maximumBackoffMs,
      this.initialBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    const jitter = 1 + (this.scheduler.random() * 2 - 1) * this.jitterRatio;
    return Math.max(1, Math.round(exponential * jitter));
  }

  private async activateSubscriptions(transport: CompanionTransport): Promise<void> {
    for (const subscription of this.subscriptions.values()) {
      await this.activateSubscription(subscription, transport);
    }
  }

  private async activateSubscription(
    subscription: RegisteredSubscription,
    transport: CompanionTransport,
  ): Promise<void> {
    subscription.sequence.reset();
    const active = await transport.subscribe(
      subscription.method,
      subscription.input,
      {
        onItem: (item) => {
          const sequence = streamSequence(item);
          const observation = subscription.sequence.observe(sequence.sequence, sequence.snapshot);
          if (sequence.resync || observation.disposition === "gap") {
            this.forceReconnect(
              new CompanionClientError(
                "SequenceGap",
                "A Companion stream update was missed; resynchronizing from a snapshot.",
                true,
              ),
            );
            return;
          }
          if (observation.disposition === "duplicate") return;
          try {
            subscription.handlers.onItem(item);
          } catch (error) {
            subscription.handlers.onError(error);
          }
        },
        onError: (error) => this.forceReconnect(normalizeError(error)),
      },
    );
    if (this.transport !== transport || !this.subscriptions.has(subscription.id)) {
      await active.close().catch(() => undefined);
      return;
    }
    subscription.active = active;
  }

  private forceReconnect(error: CompanionClientError): void {
    if (this.transport === null || this.runController?.signal.aborted === true) return;
    this.setState({
      status: "disconnected",
      attempt: Math.max(1, this.stateValue.attempt),
      hello: null,
      error,
    });
    void this.transport.close(error.code).catch(() => undefined);
  }

  private async closeActiveSubscriptions(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const subscription of this.subscriptions.values()) {
      subscription.sequence.reset();
      if (subscription.active !== null) {
        closing.push(subscription.active.close().catch(() => undefined));
        subscription.active = null;
      }
    }
    await Promise.all(closing);
  }

  private async cleanupTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    await this.closeActiveSubscriptions();
    await transport?.close("reconnect").catch(() => undefined);
  }

  private setState(state: CompanionConnectionState): void {
    this.stateValue = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // One UI observer must not break connection management for all clients.
      }
    }
  }
}

export const createCompanionConnection = (
  options: CreateCompanionConnectionOptions,
): CompanionConnection => new CompanionConnection(options);

export type CompanionUnaryOperations = CompanionRequestMap;
export type CompanionStreamingOperations = CompanionStreamMap;
