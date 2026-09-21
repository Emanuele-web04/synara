import type { BrowserToolName, ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";

import type { BrowserHostRpcError } from "../browserHostRpcClient.ts";

export interface BrowserAutomationHostCall {
  readonly sessionKey: string;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly name: BrowserToolName;
  readonly arguments: Record<string, unknown>;
  /** server-resolved authenticated thread workspace — never accepted from MCP arguments */
  readonly workspaceRoot?: string;
  readonly timeoutMs: number;
}

export interface BrowserAutomationHostShape {
  readonly available: boolean;
  readonly execute: (
    input: BrowserAutomationHostCall,
  ) => Effect.Effect<unknown, BrowserHostRpcError>;
}

export class BrowserAutomationHost extends ServiceMap.Service<
  BrowserAutomationHost,
  BrowserAutomationHostShape
>()("synara/browserAutomation/Services/BrowserAutomationHost") {}
