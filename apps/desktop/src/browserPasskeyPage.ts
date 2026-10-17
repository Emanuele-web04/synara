import type { BrowserPasskeyRequest, BrowserPasskeyResult } from "@synara/contracts";

export function installPhonePasskeys(): void {
  const root = window as Window & {
    __synaraPhonePasskeys?: {
      request(input: BrowserPasskeyRequest): Promise<BrowserPasskeyResult>;
      abort(id: string): Promise<void>;
    };
  };
  const bridge = root.__synaraPhonePasskeys;
  if (!bridge || !window.isSecureContext || !navigator.credentials || window.top !== window) return;
  const original = navigator.credentials.get.bind(navigator.credentials);
  const encodeBase64 = btoa.bind(window);
  const decodeBase64 = atob.bind(window);
  const encode = (value: ArrayBuffer | ArrayBufferView): string => {
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    if (bytes.length === 0 || bytes.length > 4096) throw new TypeError("Invalid credential bytes.");
    return encodeBase64(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  };
  const decode = (value: string): ArrayBuffer =>
    Uint8Array.from(decodeBase64(value.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
      character.charCodeAt(0),
    ).buffer;
  navigator.credentials.get = async (
    options?: CredentialRequestOptions,
  ): Promise<Credential | null> => {
    if (
      !options?.publicKey ||
      options.mediation === "conditional" ||
      options.mediation === "silent"
    )
      return original(options);
    const key = options.publicKey;
    const signal = options.signal;
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const abort = () => {
      void bridge.abort(id).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const input: BrowserPasskeyRequest = {
        id,
        publicKey: {
          challenge: encode(key.challenge),
          ...(key.rpId === undefined ? {} : { rpId: key.rpId }),
          ...(key.timeout === undefined ? {} : { timeout: key.timeout }),
          ...(key.userVerification === undefined ? {} : { userVerification: key.userVerification }),
          allowCredentials: (key.allowCredentials ?? []).map((credential) => ({
            type: credential.type,
            id: encode(credential.id),
          })),
        },
      };
      signal?.throwIfAborted();
      const pending = bridge.request(input);
      if (signal?.aborted) abort();
      const result = await pending;
      signal?.throwIfAborted();
      if (!result.ok)
        throw new DOMException("The phone-passkey request could not be completed.", result.code);
      const credential = result.credential;
      const response = Object.create(
        AuthenticatorAssertionResponse.prototype,
      ) as AuthenticatorAssertionResponse;
      Object.defineProperties(response, {
        clientDataJSON: { enumerable: true, value: decode(credential.response.clientDataJSON) },
        authenticatorData: {
          enumerable: true,
          value: decode(credential.response.authenticatorData),
        },
        signature: { enumerable: true, value: decode(credential.response.signature) },
        userHandle: {
          enumerable: true,
          value:
            credential.response.userHandle === null ? null : decode(credential.response.userHandle),
        },
      });
      const output = Object.create(PublicKeyCredential.prototype) as PublicKeyCredential;
      Object.defineProperties(output, {
        id: { enumerable: true, value: credential.id },
        rawId: { enumerable: true, value: decode(credential.rawId) },
        type: { enumerable: true, value: "public-key" },
        response: { enumerable: true, value: response },
        authenticatorAttachment: { enumerable: true, value: "cross-platform" },
        getClientExtensionResults: { configurable: true, writable: true, value: () => ({}) },
        toJSON: {
          configurable: true,
          writable: true,
          value: () => ({
            ...credential,
            authenticatorAttachment: "cross-platform",
            clientExtensionResults: {},
          }),
        },
      });
      return output;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
  PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  const constructor = PublicKeyCredential as typeof PublicKeyCredential & {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  };
  const capabilities = constructor.getClientCapabilities?.bind(constructor);
  constructor.getClientCapabilities = async () => {
    const native = (await capabilities?.().catch(() => ({}))) ?? {};
    return {
      ...Object.fromEntries(Object.keys(native).map((name) => [name, false])),
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
    };
  };
}
