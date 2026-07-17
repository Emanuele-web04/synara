import {
  AuthBearerBootstrapResult,
  AuthBootstrapResult,
  AuthLogoutResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  CompanionError,
  CompanionUpdateDeviceLabelResult,
  type CompanionErrorCode,
} from "@synara/contracts";
import { Schema } from "effect";

export interface CompanionFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface CompanionFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly credentials?: "include" | "omit";
  readonly signal?: AbortSignal;
}

export type CompanionFetch = (
  input: string,
  init?: CompanionFetchInit,
) => Promise<CompanionFetchResponse>;

export class CompanionHttpError extends Error {
  override readonly name = "CompanionHttpError";

  constructor(
    readonly code: CompanionErrorCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface CompanionAuthRequestOptions {
  readonly bearerToken?: string;
  readonly signal?: AbortSignal;
}

export interface CompanionBootstrapOptions {
  readonly deviceLabel?: string;
  readonly signal?: AbortSignal;
}

export interface CompanionAuthClient {
  getSession(options?: CompanionAuthRequestOptions): Promise<AuthSessionState>;
  bootstrap(
    credential: string,
    options?: CompanionBootstrapOptions,
  ): Promise<AuthBootstrapResult>;
  bootstrapBearer(
    credential: string,
    options?: CompanionBootstrapOptions,
  ): Promise<AuthBearerBootstrapResult>;
  updateDeviceLabel(
    deviceLabel: string,
    options?: CompanionAuthRequestOptions,
  ): Promise<CompanionUpdateDeviceLabelResult>;
  issueWebSocketToken(options?: CompanionAuthRequestOptions): Promise<AuthWebSocketTokenResult>;
  logout(options?: CompanionAuthRequestOptions): Promise<AuthLogoutResult>;
}

export interface CreateCompanionAuthClientOptions {
  readonly baseUrl: string;
  readonly fetch: CompanionFetch;
}

// HTTP JSON carries DateTime values as ISO strings; the JSON codecs restore the
// same typed values that Effect RPC consumers receive.
const decodeAuthSessionState = Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState));
const decodeAuthBootstrapResult = Schema.decodeUnknownSync(Schema.toCodecJson(AuthBootstrapResult));
const decodeAuthBearerBootstrapResult = Schema.decodeUnknownSync(
  Schema.toCodecJson(AuthBearerBootstrapResult),
);
const decodeAuthWebSocketTokenResult = Schema.decodeUnknownSync(
  Schema.toCodecJson(AuthWebSocketTokenResult),
);
const decodeAuthLogoutResult = Schema.decodeUnknownSync(Schema.toCodecJson(AuthLogoutResult));
const decodeCompanionUpdateDeviceLabelResult = Schema.decodeUnknownSync(
  Schema.toCodecJson(CompanionUpdateDeviceLabelResult),
);
const isCompanionError: (value: unknown) => value is CompanionError = Schema.is(CompanionError);

const httpOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CompanionHttpError(
      "ValidationFailed",
      "The Synara host URL must use HTTP or HTTPS.",
      0,
      false,
    );
  }
  return url.origin;
};

const statusCodeToErrorCode = (status: number): CompanionErrorCode => {
  if (status === 401) return "SessionExpired";
  if (status === 403) return "Forbidden";
  if (status === 404) return "NotFound";
  if (status === 409) return "Conflict";
  if (status === 413) return "PayloadTooLarge";
  if (status === 429) return "RateLimited";
  if (status >= 500) return "HostUnavailable";
  return "ValidationFailed";
};

const defaultErrorMessage = (status: number): string => {
  if (status === 401) return "The Synara session has expired.";
  if (status === 403) return "This session cannot perform that operation.";
  if (status === 429) return "Too many requests. Try again shortly.";
  if (status >= 500) return "The Synara host is temporarily unavailable.";
  return "Synara rejected the request.";
};

export const createCompanionAuthClient = ({
  baseUrl,
  fetch: fetchRequest,
}: CreateCompanionAuthClientOptions): CompanionAuthClient => {
  const root = httpOrigin(baseUrl);

  const request = async <Result>(
    path: string,
    decode: (input: unknown) => Result,
    options: CompanionAuthRequestOptions & {
      readonly method?: "GET" | "POST" | "PATCH";
      readonly body?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<Result> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.bearerToken !== undefined) {
      headers.Authorization = `Bearer ${options.bearerToken}`;
    }

    let response: CompanionFetchResponse;
    try {
      response = await fetchRequest(`${root}${path}`, {
        method: options.method ?? "GET",
        headers,
        credentials: "include",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      throw new CompanionHttpError(
        "HostUnavailable",
        "Could not reach the Synara host.",
        0,
        true,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      if (isCompanionError(body)) {
        throw new CompanionHttpError(body._tag, body.message, response.status, body.retryable);
      }
      const code = statusCodeToErrorCode(response.status);
      throw new CompanionHttpError(
        code,
        defaultErrorMessage(response.status),
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    try {
      return decode(body);
    } catch {
      throw new CompanionHttpError(
        "InternalError",
        "The Synara host returned an invalid response.",
        502,
        false,
      );
    }
  };

  return {
    getSession: (options = {}) => request("/api/auth/session", decodeAuthSessionState, options),
    bootstrap: (credential, options = {}) =>
      request("/api/auth/bootstrap", decodeAuthBootstrapResult, {
        ...(options.signal ? { signal: options.signal } : {}),
        method: "POST",
        body: { credential, ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}) },
      }),
    bootstrapBearer: (credential, options = {}) =>
      request("/api/auth/bootstrap/bearer", decodeAuthBearerBootstrapResult, {
        ...(options.signal ? { signal: options.signal } : {}),
        method: "POST",
        body: { credential, ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}) },
      }),
    updateDeviceLabel: (deviceLabel, options = {}) =>
      request(
        "/api/companion/v1/session/device-label",
        decodeCompanionUpdateDeviceLabelResult,
        {
          ...options,
          method: "PATCH",
          body: { deviceLabel },
        },
      ),
    issueWebSocketToken: (options = {}) =>
      request("/api/auth/ws-token", decodeAuthWebSocketTokenResult, {
        ...options,
        method: "POST",
      }),
    logout: (options = {}) =>
      request("/api/auth/logout", decodeAuthLogoutResult, {
        ...options,
        method: "POST",
      }),
  };
};
