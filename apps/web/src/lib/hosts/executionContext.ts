import type { ExecutionEnvironmentDescriptor, RemoteExecutionScope } from "@synara/contracts";

export interface WindowExecutionContext {
  readonly controller: ExecutionEnvironmentDescriptor;
  readonly execution: ExecutionEnvironmentDescriptor;
  readonly remoteHostId?: string;
  readonly remote: RemoteExecutionScope | null;
}
let context: WindowExecutionContext | undefined;
export function initializeExecutionContext(value: WindowExecutionContext): void {
  if (context) throw new Error("Execution context cannot change without reloading the window");
  context = Object.freeze(value);
}
export function readExecutionContext(): WindowExecutionContext | undefined {
  return context;
}
export function executionNamespace(): string | undefined {
  if (!context) return undefined;
  const remote = context.remote;
  return JSON.stringify(
    remote
      ? [
          "remote",
          remote.accountAuthority,
          remote.userId,
          remote.organizationId,
          context.execution.environmentId,
        ]
      : ["local", context.execution.environmentId],
  );
}
export function executionKey(key: string): string {
  const namespace = executionNamespace();
  return namespace ? `synara:execution:${encodeURIComponent(namespace)}:${key}` : key;
}
