export type PtyAdapterRuntime = "bun" | "node";

export function selectPtyAdapterRuntime(input: {
  readonly platform: NodeJS.Platform;
  readonly runtime: PtyAdapterRuntime;
}): PtyAdapterRuntime {
  // node-pty ships a Windows ConPTY binding loadable from Bun — same implementation under either JS runtime on Windows
  return input.platform === "win32" ? "node" : input.runtime;
}
