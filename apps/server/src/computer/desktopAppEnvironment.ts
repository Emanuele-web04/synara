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
import { pathToFileURL } from "node:url";

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
  // Kept so the accessibility switch below survives a second scrub (the
  // nested session re-scrubs what the backend already did).
  "ACCESSIBILITY_ENABLED",
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

/**
 * Accessibility switched on for applications the agent launches — never for
 * the human's own, which this module never touches. Perception reads the
 * AT-SPI tree, and toolkits that build theirs lazily have none until an
 * assistive technology asks: Chromium and Electron expose one empty frame, and
 * Qt only bridges when told to. `ACCESSIBILITY_ENABLED` is what Chromium and
 * GTK's bridge check; the Qt variable forces Qt's.
 */
export const AGENT_ACCESSIBILITY_ENVIRONMENT: Readonly<Record<string, string>> = {
  ACCESSIBILITY_ENABLED: "1",
  QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
};

/** Chromium's switch for building the web-content tree from the start. */
export const CHROMIUM_ACCESSIBILITY_ARGUMENT = "--force-renderer-accessibility";

/**
 * Executables and Flatpak ids known to be Chromium or Electron, so they take
 * Chromium switches. Deliberately a list rather than a guess: an unknown
 * program handed an unknown switch may refuse to start.
 */
const CHROMIUM_FAMILY_EXECUTABLES: ReadonlySet<string> = new Set([
  "chromium",
  "chromium-browser",
  "ungoogled-chromium",
  "chrome",
  "google-chrome",
  "google-chrome-stable",
  "google-chrome-beta",
  "google-chrome-unstable",
  "brave",
  "brave-browser",
  "brave-browser-stable",
  "microsoft-edge",
  "microsoft-edge-stable",
  "microsoft-edge-beta",
  "microsoft-edge-dev",
  "vivaldi",
  "vivaldi-stable",
  "opera",
  "electron",
  "code",
  "code-insiders",
  "code-oss",
  "codium",
  "vscodium",
  "cursor",
  "slack",
  "discord",
  "signal-desktop",
  "obsidian",
  "element-desktop",
  "teams-for-linux",
]);

const CHROMIUM_FAMILY_FLATPAKS: ReadonlySet<string> = new Set([
  "org.chromium.Chromium",
  "io.github.ungoogled_software.ungoogled_chromium",
  "com.google.Chrome",
  "com.google.ChromeDev",
  "com.brave.Browser",
  "com.microsoft.Edge",
  "com.vivaldi.Vivaldi",
  "com.opera.Opera",
  "com.visualstudio.code",
  "com.vscodium.codium",
  "com.slack.Slack",
  "com.discordapp.Discord",
  "org.signal.Signal",
  "md.obsidian.Obsidian",
  "im.riot.Riot",
  "com.github.IsmaelMartinez.teams_for_linux",
]);

/** `electron`, `electron37` and the like: versioned Electron runtimes. */
const VERSIONED_ELECTRON = /^electron\d+$/;

/** What a launch resolved to: the program spawned and its arguments. */
export interface AgentLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The launch with Chromium's accessibility switch added when the program is a
 * known Chromium or Electron build, run directly or through `flatpak run`.
 * Anything else — including `gio launch`, which forwards only files — is
 * returned unchanged.
 */
export function withAgentAccessibilityArguments<T extends AgentLaunch>(launch: T): T {
  if (launch.args.includes(CHROMIUM_ACCESSIBILITY_ARGUMENT)) return launch;
  if (!isChromiumFamilyLaunch(launch)) return launch;
  // Before a `--`: after it the switch would be a file name.
  const end = launch.args.indexOf("--");
  const args =
    end === -1
      ? [...launch.args, CHROMIUM_ACCESSIBILITY_ARGUMENT]
      : [...launch.args.slice(0, end), CHROMIUM_ACCESSIBILITY_ARGUMENT, ...launch.args.slice(end)];
  return { ...launch, args };
}

/**
 * A launch of a program that keeps one running instance per profile and hands
 * any second launch over to it — through a socket or pipe found via the
 * profile directory or the user's temp directory, not the session bus. Two
 * families are known: Chromium and Electron builds (their profile singleton),
 * and LibreOffice (its per-installation IPC pipe). `name` is the program or
 * Flatpak id; `flatpakAppId` is set when it runs inside Flatpak's sandbox,
 * which sees only its own `~/.var/app/<id>`. `desktopEntry` is a `gio launch`
 * of such a program's desktop entry, which takes no arguments at all.
 */
export interface SingleInstanceLaunch {
  readonly family: "chromium" | "libreoffice";
  readonly name: string;
  readonly flatpakAppId?: string;
  readonly desktopEntry?: boolean;
}

const LIBREOFFICE_EXECUTABLES: ReadonlySet<string> = new Set([
  "soffice",
  "libreoffice",
  "lowriter",
  "localc",
  "loimpress",
  "lodraw",
  "lomath",
  "lobase",
  "loweb",
]);
const LIBREOFFICE_FLATPAK = "org.libreoffice.LibreOffice";

function singleInstanceFamily(name: string): SingleInstanceLaunch["family"] | undefined {
  if (
    CHROMIUM_FAMILY_EXECUTABLES.has(name) ||
    VERSIONED_ELECTRON.test(name) ||
    CHROMIUM_FAMILY_FLATPAKS.has(name)
  ) {
    return "chromium";
  }
  if (LIBREOFFICE_EXECUTABLES.has(name) || name === LIBREOFFICE_FLATPAK) return "libreoffice";
  // Desktop entries name LibreOffice's modules `libreoffice-writer` and the like.
  if (name.startsWith("libreoffice-") || name.startsWith(`${LIBREOFFICE_FLATPAK}.`)) {
    return "libreoffice";
  }
  return undefined;
}

/** What `launch` is, when it is a single-instance program; see `SingleInstanceLaunch`. */
export function singleInstanceLaunch(launch: AgentLaunch): SingleInstanceLaunch | undefined {
  const program = basename(launch.command);
  if (program === "flatpak") {
    const appId = flatpakRunAppId(launch.args);
    const family = appId === undefined ? undefined : singleInstanceFamily(appId);
    return family && appId ? { family, name: appId, flatpakAppId: appId } : undefined;
  }
  if (program === "gio" && launch.args[0] === "launch" && launch.args[1] !== undefined) {
    const entry = basename(launch.args[1]).replace(/\.desktop$/, "");
    const family = singleInstanceFamily(entry);
    return family ? { family, name: entry, desktopEntry: true } : undefined;
  }
  const family = singleInstanceFamily(program);
  if (!family) return undefined;
  // A Flatpak export is a wrapper named after the app id.
  return CHROMIUM_FAMILY_FLATPAKS.has(program) || program === LIBREOFFICE_FLATPAK
    ? { family, name: program, flatpakAppId: program }
    : { family, name: program };
}

/**
 * `launch` bound to the profile in `directory`, so it can only ever reach an
 * instance started with that same profile: `--user-data-dir` for Chromium and
 * Electron, `-env:UserInstallation` for LibreOffice. A profile the caller
 * named itself is replaced, not kept: it is how a launch would reach the
 * human's running instance. Inserted before a `--`, after which it would be a
 * file name.
 */
export function withIsolatedProfile(
  launch: AgentLaunch,
  program: SingleInstanceLaunch,
  directory: string,
): AgentLaunch {
  const chromium = program.family === "chromium";
  const flag = chromium ? "--user-data-dir" : "-env:UserInstallation";
  const value = chromium ? directory : pathToFileURL(directory).href;
  const end = launch.args.indexOf("--");
  const head = end === -1 ? launch.args : launch.args.slice(0, end);
  const tail = end === -1 ? [] : launch.args.slice(end);
  const kept: string[] = [];
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    if (arg === undefined || arg.startsWith(`${flag}=`)) continue;
    if (arg === flag) {
      // The separate-value spelling: the value goes with it.
      index += 1;
      continue;
    }
    kept.push(arg);
  }
  return { ...launch, args: [...kept, `${flag}=${value}`, ...tail] };
}

function flatpakRunAppId(args: readonly string[]): string | undefined {
  // `flatpak run [options] <app-id> [args]`: the first bare word after `run`
  // is the application.
  const run = args.indexOf("run");
  return run === -1 ? undefined : args.slice(run + 1).find((arg) => !arg.startsWith("-"));
}

function isChromiumFamilyLaunch(launch: AgentLaunch): boolean {
  const program = basename(launch.command);
  if (program === "flatpak") {
    const appId = flatpakRunAppId(launch.args);
    return appId !== undefined && CHROMIUM_FAMILY_FLATPAKS.has(appId);
  }
  return (
    CHROMIUM_FAMILY_EXECUTABLES.has(program) ||
    VERSIONED_ELECTRON.test(program) ||
    CHROMIUM_FAMILY_FLATPAKS.has(program)
  );
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
