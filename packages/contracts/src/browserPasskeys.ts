import { Schema } from "effect";

const EncodedBytes = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export const BrowserPasskeyRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  publicKey: Schema.Struct({
    challenge: EncodedBytes,
    rpId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253))),
    timeout: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
    userVerification: Schema.optional(Schema.Literals(["required", "preferred", "discouraged"])),
    allowCredentials: Schema.Array(
      Schema.Struct({ type: Schema.Literal("public-key"), id: EncodedBytes }),
    ).check(Schema.isMaxLength(64)),
  }),
});
export type BrowserPasskeyRequest = typeof BrowserPasskeyRequest.Type;

export const BrowserPasskeyCredential = Schema.Struct({
  id: EncodedBytes,
  rawId: EncodedBytes,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    authenticatorData: EncodedBytes,
    clientDataJSON: EncodedBytes,
    signature: EncodedBytes,
    userHandle: Schema.NullOr(EncodedBytes),
  }),
});
export type BrowserPasskeyCredential = typeof BrowserPasskeyCredential.Type;
export type BrowserPasskeyResult =
  | { readonly ok: true; readonly credential: BrowserPasskeyCredential }
  | {
      readonly ok: false;
      readonly code: "SecurityError" | "NotAllowedError" | "AbortError" | "NotSupportedError";
    };

export interface BrowserPasskeyPrompt {
  readonly id: string;
  readonly origin: string;
  readonly rpId: string;
  readonly phase: "confirm" | "qr" | "waiting";
  readonly svg: string | null;
}
export interface BrowserPasskeyMethods {
  snapshot(): Promise<BrowserPasskeyPrompt | null>;
  start(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
