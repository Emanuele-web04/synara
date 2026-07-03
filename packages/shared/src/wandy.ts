// FILE: wandy.ts
// Purpose: Shared helpers for Synara's bundled desktop automation ("Wandy").
// Layer: Shared runtime utilities
// Exports: branding constants, Codex MCP config helpers, runtime path resolution.

import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WANDY_MCP_SERVER_NAME = "wandy";
export const WANDY_DISPLAY_NAME = "Wandy";
export const WANDY_MCP_TOOL_PREFIX = `mcp__${WANDY_MCP_SERVER_NAME}__`;
export const WANDY_GROK_MCP_TOOL_PREFIX = `${WANDY_MCP_SERVER_NAME}__`;

export const WANDY_MCP_TOOL_NAMES = [
  "list_apps",
  "get_app_state",
  "click",
  "perform_secondary_action",
  "scroll",
  "drag",
  "run_sequence",
  "type_text",
  "press_key",
  "set_value",
] as const;

export type WandyMcpToolName = (typeof WANDY_MCP_TOOL_NAMES)[number];

// run_sequence is only implemented by the macOS runtime (WandyKit); the
// Linux/Windows runtimes neither expose nor dispatch it, so it must not be
// advertised to agents there.
export function wandyMcpToolNamesForPlatform(
  platform: NodeJS.Platform = process.platform,
): readonly WandyMcpToolName[] {
  return platform === "darwin"
    ? WANDY_MCP_TOOL_NAMES
    : WANDY_MCP_TOOL_NAMES.filter((tool) => tool !== "run_sequence");
}

export function formatWandyGrokToolName(tool: WandyMcpToolName): string {
  return `${WANDY_GROK_MCP_TOOL_PREFIX}${tool}`;
}

export function formatWandyCodexToolName(tool: WandyMcpToolName): string {
  return `${WANDY_MCP_TOOL_PREFIX}${tool}`;
}

export const WANDY_BROWSER_TOOL_ROUTING_INSTRUCTIONS = `

## Browser tool routing

Prefer the built-in in-app browser for browser work whenever possible.

When the user asks to inspect a page, navigate a site, read what is visible in the browser, take a browser screenshot, or interact with content already open in chat, use the in-app browser path first.

Use \`Wandy\` only when at least one of these is true:
- the user explicitly asks to use \`Wandy\` or \`@wandy\`
- the task is outside the in-app browser (desktop apps, OS settings, system UI, other app windows)
- the in-app browser cannot complete the task and a broader desktop fallback is required

Do not choose \`Wandy\` first for ordinary browser inspection, browser screenshots, or browser navigation when the in-app browser can handle the request.`;

export function buildWandyAcpToolInvocationInstructions(
  platform: NodeJS.Platform = process.platform,
): string {
  const toolCatalog = wandyMcpToolNamesForPlatform(platform)
    .map((tool) => formatWandyGrokToolName(tool))
    .join(", ");
  const runSequenceRule =
    platform === "darwin"
      ? "\n- When the next steps are already known from the current tree, prefer `wandy__run_sequence` to run consecutive clicks, typing, and key presses in one local batch."
      : "";

  return `

## Wandy MCP tool invocation

When the user asks for \`Wandy\` or \`@wandy\`, you must drive the desktop through the \`wandy\` MCP server. Do not substitute shell commands such as \`open\`, \`osascript\`, \`open -a\`, or AppleScript for desktop automation.

The \`wandy\` MCP server is registered when the session starts. These tools are already available — call them directly. Do not call \`search_tool\`, \`tool_search\`, or similar discovery tools to find them. Never spend multiple turns searching for names like "wandy click" or "wandy get_app_state".

Grok qualified tool names (call with \`use_tool\`): ${toolCatalog}.
Codex qualified tool names use the \`mcp__wandy__\` prefix (for example \`mcp__wandy__get_app_state\`).

Speed rules for desktop UI work:
- Start each assistant turn with one \`wandy__get_app_state\` for the target app, then act from that tree.
- Re-fetch state only after navigation, opening/closing dialogs, or a failed/missed click — not before every click on the same stable screen.
- Do not immediately call \`wandy__get_app_state\` after a successful action; first use the returned action result unless the next step needs a fresh tree.
- Prefer \`wandy__set_value\` for text fields and \`wandy__click\` with element indices from the latest tree.${runSequenceRule}
- Batch obvious next steps instead of alternating search/discovery and single actions.
- Do not call \`ask_user_question\` for routine confirmation when the user already gave a direct action request.

If a \`wandy__\` tool call fails with "Tool not found", report that failure to the user instead of retrying discovery loops or falling back to shell automation.`;
}

export const WANDY_ACP_TOOL_INVOCATION_INSTRUCTIONS = buildWandyAcpToolInvocationInstructions();

export const SYNARA_WANDY_PROMPT_APPEND = [
  WANDY_BROWSER_TOOL_ROUTING_INSTRUCTIONS.trim(),
  WANDY_ACP_TOOL_INVOCATION_INSTRUCTIONS.trim(),
].join("\n");

function toWandyMcpResolutionInput(
  input: NodeJS.ProcessEnv | WandyMcpResolutionInput,
): WandyMcpResolutionInput {
  const candidate = input as WandyMcpResolutionInput;
  if (
    typeof candidate.env === "object" ||
    candidate.fallbackLauncherPath !== undefined ||
    candidate.fallbackPackageRoots !== undefined ||
    candidate.searchRoots !== undefined ||
    candidate.platform !== undefined ||
    candidate.arch !== undefined
  ) {
    return candidate;
  }

  return { env: input as NodeJS.ProcessEnv };
}

export function withSynaraWandyPromptContext(
  text: string,
  input: NodeJS.ProcessEnv | WandyMcpResolutionInput = process.env,
): string {
  const trimmed = text.trim();
  const resolutionInput = toWandyMcpResolutionInput(input);
  if (trimmed.length === 0 || !resolveWandyMcpLauncher(resolutionInput)) {
    return text;
  }

  return `${trimmed}\n\n${SYNARA_WANDY_PROMPT_APPEND}`;
}

export const SYNARA_WANDY_ENABLED_ENV = "SYNARA_ENABLE_WANDY";
export const SYNARA_WANDY_LAUNCHER_ENV = "SYNARA_WANDY_LAUNCHER_PATH";
export const SYNARA_WANDY_RUNTIME_ENV = "SYNARA_WANDY_RUNTIME_PATH";
export const SYNARA_WANDY_STABLE_APP_DIR_ENV = "SYNARA_WANDY_STABLE_APP_DIR";
export const WANDY_DISABLE_APP_AGENT_PROXY_ENV = "WANDY_DISABLE_APP_AGENT_PROXY";

const WANDY_ACP_MCP_SERVER_ENV = [] as const;

export const WANDY_APP_BUNDLE_NAME = "Wandy.app";
// Path of the executable inside Wandy.app; the single source for every
// consumer that can import this module (stable helper, build scripts).
export const WANDY_MACOS_APP_EXECUTABLE_PARTS = ["Contents", "MacOS", "Wandy"] as const;
const STABLE_APP_EXECUTABLE_RELATIVE_PATH = [
  WANDY_APP_BUNDLE_NAME,
  ...WANDY_MACOS_APP_EXECUTABLE_PARTS,
] as const;

const LEGACY_MCP_SERVER_NAMES = [
  "open-computer-use",
  "open-codex-computer-use",
  "computer_use",
] as const;

const LEGACY_PLUGIN_HEADERS = [
  '[plugins."open-computer-use@open-computer-use-local"]',
  '[marketplaces."open-computer-use-local"]',
] as const;

const WANDY_MCP_HEADER = `[mcp_servers."${WANDY_MCP_SERVER_NAME}"]`;
const WANDY_MCP_HEADER_PREFIX = `[mcp_servers."${WANDY_MCP_SERVER_NAME}".`;
const VALID_CODEX_SERVICE_TIERS = new Set(["fast", "flex"]);

type TomlSection = {
  readonly header: string;
  readonly bodyLines: string[];
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") {
    end -= 1;
  }
  return lines.slice(0, end);
}

function canonicalSectionBody(bodyLines: string[]): string {
  const lines = [...bodyLines];
  while (lines.length > 0 && lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function splitTomlSections(text: string): {
  preambleLines: string[];
  sections: TomlSection[];
} {
  const normalized = normalizeNewlines(text);
  if (normalized.length === 0) {
    return { preambleLines: [], sections: [] };
  }

  const lines = normalized.split("\n");
  const preambleLines: string[] = [];
  const sections: TomlSection[] = [];
  let currentHeader: string | null = null;
  let currentBodyLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      if (currentHeader === null) {
        preambleLines.push(...currentBodyLines);
      } else {
        sections.push({ header: currentHeader, bodyLines: currentBodyLines });
      }
      currentHeader = `[${headerMatch[1]}]`;
      currentBodyLines = [];
      continue;
    }

    currentBodyLines.push(line);
  }

  if (currentHeader === null) {
    preambleLines.push(...currentBodyLines);
  } else {
    sections.push({ header: currentHeader, bodyLines: currentBodyLines });
  }

  return {
    preambleLines: trimTrailingBlankLines(preambleLines),
    sections,
  };
}

function renderTomlDocument(input: { preambleLines: string[]; sections: TomlSection[] }): string {
  const blocks: string[] = [];
  if (input.preambleLines.length > 0) {
    blocks.push(input.preambleLines.join("\n"));
  }

  for (const section of input.sections) {
    blocks.push(section.header, ...section.bodyLines);
  }

  return blocks.join("\n").trimEnd();
}

function buildWandyMcpSectionBody(launcherPath: string): string {
  return [`command = ${JSON.stringify(launcherPath)}`, 'args = ["mcp"]'].join("\n");
}

function sanitizeCodexConfigForSynaraOverlay(content: string): string {
  const lines = content.split(/\r?\n/);
  const sanitized = lines.flatMap((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^service_tier\s*=\s*(?:"([^"]+)"|'([^']+)')$/);
    if (!match) {
      return [line];
    }

    const value = match[1] ?? match[2] ?? "";
    if (value.length === 0 || VALID_CODEX_SERVICE_TIERS.has(value)) {
      return [line];
    }

    if (value === "default") {
      return [line.replace(/=\s*(?:"[^"]+"|'[^']+')/, '= "flex"')];
    }

    return [];
  });

  return sanitized.join("\n").trimEnd();
}

function shouldRemoveSection(header: string): boolean {
  if (header === WANDY_MCP_HEADER || header.startsWith(WANDY_MCP_HEADER_PREFIX)) {
    return true;
  }

  if (LEGACY_PLUGIN_HEADERS.includes(header as (typeof LEGACY_PLUGIN_HEADERS)[number])) {
    return true;
  }

  for (const legacyName of LEGACY_MCP_SERVER_NAMES) {
    if (header === `[mcp_servers."${legacyName}"]`) {
      return true;
    }
  }

  return false;
}

export type WandyAcpMcpServer = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
};

export type WandyClaudeMcpServerConfig = {
  readonly command: string;
  readonly args: string[];
};

export type WandyOpenCodeMcpConfig = {
  readonly type: "local";
  readonly command: string[];
  readonly enabled: true;
};

export type WandyMcpResolutionInput = {
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackLauncherPath?: string;
  readonly fallbackPackageRoots?: readonly string[];
  readonly searchRoots?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
};

function withDefaultWandyPackageRoots(
  input: WandyMcpResolutionInput = {},
): WandyMcpResolutionInput {
  const fallbackPackageRoots =
    input.fallbackPackageRoots ??
    (input.searchRoots
      ? resolveWandyPackageRoots({ searchRoots: input.searchRoots })
      : resolveWandyPackageRoots());

  return {
    ...input,
    fallbackPackageRoots,
  };
}

// Launcher resolution walks several existsSync/accessSync candidates and runs
// on every turn (prompt context) and session start. The default process-env
// resolution is memoized briefly; the enabled/disabled gate stays uncached so
// settings toggles apply immediately.
const DEFAULT_LAUNCHER_CACHE_TTL_MS = 5_000;
let defaultLauncherCache: { readonly value: string | null; readonly expiresAtMs: number } | null =
  null;

function isDefaultWandyResolutionInput(input: WandyMcpResolutionInput): boolean {
  return (
    (input.env === undefined || input.env === process.env) &&
    input.fallbackLauncherPath === undefined &&
    input.fallbackPackageRoots === undefined &&
    input.searchRoots === undefined &&
    input.platform === undefined &&
    input.arch === undefined
  );
}

export function resolveWandyMcpLauncher(input: WandyMcpResolutionInput = {}): string | null {
  if (!isWandyEnabledInEnv(input.env)) {
    return null;
  }
  if (!isDefaultWandyResolutionInput(input)) {
    return resolveWandyLauncherPath(withDefaultWandyPackageRoots(input));
  }

  const now = Date.now();
  if (defaultLauncherCache && defaultLauncherCache.expiresAtMs > now) {
    return defaultLauncherCache.value;
  }
  const value = resolveWandyLauncherPath(withDefaultWandyPackageRoots(input));
  defaultLauncherCache = { value, expiresAtMs: now + DEFAULT_LAUNCHER_CACHE_TTL_MS };
  return value;
}

export function buildWandyAcpMcpServers(
  input: WandyMcpResolutionInput = {},
): readonly WandyAcpMcpServer[] {
  const launcherPath = resolveWandyMcpLauncher(input);
  if (!launcherPath) {
    return [];
  }

  return [
    {
      name: WANDY_MCP_SERVER_NAME,
      command: launcherPath,
      args: ["mcp"],
      env: WANDY_ACP_MCP_SERVER_ENV,
    },
  ];
}

export function shouldSkipAcpSessionResumeForWandy(input: WandyMcpResolutionInput = {}): boolean {
  return buildWandyAcpMcpServers(input).length > 0;
}

export function buildWandyClaudeMcpServers(
  input: WandyMcpResolutionInput = {},
): Record<string, WandyClaudeMcpServerConfig> {
  const launcherPath = resolveWandyMcpLauncher(input);
  if (!launcherPath) {
    return {};
  }

  return {
    [WANDY_MCP_SERVER_NAME]: {
      command: launcherPath,
      args: ["mcp"],
    },
  };
}

export function buildWandyOpenCodeMcpConfig(
  input: WandyMcpResolutionInput = {},
): { readonly name: string; readonly config: WandyOpenCodeMcpConfig } | null {
  const launcherPath = resolveWandyMcpLauncher(input);
  if (!launcherPath) {
    return null;
  }

  return {
    name: WANDY_MCP_SERVER_NAME,
    config: {
      type: "local",
      command: [launcherPath, "mcp"],
      enabled: true,
    },
  };
}

export function applyWandyCodexConfig(input: {
  readonly config: string;
  readonly enabled: boolean;
  readonly launcherPath: string;
}): string {
  const launcherPath = input.launcherPath.trim();
  const sanitizedConfig = sanitizeCodexConfigForSynaraOverlay(input.config);

  // Stale wandy/legacy sections are removed even when no launcher is
  // resolvable: a leftover entry pointing at a missing binary would make Codex
  // spawn a broken MCP server.
  const document = splitTomlSections(sanitizedConfig);
  const desiredBody = buildWandyMcpSectionBody(launcherPath);
  const desiredCanonical = canonicalSectionBody(desiredBody.split("\n"));

  const nextSections = document.sections.flatMap((section) => {
    if (shouldRemoveSection(section.header)) {
      return [];
    }
    return [section];
  });

  if (input.enabled && launcherPath.length > 0) {
    const existing = document.sections.find((section) => section.header === WANDY_MCP_HEADER);
    const existingCanonical = existing ? canonicalSectionBody(existing.bodyLines) : null;
    if (existingCanonical !== desiredCanonical) {
      nextSections.push({
        header: WANDY_MCP_HEADER,
        bodyLines: ["", ...desiredBody.split("\n"), ""],
      });
    } else if (existing) {
      nextSections.push(existing);
    }
  }

  return renderTomlDocument({
    preambleLines: document.preambleLines,
    sections: nextSections,
  });
}

export function isWandyExplicitlyDisabledInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SYNARA_WANDY_ENABLED_ENV]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no";
}

export function isWandyEnabledInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isWandyExplicitlyDisabledInEnv(env)) {
    return false;
  }
  const raw = env[SYNARA_WANDY_ENABLED_ENV]?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") {
    return true;
  }
  return env.DPCODE_MODE === "desktop" || env.T3CODE_MODE === "desktop";
}

export function syncWandyEnabledEnv(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  env[SYNARA_WANDY_ENABLED_ENV] = enabled ? "1" : "0";
}

// The persisted setting can only narrow what the environment already allows:
// pass the env as it looked before any syncWandyEnabledEnv mutation so turning
// the setting back on restores the boot behavior.
export function resolveWandyEnabledFromSettings(input: {
  readonly enableWandy: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  return isWandyEnabledInEnv(input.env ?? process.env) && input.enableWandy;
}

// Mirrored (with a pointer back here) in the standalone launchers that cannot
// import workspace TS: packages/wandy/bin/wandy{,-mcp} (generated npm shims)
// and apps/desktop/scripts/wandyMcp.mjs.
const PLATFORM_RUNTIME_RELATIVE_PATHS: Record<string, readonly string[]> = {
  "darwin-arm64": ["dist", WANDY_APP_BUNDLE_NAME, ...WANDY_MACOS_APP_EXECUTABLE_PARTS],
  "linux-arm64": ["dist", "linux", "arm64", "wandy"],
  "linux-x64": ["dist", "linux", "amd64", "wandy"],
  "win32-arm64": ["dist", "windows", "arm64", "wandy.exe"],
  "win32-x64": ["dist", "windows", "amd64", "wandy.exe"],
};

// Package-relative path segments of the bundled runtime for a platform/arch,
// or null when no native runtime ships for that combination.
export function wandyRuntimeRelativeParts(
  platform: NodeJS.Platform,
  arch: string,
): readonly string[] | null {
  return PLATFORM_RUNTIME_RELATIVE_PATHS[`${platform}-${arch}`] ?? null;
}

export function isWandyPackageRoot(root: string): boolean {
  return existsSync(path.join(root, "package.json"));
}

function resolveBundledWandyBinLauncherPath(input: {
  readonly packageRoot: string;
  readonly platform?: NodeJS.Platform;
}): string | null {
  const platform = input.platform ?? process.platform;
  const binDir = path.join(input.packageRoot, "bin");
  const candidates =
    platform === "win32"
      ? [path.join(binDir, "wandy.exe"), path.join(binDir, "wandy")]
      : [path.join(binDir, "wandy")];

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveBundledWandyLauncherPath(input: {
  readonly packageRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): string | null {
  const runtimePath = resolveBundledWandyRuntimePath(input);
  if (runtimePath) {
    return runtimePath;
  }

  return resolveBundledWandyBinLauncherPath(input);
}

function normalizeWandyMcpLauncherPath(
  launcherPath: string,
  input: {
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  } = {},
): string {
  // Compare with normalized separators so Windows paths configured with
  // forward slashes still get upgraded to the native runtime.
  const normalizedLauncherPath = launcherPath.replace(/\\/g, "/");
  const isBinLauncher =
    normalizedLauncherPath.endsWith("bin/wandy") ||
    normalizedLauncherPath.endsWith("bin/wandy.exe");
  if (!isBinLauncher) {
    return launcherPath;
  }

  const packageRoot = path.resolve(launcherPath, "..", "..");
  const nativeFromConfigured = resolveBundledWandyRuntimePath({
    packageRoot,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.arch !== undefined ? { arch: input.arch } : {}),
  });
  if (nativeFromConfigured) {
    return nativeFromConfigured;
  }

  return launcherPath;
}

function moduleRelativeWandyPackageRootCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "..", "..", "wandy"),
    path.resolve(moduleDir, "..", "..", "..", "packages", "wandy"),
    path.resolve(moduleDir, "..", "..", "@t3tools", "wandy"),
  ];
}

export function resolveWandyPackageRoots(
  input: { readonly searchRoots?: readonly string[] } = {},
): string[] {
  const searchRoots = input.searchRoots ?? [process.cwd()];
  const relativeCandidates = [
    ["packages", "wandy"],
    ["node_modules", "@t3tools", "wandy"],
  ] as const;
  const seen = new Set<string>();
  const roots: string[] = [];

  const appendRoot = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !isWandyPackageRoot(resolved)) {
      return;
    }
    seen.add(resolved);
    roots.push(resolved);
  };

  for (const searchRoot of searchRoots) {
    const resolvedSearchRoot = path.resolve(searchRoot);
    for (const relativeParts of relativeCandidates) {
      appendRoot(path.join(resolvedSearchRoot, ...relativeParts));
    }
  }

  for (const candidate of moduleRelativeWandyPackageRootCandidates()) {
    appendRoot(candidate);
  }

  return roots;
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBundledWandyRuntimePath(input: {
  readonly packageRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): string | null {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const relativeParts = wandyRuntimeRelativeParts(platform, arch);
  if (!relativeParts) {
    return null;
  }

  const candidate = path.join(input.packageRoot, ...relativeParts);
  return isExecutableFile(candidate) ? candidate : null;
}

export function resolveStableWandyAppDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SYNARA_WANDY_STABLE_APP_DIR_ENV]?.trim();
  if (configured && configured.length > 0) {
    return path.resolve(configured);
  }

  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (home && home.length > 0) {
    return path.join(home, ".synara", "wandy-app");
  }

  return path.resolve(".synara", "wandy-app");
}

export function resolveStableWandyLauncherPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const launcherPath = path.join(
    resolveStableWandyAppDir(env),
    ...STABLE_APP_EXECUTABLE_RELATIVE_PATH,
  );
  return isExecutableFile(launcherPath) ? launcherPath : null;
}

export function resolveWandyLauncherPath(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fallbackLauncherPath?: string;
    readonly fallbackPackageRoots?: readonly string[];
    readonly preferBundled?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  } = {},
): string | null {
  const env = input.env ?? process.env;
  const configured = env[SYNARA_WANDY_LAUNCHER_ENV]?.trim() || input.fallbackLauncherPath?.trim();
  if (configured && configured.length > 0) {
    const launcherPath = normalizeWandyMcpLauncherPath(configured, input);
    const isPathLike =
      path.isAbsolute(launcherPath) || launcherPath.includes("/") || launcherPath.includes("\\");
    if (!isPathLike || isExecutableFile(launcherPath)) {
      return launcherPath;
    }
  }

  if (!input.preferBundled) {
    const stableLauncherPath = resolveStableWandyLauncherPath(env);
    if (stableLauncherPath) {
      return stableLauncherPath;
    }
  }

  for (const packageRoot of input.fallbackPackageRoots ?? []) {
    const launcherPath = resolveBundledWandyRuntimePath({
      packageRoot,
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.arch !== undefined ? { arch: input.arch } : {}),
    });
    if (launcherPath) {
      return launcherPath;
    }
  }

  return null;
}
