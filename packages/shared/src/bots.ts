// FILE: bots.ts
// Purpose: Pure SynBot rules shared by the server, the web app and tests: bot templates, the
//          deterministic project scan that suggests bots, scope path matching, mascot palette
//          picks, and the economy model a new bot starts on.
// Layer: Shared runtime utilities (no I/O)
// Exports: BOT_TEMPLATES, BOT_CREW, suggestBotDrafts, botScopePathMatches, filesOutsideBotScope,
//          mascotForIndex, economyModelSlug, sentenceList

import {
  BOT_MASCOT_COLORS,
  BOT_NAME_MAX_LENGTH,
  BOT_ROLE_MAX_LENGTH,
  type BotDraft,
  type BotMascot,
  type BotMascotShape,
  type ProjectId,
} from "@synara/contracts";

// ── Templates ────────────────────────────────────────────────────────

export interface BotTemplate {
  readonly name: string;
  readonly role: string;
  readonly mascot: BotMascot;
  readonly instructions: string;
}

/** Roles a new bot can start from (ported from HoloBot `apps/desktop/src/bots/templates.ts`). */
export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    name: "Frontend",
    role: "Interfaces, components and styles",
    mascot: { shape: "clover", color: "#2fb36b" },
    instructions:
      "You own the user interface. Match the existing components and design tokens, keep it accessible, and check your change in light and dark. Small steps; test what you touch.",
  },
  {
    name: "Backend",
    role: "APIs, data and services",
    mascot: { shape: "square", color: "#8b5cf6" },
    instructions:
      "You own the server side: APIs, data, jobs. Keep interfaces stable, migrations reversible and errors explicit. Add a test for every behavior you change.",
  },
  {
    name: "QA",
    role: "Tests and reviews",
    mascot: { shape: "hexagon", color: "#e5484d" },
    instructions:
      "You keep the work honest: write and fix tests, and review what other bots change for bugs and regressions. Report what fails with the command that shows it.",
  },
  {
    name: "Docs",
    role: "Docs and release notes",
    mascot: { shape: "star", color: "#d9a400" },
    instructions:
      "You keep the docs true: READMEs, guides, release notes. Short sentences, plain words, examples that run.",
  },
  {
    name: "iOS",
    role: "The iPhone app",
    mascot: { shape: "triangle", color: "#1a80fa" },
    instructions:
      "You own the iPhone app. Follow the Human Interface Guidelines and the existing SwiftUI patterns; run the tests in the simulator before you finish.",
  },
];

/** The coding crew created in one click: the ones that do not exist yet. */
export const BOT_CREW = ["Frontend", "Backend", "QA"] as const;

// ── Mascots ──────────────────────────────────────────────────────────

const PALETTE_SHAPES: readonly Exclude<BotMascotShape, "synara">[] = [
  "circle",
  "clover",
  "square",
  "hexagon",
  "star",
  "triangle",
  "gem",
  "drop",
  "pill",
];

/** The n-th mascot of the palette, cycling shapes and colors independently. */
export function mascotForIndex(index: number): BotMascot {
  const safe = Math.max(0, Math.floor(index));
  return {
    shape: PALETTE_SHAPES[safe % PALETTE_SHAPES.length]!,
    color: BOT_MASCOT_COLORS[safe % BOT_MASCOT_COLORS.length]!,
  };
}

// ── Project scan ─────────────────────────────────────────────────────

/** Most suggestions of one scan. */
export const BOT_SUGGESTIONS_MAX = 3;

const FRONTEND_FOLDERS = ["web", "frontend", "client", "site", "landing"];
const BACKEND_FOLDERS = ["api", "server", "backend", "services", "engine"];
const MOBILE_FOLDERS = ["ios", "android", "mobile"];
/** Folders never looked into. */
export const BOT_SCAN_SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  "node_modules",
  "target",
  "vendor",
  "dist",
  "build",
  "Pods",
]);

export interface BotProjectScanInput {
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** Names of the project's top-level folders (no hidden folders, no build output). */
  readonly topFolders: readonly string[];
  /** Names of the folders under `apps/`, when there is one. */
  readonly appsFolders: readonly string[];
  readonly hasGitHubWorkflows: boolean;
  /** Names of the bots that exist, to avoid duplicates. */
  readonly takenNames: readonly string[];
}

export interface BotProjectScan {
  readonly drafts: readonly BotDraft[];
  /** The folders the drafts are about; empty when the draft covers the whole project. */
  readonly found: readonly string[];
  /** The card's question, for example "api has apps/web and server. Set up bots for them?". */
  readonly message: string;
}

const cut = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/** `a`, `a and b`, `a, b and c`; past six items, the first five and `N more`. */
export function sentenceList(items: readonly string[]): string {
  const shown = items.length > 6 ? [...items.slice(0, 5), `${items.length - 5} more`] : items;
  if (shown.length === 0) return "";
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

function freeName(name: string, projectName: string, taken: readonly string[]): string {
  const used = (candidate: string) =>
    taken.some((existing) => existing.toLowerCase() === candidate.toLowerCase());
  if (!used(name)) return name;
  const longer = cut(`${name} · ${projectName}`, BOT_NAME_MAX_LENGTH);
  return used(longer) ? name : longer;
}

/**
 * What a project's folders suggest as bots (ported from HoloBot `engine/core/src/bots/suggest.rs`).
 * Deterministic: no model call. Frontend, Backend and Mobile from folder names at the top level
 * or under `apps/`, CI from `.github/workflows`; at most three. A project with none of these gets
 * one bot named after it, for the whole project.
 */
export function suggestBotDrafts(input: BotProjectScanInput): BotProjectScan {
  const groups: Array<{ name: string; folders: string[] }> = [
    { name: "Frontend", folders: [] },
    { name: "Backend", folders: [] },
    { name: "Mobile", folders: [] },
  ];
  const kinds = [FRONTEND_FOLDERS, BACKEND_FOLDERS, MOBILE_FOLDERS];
  const place = (name: string, folder: string) => {
    const at = kinds.findIndex((set) => set.includes(name.toLowerCase()));
    if (at >= 0) groups[at]!.folders.push(folder);
  };
  const visible = (name: string) => !name.startsWith(".") && !BOT_SCAN_SKIPPED_FOLDERS.has(name);
  for (const name of [...input.topFolders].filter(visible).toSorted()) {
    place(name, name);
    if (name === "apps") {
      for (const child of [...input.appsFolders].filter(visible).toSorted()) {
        place(child, `apps/${child}`);
      }
    }
  }
  const suggestions = groups
    .filter((group) => group.folders.length > 0)
    .map((group) => ({
      name: group.name,
      folders: group.folders,
      paths: group.folders.map((folder) => `${folder}/**`),
      role: cut(group.folders.join(", "), BOT_ROLE_MAX_LENGTH),
    }));
  if (input.hasGitHubWorkflows) {
    suggestions.push({
      name: "CI",
      folders: [".github/workflows"],
      paths: [".github/**"],
      role: "GitHub workflows",
    });
  }
  const chosen = suggestions.slice(0, BOT_SUGGESTIONS_MAX);
  const scope = (paths: readonly string[]) => ({
    projects: [input.projectId] as ProjectId[],
    paths: [...paths],
  });
  const projectName = input.projectName.trim() || "Project";
  if (chosen.length === 0) {
    return {
      drafts: [
        {
          name: cut(projectName, BOT_NAME_MAX_LENGTH),
          role: "",
          mascot: mascotForIndex(0),
          scope: scope([]),
        },
      ],
      found: [],
      message: `${projectName} looks like one project. Set up a bot for it?`,
    };
  }
  const found = chosen.flatMap((suggestion) => suggestion.folders);
  return {
    drafts: chosen.map((suggestion, index) => ({
      name: freeName(suggestion.name, projectName, input.takenNames),
      role: suggestion.role,
      mascot: mascotForIndex(index),
      scope: scope(suggestion.paths),
    })),
    found,
    message: `${projectName} has ${sentenceList(found)}. Set up bots for them?`,
  };
}

// ── Scope paths ──────────────────────────────────────────────────────

const globCache = new Map<string, RegExp>();

/** Compiles a repository-relative glob: `**` crosses folders, `*` and `?` stay in one. */
function compileGlob(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const normalized = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "/**");
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        const slashAfter = normalized[index + 2] === "/";
        pattern += slashAfter ? "(?:.*/)?" : ".*";
        index += slashAfter ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`^${pattern}$`);
  globCache.set(glob, compiled);
  return compiled;
}

/** True when `path` (repository-relative, `/`-separated) is inside any of `globs`. */
export function botScopePathMatches(path: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return true;
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((glob) => {
    const trimmed = glob.trim();
    if (!trimmed) return false;
    // A bare folder ("apps/web") covers everything inside it.
    if (!/[*?]/.test(trimmed)) {
      const folder = trimmed.replace(/\/+$/, "");
      return normalized === folder || normalized.startsWith(`${folder}/`);
    }
    return compileGlob(trimmed).test(normalized);
  });
}

/** The changed files a task touched outside its bot's path scope (empty scope: none). */
export function filesOutsideBotScope(
  files: readonly string[],
  globs: readonly string[],
): readonly string[] {
  if (globs.length === 0) return [];
  return files.filter((file) => !botScopePathMatches(file, globs));
}

// ── Engines ──────────────────────────────────────────────────────────

/**
 * The model a new bot starts on: its provider's economy model when the provider has one in
 * `availableSlugs`, else `null` (keep the user's choice). Never upgrades a choice silently.
 */
export function economyModelSlug(
  provider: string,
  availableSlugs: readonly string[],
): string | null {
  const has = (slug: string) => availableSlugs.includes(slug);
  if (provider === "codex") {
    if (has("gpt-6-luna")) return "gpt-6-luna";
    return availableSlugs.find((slug) => /-mini$/.test(slug)) ?? null;
  }
  if (provider === "claudeAgent") {
    return availableSlugs.find((slug) => slug.includes("sonnet")) ?? null;
  }
  return null;
}
