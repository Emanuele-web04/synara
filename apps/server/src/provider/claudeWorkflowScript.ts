// meta must open the script as a pure literal so it's readable without evaluation — return undefined on anything else

import type { WorkflowAgentPlan, WorkflowAgentSnapshot, WorkflowPhase } from "@synara/contracts";

export interface ClaudeWorkflowScriptMeta {
  readonly name?: string;
  readonly description?: string;
  readonly phases?: ReadonlyArray<WorkflowPhase>;
}

export interface ClaudeWorkflowLaunch {
  readonly taskId?: string;
  readonly runId?: string;
  readonly scriptPath?: string;
  readonly transcriptDir?: string;
}

const QUOTES = new Set(['"', "'", "`"]);

function parseLiteral(source: string, index: number): { value: unknown; end: number } | undefined {
  // an unterminated block comment has no valid resumption — jump to end-of-source so the caller treats it as a mismatch
  const skipTrivia = (from: number): number => {
    let at = from;
    while (at < source.length) {
      const char = source[at]!;
      if (/\s/.test(char)) {
        at += 1;
        continue;
      }
      if (char === "/" && source[at + 1] === "/") {
        const newline = source.indexOf("\n", at + 2);
        at = newline === -1 ? source.length : newline;
        continue;
      }
      if (char === "/" && source[at + 1] === "*") {
        const close = source.indexOf("*/", at + 2);
        if (close === -1) {
          return source.length;
        }
        at = close + 2;
        continue;
      }
      break;
    }
    return at;
  };

  const parseString = (from: number): { value: string; end: number } | undefined => {
    const quote = source[from]!;
    let at = from + 1;
    let text = "";
    while (at < source.length) {
      const char = source[at]!;
      if (char === "\\" && at + 1 < source.length) {
        text += source[at + 1];
        at += 2;
        continue;
      }
      if (quote === "`" && char === "$" && source[at + 1] === "{") {
        return undefined;
      }
      if (char === quote) {
        return { value: text, end: at + 1 };
      }
      text += char;
      at += 1;
    }
    return undefined;
  };

  const at = skipTrivia(index);
  const char = source[at];
  if (char === undefined) {
    return undefined;
  }

  if (QUOTES.has(char)) {
    const parsed = parseString(at);
    return parsed ? { value: parsed.value, end: parsed.end } : undefined;
  }

  if (char === "[") {
    const items: Array<unknown> = [];
    let cursor = skipTrivia(at + 1);
    while (cursor < source.length && source[cursor] !== "]") {
      const item = parseLiteral(source, cursor);
      if (!item) {
        return undefined;
      }
      items.push(item.value);
      cursor = skipTrivia(item.end);
      if (source[cursor] === ",") {
        cursor = skipTrivia(cursor + 1);
      }
    }
    return source[cursor] === "]" ? { value: items, end: cursor + 1 } : undefined;
  }

  if (char === "{") {
    const record: Record<string, unknown> = {};
    let cursor = skipTrivia(at + 1);
    while (cursor < source.length && source[cursor] !== "}") {
      let key: string;
      if (QUOTES.has(source[cursor]!)) {
        const parsedKey = parseString(cursor);
        if (!parsedKey) {
          return undefined;
        }
        key = parsedKey.value;
        cursor = parsedKey.end;
      } else {
        const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
        if (!identifier) {
          return undefined;
        }
        key = identifier[0];
        cursor += identifier[0].length;
      }
      cursor = skipTrivia(cursor);
      if (source[cursor] !== ":") {
        return undefined;
      }
      const entry = parseLiteral(source, cursor + 1);
      if (!entry) {
        return undefined;
      }
      record[key] = entry.value;
      cursor = skipTrivia(entry.end);
      if (source[cursor] === ",") {
        cursor = skipTrivia(cursor + 1);
      }
    }
    return source[cursor] === "}" ? { value: record, end: cursor + 1 } : undefined;
  }

  const primitive = /^(?:true|false|null|-?\d+(?:\.\d+)?)/.exec(source.slice(at));
  if (primitive) {
    const raw = primitive[0];
    const value =
      raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : Number(raw);
    return { value, end: at + raw.length };
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readPhases(value: unknown): ReadonlyArray<WorkflowPhase> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const phases = value.flatMap((entry): Array<WorkflowPhase> => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const title = readString(record.title);
    if (!title) {
      return [];
    }
    const detail = readString(record.detail);
    return [{ title, ...(detail ? { detail } : {}) }];
  });
  return phases.length > 0 ? phases : undefined;
}

export function parseClaudeWorkflowScriptMeta(
  script: string,
): ClaudeWorkflowScriptMeta | undefined {
  const declaration = /export\s+const\s+meta\s*=/.exec(script);
  if (!declaration) {
    return undefined;
  }
  const parsed = parseLiteral(script, declaration.index + declaration[0].length);
  if (!parsed || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return undefined;
  }
  const record = parsed.value as Record<string, unknown>;
  const name = readString(record.name);
  const description = readString(record.description);
  const phases = readPhases(record.phases);
  if (!name && !description && !phases) {
    return undefined;
  }
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(phases ? { phases } : {}),
  };
}

export function extractClaudeWorkflowAgentPlans(
  script: string,
): Record<string, WorkflowAgentPlan> | undefined {
  const plans: Record<string, WorkflowAgentPlan> = {};
  const callPattern = /\bagent\s*\(/g;
  for (let match = callPattern.exec(script); match; match = callPattern.exec(script)) {
    const callText = readBalancedCall(script, match.index + match[0].length - 1);
    if (!callText) {
      continue;
    }
    const label = readOptionStringLiteral(callText, "label");
    if (!label) {
      continue;
    }
    const phase = readOptionStringLiteral(callText, "phase");
    const model = readOptionStringLiteral(callText, "model");
    const effort = readOptionStringLiteral(callText, "effort");
    if (phase || model || effort) {
      plans[label] = {
        ...(phase ? { phase } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
    }
  }
  return Object.keys(plans).length > 0 ? plans : undefined;
}

// Legacy label -> phase map derived from the plans; still emitted so older persisted-event consumers keep working.
export function extractClaudeWorkflowAgentPhases(
  script: string,
): Record<string, string> | undefined {
  const plans = extractClaudeWorkflowAgentPlans(script);
  if (!plans) {
    return undefined;
  }
  const pairs = Object.entries(plans).flatMap(
    ([label, plan]): Array<[string, string]> => (plan.phase ? [[label, plan.phase]] : []),
  );
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

// balanced-paren arg scan skips strings and comments; comment regions collapse to one space so downstream regex never sees commented-out content
function readBalancedCall(source: string, openParen: number): string | undefined {
  let depth = 0;
  let at = openParen;
  let segmentStart = openParen;
  const parts: Array<string> = [];

  while (at < source.length) {
    const char = source[at]!;
    if (QUOTES.has(char)) {
      const quote = char;
      at += 1;
      while (at < source.length && source[at] !== quote) {
        at += source[at] === "\\" ? 2 : 1;
      }
      at += 1;
      continue;
    }
    if (char === "/" && source[at + 1] === "/") {
      parts.push(source.slice(segmentStart, at), " ");
      const newline = source.indexOf("\n", at + 2);
      at = newline === -1 ? source.length : newline;
      segmentStart = at;
      continue;
    }
    if (char === "/" && source[at + 1] === "*") {
      const close = source.indexOf("*/", at + 2);
      if (close === -1) {
        return undefined;
      }
      parts.push(source.slice(segmentStart, at), " ");
      at = close + 2;
      segmentStart = at;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        parts.push(source.slice(segmentStart, at));
        return parts.join("").slice(1);
      }
    }
    at += 1;
  }
  return undefined;
}

function readOptionStringLiteral(callText: string, key: string): string | undefined {
  const pattern = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
  const match = pattern.exec(callText);
  const value = match?.[2]?.replaceAll(/\\(.)/g, "$1").trim();
  return value && !value.includes("${") ? value : undefined;
}

const WORKFLOW_RUN_ID_PATTERN = /\bwf_[a-z0-9-]{6,}\b/;

export const WORKFLOW_PROMPT_PREVIEW_CHARS = 400;

// Launch identifiers from the Workflow tool result. taskType was added after the original structured result shape, so it may be absent on older results.
export function parseClaudeWorkflowLaunch(value: unknown): ClaudeWorkflowLaunch | undefined {
  if (typeof value === "string") {
    try {
      return parseClaudeWorkflowLaunch(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.taskType !== undefined && record.taskType !== "local_workflow") {
    return undefined;
  }
  const taskId = readString(record.taskId);
  const runId = readString(record.runId);
  const scriptPath = readString(record.scriptPath);
  const transcriptDir = readString(record.transcriptDir);
  if (!runId && !scriptPath) {
    return undefined;
  }
  return {
    ...(taskId ? { taskId } : {}),
    ...(runId && WORKFLOW_RUN_ID_PATTERN.test(runId) ? { runId } : {}),
    ...(scriptPath ? { scriptPath } : {}),
    ...(transcriptDir ? { transcriptDir } : {}),
  };
}

export function parseClaudeWorkflowLaunchFromText(text: string): ClaudeWorkflowLaunch | undefined {
  const runId = WORKFLOW_RUN_ID_PATTERN.exec(text)?.[0];
  const scriptPath = text
    .split("\n")
    .filter((line) => /script|persisted/i.test(line))
    .map((line) => /(\/[^\s"'`]+\.[a-z]{2,4})\b/.exec(line)?.[1])
    .find((path) => path !== undefined);
  if (!runId && !scriptPath) {
    return undefined;
  }
  return {
    ...(runId ? { runId } : {}),
    ...(scriptPath ? { scriptPath } : {}),
  };
}

export function parseClaudeWorkflowProgressAgents(
  content: string,
): ReadonlyArray<WorkflowAgentSnapshot> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const progress = (parsed as Record<string, unknown>).workflowProgress;
  if (!Array.isArray(progress)) {
    return undefined;
  }
  const agents = progress.flatMap((entry): Array<WorkflowAgentSnapshot> => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (record.type !== "workflow_agent") {
      return [];
    }
    const label = readString(record.label);
    if (!label) {
      return [];
    }
    const phaseIndex = readInt(record.phaseIndex);
    const phaseTitle = readString(record.phaseTitle);
    const agentId = readString(record.agentId);
    const model = readString(record.model);
    const effort = readString(record.effort);
    const state = readString(record.state);
    const tokens = readInt(record.tokens);
    const toolCalls = readInt(record.toolCalls);
    const durationMs = readInt(record.durationMs);
    const lastToolName = readString(record.lastToolName);
    const promptPreview = readString(record.promptPreview)?.slice(0, WORKFLOW_PROMPT_PREVIEW_CHARS);
    return [
      {
        label,
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        ...(phaseTitle ? { phaseTitle } : {}),
        ...(agentId ? { agentId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(state ? { state } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(lastToolName ? { lastToolName } : {}),
        ...(promptPreview ? { promptPreview } : {}),
      },
    ];
  });
  return agents.length > 0 ? agents : undefined;
}
