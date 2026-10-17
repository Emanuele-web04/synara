/** Debugger children inherit normal user environment, never Synara control-plane authority.
 * This is environment hygiene, not a sandbox for explicitly trusted workspace code. */
export function editorChildEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  electron: boolean,
): NodeJS.ProcessEnv {
  const blocked = new Set([
    "BUN_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS",
  ]);
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => {
      const normalized = key.toUpperCase();
      return !normalized.startsWith("SYNARA_") && !blocked.has(normalized);
    }),
  );
  // Packaged desktop reuses Electron's executable; set this explicitly rather than
  // depending on an inherited native capability to prevent a second GUI process.
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}
