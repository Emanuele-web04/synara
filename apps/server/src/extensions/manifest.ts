import path from "node:path";
import semver from "semver";
import { z } from "zod";

/** Must match package.json at the immutable upstream source commit. */
export const CODE_OSS_VERSION = "1.138.0";
export const CODE_OSS_COMMIT = "7debcd0e2acdea1c52de81bf9ee1620444407dda";
const identifierPart = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/i);
const commandContribution = z.object({ command: z.string().max(512) });
const languageContribution = z.object({ id: z.string().max(512) });
const debugContribution = z.object({ type: z.string().max(512) });

export const extensionManifestSchema = z
  .object({
    publisher: identifierPart,
    name: identifierPart,
    version: z
      .string()
      .max(128)
      .refine((value) => semver.valid(value) !== null),
    displayName: z.string().max(256).optional(),
    description: z.string().max(4_096).optional(),
    engines: z.object({
      vscode: z
        .string()
        .max(128)
        .refine((value) => semver.validRange(value) !== null),
    }),
    main: z.string().max(4_096).optional(),
    browser: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    activationEvents: z.array(z.string().max(512)).max(1_024).optional(),
    extensionDependencies: z.array(z.string().max(257)).max(64).optional(),
    extensionPack: z.array(z.string().max(257)).max(128).optional(),
    contributes: z.record(z.string(), z.unknown()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

export function extensionId(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts.every((part) => identifierPart.safeParse(part).success)) {
    throw new Error("Invalid extension identifier.");
  }
  return value.toLowerCase();
}

/** Reject paths whose meaning differs between supported installation platforms. */
export function extensionArchivePath(value: string): string {
  if (
    !value ||
    value.length > 4_096 ||
    /[\\\u0000-\u001f\u007f:]/.test(value) ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error("Unsafe extension archive path.");
  }
  const name = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = name.split("/");
  if (
    segments.length > 64 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
        /[<>"|?*]/.test(segment),
    )
  )
    throw new Error("Unsafe extension archive path.");
  return name;
}

export function parseExtensionManifest(
  value: unknown,
  apiVersion = CODE_OSS_VERSION,
): ExtensionManifest {
  const manifest = extensionManifestSchema.parse(value);
  if (!semver.satisfies(apiVersion, manifest.engines.vscode)) {
    throw new Error(
      `Extension requires VS Code ${manifest.engines.vscode}; this host exposes ${apiVersion}.`,
    );
  }
  if (manifest.main) extensionArchivePath(manifest.main.replace(/^\.\//, ""));
  for (const dependency of manifest.extensionDependencies ?? []) extensionId(dependency);
  for (const dependency of manifest.extensionPack ?? []) extensionId(dependency);
  return manifest;
}

export function activationEvents(manifest: ExtensionManifest): string[] {
  const events = new Set(manifest.activationEvents ?? []);
  const contributes = manifest.contributes ?? {};
  for (const value of Array.isArray(contributes.commands) ? contributes.commands : []) {
    const command = commandContribution.safeParse(value);
    if (command.success) events.add(`onCommand:${command.data.command}`);
  }
  for (const value of Array.isArray(contributes.languages) ? contributes.languages : []) {
    const language = languageContribution.safeParse(value);
    if (language.success) events.add(`onLanguage:${language.data.id}`);
  }
  for (const value of Array.isArray(contributes.debuggers) ? contributes.debuggers : []) {
    const debuggerContribution = debugContribution.safeParse(value);
    if (debuggerContribution.success) {
      events.add(`onDebugResolve:${debuggerContribution.data.type}`);
      events.add(`onDebugInitialConfigurations:${debuggerContribution.data.type}`);
    }
  }
  const viewContributions = contributes.views;
  for (const views of Object.values(
    viewContributions && typeof viewContributions === "object" ? viewContributions : {},
  )) {
    if (!Array.isArray(views)) continue;
    for (const view of views)
      if (view && typeof view.id === "string" && view.type !== "webview")
        events.add(`onView:${view.id}`);
  }
  return [...events];
}
