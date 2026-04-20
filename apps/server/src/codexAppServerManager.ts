import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  type ProviderComposerCapabilities,
  ProviderItemId,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderMentionReference,
  type ProviderPluginAppSummary,
  type ProviderPluginDescriptor,
  type ProviderPluginDetail,
  type ProviderForkThreadInput,
  type ProviderReadPluginResult,
  type ProviderForkThreadResult,
  type ProviderListSkillsResult,
  type ProviderListPluginsInput,
  type ProviderReadPluginInput,
  type ProviderStartReviewInput,
  type ProviderSkillDescriptor,
  type ProviderSkillReference,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeMode,
  ProviderInteractionMode,
  type ServerVoiceTranscriptionInput,
  type ServerVoiceTranscriptionResult,
} from "@t3tools/contracts";
import { readActiveCodexProviderEnvKey } from "@t3tools/shared/codexConfig";
import { normalizeModelSlug } from "@t3tools/shared/model";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@t3tools/shared/shell";
import { Effect, ServiceMap } from "effect";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion";
import { isNonFatalCodexErrorMessage } from "./codexErrorClassification.ts";
import { transcribeVoiceWithChatGptSession } from "./voiceTranscription.ts";

type PendingRequestKey = string;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface CodexUserInputAnswer {
  answers: string[];
}

interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<string, TurnId>;
  collabReceiverParents: Map<string, string>;
  reviewTurnIds: Set<TurnId>;
  nextRequestId: number;
  stopping: boolean;
  discovery?: boolean;
}

interface CodexSkillListInput {
  readonly cwd: string;
  readonly forceReload?: boolean;
  readonly threadId?: string;
}

interface CodexPluginListInput extends Omit<ProviderListPluginsInput, "provider"> {}

interface CodexPluginReadInput extends Omit<ProviderReadPluginInput, "provider"> {}

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

function shouldRetrySkillsListWithCwdFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("skills/list failed") &&
    (message.includes("invalid") ||
      message.includes("unknown field") ||
      message.includes("unrecognized field") ||
      message.includes("missing field") ||
      message.includes("expected") ||
      message.includes("cwds"))
  );
}

type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

interface CodexVoiceTranscriptionAuthContext {
  readonly authMethod: "chatgpt" | "chatgptAuthTokens";
  readonly token: string;
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
  readonly mentions?: ReadonlyArray<ProviderMentionReference>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

type CodexAppServerReviewTarget = ProviderStartReviewInput["target"];

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: RuntimeMode;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
  cwd?: string | null;
}

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const BENIGN_PROCESS_OUTPUT_REGEXES = [/^(?:\^C)?Token usage:/i];
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];
const CODEX_DEFAULT_MODEL = "gpt-5.3-codex";
const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
const CODEX_SPARK_DISABLED_PLAN_TYPES = new Set<CodexPlanType>(["free", "go", "plus"]);
const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const CODEX_BROWSER_USE_PIPE_PATH =
  process.platform === "win32" ? String.raw`\\.\pipe\codex-browser-use` : "/tmp/codex-browser-use";
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
  } = {},
): NodeJS.ProcessEnv {
  const baseEnv = { ...(input.env ?? process.env) };
  const effectiveEnv = input.homePath ? { ...baseEnv, CODEX_HOME: input.homePath } : baseEnv;
  const platform = input.platform ?? process.platform;

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
      if (shell && providerEnvKey && !effectiveEnv[providerEnvKey]?.trim()) {
        const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
          ...CODEX_PROCESS_SHELL_ENV_NAMES,
          providerEnvKey,
        ]);

        if (shellEnvironment.PATH) {
          effectiveEnv.PATH = shellEnvironment.PATH;
        }
        if (!effectiveEnv.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
          effectiveEnv.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
        }
        if (shellEnvironment[providerEnvKey]) {
          effectiveEnv[providerEnvKey] = shellEnvironment[providerEnvKey];
        }
      }
    } catch {
      // Keep inherited environment if shell lookup fails.
    }
  }

  if (platform !== "win32") {
    const allowedSockets =
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS]
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) ?? [];
    if (!allowedSockets.includes(CODEX_BROWSER_USE_PIPE_PATH)) {
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS] = [
        ...allowedSockets,
        CODEX_BROWSER_USE_PIPE_PATH,
      ].join(",");
    }
  }

  return effectiveEnv;
}

function normalizeCodexProcessLine(rawLine: string): string {
  return rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
}

function isIgnorableCodexProcessLine(rawLine: string): boolean {
  const line = normalizeCodexProcessLine(rawLine);
  if (!line) {
    return true;
  }
  return BENIGN_PROCESS_OUTPUT_REGEXES.some((pattern) => pattern.test(line));
}

function normalizeCodexUserVisibleErrorMessage(rawMessage: string): string {
  const message = normalizeCodexProcessLine(rawMessage);

  const duplicateFunctionArgMatch = message.match(
    /failed to parse function arguments: duplicate field `([^`]+)`/i,
  );
  if (duplicateFunctionArgMatch) {
    const fieldName = duplicateFunctionArgMatch[1];
    return `Tool call failed because the same argument was sent twice${fieldName ? ` (${fieldName})` : ""}.`;
  }

  return message;
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    };
  }

  if (accountType === "chatgpt") {
    const planType = (account?.planType as CodexPlanType | null) ?? "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: !CODEX_SPARK_DISABLED_PLAN_TYPES.has(planType),
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: true,
  };
}

const CODEX_BROWSER_TOOL_ROUTING_INSTRUCTIONS = `

## Browser tool routing

Prefer the built-in in-app browser for browser work whenever possible.

When the user asks to inspect a page, navigate a site, read what is visible in the browser, take a browser screenshot, or interact with content already open in chat, use the in-app browser path first.

Use \`Computer Use\` only when at least one of these is true:
- the user explicitly asks to use \`Computer Use\`
- the task is outside the in-app browser (desktop apps, OS settings, system UI, other app windows)
- the in-app browser cannot complete the task and a broader desktop fallback is required

Do not choose \`Computer Use\` first for ordinary browser inspection, browser screenshots, or browser navigation when the in-app browser can handle the request.`;

export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a \`<proposed_plan>\` block.

Separately, \`update_plan\` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use \`update_plan\` in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, \`target/\`, \`.cache/\`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 - Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 - Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet-ask.

## PHASE 3 - Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the \`request_user_input\` tool to ask any questions.
* Offer only meaningful multiple-choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the \`request_user_input\` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., "where is this struct").

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2-4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

plan content should be human and agent digestible. The final plan must be plan-only and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a \`<proposed_plan>\` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.
</collaboration_mode>${CODEX_BROWSER_TOOL_ROUTING_INSTRUCTIONS}`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

The \`request_user_input\` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>${CODEX_BROWSER_TOOL_ROUTING_INSTRUCTIONS}`;

function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "untrusted";
  readonly sandbox: "read-only";
} | null {
  if (runtimeMode === "approval-required") {
    return {
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    };
  }

  return null;
}

function ensureIsolatedScratchWorkspace(threadId: ThreadId): string {
  const workspaceRoot = path.join(tmpdir(), "dpcode-codex-workspaces");
  const workspaceDir = path.join(workspaceRoot, String(threadId));
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  account: CodexAccountSnapshot,
): string | undefined {
  if (model !== CODEX_SPARK_MODEL || account.sparkEnabled) {
    return model;
  }

  return CODEX_DEFAULT_MODEL;
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // fallback to direct kill
    }
  }
  child.kill();
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "DP Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
}):
  | {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    }
  | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? "gpt-5.3-codex";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions:
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  if (isIgnorableCodexProcessLine(rawLine)) {
    return null;
  }
  const line = normalizeCodexProcessLine(rawLine);

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: normalizeCodexUserVisibleErrorMessage(line) };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  private readonly discoverySessions = new Map<string, CodexSessionContext>();
  private readonly skillsCache = new Map<string, ProviderListSkillsResult>();
  private readonly pluginsCache = new Map<string, ProviderListPluginsResult>();
  private readonly pluginDetailCache = new Map<string, ProviderReadPluginResult>();
  private readonly modelCache = new Map<string, ProviderListModelsResult>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const resolvedCwd = input.cwd ?? ensureIsolatedScratchWorkspace(threadId);

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions(input);
      const codexBinaryPath = codexOptions.binaryPath ?? "codex";
      const codexHomePath = codexOptions.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const child = spawn(codexBinaryPath, ["app-server"], {
        cwd: resolvedCwd,
        env: buildCodexProcessEnv({
          ...(codexHomePath ? { homePath: codexHomePath } : {}),
        }),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());

      this.writeMessage(context, { method: "initialized" });
      try {
        const modelListResponse = await this.sendRequest(context, "model/list", {});
        console.log("codex model/list response", modelListResponse);
      } catch (error) {
        console.log("codex model/list failed", error);
      }
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        console.log("codex account/read response", accountReadResponse);
        context.account = readCodexAccountSnapshot(accountReadResponse);
        console.log("codex subscription status", {
          type: context.account.type,
          planType: context.account.planType,
          sparkEnabled: context.account.sparkEnabled,
        });
      } catch (error) {
        console.log("codex account/read failed", error);
      }

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.account,
      );
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: resolvedCwd,
        ...(mapCodexRuntimeMode(input.runtimeMode ?? "full-access") ?? {}),
      };

      const threadStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
      };
      const resumeThreadId = readResumeThreadId(input);
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await this.sendRequest(context, "thread/resume", {
            ...sessionOverrides,
            threadId: resumeThreadId,
          });
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
      }

      const threadOpenRecord = this.readObject(threadOpenResponse);
      const threadIdRaw =
        this.readString(this.readObject(threadOpenRecord, "thread"), "id") ??
        this.readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: providerThreadId },
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();

    // Normal sends never interrupt active work. The orchestration layer decides
    // when a queued follow-up is ready to become a provider turn.
    const turnInput: Array<
      | { type: "text"; text: string; text_elements: [] }
      | { type: "image"; url: string }
      | { type: "skill"; name: string; path: string }
      | { type: "mention"; name: string; path: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    for (const skill of input.skills ?? []) {
      turnInput.push({
        type: "skill",
        name: skill.name,
        path: skill.path,
      });
    }
    for (const mention of input.mentions ?? []) {
      turnInput.push({
        type: "mention",
        name: mention.name,
        path: mention.path,
      });
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<
        | { type: "text"; text: string; text_elements: [] }
        | { type: "image"; url: string }
        | { type: "skill"; name: string; path: string }
        | { type: "mention"; name: string; path: string }
      >;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    const collaborationMode = buildCodexCollaborationMode({
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
    if (collaborationMode) {
      if (!turnStartParams.model) {
        turnStartParams.model = collaborationMode.settings.model;
      }
      turnStartParams.collaborationMode = collaborationMode;
    }

    const response = await this.sendRequest(context, "turn/start", turnStartParams);
    const turnIdRaw = this.readString(this.readObject(this.readObject(response), "turn"), "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async steerTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();

    const activeTurnId = context.session.activeTurnId;
    if (context.session.status !== "running" || activeTurnId === undefined) {
      return this.sendTurn(input);
    }

    const turnInput: Array<
      | { type: "text"; text: string; text_elements: [] }
      | { type: "image"; url: string }
      | { type: "skill"; name: string; path: string }
      | { type: "mention"; name: string; path: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    for (const skill of input.skills ?? []) {
      turnInput.push({
        type: "skill",
        name: skill.name,
        path: skill.path,
      });
    }
    for (const mention of input.mentions ?? []) {
      turnInput.push({
        type: "mention",
        name: mention.name,
        path: mention.path,
      });
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }

    const response = await this.sendRequest(context, "turn/steer", {
      threadId: providerThreadId,
      input: turnInput,
      expectedTurnId: activeTurnId,
    });

    const turnIdRaw = this.readString(this.readObject(response), "turnId");
    if (!turnIdRaw) {
      throw new Error("turn/steer response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async startReview(input: ProviderStartReviewInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "review/start", {
      threadId: providerThreadId,
      delivery: "inline",
      target: this.toCodexReviewTarget(input.target),
    });

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("review/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    context.reviewTurnIds.add(turnId);
    console.log("[codex-review] review/start acknowledged", {
      threadId: context.session.threadId,
      providerThreadId,
      turnId,
      target: input.target.type,
    });

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async interruptTurn(
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadIdOverride?: string,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerThreadId =
      providerThreadIdOverride ??
      readResumeThreadId({
        threadId: context.session.threadId,
        runtimeMode: context.session.runtimeMode,
        resumeCursor: context.session.resumeCursor,
      });
    if (!effectiveTurnId || !providerThreadId) {
      console.log("[codex-review] turn/interrupt skipped", {
        threadId,
        requestedTurnId: turnId ?? null,
        activeTurnId: context.session.activeTurnId ?? null,
        providerThreadId: providerThreadId ?? null,
      });
      return;
    }

    console.log("[codex-review] turn/interrupt requested", {
      threadId,
      providerThreadId,
      turnId: effectiveTurnId,
      isTrackedReviewTurn: context.reviewTurnIds.has(effectiveTurnId),
    });
    try {
      await this.sendRequest(context, "turn/interrupt", {
        threadId: providerThreadId,
        turnId: effectiveTurnId,
      });
      console.log("[codex-review] turn/interrupt acknowledged", {
        threadId,
        providerThreadId,
        turnId: effectiveTurnId,
      });
    } catch (error) {
      console.log("[codex-review] turn/interrupt failed", {
        threadId,
        providerThreadId,
        turnId: effectiveTurnId,
        isTrackedReviewTurn: context.reviewTurnIds.has(effectiveTurnId),
        error: error instanceof Error ? error.message : String(error),
      });
      if (!context.reviewTurnIds.has(effectiveTurnId) || !this.isTurnInterruptTimeout(error)) {
        throw error;
      }

      const snapshot = await this.readThread(threadId);
      const latestReviewTurnId = this.findLatestReviewTurnId(snapshot);
      console.log("[codex-review] review interrupt recovery snapshot", {
        threadId,
        currentTurnId: effectiveTurnId,
        latestReviewTurnId: latestReviewTurnId ?? null,
        latestReviewTurnExited:
          latestReviewTurnId ? this.isExitedReviewTurn(snapshot, latestReviewTurnId) : false,
        snapshotTurnIds: snapshot.turns.map((turn) => String(turn.id)),
      });

      if (latestReviewTurnId && this.isExitedReviewTurn(snapshot, latestReviewTurnId)) {
        console.log("[codex-review] settling review from thread/read exitedReviewMode", {
          threadId,
          turnId: latestReviewTurnId,
        });
        this.settleTrackedReview(context, {
          completedTurnId: latestReviewTurnId,
          reason: "review exited via thread/read",
        });
        return;
      }

      if (latestReviewTurnId && latestReviewTurnId !== effectiveTurnId) {
        console.log("[codex-review] retrying turn/interrupt with refreshed review turn", {
          threadId,
          previousTurnId: effectiveTurnId,
          nextTurnId: latestReviewTurnId,
        });
        await this.sendRequest(context, "turn/interrupt", {
          threadId: providerThreadId,
          turnId: latestReviewTurnId,
        });
        context.reviewTurnIds.add(latestReviewTurnId);
        this.updateSession(context, {
          activeTurnId: latestReviewTurnId,
        });
        return;
      }

      throw error;
    }
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  async readExternalThread(input: {
    externalThreadId: string;
    cwd?: string;
  }): Promise<CodexThreadSnapshot> {
    const context = await this.resolveContextForDiscovery(undefined, input.cwd);
    const response = await this.sendRequest(context, "thread/read", {
      threadId: input.externalThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  async forkThread(input: ProviderForkThreadInput): Promise<ProviderForkThreadResult> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const sourceProviderThreadId = readResumeCursorThreadId(input.sourceResumeCursor);
      if (!sourceProviderThreadId) {
        throw new Error("Provider fork is missing the source thread resume id.");
      }

      const resolvedCwd = input.cwd ?? ensureIsolatedScratchWorkspace(threadId);
      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model:
          input.modelSelection?.provider === "codex"
            ? normalizeCodexModelSlug(input.modelSelection.model)
            : undefined,
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions({
        threadId,
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      });
      const codexBinaryPath = codexOptions.binaryPath ?? "codex";
      const codexHomePath = codexOptions.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const child = spawn(codexBinaryPath, ["app-server"], {
        cwd: resolvedCwd,
        env: buildCodexProcessEnv({
          ...(codexHomePath ? { homePath: codexHomePath } : {}),
        }),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);
      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());
      this.writeMessage(context, { method: "initialized" });
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch {
        // Fork can proceed without account metadata; model fallback will stay best-effort.
      }

      const normalizedModel =
        input.modelSelection?.provider === "codex"
          ? resolveCodexModelForAccount(
              normalizeCodexModelSlug(input.modelSelection.model),
              context.account,
            )
          : undefined;
      const forkParams = {
        threadId: sourceProviderThreadId,
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
          ? { serviceTier: "fast" as const }
          : {}),
        cwd: resolvedCwd,
        ...(mapCodexRuntimeMode(input.runtimeMode) ?? {}),
      };

      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        `Forking Codex thread ${sourceProviderThreadId}.`,
      );
      const response = await this.sendRequest(context, "thread/fork", forkParams);
      const forkedProviderThreadId = this.readThreadIdFromResponse("thread/fork", response);

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: forkedProviderThreadId },
      });
      this.emitLifecycleEvent(context, "session/threadOpenResolved", "Codex thread/fork resolved.");
      this.emitLifecycleEvent(
        context,
        "session/ready",
        `Connected to thread ${forkedProviderThreadId}`,
      );

      return {
        threadId,
        resumeCursor: {
          threadId: forkedProviderThreadId,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fork Codex thread.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/threadForkFailed", message);
        this.stopSession(threadId);
      }
      throw new Error(message, { cause: error });
    }
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerThreadId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseThreadSnapshot("thread/rollback", response);
  }

  async compactThread(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    await Effect.logInfo("codex app-server compact requested", {
      threadId: context.session.threadId,
      providerThreadId,
      runtimeMode: context.session.runtimeMode,
      activeTurnId: context.session.activeTurnId ?? null,
    }).pipe(this.runPromise);

    this.updateSession(context, {
      status: "running",
    });
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.session.activeTurnId ? { turnId: context.session.activeTurnId } : {}),
      method: "thread/compacting",
      message: "Compacting context",
      payload: {
        threadId: providerThreadId,
        state: "compacting",
      },
    });
    try {
      await this.sendRequest(context, "thread/compact/start", {
        threadId: providerThreadId,
      });
      await Effect.logInfo("codex app-server compact start acknowledged", {
        threadId: context.session.threadId,
        providerThreadId,
      }).pipe(this.runPromise);
    } catch (error) {
      this.updateSession(context, {
        status: "error",
        lastError: error instanceof Error ? error.message : context.session.lastError,
      });
      await Effect.logWarning("codex app-server compact failed", {
        threadId: context.session.threadId,
        providerThreadId,
        cause: error,
      }).pipe(this.runPromise);
      throw error;
    }
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        decision,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
    for (const discoveryKey of this.discoverySessions.keys()) {
      this.stopDiscoverySession(discoveryKey);
    }
  }

  async listSkills(input: CodexSkillListInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd.trim();
    const cacheKey = JSON.stringify({
      cwd,
      threadId: input.threadId?.trim() || null,
    });
    if (!input.forceReload) {
      const cached = this.skillsCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          cached: true,
        };
      }
    }

    const context = await this.resolveContextForDiscovery(input.threadId, cwd);
    let response: Record<string, unknown>;
    try {
      response = await this.sendRequest<Record<string, unknown>>(context, "skills/list", {
        cwds: [cwd],
        ...(input.forceReload ? { forceReload: true } : {}),
      });
    } catch (error) {
      if (!shouldRetrySkillsListWithCwdFallback(error)) {
        throw error;
      }
      response = await this.sendRequest<Record<string, unknown>>(context, "skills/list", {
        cwd,
        ...(input.forceReload ? { forceReload: true } : {}),
      });
    }
    const skills = this.parseSkillsListResponse(response, cwd);
    const result: ProviderListSkillsResult = {
      skills,
      source: "codex-app-server",
      cached: false,
    };
    this.skillsCache.set(cacheKey, result);
    return result;
  }

  async listPlugins(input: CodexPluginListInput): Promise<ProviderListPluginsResult> {
    const cwd = input.cwd?.trim() || null;
    const cacheKey = JSON.stringify({
      cwd,
      threadId: input.threadId?.trim() || null,
      forceRemoteSync: input.forceRemoteSync === true,
    });
    if (!input.forceReload) {
      const cached = this.pluginsCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          cached: true,
        };
      }
    }

    const context = await this.resolveContextForDiscovery(input.threadId, cwd ?? undefined);
    const response = await this.sendRequest<Record<string, unknown>>(context, "plugin/list", {
      ...(cwd ? { cwds: [cwd] } : {}),
      ...(input.forceRemoteSync ? { forceRemoteSync: true } : {}),
    });
    const result: ProviderListPluginsResult = {
      ...this.parsePluginListResponse(response),
      source: "codex-app-server",
      cached: false,
    };
    this.pluginsCache.set(cacheKey, result);
    return result;
  }

  async readPlugin(input: CodexPluginReadInput): Promise<ProviderReadPluginResult> {
    const marketplacePath = input.marketplacePath.trim();
    const pluginName = input.pluginName.trim();
    const cacheKey = JSON.stringify({
      marketplacePath,
      pluginName,
    });
    const cached = this.pluginDetailCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }

    const context = await this.resolveContextForDiscovery(undefined);
    const response = await this.sendRequest<Record<string, unknown>>(context, "plugin/read", {
      marketplacePath,
      pluginName,
    });
    const result: ProviderReadPluginResult = {
      plugin: this.parsePluginReadResponse(response),
      source: "codex-app-server",
      cached: false,
    };
    this.pluginDetailCache.set(cacheKey, result);
    return result;
  }

  async listModels(threadId?: string): Promise<ProviderListModelsResult> {
    const cacheKey = threadId?.trim() || "__default__";
    const cached = this.modelCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }

    const context = await this.resolveContextForDiscovery(threadId);
    const response = await this.sendRequest<Record<string, unknown>>(context, "model/list", {});
    const models = this.parseModelListResponse(response);
    const result: ProviderListModelsResult = {
      models,
      source: "codex-app-server",
      cached: false,
    };
    this.modelCache.set(cacheKey, result);
    return result;
  }

  async transcribeVoice(
    input: ServerVoiceTranscriptionInput,
  ): Promise<ServerVoiceTranscriptionResult> {
    return transcribeVoiceWithChatGptSession({
      request: input,
      resolveAuth: (refreshToken) =>
        this.resolveVoiceTranscriptionAuth({
          cwd: input.cwd,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          refreshToken,
        }),
    });
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: "codex",
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: true,
      supportsPluginDiscovery: true,
      supportsRuntimeModelList: true,
    };
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private async resolveContextForDiscovery(
    threadId?: string,
    cwd?: string,
  ): Promise<CodexSessionContext> {
    const normalizedThreadId = threadId?.trim();
    const normalizedCwd = cwd?.trim() || undefined;
    if (normalizedThreadId) {
      try {
        const session = this.requireSession(ThreadId.makeUnsafe(normalizedThreadId));
        if (!normalizedCwd || session.session.cwd === normalizedCwd) {
          return session;
        }
      } catch {
        // Discovery is read-only metadata, so if the current draft thread does not
        // have a live Codex session yet we can still service repo-scoped
        // discovery through a dedicated discovery session for that cwd.
      }
    }
    if (normalizedCwd) {
      for (const activeSession of this.sessions.values()) {
        if (
          !activeSession.stopping &&
          !activeSession.child.killed &&
          activeSession.session.cwd === normalizedCwd
        ) {
          return activeSession;
        }
      }
      return this.getOrCreateDiscoverySession(normalizedCwd);
    }
    const firstActive = this.sessions.values().next().value;
    if (firstActive) {
      return firstActive;
    }
    return this.getOrCreateDiscoverySession(process.cwd());
  }

  private async resolveVoiceTranscriptionAuth(input: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly refreshToken: boolean;
  }): Promise<CodexVoiceTranscriptionAuthContext> {
    // Voice transcription should always resolve auth from a fresh discovery context
    // instead of reusing a possibly stale thread-bound session token.
    const context = await this.getOrCreateDiscoverySession(input.cwd?.trim() || process.cwd());
    const response = await this.sendRequest<Record<string, unknown>>(context, "getAuthStatus", {
      includeToken: true,
      refreshToken: input.refreshToken,
    });
    const authMethod = this.readString(response, "authMethod");
    const token = this.readString(response, "authToken");

    if (!token) {
      throw new Error("No ChatGPT session token is available. Sign in to ChatGPT in Codex.");
    }
    if (authMethod !== "chatgpt" && authMethod !== "chatgptAuthTokens") {
      throw new Error("Voice transcription requires a ChatGPT-authenticated Codex session.");
    }

    return {
      authMethod,
      token,
    };
  }

  private async getOrCreateDiscoverySession(cwd: string): Promise<CodexSessionContext> {
    const normalizedCwd = cwd.trim() || process.cwd();
    const existing = this.discoverySessions.get(normalizedCwd);
    if (existing && !existing.stopping && !existing.child.killed) {
      return existing;
    }

    const now = new Date().toISOString();
    this.assertSupportedCodexCliVersion({
      binaryPath: "codex",
      cwd: normalizedCwd,
    });
    const child = spawn("codex", ["app-server"], {
      cwd: normalizedCwd,
      env: buildCodexProcessEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });
    const context: CodexSessionContext = {
      session: {
        provider: "codex",
        status: "connecting",
        runtimeMode: "full-access",
        model: CODEX_DEFAULT_MODEL,
        cwd: normalizedCwd,
        threadId: ThreadId.makeUnsafe(`__codex_discovery__:${normalizedCwd}`),
        createdAt: now,
        updatedAt: now,
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child,
      output,
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      discovery: true,
    };

    this.discoverySessions.set(normalizedCwd, context);
    this.attachProcessListeners(context);
    try {
      await this.sendRequest(context, "initialize", buildCodexInitializeParams());
      this.writeMessage(context, { method: "initialized" });
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch {
        // Discovery can still function without account metadata.
      }
      this.updateSession(context, { status: "ready" });
      return context;
    } catch (error) {
      this.stopDiscoverySession(normalizedCwd);
      throw error;
    }
  }

  private stopDiscoverySession(discoveryKey: string): void {
    const context = this.discoverySessions.get(discoveryKey);
    if (!context) {
      return;
    }

    context.stopping = true;
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Discovery session stopped before request completed."));
    }
    context.pending.clear();
    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.discoverySessions.delete(discoveryKey);
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    context.output.on("line", (line) => {
      if (context.stopping || isIgnorableCodexProcessLine(line)) {
        return;
      }
      this.handleStdoutLine(context, line);
    });

    context.child.stderr.on("data", (chunk: Buffer) => {
      if (context.stopping) {
        return;
      }
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitErrorEvent(context, "process/stderr", classified.message);
      }
    });

    context.child.on("error", (error) => {
      const message = normalizeCodexUserVisibleErrorMessage(
        error.message || "codex app-server process errored.",
      );
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      if (context.stopping) {
        return;
      }

      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      if (context.discovery) {
        const discoveryKey = context.session.cwd ?? "";
        if (discoveryKey) {
          this.discoverySessions.delete(discoveryKey);
        }
      } else {
        this.sessions.delete(context.session.threadId);
      }
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    if (isIgnorableCodexProcessLine(line)) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const rawRoute = this.readRouteFields(notification.params);
    this.rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const childParentTurnId = this.readChildParentTurnId(context, notification.params);
    const providerThreadId = normalizeProviderThreadId(
      this.readProviderConversationId(notification.params),
    );
    const providerParentThreadId = this.readChildParentProviderThreadId(
      context,
      notification.params,
    );
    const isChildConversation = childParentTurnId !== undefined;
    if (
      isChildConversation &&
      this.shouldSuppressChildConversationNotification(notification.method)
    ) {
      return;
    }
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerParentThreadId ? { providerParentThreadId } : {}),
      textDelta,
      payload: notification.params,
    });

    if (notification.method === "thread/started") {
      const startedThreadId = normalizeProviderThreadId(
        this.readString(this.readObject(notification.params)?.thread, "id"),
      );
      if (startedThreadId && !isChildConversation) {
        this.updateSession(context, {
          resumeCursor: { threadId: startedThreadId },
        });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      const turnId = toTurnId(this.readString(this.readObject(notification.params)?.turn, "id"));
      if (
        turnId !== undefined &&
        context.session.activeTurnId !== undefined &&
        context.reviewTurnIds.has(context.session.activeTurnId)
      ) {
        context.reviewTurnIds.add(turnId);
        console.log("[codex-review] extending tracked review turn set on turn/started", {
          threadId: context.session.threadId,
          previousTurnId: context.session.activeTurnId,
          nextTurnId: turnId,
        });
      }
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      if (rawRoute.turnId) {
        context.reviewTurnIds.delete(rawRoute.turnId);
      }
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessageRaw = this.readString(this.readObject(turn, "error"), "message");
      const errorMessage =
        errorMessageRaw !== undefined
          ? normalizeCodexUserVisibleErrorMessage(errorMessageRaw)
          : undefined;
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "turn/aborted") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      if (rawRoute.turnId) {
        context.reviewTurnIds.delete(rawRoute.turnId);
      }
      this.updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      });
      return;
    }

    if (this.isExitedReviewModeNotification(notification)) {
      if (isChildConversation) {
        return;
      }
      const item = this.readObject(notification.params, "item");
      const reviewTurnId = toTurnId(this.readString(item, "id")) ?? rawRoute.turnId;
      const reviewTurnTracked =
        reviewTurnId !== undefined ? context.reviewTurnIds.has(reviewTurnId) : false;
      const activeTurnTracked =
        context.session.activeTurnId !== undefined &&
        context.reviewTurnIds.has(context.session.activeTurnId);
      console.log("[codex-review] exitedReviewMode notification", {
        threadId: context.session.threadId,
        reviewTurnId: reviewTurnId ?? null,
        activeTurnId: context.session.activeTurnId ?? null,
        reviewTurnTracked,
        activeTurnTracked,
      });
      if (
        reviewTurnId !== undefined &&
        context.session.activeTurnId !== undefined &&
        reviewTurnId !== context.session.activeTurnId &&
        !reviewTurnTracked &&
        !activeTurnTracked
      ) {
        console.log("[codex-review] exitedReviewMode ignored due to turn mismatch", {
          threadId: context.session.threadId,
          reviewTurnId,
          activeTurnId: context.session.activeTurnId,
        });
        return;
      }
      // `review/start` can emit the final review result via `exitedReviewMode`
      // before the terminal `turn/completed` notification arrives. If that
      // completion never shows up, settle the session here instead of leaving
      // native review stuck in "running" forever.
      console.log("[codex-review] settling review from exitedReviewMode notification", {
        threadId: context.session.threadId,
        reviewTurnId: reviewTurnId ?? null,
      });
      this.settleTrackedReview(context, {
        completedTurnId: reviewTurnId,
        reason: "review exited via exitedReviewMode",
      });
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const rawMessage = this.readString(this.readObject(notification.params)?.error, "message");
      const message =
        rawMessage !== undefined ? normalizeCodexUserVisibleErrorMessage(rawMessage) : undefined;
      const willRetry = this.readBoolean(notification.params, "willRetry");
      const isNonFatalWarning =
        message !== undefined && !willRetry && isNonFatalCodexErrorMessage(message);

      if (willRetry) {
        this.updateSession(context, {
          status: "running",
        });
        return;
      }

      if (isNonFatalWarning) {
        return;
      }

      this.updateSession(context, {
        status: "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const rawRoute = this.readRouteFields(request.params);
    const childParentTurnId = this.readChildParentTurnId(context, request.params);
    const providerThreadId = normalizeProviderThreadId(
      this.readProviderConversationId(request.params),
    );
    const providerParentThreadId = this.readChildParentProviderThreadId(context, request.params);
    const requestKind = this.requestKindForMethod(request.method);
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method:
          requestKind === "command"
            ? "item/commandExecution/requestApproval"
            : requestKind === "file-read"
              ? "item/fileRead/requestApproval"
              : "item/fileChange/requestApproval",
        requestKind,
        threadId: context.session.threadId,
        ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerParentThreadId ? { providerParentThreadId } : {}),
      requestId,
      requestKind,
      payload: request.params,
    });

    if (requestKind) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      return;
    }

    this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    context.child.stdin.write(`${encoded}\n`);
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    if (context.discovery) {
      return;
    }
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    if (context.discovery) {
      return;
    }
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private settleTrackedReview(
    context: CodexSessionContext,
    input: {
      readonly completedTurnId?: TurnId;
      readonly reason: string;
    },
  ): void {
    const terminalTurnId =
      context.session.activeTurnId !== undefined &&
      context.reviewTurnIds.has(context.session.activeTurnId)
        ? context.session.activeTurnId
        : input.completedTurnId !== undefined && context.reviewTurnIds.has(input.completedTurnId)
          ? input.completedTurnId
          : context.reviewTurnIds.values().next().value;

    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });

    context.reviewTurnIds.clear();

    if (!terminalTurnId) {
      return;
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "turn/completed",
      turnId: terminalTurnId,
      message: input.reason,
      payload: {
        turn: {
          id: terminalTurnId,
          status: "completed",
        },
      },
    });
  }

  private assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  }): void {
    assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private requestKindForMethod(method: string): ProviderRequestKind | undefined {
    if (method === "item/commandExecution/requestApproval") {
      return "command";
    }

    if (method === "item/fileRead/requestApproval") {
      return "file-read";
    }

    if (method === "item/fileChange/requestApproval") {
      return "file-change";
    }

    return undefined;
  }

  private parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
    const responseRecord = this.readObject(response);
    const threadRecord = this.readObject(responseRecord, "thread");
    const threadIdRaw = this.readThreadIdFromResponse(method, responseRecord);
    const turnsRaw =
      this.readArray(threadRecord, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items,
      };
    });

    return {
      threadId: threadIdRaw,
      turns,
      cwd: this.readString(threadRecord, "cwd") ?? this.readString(responseRecord, "cwd") ?? null,
    };
  }

  private toCodexReviewTarget(target: CodexAppServerReviewTarget): Record<string, unknown> {
    switch (target.type) {
      case "uncommittedChanges":
        return {
          type: "uncommittedChanges",
        };
      case "baseBranch":
        return {
          type: "baseBranch",
          branch: target.branch,
        };
    }
  }

  private readThreadIdFromResponse(method: string, response: unknown): string {
    const responseRecord = this.readObject(response);
    const thread = this.readObject(responseRecord, "thread");
    const threadIdRaw =
      this.readString(thread, "id") ?? this.readString(responseRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    return threadIdRaw;
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ?? this.readString(this.readObject(params, "turn"), "id"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readProviderConversationId(params: unknown): string | undefined {
    return (
      this.readString(params, "threadId") ??
      this.readString(this.readObject(params, "thread"), "id") ??
      this.readString(params, "conversationId")
    );
  }

  private readChildParentTurnId(context: CodexSessionContext, params: unknown): TurnId | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverTurns.get(providerConversationId);
  }

  private readChildParentProviderThreadId(
    context: CodexSessionContext,
    params: unknown,
  ): string | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverParents.get(providerConversationId);
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: TurnId | undefined,
  ): void {
    if (!parentTurnId) {
      return;
    }
    const payload = this.readObject(params);
    const item = this.readObject(payload, "item") ?? payload;
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    if (itemType !== "collabAgentToolCall") {
      return;
    }
    const parentProviderThreadId = normalizeProviderThreadId(
      this.readProviderConversationId(params),
    );

    const receiverThreadIds =
      this.readArray(item, "receiverThreadIds")
        ?.map((value) => (typeof value === "string" ? value : null))
        .filter((value): value is string => value !== null) ?? [];
    for (const receiverThreadId of receiverThreadIds) {
      context.collabReceiverTurns.set(receiverThreadId, parentTurnId);
      if (parentProviderThreadId) {
        context.collabReceiverParents.set(receiverThreadId, parentProviderThreadId);
      }
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    // Intentionally do NOT suppress `turn/plan/updated` or `item/plan/delta` here,
    // even for child conversations. These are the events that let the active plan
    // card advance ("1 out of 5" → "2 out of 5" ...) and render streaming plan text;
    // suppressing them freezes the plan UI at its initial all-pending snapshot.
    return (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/compacted" ||
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/aborted"
    );
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }

  private isExitedReviewModeNotification(notification: JsonRpcNotification): boolean {
    if (notification.method !== "item/completed") {
      return false;
    }
    const item = this.readObject(notification.params, "item");
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    return itemType === "exitedReviewMode";
  }

  private isTurnInterruptTimeout(error: unknown): boolean {
    return error instanceof Error && error.message.includes("Timed out waiting for turn/interrupt");
  }

  private normalizeItemType(raw: unknown): string {
    if (typeof raw !== "string") return "";
    return raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[._/-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private turnHasReviewItem(
    turn: CodexThreadTurnSnapshot,
    itemType: "entered" | "exited",
  ): boolean {
    return turn.items.some((item) => {
      const record = this.readObject(item);
      const normalized = this.normalizeItemType(
        this.readString(record, "type") ?? this.readString(record, "kind"),
      );
      return itemType === "entered"
        ? normalized.includes("entered review mode")
        : normalized.includes("exited review mode");
    });
  }

  private findLatestReviewTurnId(snapshot: CodexThreadSnapshot): TurnId | undefined {
    const latestReviewTurn = [...snapshot.turns]
      .reverse()
      .find((turn) => this.turnHasReviewItem(turn, "entered"));
    return latestReviewTurn?.id;
  }

  private isExitedReviewTurn(snapshot: CodexThreadSnapshot, turnId: TurnId): boolean {
    const turn = snapshot.turns.find((entry) => entry.id === turnId);
    return turn ? this.turnHasReviewItem(turn, "exited") : false;
  }

  private parseSkillDescriptor(skill: unknown): ProviderSkillDescriptor | undefined {
    const record = this.readObject(skill);
    if (!record) return undefined;
    const name = this.readString(record, "name")?.trim();
    const path = this.readString(record, "path")?.trim();
    if (!name || !path) {
      return undefined;
    }
    const description = this.readString(record, "description")?.trim();
    const scope = this.readString(record, "scope")?.trim();
    const display = this.readObject(record, "interface");
    return {
      name,
      path,
      enabled: record.enabled !== false,
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
      ...(display
        ? {
            interface: {
              ...(this.readString(display, "displayName")
                ? { displayName: this.readString(display, "displayName") }
                : {}),
              ...(this.readString(display, "shortDescription")
                ? {
                    shortDescription: this.readString(display, "shortDescription"),
                  }
                : {}),
            },
          }
        : {}),
      ...(record.dependencies !== undefined ? { dependencies: record.dependencies } : {}),
    } satisfies ProviderSkillDescriptor;
  }

  private parseSkillsListResponse(response: unknown, cwd: string): ProviderSkillDescriptor[] {
    const responseRecord = this.readObject(response);
    const resultRecord = this.readObject(responseRecord, "result") ?? responseRecord;
    const dataItems = this.readArray(resultRecord, "data") ?? [];
    const scopedData = dataItems.find((value) => {
      const item = this.readObject(value);
      const itemCwd = this.readString(item, "cwd");
      return itemCwd === cwd;
    });
    const scopedSkills = this.readArray(this.readObject(scopedData), "skills");
    const directSkills = this.readArray(resultRecord, "skills");
    const rawSkills = scopedSkills ?? directSkills ?? [];

    const parsedSkills = rawSkills.flatMap((skill) => {
      const parsedSkill = this.parseSkillDescriptor(skill);
      return parsedSkill ? [parsedSkill] : [];
    });

    return parsedSkills.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  private parsePluginListResponse(
    response: unknown,
  ): Omit<ProviderListPluginsResult, "source" | "cached"> {
    const responseRecord = this.readObject(response);
    const resultRecord = this.readObject(responseRecord, "result") ?? responseRecord;
    const marketplaces = (this.readArray(resultRecord, "marketplaces") ?? []).flatMap(
      (marketplace) => {
        const record = this.readObject(marketplace);
        if (!record) return [];
        const name = this.readString(record, "name")?.trim();
        const path = this.readString(record, "path")?.trim();
        if (!name || !path) {
          return [];
        }
        const rawPlugins = this.readArray(record, "plugins") ?? [];
        const plugins = rawPlugins.flatMap((plugin) => {
          const parsedPlugin = this.parsePluginSummary(plugin);
          return parsedPlugin ? [parsedPlugin] : [];
        });
        const marketplaceInterface = this.readObject(record, "interface");
        const marketplaceDisplayName = this.readString(marketplaceInterface, "displayName")?.trim();
        return [
          {
            name,
            path,
            ...(marketplaceDisplayName
              ? {
                  interface: {
                    displayName: marketplaceDisplayName,
                  },
                }
              : {}),
            plugins,
          },
        ];
      },
    );
    const marketplaceLoadErrors = (this.readArray(resultRecord, "marketplaceLoadErrors") ?? [])
      .map((error) => this.readObject(error))
      .flatMap((error) => {
        if (!error) return [];
        const marketplacePath = this.readString(error, "marketplacePath")?.trim();
        const message = this.readString(error, "message")?.trim();
        if (!marketplacePath || !message) {
          return [];
        }
        return [{ marketplacePath, message }];
      });
    const featuredPluginIds = (this.readArray(resultRecord, "featuredPluginIds") ?? [])
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0);
    const remoteSyncError = this.readString(resultRecord, "remoteSyncError")?.trim() ?? null;

    return {
      marketplaces,
      marketplaceLoadErrors,
      remoteSyncError: remoteSyncError?.length ? remoteSyncError : null,
      featuredPluginIds,
    };
  }

  private parsePluginSummary(plugin: unknown): ProviderPluginDescriptor | undefined {
    const record = this.readObject(plugin);
    if (!record) return undefined;
    const id = this.readString(record, "id")?.trim();
    const name = this.readString(record, "name")?.trim();
    const source = this.readObject(record, "source");
    const sourcePath = this.readString(source, "path")?.trim();
    const installPolicy = this.readString(record, "installPolicy");
    const authPolicy = this.readString(record, "authPolicy");
    if (
      !id ||
      !name ||
      !sourcePath ||
      (installPolicy !== "NOT_AVAILABLE" &&
        installPolicy !== "AVAILABLE" &&
        installPolicy !== "INSTALLED_BY_DEFAULT") ||
      (authPolicy !== "ON_INSTALL" && authPolicy !== "ON_USE")
    ) {
      return undefined;
    }

    const pluginInterface = this.parsePluginInterface(this.readObject(record, "interface"));

    return {
      id,
      name,
      source: {
        type: "local",
        path: sourcePath,
      },
      installed: record.installed === true,
      enabled: record.enabled === true,
      installPolicy,
      authPolicy,
      ...(pluginInterface ? { interface: pluginInterface } : {}),
    } satisfies ProviderPluginDescriptor;
  }

  private parsePluginInterface(value: unknown): ProviderPluginDescriptor["interface"] | undefined {
    const record = this.readObject(value);
    if (!record) return undefined;
    const capabilities = (this.readArray(record, "capabilities") ?? [])
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    const defaultPrompt = (this.readArray(record, "defaultPrompt") ?? [])
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    const screenshots = (this.readArray(record, "screenshots") ?? [])
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);

    return {
      ...(this.readString(record, "displayName")?.trim()
        ? { displayName: this.readString(record, "displayName")?.trim() }
        : {}),
      ...(this.readString(record, "shortDescription")?.trim()
        ? {
            shortDescription: this.readString(record, "shortDescription")?.trim(),
          }
        : {}),
      ...(this.readString(record, "longDescription")?.trim()
        ? {
            longDescription: this.readString(record, "longDescription")?.trim(),
          }
        : {}),
      ...(this.readString(record, "developerName")?.trim()
        ? { developerName: this.readString(record, "developerName")?.trim() }
        : {}),
      ...(this.readString(record, "category")?.trim()
        ? { category: this.readString(record, "category")?.trim() }
        : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(this.readString(record, "websiteUrl")?.trim()
        ? { websiteUrl: this.readString(record, "websiteUrl")?.trim() }
        : {}),
      ...(this.readString(record, "privacyPolicyUrl")?.trim()
        ? {
            privacyPolicyUrl: this.readString(record, "privacyPolicyUrl")?.trim(),
          }
        : {}),
      ...(this.readString(record, "termsOfServiceUrl")?.trim()
        ? {
            termsOfServiceUrl: this.readString(record, "termsOfServiceUrl")?.trim(),
          }
        : {}),
      ...(defaultPrompt.length > 0 ? { defaultPrompt } : {}),
      ...(this.readString(record, "brandColor")?.trim()
        ? { brandColor: this.readString(record, "brandColor")?.trim() }
        : {}),
      ...(this.readString(record, "composerIcon")?.trim()
        ? { composerIcon: this.readString(record, "composerIcon")?.trim() }
        : {}),
      ...(this.readString(record, "logo")?.trim()
        ? { logo: this.readString(record, "logo")?.trim() }
        : {}),
      ...(screenshots.length > 0 ? { screenshots } : {}),
    };
  }

  private parsePluginReadResponse(response: unknown): ProviderPluginDetail {
    const responseRecord = this.readObject(response);
    const resultRecord = this.readObject(responseRecord, "result") ?? responseRecord;
    const pluginRecord = this.readObject(resultRecord, "plugin") ?? resultRecord;
    const marketplaceName = this.readString(pluginRecord, "marketplaceName")?.trim();
    const marketplacePath = this.readString(pluginRecord, "marketplacePath")?.trim();
    const summary = this.parsePluginSummary(this.readObject(pluginRecord, "summary"));
    if (!marketplaceName || !marketplacePath || !summary) {
      throw new Error("plugin/read response did not include a valid plugin payload.");
    }
    const skills = (this.readArray(pluginRecord, "skills") ?? []).flatMap((skill) => {
      const parsedSkill = this.parseSkillDescriptor(skill);
      return parsedSkill ? [parsedSkill] : [];
    });
    const apps = (this.readArray(pluginRecord, "apps") ?? []).flatMap((app) => {
      const parsedApp = this.parsePluginAppSummary(app);
      return parsedApp ? [parsedApp] : [];
    });
    const mcpServers = (this.readArray(pluginRecord, "mcpServers") ?? [])
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0);
    const description = this.readString(pluginRecord, "description")?.trim();

    return {
      marketplaceName,
      marketplacePath,
      summary,
      ...(description ? { description } : {}),
      skills,
      apps,
      mcpServers,
    };
  }

  private parsePluginAppSummary(value: unknown): ProviderPluginAppSummary | undefined {
    const record = this.readObject(value);
    if (!record) return undefined;
    const id = this.readString(record, "id")?.trim();
    const name = this.readString(record, "name")?.trim();
    if (!id || !name) {
      return undefined;
    }
    const description = this.readString(record, "description")?.trim();
    const installUrl = this.readString(record, "installUrl")?.trim();
    return {
      id,
      name,
      ...(description ? { description } : {}),
      ...(installUrl ? { installUrl } : {}),
      needsAuth: record.needsAuth === true,
    };
  }

  private parseModelListResponse(response: unknown): ProviderListModelsResult["models"] {
    const responseRecord = this.readObject(response);
    const resultRecord = this.readObject(responseRecord, "result") ?? responseRecord;
    const rawModels =
      this.readArray(resultRecord, "models") ?? this.readArray(resultRecord, "data") ?? [];

    return rawModels
      .map((value) => this.readObject(value))
      .flatMap((model) => {
        if (!model) return [];
        const slug = this.readString(model, "id") ?? this.readString(model, "slug");
        const name = this.readString(model, "name") ?? slug;
        if (!slug || !name) {
          return [];
        }
        return [{ slug, name }];
      });
  }
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function readCodexProviderOptions(input: CodexAppServerStartSessionInput): {
  readonly binaryPath?: string;
  readonly homePath?: string;
} {
  const options = input.providerOptions?.codex;
  if (!options) {
    return {};
  }
  return {
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.homePath ? { homePath: options.homePath } : {}),
  };
}

function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: buildCodexProcessEnv({
      ...(input.homePath ? { homePath: input.homePath } : {}),
    }),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

function readResumeThreadId(input: CodexAppServerStartSessionInput): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
