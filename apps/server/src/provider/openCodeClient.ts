import type { OpencodeClient } from "@opencode-ai/sdk/v2";

/** The semantic surface used by Synara; independent of the server's wire generation. */
type ClientMethod<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<{
      data?: (Awaited<R> extends { data?: infer D } ? D : never) | undefined;
      error?: unknown;
    }>
  : never;

type Methods<T, K extends keyof T> = { [P in K]: ClientMethod<T[P]> };

type SdkEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    stream: AsyncIterable<infer E>;
  }
    ? E
    : never;
export type OpenCodeEvent =
  | SdkEvent
  | {
      readonly type: "question.unsupported";
      readonly properties: {
        readonly sessionID: string;
        readonly requestID: string;
        readonly message: string;
      };
    }
  | { readonly type: "session.interrupted"; readonly properties: { readonly sessionID: string } }
  | {
      readonly type: "session.warning";
      readonly properties: {
        readonly sessionID: string;
        readonly message: string;
        readonly detail?: unknown;
      };
    };

export interface OpenCodeClient {
  readonly session: Methods<
    OpencodeClient["session"],
    | "create"
    | "get"
    | "update"
    | "prompt"
    | "promptAsync"
    | "status"
    | "abort"
    | "messages"
    | "children"
    | "revert"
    | "summarize"
    | "fork"
  >;
  readonly permission: Methods<OpencodeClient["permission"], "list" | "reply">;
  readonly question: Methods<OpencodeClient["question"], "list" | "reply" | "reject">;
  readonly mcp: Methods<OpencodeClient["mcp"], "add">;
  readonly provider: Methods<OpencodeClient["provider"], "list">;
  readonly app: Methods<OpencodeClient["app"], "agents">;
  readonly path: Methods<OpencodeClient["path"], "get">;
  readonly command: Methods<OpencodeClient["command"], "list">;
  readonly experimental: {
    readonly console: Methods<OpencodeClient["experimental"]["console"], "get">;
  };
  readonly event: {
    readonly subscribe: (
      parameters?: { directory?: string; workspace?: string },
      options?: { signal?: AbortSignal; onSseError?: (error: unknown) => void },
    ) => Promise<{ stream: AsyncIterable<OpenCodeEvent> }>;
  };
}
