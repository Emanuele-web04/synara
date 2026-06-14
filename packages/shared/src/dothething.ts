// FILE: dothething.ts
// Purpose: Shared helpers for Synara's bundled desktop automation ("Do The Thing").
// Layer: Shared runtime utilities
// Exports: branding constants, Codex MCP config helpers, runtime path resolution.

import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOTHETHING_MCP_SERVER_NAME = "dothething";
export const DOTHETHING_DISPLAY_NAME = "Do The Thing";
export const DOTHETHING_MCP_TOOL_PREFIX = `mcp__${DOTHETHING_MCP_SERVER_NAME}__`;
export const DOTHETHING_GROK_MCP_TOOL_PREFIX = `${DOTHETHING_MCP_SERVER_NAME}__`;

export const DOTHETHING_MCP_TOOL_NAMES = [
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

export type DoTheThingMcpToolName = (typeof DOTHETHING_MCP_TOOL_NAMES)[number];

export function formatDoTheThingGrokToolName(tool: DoTheThingMcpToolName): string {
  return `${DOTHETHING_GROK_MCP_TOOL_PREFIX}${tool}`;
}

export function formatDoTheThingCodexToolName(tool: DoTheThingMcpToolName): string {
  return `${DOTHETHING_MCP_TOOL_PREFIX}${tool}`;
}

const DOTHETHING_GROK_TOOL_CATALOG = DOTHETHING_MCP_TOOL_NAMES.map((tool) =>
  formatDoTheThingGrokToolName(tool),
).join(", ");

export const DOTHETHING_BROWSER_TOOL_ROUTING_INSTRUCTIONS = `

## Browser tool routing

Prefer the built-in in-app browser for browser work whenever possible.

When the user asks to inspect a page, navigate a site, read what is visible in the browser, take a browser screenshot, or interact with content already open in chat, use the in-app browser path first.

Use \`Do The Thing\` only when at least one of these is true:
- the user explicitly asks to use \`Do The Thing\` or \`@dothething\`
- the task is outside the in-app browser (desktop apps, OS settings, system UI, other app windows)
- the in-app browser cannot complete the task and a broader desktop fallback is required

Do not choose \`Do The Thing\` first for ordinary browser inspection, browser screenshots, or browser navigation when the in-app browser can handle the request.`;

export const DOTHETHING_ACP_TOOL_INVOCATION_INSTRUCTIONS = `

## Do The Thing MCP tool invocation

When the user asks for \`Do The Thing\` or \`@dothething\`, you must drive the desktop through the \`dothething\` MCP server. Do not substitute shell commands such as \`open\`, \`osascript\`, \`open -a\`, or AppleScript for desktop automation.

The \`dothething\` MCP server is registered when the session starts. These tools are already available — call them directly. Do not call \`search_tool\`, \`tool_search\`, or similar discovery tools to find them. Never spend multiple turns searching for names like "dothething click" or "dothething get_app_state".

Grok qualified tool names (call with \`use_tool\`): ${DOTHETHING_GROK_TOOL_CATALOG}.
Codex qualified tool names use the \`mcp__dothething__\` prefix (for example \`mcp__dothething__get_app_state\`).

Speed rules for desktop UI work:
- Start each assistant turn with one \`dothething__get_app_state\` for the target app, then act from that tree.
- Re-fetch state only after navigation, opening/closing dialogs, or a failed/missed click — not before every click on the same stable screen.
- Do not immediately call \`dothething__get_app_state\` after a successful action; first use the returned action result unless the next step needs a fresh tree.
- Prefer \`dothething__set_value\` for text fields and \`dothething__click\` with element indices from the latest tree.
- When the next steps are already known from the current tree, prefer \`dothething__run_sequence\` to run consecutive clicks, typing, and key presses in one local batch.
- Batch obvious next steps instead of alternating search/discovery and single actions.
- Do not call \`ask_user_question\` for routine confirmation when the user already gave a direct action request.

If a \`dothething__\` tool call fails with "Tool not found", report that failure to the user instead of retrying discovery loops or falling back to shell automation.`;

export const SYNARA_DOTHETHING_PROMPT_APPEND = [
  DOTHETHING_BROWSER_TOOL_ROUTING_INSTRUCTIONS.trim(),
  DOTHETHING_ACP_TOOL_INVOCATION_INSTRUCTIONS.trim(),
].join("\n");

function toDoTheThingMcpResolutionInput(
  input: NodeJS.ProcessEnv | DoTheThingMcpResolutionInput,
): DoTheThingMcpResolutionInput {
  const candidate = input as DoTheThingMcpResolutionInput;
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

export function withSynaraDoTheThingPromptContext(
  text: string,
  input: NodeJS.ProcessEnv | DoTheThingMcpResolutionInput = process.env,
): string {
  const trimmed = text.trim();
  const resolutionInput = toDoTheThingMcpResolutionInput(input);
  if (trimmed.length === 0 || !resolveDoTheThingMcpLauncher(resolutionInput)) {
    return text;
  }

  return `${trimmed}\n\n${SYNARA_DOTHETHING_PROMPT_APPEND}`;
}

export const SYNARA_DOTHETHING_ENABLED_ENV = "SYNARA_ENABLE_DOTHETHING";
export const SYNARA_DOTHETHING_LAUNCHER_ENV = "SYNARA_DOTHETHING_LAUNCHER_PATH";
export const SYNARA_DOTHETHING_RUNTIME_ENV = "SYNARA_DOTHETHING_RUNTIME_PATH";
export const SYNARA_DOTHETHING_STABLE_APP_DIR_ENV = "SYNARA_DOTHETHING_STABLE_APP_DIR";
export const DOTHETHING_DISABLE_APP_AGENT_PROXY_ENV = "DOTHETHING_DISABLE_APP_AGENT_PROXY";

const DOTHETHING_ACP_MCP_SERVER_ENV = [] as const;

const STABLE_APP_BUNDLE_NAME = "Do The Thing.app";
const STABLE_APP_EXECUTABLE_RELATIVE_PATH = [
  STABLE_APP_BUNDLE_NAME,
  "Contents",
  "MacOS",
  "DoTheThing",
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

const DOTHETHING_MCP_HEADER = `[mcp_servers."${DOTHETHING_MCP_SERVER_NAME}"]`;
const DOTHETHING_MCP_HEADER_PREFIX = `[mcp_servers."${DOTHETHING_MCP_SERVER_NAME}".`;
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

function buildDoTheThingMcpSectionBody(launcherPath: string): string {
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
  if (header === DOTHETHING_MCP_HEADER || header.startsWith(DOTHETHING_MCP_HEADER_PREFIX)) {
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

export type DoTheThingAcpMcpServer = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
};

export type DoTheThingClaudeMcpServerConfig = {
  readonly command: string;
  readonly args: string[];
};

export type DoTheThingOpenCodeMcpConfig = {
  readonly type: "local";
  readonly command: string[];
  readonly enabled: true;
};

export type DoTheThingMcpResolutionInput = {
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackLauncherPath?: string;
  readonly fallbackPackageRoots?: readonly string[];
  readonly searchRoots?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
};

function withDefaultDoTheThingPackageRoots(
  input: DoTheThingMcpResolutionInput = {},
): DoTheThingMcpResolutionInput {
  const fallbackPackageRoots =
    input.fallbackPackageRoots ??
    (input.searchRoots
      ? resolveDoTheThingPackageRoots({ searchRoots: input.searchRoots })
      : resolveDoTheThingPackageRoots());

  return {
    ...input,
    fallbackPackageRoots,
  };
}

export function resolveDoTheThingMcpLauncher(
  input: DoTheThingMcpResolutionInput = {},
): string | null {
  if (!isDoTheThingEnabledInEnv(input.env)) {
    return null;
  }
  return resolveDoTheThingLauncherPath(withDefaultDoTheThingPackageRoots(input));
}

export function buildDoTheThingAcpMcpServers(
  input: DoTheThingMcpResolutionInput = {},
): readonly DoTheThingAcpMcpServer[] {
  const launcherPath = resolveDoTheThingMcpLauncher(input);
  if (!launcherPath) {
    return [];
  }

  return [
    {
      name: DOTHETHING_MCP_SERVER_NAME,
      command: launcherPath,
      args: ["mcp"],
      env: DOTHETHING_ACP_MCP_SERVER_ENV,
    },
  ];
}

export function shouldSkipAcpSessionResumeForDoTheThing(
  input: DoTheThingMcpResolutionInput = {},
): boolean {
  return buildDoTheThingAcpMcpServers(input).length > 0;
}

export function buildDoTheThingClaudeMcpServers(
  input: DoTheThingMcpResolutionInput = {},
): Record<string, DoTheThingClaudeMcpServerConfig> {
  const launcherPath = resolveDoTheThingMcpLauncher(input);
  if (!launcherPath) {
    return {};
  }

  return {
    [DOTHETHING_MCP_SERVER_NAME]: {
      command: launcherPath,
      args: ["mcp"],
    },
  };
}

export function buildDoTheThingOpenCodeMcpConfig(
  input: DoTheThingMcpResolutionInput = {},
): { readonly name: string; readonly config: DoTheThingOpenCodeMcpConfig } | null {
  const launcherPath = resolveDoTheThingMcpLauncher(input);
  if (!launcherPath) {
    return null;
  }

  return {
    name: DOTHETHING_MCP_SERVER_NAME,
    config: {
      type: "local",
      command: [launcherPath, "mcp"],
      enabled: true,
    },
  };
}

export function applyDoTheThingCodexConfig(input: {
  readonly config: string;
  readonly enabled: boolean;
  readonly launcherPath: string;
}): string {
  const launcherPath = input.launcherPath.trim();
  const sanitizedConfig = sanitizeCodexConfigForSynaraOverlay(input.config);
  if (input.enabled && launcherPath.length === 0) {
    return sanitizedConfig;
  }

  const document = splitTomlSections(sanitizedConfig);
  const desiredBody = buildDoTheThingMcpSectionBody(launcherPath);
  const desiredCanonical = canonicalSectionBody(desiredBody.split("\n"));

  const nextSections = document.sections.flatMap((section) => {
    if (shouldRemoveSection(section.header)) {
      return [];
    }
    return [section];
  });

  if (input.enabled && launcherPath.length > 0) {
    const existing = document.sections.find((section) => section.header === DOTHETHING_MCP_HEADER);
    const existingCanonical = existing ? canonicalSectionBody(existing.bodyLines) : null;
    if (existingCanonical !== desiredCanonical) {
      nextSections.push({
        header: DOTHETHING_MCP_HEADER,
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

export function isDoTheThingEnabledInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SYNARA_DOTHETHING_ENABLED_ENV]?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") {
    return false;
  }
  if (raw === "1" || raw === "true" || raw === "yes") {
    return true;
  }
  return env.DPCODE_MODE === "desktop" || env.T3CODE_MODE === "desktop";
}

export function syncDoTheThingEnabledEnv(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env[SYNARA_DOTHETHING_ENABLED_ENV] = enabled ? "1" : "0";
}

export function resolveDoTheThingEnabledFromSettings(input: {
  readonly enableDoTheThing: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  if (env.DPCODE_MODE === "desktop" || env.T3CODE_MODE === "desktop") {
    return input.enableDoTheThing;
  }
  return false;
}

const PLATFORM_RUNTIME_RELATIVE_PATHS: Record<string, readonly string[]> = {
  "darwin-arm64": ["dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"],
  "darwin-x64": ["dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"],
  "linux-arm64": ["dist", "linux", "arm64", "dothething"],
  "linux-x64": ["dist", "linux", "amd64", "dothething"],
  "win32-arm64": ["dist", "windows", "arm64", "dothething.exe"],
  "win32-x64": ["dist", "windows", "amd64", "dothething.exe"],
};

function resolveBundledDoTheThingBinLauncherPath(input: {
  readonly packageRoot: string;
  readonly platform?: NodeJS.Platform;
}): string | null {
  const platform = input.platform ?? process.platform;
  const binDir = path.join(input.packageRoot, "bin");
  const candidates =
    platform === "win32"
      ? [path.join(binDir, "dothething.exe"), path.join(binDir, "dothething")]
      : [path.join(binDir, "dothething")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveBundledDoTheThingLauncherPath(input: {
  readonly packageRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): string | null {
  const runtimePath = resolveBundledDoTheThingRuntimePath(input);
  if (runtimePath) {
    return runtimePath;
  }

  return resolveBundledDoTheThingBinLauncherPath(input);
}

function normalizeDoTheThingMcpLauncherPath(
  launcherPath: string,
  input: {
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  } = {},
): string {
  const binLauncherPath = path.join("bin", "dothething");
  const isBinLauncher =
    launcherPath.endsWith(binLauncherPath) || launcherPath.endsWith(`${binLauncherPath}.exe`);
  if (!isBinLauncher) {
    return launcherPath;
  }

  const packageRoot = path.resolve(launcherPath, "..", "..");
  const nativeFromConfigured = resolveBundledDoTheThingRuntimePath({
    packageRoot,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.arch !== undefined ? { arch: input.arch } : {}),
  });
  if (nativeFromConfigured) {
    return nativeFromConfigured;
  }

  return launcherPath;
}

function moduleRelativeDoTheThingPackageRootCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "..", "..", "dothething"),
    path.resolve(moduleDir, "..", "..", "..", "packages", "dothething"),
    path.resolve(moduleDir, "..", "..", "@t3tools", "dothething"),
  ];
}

export function resolveDoTheThingPackageRoots(
  input: { readonly searchRoots?: readonly string[] } = {},
): string[] {
  const searchRoots = input.searchRoots ?? [process.cwd()];
  const relativeCandidates = [
    ["packages", "dothething"],
    ["node_modules", "@t3tools", "dothething"],
  ] as const;
  const seen = new Set<string>();
  const roots: string[] = [];

  const appendRoot = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !existsSync(path.join(resolved, "package.json"))) {
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

  for (const candidate of moduleRelativeDoTheThingPackageRootCandidates()) {
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

export function resolveBundledDoTheThingRuntimePath(input: {
  readonly packageRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): string | null {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const platformKey = `${platform}-${arch}`;
  const relativeParts = PLATFORM_RUNTIME_RELATIVE_PATHS[platformKey];
  if (!relativeParts) {
    return null;
  }

  const candidate = path.join(input.packageRoot, ...relativeParts);
  return isExecutableFile(candidate) ? candidate : null;
}

export function resolveStableDoTheThingAppDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SYNARA_DOTHETHING_STABLE_APP_DIR_ENV]?.trim();
  if (configured && configured.length > 0) {
    return path.resolve(configured);
  }

  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (home && home.length > 0) {
    return path.join(home, ".synara", "dothething-app");
  }

  return path.resolve(".synara", "dothething-app");
}

export function resolveStableDoTheThingLauncherPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const launcherPath = path.join(
    resolveStableDoTheThingAppDir(env),
    ...STABLE_APP_EXECUTABLE_RELATIVE_PATH,
  );
  return isExecutableFile(launcherPath) ? launcherPath : null;
}

export function resolveDoTheThingLauncherPath(
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
  const configured =
    env[SYNARA_DOTHETHING_LAUNCHER_ENV]?.trim() || input.fallbackLauncherPath?.trim();
  if (configured && configured.length > 0) {
    const launcherPath = normalizeDoTheThingMcpLauncherPath(configured, input);
    const isPathLike =
      path.isAbsolute(launcherPath) || launcherPath.includes("/") || launcherPath.includes("\\");
    if (!isPathLike || isExecutableFile(launcherPath)) {
      return launcherPath;
    }
  }

  if (!input.preferBundled) {
    const stableLauncherPath = resolveStableDoTheThingLauncherPath(env);
    if (stableLauncherPath) {
      return stableLauncherPath;
    }
  }

  for (const packageRoot of input.fallbackPackageRoots ?? []) {
    const launcherPath = resolveBundledDoTheThingRuntimePath({
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
