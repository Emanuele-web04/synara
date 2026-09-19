/**
 * The environment a desktop application launched by the agent starts with.
 *
 * The server's own environment is the wrong thing to inherit. It carries the
 * server's secrets (`SYNARA_AUTH_TOKEN`, provider API keys), the Electron
 * runtime's control variables (`ELECTRON_RUN_AS_NODE` turns a launched Electron
 * app into a headless node process; `NODE_OPTIONS` injects into every Node
 * child), and whatever a developer's shell had exported. A browser or editor
 * the agent opens must see none of that — only what a desktop session gives
 * every application: where its home is, which display and bus to talk to, and
 * how to render text.
 *
 * One allowlist rather than a denylist, because the set of things that must
 * not leak grows with every integration while the set a desktop app needs does
 * not. Shared by every Linux backend that spawns applications, so a variable
 * added here is scrubbed or kept the same way on each of them.
 *
 * @module computer/desktopAppEnvironment
 */

/** Exact variable names a desktop application is entitled to. */
const DESKTOP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XAUTHORITY",
]);

/** Variable-name prefixes a desktop application is entitled to. */
const DESKTOP_ENVIRONMENT_PREFIXES: readonly string[] = ["LC_", "XDG_", "QT_", "GTK_", "GDK_"];

function isDesktopEnvironmentName(name: string): boolean {
  if (DESKTOP_ENVIRONMENT_NAMES.has(name)) return true;
  return DESKTOP_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * `base` reduced to the desktop session's variables, with `overrides` applied
 * on top verbatim. Overrides are the caller's explicit decision — a nested
 * compositor's `WAYLAND_DISPLAY`, an Xwayland `DISPLAY` — so they are never
 * filtered, and an override set to `undefined` removes the variable.
 */
export function desktopApplicationEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || !isDesktopEnvironmentName(name)) continue;
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}
