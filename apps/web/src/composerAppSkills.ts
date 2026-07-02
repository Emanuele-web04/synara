export const COMPOSER_APP_SKILLS = ["live-edit"] as const;

export type ComposerAppSkillId = (typeof COMPOSER_APP_SKILLS)[number];

export interface ComposerAppSkillDefinition {
  id: ComposerAppSkillId;
  label: string;
  trigger: `/${ComposerAppSkillId}`;
  description: string;
}

export interface ComposerAppSkillInvocation {
  id: ComposerAppSkillId;
  args: string;
}

export interface LiveEditAppSkillArgs {
  action?: "stop" | "nuke";
  target?: string;
  url?: string;
  command?: string;
  preferredPort?: number;
}

const COMPOSER_APP_SKILL_DEFINITIONS: Record<ComposerAppSkillId, ComposerAppSkillDefinition> = {
  "live-edit": {
    id: "live-edit",
    label: "Live Edit",
    trigger: "/live-edit",
    description: "Start a local frontend preview and open the browser editor",
  },
};

function normalizeAppSkillName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

export function parseComposerAppSkillInvocation(text: string): ComposerAppSkillInvocation | null {
  const match = /^\/([a-z-]+)(?:\s+(.*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const id = normalizeAppSkillName(match[1] ?? "");
  if (!COMPOSER_APP_SKILLS.includes(id as ComposerAppSkillId)) {
    return null;
  }
  return {
    id: id as ComposerAppSkillId,
    args: (match[2] ?? "").trim(),
  };
}

export function filterComposerAppSkills(query: string): ComposerAppSkillDefinition[] {
  const normalizedQuery = query.trim().toLowerCase();
  return COMPOSER_APP_SKILLS.map((id) => COMPOSER_APP_SKILL_DEFINITIONS[id]).filter(
    (definition) =>
      normalizedQuery.length === 0 ||
      definition.id.includes(normalizedQuery) ||
      definition.label.toLowerCase().includes(normalizedQuery) ||
      definition.trigger.slice(1).includes(normalizedQuery) ||
      definition.description.toLowerCase().includes(normalizedQuery),
  );
}

function tokenizeSkillArgs(args: string): string[] {
  return Array.from(args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)).map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

export function parseLiveEditAppSkillArgs(args: string): LiveEditAppSkillArgs {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const tokens = tokenizeSkillArgs(trimmed);
  const parsed: LiveEditAppSkillArgs = {};
  const targetParts: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--url") {
      const value = tokens[index + 1];
      if (value) parsed.url = value;
      index += 1;
      continue;
    }
    if (token === "--command") {
      const value = tokens[index + 1];
      if (value) parsed.command = value;
      index += 1;
      continue;
    }
    if (token === "--port") {
      const preferredPort = parsePort(tokens[index + 1]);
      if (preferredPort !== undefined) parsed.preferredPort = preferredPort;
      index += 1;
      continue;
    }
    // A bare URL token is a URL wherever it appears, so `/live-edit http://... --port 5174`
    // does not glue trailing flags into the URL string.
    if (/^https?:\/\//i.test(token)) {
      parsed.url ??= token;
      continue;
    }
    // Recognize the stop/nuke action anywhere among positional tokens so
    // `/live-edit --port 3000 stop` does not turn into a start request.
    const lowered = token.toLowerCase();
    if ((lowered === "stop" || lowered === "nuke") && parsed.action === undefined) {
      parsed.action = lowered;
      continue;
    }
    targetParts.push(token);
  }
  const target = targetParts.join(" ").trim();
  return target.length > 0 ? { ...parsed, target } : parsed;
}
