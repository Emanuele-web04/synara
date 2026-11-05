// FILE: BotService.ts (layer)
// Purpose: SynBot on top of Hubs. A bot is a Hub (project kind "group") plus a bot profile; this
//          layer creates and edits them through ProjectAgentService, routes delegations between
//          bot chats with server-resolved provenance, settles them from the target's turns and
//          Hub work, reports back once, posts cards, computes the merge proof and runs Stop all.
// Layer: Server domain service
// See: docs/plans/synbot.md, ../Services/BotService.ts

import * as nodePath from "node:path";

import {
  BOT_CARD_ACTIVITY_KIND,
  BOT_CARD_RESOLVED_ACTIVITY_KIND,
  BOT_CONTROL_ACTIVITY_KIND,
  BOT_DELEGATION_ACTIVITY_KIND,
  BOT_DELEGATION_MAX_DEPTH,
  BOT_DELEGATION_MESSAGE_PREFIX,
  BOT_DELEGATION_TERMINAL_STATES,
  BOT_DELEGATIONS_PER_TURN,
  BOT_REPORT_ACTIVITY_KIND,
  BOT_REPORT_MESSAGE_PREFIX,
  BotCard,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROJECT_AGENT_LIMITS,
  EventId,
  MODEL_OPTIONS_BY_PROVIDER,
  MessageId,
  ModelSelection,
  ProjectId,
  SYNBOT_MAIN_BOT_NAME,
  ThreadId,
  TurnId,
  hubWorkItem,
  type Bot,
  type BotCardResolution,
  type BotDelegation,
  type BotDelegationNotice,
  type BotDraft,
  type BotMascot,
  type BotMergeProof,
  type BotReportNotice,
  type BotScope,
  type BotSettings,
  type BotStreamEvent,
  type BotsSnapshot,
  type HubWorkRecord,
  type HubWorkSourceMessage,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type ProjectAgentConfig,
  type ProviderKind,
} from "@synara/contracts";
import { BOT_TEMPLATES, economyModelSlug, suggestBotDrafts } from "@synara/shared/bots";
import { slugifyGroupTitle } from "@synara/shared/groupSlug";
import { isOrdinaryProjectRow } from "@synara/shared/projectContainers";
import { MEMORY_AUTO_DOCUMENT_PATH } from "@synara/shared/projectAgent";
import {
  Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { stableGatewayDigest } from "../../agentGateway/creationUtils.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { prepareGroupWorkspaceRoot } from "../../groupWorkspaceScaffold.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  BotRepository,
  type BotDelegationRecord,
  type BotProfileRecord,
} from "../../persistence/Services/BotRepository.ts";
import { HubWorkRepository } from "../../persistence/Services/HubWorkRepository.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { makeHubWorkService } from "../../projectAgent/hubWorkService.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { PullRequestService } from "../../pullRequests/Services/PullRequestService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  describeBotScope,
  renderBotContextSection,
  renderDelegationMessage,
  renderDelegationReport,
  summarizeDelegationResult,
  type DelegationReportEntry,
} from "../botPrompts.ts";
import { evaluateDelegationSettlement } from "../delegationSettle.ts";
import { evaluateMergeProof } from "../mergeProof.ts";
import {
  BotService,
  BotServiceError,
  type BotCaller,
  type BotServiceShape,
} from "../Services/BotService.ts";
import { SYNBOT_UNAVAILABLE_MESSAGE, isServerSynbotEnabled } from "../synbotGate.ts";

const USER = { kind: "user" } as const;
const MAIN_ROLE = "Routes work to the right bot";
const MAIN_MASCOT: BotMascot = { shape: "synara", color: "#1a80fa" };
const RECENT_DELEGATIONS = 60;
const TASKS_PER_BOT = 40;
const RECENT_TASK_MS = 7 * 24 * 60 * 60 * 1000;
const STRONG_PROVIDER_ORDER: readonly ProviderKind[] = ["codex", "claudeAgent"];
const ACTIVE_ITEM_STATES = new Set(["queued", "starting", "working"]);
const QUEUED_ITEM_STATES = new Set(["queued", "idle"]);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const decodeCard = Schema.decodeUnknownOption(BotCard);

const isoNow = () => new Date().toISOString();
const fail = (message: string, code: BotServiceError["code"], cause?: unknown) =>
  new BotServiceError({ message, code, ...(cause !== undefined ? { cause } : {}) });
const toServiceError =
  (message: string, code: BotServiceError["code"] = "storage") =>
  (cause: unknown) =>
    cause instanceof BotServiceError
      ? cause
      : fail(
          cause &&
            typeof cause === "object" &&
            "message" in cause &&
            typeof cause.message === "string"
            ? `${message} ${cause.message}`
            : message,
          code,
          cause,
        );

const requireEnabled = Effect.suspend(() =>
  isServerSynbotEnabled()
    ? Effect.void
    : Effect.fail(fail(SYNBOT_UNAVAILABLE_MESSAGE, "unavailable")),
);

const repositoryFromPrUrl = (url: string): string | null => {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
};

const isHumanMessage = (message: OrchestrationMessage | undefined) =>
  message !== undefined &&
  message.role === "user" &&
  (message.dispatchOrigin === undefined || message.dispatchOrigin === "user");

const toDelegation = (record: BotDelegationRecord): BotDelegation => ({
  id: record.id,
  requestId: record.requestId,
  rootId: record.rootId,
  depth: record.depth,
  fromBotId: record.fromBotId,
  fromThreadId: record.fromThreadId,
  toBotId: record.toBotId,
  toThreadId: record.toThreadId,
  brief: record.brief,
  state: record.state,
  humanRooted: record.humanRooted,
  resultSummary: record.resultSummary,
  taskIds: record.taskIds,
  createdAt: record.createdAt,
  startedAt: record.startedAt,
  settledAt: record.settledAt,
});

const make = Effect.gen(function* () {
  const repository = yield* BotRepository;
  const projectAgent = yield* ProjectAgentService;
  const projectAgentRepository = yield* ProjectAgentRepository;
  const hubWorkRepository = yield* HubWorkRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurns = yield* ProjectionTurnRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverConfig = yield* ServerConfig;
  const providerHealth = yield* ProviderHealth;
  const serverSettings = yield* ServerSettingsService;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const pullRequests = yield* Effect.serviceOption(PullRequestService);
  const events = yield* PubSub.unbounded<BotStreamEvent>();
  const createLock = yield* Semaphore.make(1);
  const settleLock = yield* Semaphore.make(1);
  const hubWork = makeHubWorkService({
    repository: hubWorkRepository,
    projectAgentRepository,
    projectAgentService: projectAgent,
    snapshotQuery,
  });
  const lastPublishedStatus = new Map<ProjectId, string>();

  const publish = (event: BotStreamEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  // ── Reads ──────────────────────────────────────────────────────────

  const readInstructions = (projectId: ProjectId) =>
    projectAgentRepository.readDocumentRevision({ projectId, logicalPath: "instructions.md" }).pipe(
      Effect.map((revision) =>
        Option.isSome(revision) ? revision.value.content.replace(/^# Instructions\s*/, "") : "",
      ),
      Effect.orElseSucceed(() => ""),
    );

  const readMemoryIndex = (projectId: ProjectId) =>
    projectAgentRepository
      .readDocumentRevision({ projectId, logicalPath: MEMORY_AUTO_DOCUMENT_PATH })
      .pipe(
        Effect.map((revision) => (Option.isSome(revision) ? revision.value.content : "")),
        Effect.orElseSucceed(() => ""),
      );

  const listItems = (projectId: ProjectId) =>
    hubWorkRepository.list(projectId).pipe(Effect.orElseSucceed(() => [] as HubWorkRecord[]));

  const statusFor = (input: {
    readonly config: ProjectAgentConfig;
    readonly shell: OrchestrationThreadShell | null;
    readonly items: readonly HubWorkRecord[];
    readonly awaitingStart: boolean;
  }): Bot["status"] => {
    if (input.config.pausedAt || input.config.archivedAt) return "paused";
    const { shell } = input;
    if (
      shell?.hasPendingApprovals ||
      shell?.hasPendingUserInput ||
      input.awaitingStart ||
      input.items.some((item) => item.state === "waiting")
    )
      return "waiting";
    if (
      shell?.latestTurn?.state === "running" ||
      (shell?.session?.activeTurnId ?? null) !== null ||
      input.items.some((item) => ACTIVE_ITEM_STATES.has(item.state))
    )
      return "working";
    return "idle";
  };

  const assembleBot = (profile: BotProfileRecord) =>
    Effect.gen(function* () {
      const config = yield* projectAgentRepository
        .getConfig(profile.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectAgentConfig>()));
      if (Option.isNone(config)) return null;
      const shell = yield* snapshotQuery
        .getThreadShellById(config.value.coordinatorThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
      const items = yield* listItems(profile.projectId);
      const delegations = yield* repository
        .listActiveDelegations()
        .pipe(Effect.orElseSucceed(() => [] as BotDelegationRecord[]));
      const instructions = yield* readInstructions(profile.projectId);
      const taskModel = config.value.workerRouting?.modelSelection;
      const bot: Bot = {
        id: profile.projectId,
        kind: profile.kind,
        name: config.value.coordinatorName,
        role: profile.role,
        mascot: profile.mascot,
        instructions,
        scope: profile.scope,
        modelSelection: config.value.coordinatorModelSelection,
        ...(taskModel ? { taskModelSelection: taskModel } : {}),
        autonomy: profile.autonomy,
        pinnedSkills: profile.pinnedSkills,
        pinned: profile.pinned,
        threadId: config.value.coordinatorThreadId,
        status: statusFor({
          config: config.value,
          shell: Option.getOrNull(shell),
          items,
          awaitingStart: delegations.some(
            (delegation) =>
              delegation.toBotId === profile.projectId && delegation.state === "awaiting-start",
          ),
        }),
        revision: config.value.revision + profile.revision,
        createdAt: profile.createdAt,
        updatedAt:
          profile.updatedAt > config.value.updatedAt ? profile.updatedAt : config.value.updatedAt,
      };
      return bot;
    });

  const loadBot = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const profile = yield* repository
        .getProfile(projectId)
        .pipe(Effect.mapError(toServiceError("Could not load the bot.")));
      if (!profile) return null;
      return yield* assembleBot(profile);
    });

  const requireBot = (projectId: ProjectId) =>
    loadBot(projectId).pipe(
      Effect.flatMap((bot) =>
        bot ? Effect.succeed(bot) : Effect.fail(fail("Bot was not found.", "not-found")),
      ),
    );

  const listBots = () =>
    Effect.gen(function* () {
      const profiles = yield* repository
        .listProfiles()
        .pipe(Effect.mapError(toServiceError("Could not list bots.")));
      const bots = yield* Effect.forEach(profiles, assembleBot, { concurrency: 4 });
      return bots.filter((bot): bot is Bot => bot !== null);
    });

  const publishBot = (projectId: ProjectId) =>
    loadBot(projectId).pipe(
      Effect.flatMap((bot) => {
        if (!bot) return Effect.void;
        lastPublishedStatus.set(bot.id, `${bot.status}:${bot.revision}:${bot.updatedAt}`);
        return publish({ type: "bot-upserted", bot });
      }),
      Effect.catch(() => Effect.void),
    );

  /** Republish only when the derived status changed (cheap enough to call on every event). */
  const refreshBotStatus = (projectId: ProjectId) =>
    loadBot(projectId).pipe(
      Effect.flatMap((bot) => {
        if (!bot) return Effect.void;
        const signature = `${bot.status}:${bot.revision}:${bot.updatedAt}`;
        if (lastPublishedStatus.get(bot.id) === signature) return Effect.void;
        lastPublishedStatus.set(bot.id, signature);
        return publish({ type: "bot-upserted", bot });
      }),
      Effect.catch(() => Effect.void),
    );

  const publishDelegation = (record: BotDelegationRecord) =>
    publish({ type: "delegation-upserted", delegation: toDelegation(record) }).pipe(
      Effect.andThen(refreshBotStatus(record.toBotId)),
      Effect.andThen(refreshBotStatus(record.fromBotId)),
    );

  const getSettings = () =>
    repository.getSettings().pipe(
      Effect.map((row) => row.settings),
      Effect.mapError(toServiceError("Could not load SynBot settings.")),
    );

  // ── Thread writes ──────────────────────────────────────────────────

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly id: string;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly tone?: "info" | "approval" | "error";
  }) => {
    const createdAt = isoNow();
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`${input.id}:append`),
        threadId: input.threadId,
        activity: {
          id: EventId.makeUnsafe(input.id),
          tone: input.tone ?? "info",
          kind: input.kind,
          summary: input.summary,
          payload: JSON.parse(JSON.stringify(input.payload)),
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.asVoid,
        // Deterministic ids make a repeated append a no-op instead of a failure.
        Effect.catchTag("OrchestrationCommandIdentityCollisionError", () => Effect.void),
        Effect.mapError(toServiceError("Could not write to the bot thread.")),
      );
  };

  const startTurn = (input: {
    readonly threadId: ThreadId;
    readonly commandId: string;
    readonly messageId: string;
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      const shell = yield* snapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(toServiceError("Could not load the bot thread.")));
      if (Option.isNone(shell))
        return yield* Effect.fail(fail("The bot thread no longer exists.", "not-found"));
      const command: OrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: input.threadId,
        message: {
          messageId: MessageId.makeUnsafe(input.messageId),
          role: "user",
          text: input.text,
          attachments: [],
        },
        dispatchMode: "queue",
        dispatchOrigin: "agent",
        runtimeMode: shell.value.runtimeMode,
        interactionMode: shell.value.interactionMode,
        createdAt: isoNow(),
      };
      yield* orchestrationEngine.dispatch(command).pipe(
        Effect.asVoid,
        Effect.catchTag("OrchestrationCommandIdentityCollisionError", () => Effect.void),
        Effect.mapError(toServiceError("Could not start the bot's turn.")),
      );
    });

  const interruptThread = (threadId: ThreadId, reason: string) =>
    orchestrationEngine
      .dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe(`synbot:${reason}:${threadId}:${Date.now()}`),
        threadId,
        requestedBy: "user",
        createdAt: isoNow(),
      } as OrchestrationCommand)
      .pipe(Effect.asVoid, Effect.mapError(toServiceError("Could not stop the thread.")));

  const postCard = (input: {
    readonly threadId: ThreadId;
    readonly card: BotCard;
    readonly summary: string;
  }) =>
    appendActivity({
      threadId: input.threadId,
      id: input.card.id,
      kind: BOT_CARD_ACTIVITY_KIND,
      summary: input.summary,
      payload: input.card,
      tone: "approval",
    });

  // ── Projects and folders ───────────────────────────────────────────

  const shellSnapshot = () =>
    snapshotQuery
      .getShellSnapshot()
      .pipe(Effect.mapError(toServiceError("Could not load projects.")));

  const isOrdinary = (project: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly kind?: string | undefined;
  }) =>
    isOrdinaryProjectRow({
      projectTitle: project.title,
      projectWorkspaceRoot: project.workspaceRoot,
      projectKind: project.kind as never,
      paths: { homeDir: serverConfig.homeDir, chatWorkspaceRoot: serverConfig.chatWorkspaceRoot },
    });

  const ordinaryProjectIds = () =>
    shellSnapshot().pipe(
      Effect.map((snapshot) => snapshot.projects.filter(isOrdinary).map((project) => project.id)),
    );

  const uniqueBotFolder = (name: string) =>
    Effect.gen(function* () {
      const root = serverConfig.groupsWorkspaceRoot;
      const snapshot = yield* shellSnapshot();
      const taken = new Set(
        snapshot.projects
          .filter((project) => project.kind === "group")
          .map((project) => nodePath.basename(project.workspaceRoot).toLowerCase()),
      );
      const existing = yield* fileSystem
        .readDirectory(root)
        .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
      for (const entry of existing) taken.add(entry.toLowerCase());
      const base = `bot-${slugifyGroupTitle(name)}`;
      for (let suffix = 1; ; suffix += 1) {
        const slug = suffix === 1 ? base : `${base}-${suffix}`;
        if (!taken.has(slug.toLowerCase())) return nodePath.join(root, slug);
      }
    });

  /** Keeps the Hub's linked projects equal to the bot's scope ("all": every ordinary project). */
  const syncScopeLinks = (projectId: ProjectId, scope: BotScope) =>
    Effect.gen(function* () {
      const wanted = new Set<ProjectId>(
        scope.projects === "all" ? yield* ordinaryProjectIds() : scope.projects,
      );
      const current = new Set(
        yield* projectAgentRepository
          .listLinkedProjectIds(projectId)
          .pipe(Effect.orElseSucceed(() => [] as ProjectId[])),
      );
      for (const linkedProjectId of wanted) {
        if (current.has(linkedProjectId) || linkedProjectId === projectId) continue;
        yield* projectAgent
          .linkProject(
            {
              requestId: `synbot-link:${projectId}:${linkedProjectId}`,
              projectId,
              linkedProjectId,
            },
            USER,
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logDebug("SynBot could not link a project to a bot", {
                projectId,
                linkedProjectId,
                error: error.message,
              }),
            ),
          );
      }
      for (const linkedProjectId of current) {
        if (wanted.has(linkedProjectId)) continue;
        yield* projectAgent
          .unlinkProject(
            {
              requestId: `synbot-unlink:${projectId}:${linkedProjectId}:${Date.now()}`,
              projectId,
              linkedProjectId,
            },
            USER,
          )
          .pipe(Effect.catch(() => Effect.void));
      }
    });

  // ── Engines ────────────────────────────────────────────────────────

  const availableProviders = () =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const statuses = yield* providerHealth.getStatuses;
      return STRONG_PROVIDER_ORDER.filter((provider) => {
        const enabled = settings?.providers?.[provider]?.enabled ?? true;
        const status = statuses.find((entry) => entry.provider === provider);
        return enabled && (status === undefined || status.available);
      });
    });

  const defaultModel = (kind: "strong" | "economy", near?: ModelSelection) =>
    Effect.gen(function* () {
      const provider =
        (near?.provider as ProviderKind | undefined) ?? (yield* availableProviders())[0] ?? "codex";
      const slugs = (MODEL_OPTIONS_BY_PROVIDER[provider] ?? []).map(
        (model) => model.slug as string,
      );
      const economy = kind === "economy" ? economyModelSlug(provider, slugs) : null;
      const model =
        economy ??
        (near?.provider === provider ? near.model : undefined) ??
        DEFAULT_MODEL_BY_PROVIDER[provider as keyof typeof DEFAULT_MODEL_BY_PROVIDER] ??
        slugs[0];
      return decodeModelSelection({ provider, model });
    });

  // ── Create / update / remove ───────────────────────────────────────

  const createBot = (spec: {
    readonly requestId: string;
    readonly kind: "main" | "bot";
    readonly name: string;
    readonly role: string;
    readonly mascot: BotMascot;
    readonly instructions: string;
    readonly scope: BotScope;
    readonly modelSelection: ModelSelection;
    readonly taskModelSelection?: ModelSelection | undefined;
    readonly autonomy: "auto" | "ask";
    readonly pinnedSkills: BotProfileRecord["pinnedSkills"];
    readonly pinned: boolean;
  }) =>
    createLock.withPermits(1)(
      Effect.gen(function* () {
        // The request id fixes the project id, so a retried create finds the first attempt.
        const projectId = ProjectId.makeUnsafe(
          `bot-${stableGatewayDigest({ requestId: spec.requestId }, 24)}`,
        );
        const existingProfile = yield* repository
          .getProfile(projectId)
          .pipe(Effect.mapError(toServiceError("Could not load the bot.")));
        if (existingProfile) return yield* requireBot(projectId);
        if (spec.kind === "main") {
          const main = yield* repository
            .getMainProfile()
            .pipe(Effect.mapError(toServiceError("Could not load SynBot.")));
          if (main) return yield* requireBot(main.projectId);
        }
        const project = yield* snapshotQuery
          .getProjectShellById(projectId)
          .pipe(Effect.mapError(toServiceError("Could not load the bot's project.")));
        if (Option.isNone(project)) {
          const workspaceRoot = yield* uniqueBotFolder(spec.name);
          yield* prepareGroupWorkspaceRoot(workspaceRoot).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, pathService),
            Effect.mapError(toServiceError("Could not create the bot's folder.")),
          );
          yield* orchestrationEngine
            .dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe(`synbot-create:${projectId}`),
              projectId,
              kind: "group",
              title: spec.name,
              workspaceRoot,
              createWorkspaceRootIfMissing: true,
              defaultModelSelection: null,
              isPinned: false,
              createdAt: isoNow(),
            } as OrchestrationCommand)
            .pipe(
              Effect.catchTag("OrchestrationCommandIdentityCollisionError", () => Effect.void),
              Effect.mapError(toServiceError("Could not create the bot.")),
            );
        }
        yield* projectAgent
          .configure(
            {
              requestId: `synbot-configure:${projectId}`,
              projectId,
              coordinatorName: spec.name,
              coordinatorModelSelection: spec.modelSelection,
              // Tasks edit in their own worktree; the chat itself stays approval-required.
              workerRouting: {
                ...(spec.taskModelSelection ? { modelSelection: spec.taskModelSelection } : {}),
                runtimeMode: "full-access",
              },
              limits: { ...DEFAULT_PROJECT_AGENT_LIMITS, maxConcurrentWorkers: 1 },
              captureEnabled: true,
              ...(spec.instructions.trim()
                ? { importedInstructions: `# Instructions\n\n${spec.instructions.trim()}\n` }
                : {}),
              coordinatorColor: spec.mascot.color,
              autoMemoryEnabled: true,
              greeting:
                spec.kind === "main"
                  ? `I'm ${spec.name}. Ask me for anything: I answer quick questions myself, hand work to the bot that fits, and give you one short recap when it's done. Tasks run in their own worktree.`
                  : `I'm ${spec.name}${spec.role ? `, ${spec.role}` : ""}. Ask me for anything in my area: I answer directly or start tasks in their own worktree, and report back when they finish.`,
            },
            USER,
          )
          .pipe(Effect.mapError(toServiceError("Could not set up the bot.", "invalid")));
        const now = isoNow();
        yield* repository
          .upsertProfile({
            projectId,
            kind: spec.kind,
            role: spec.role,
            mascot: spec.mascot,
            scope: spec.scope,
            autonomy: spec.autonomy,
            pinnedSkills: spec.pinnedSkills,
            pinned: spec.pinned,
            revision: 0,
            createdAt: now,
            updatedAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Could not save the bot.")));
        yield* syncScopeLinks(projectId, spec.scope);
        yield* publishBot(projectId);
        return yield* requireBot(projectId);
      }),
    );

  const freshStart: BotServiceShape["freshStart"] = () =>
    Effect.gen(function* () {
      if (!isServerSynbotEnabled()) return;
      const row = yield* repository.getSettings();
      if (row.freshStartAt) return;
      const configs = yield* projectAgentRepository.listConfigs();
      const profiles = new Set(
        (yield* repository.listProfiles()).map((profile) => profile.projectId),
      );
      for (const { projectId } of configs) {
        if (profiles.has(projectId)) continue;
        const config = yield* projectAgentRepository.getConfig(projectId);
        if (Option.isNone(config) || config.value.pausedAt || config.value.archivedAt) continue;
        yield* projectAgent
          .pauseGroup({ requestId: `synbot-fresh-start:${projectId}`, projectId }, USER)
          .pipe(Effect.catch(() => Effect.void));
      }
      yield* repository.markFreshStart(isoNow());
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("SynBot fresh start failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const ensureMain: BotServiceShape["ensureMain"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      yield* freshStart();
      const main = yield* repository
        .getMainProfile()
        .pipe(Effect.mapError(toServiceError("Could not load SynBot.")));
      if (main) {
        const bot = yield* loadBot(main.projectId);
        if (bot) return bot;
      }
      return yield* createBot({
        requestId: "synbot-main",
        kind: "main",
        name: SYNBOT_MAIN_BOT_NAME,
        role: MAIN_ROLE,
        mascot: MAIN_MASCOT,
        instructions: "",
        scope: { projects: "all", paths: [] },
        modelSelection: input.modelSelection ?? (yield* defaultModel("strong")),
        autonomy: "auto",
        pinnedSkills: [],
        pinned: true,
      });
    });

  const create: BotServiceShape["create"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      return yield* createBot({
        requestId: input.requestId,
        kind: "bot",
        name: input.name,
        role: input.role,
        mascot:
          input.mascot.shape === "synara" ? { ...input.mascot, shape: "circle" } : input.mascot,
        instructions: input.instructions ?? "",
        scope: input.scope,
        modelSelection: input.modelSelection,
        taskModelSelection: input.taskModelSelection,
        autonomy: input.autonomy ?? "auto",
        pinnedSkills: input.pinnedSkills ?? [],
        pinned: input.pinned ?? false,
      });
    });

  const update: BotServiceShape["update"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const profile = yield* repository
        .getProfile(input.id)
        .pipe(Effect.mapError(toServiceError("Could not load the bot.")));
      if (!profile) return yield* Effect.fail(fail("Bot was not found.", "not-found"));
      const config = yield* projectAgentRepository
        .getConfig(input.id)
        .pipe(Effect.mapError(toServiceError("Could not load the bot.")));
      if (Option.isNone(config)) return yield* Effect.fail(fail("Bot was not found.", "not-found"));
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== config.value.revision + profile.revision
      ) {
        return yield* Effect.fail(fail("The bot changed. Reload and retry.", "conflict"));
      }
      if (
        profile.kind === "main" &&
        input.name !== undefined &&
        input.name !== config.value.coordinatorName
      ) {
        return yield* Effect.fail(fail("SynBot cannot be renamed.", "forbidden"));
      }
      const mascot =
        input.mascot === undefined
          ? profile.mascot
          : profile.kind === "main"
            ? { shape: "synara" as const, color: input.mascot.color }
            : input.mascot.shape === "synara"
              ? { ...input.mascot, shape: "circle" as const }
              : input.mascot;
      const engineChanged =
        input.name !== undefined ||
        input.modelSelection !== undefined ||
        input.taskModelSelection !== undefined ||
        input.mascot !== undefined;
      if (engineChanged) {
        const routing = config.value.workerRouting ?? {};
        const { modelSelection: _previousTaskModel, ...routingRest } = routing;
        const taskModel =
          input.taskModelSelection === undefined
            ? routing.modelSelection
            : input.taskModelSelection === null
              ? undefined
              : input.taskModelSelection;
        yield* projectAgent
          .configure(
            {
              requestId: `synbot-update:${input.id}:${config.value.revision}`,
              projectId: input.id,
              expectedRevision: config.value.revision,
              coordinatorName: input.name ?? config.value.coordinatorName,
              coordinatorModelSelection:
                input.modelSelection ?? config.value.coordinatorModelSelection,
              workerRouting: {
                ...routingRest,
                ...(taskModel ? { modelSelection: taskModel } : {}),
                runtimeMode: routing.runtimeMode ?? "full-access",
              },
              limits: config.value.limits,
              captureEnabled: config.value.captureEnabled,
              coordinatorColor: mascot.color,
            },
            USER,
          )
          .pipe(Effect.mapError(toServiceError("Could not update the bot.", "invalid")));
      }
      if (input.instructions !== undefined) {
        const head = yield* projectAgentRepository
          .getDocumentHead(input.id, "instructions.md")
          .pipe(Effect.orElseSucceed(() => Option.none()));
        yield* projectAgent
          .writeDocument(
            {
              requestId: `synbot-instructions:${input.id}:${Date.now()}`,
              projectId: input.id,
              logicalPath: "instructions.md",
              ...(Option.isSome(head) ? { expectedRevision: head.value.revision } : {}),
              content: `# Instructions\n\n${input.instructions.trim()}\n`,
              sources: [],
              importExternal: false,
            },
            USER,
          )
          .pipe(Effect.mapError(toServiceError("Could not save the instructions.", "invalid")));
      }
      const scope = profile.kind === "main" ? profile.scope : (input.scope ?? profile.scope);
      yield* repository
        .upsertProfile({
          ...profile,
          role: input.role ?? profile.role,
          mascot,
          scope,
          autonomy: input.autonomy ?? profile.autonomy,
          pinnedSkills: input.pinnedSkills ?? profile.pinnedSkills,
          pinned: input.pinned ?? profile.pinned,
          revision: profile.revision + 1,
          updatedAt: isoNow(),
        })
        .pipe(Effect.mapError(toServiceError("Could not save the bot.")));
      if (input.scope !== undefined && profile.kind !== "main")
        yield* syncScopeLinks(input.id, scope);
      yield* publishBot(input.id);
      return yield* requireBot(input.id);
    });

  const remove: BotServiceShape["remove"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const profile = yield* repository
        .getProfile(input.id)
        .pipe(Effect.mapError(toServiceError("Could not load the bot.")));
      if (!profile) return;
      if (profile.kind === "main")
        return yield* Effect.fail(fail("SynBot cannot be removed.", "forbidden"));
      const project = yield* snapshotQuery
        .getProjectShellById(input.id)
        .pipe(Effect.mapError(toServiceError("Could not load the bot.")));
      if (Option.isSome(project)) {
        yield* projectAgent
          .deleteGroup(
            {
              requestId: `synbot-remove:${input.id}`,
              projectId: input.id,
              confirmName: project.value.title,
            },
            USER,
          )
          .pipe(Effect.mapError(toServiceError("Could not remove the bot.")));
      }
      yield* repository
        .deleteProfile(input.id)
        .pipe(Effect.mapError(toServiceError("Could not remove the bot.")));
      lastPublishedStatus.delete(input.id);
      yield* publish({ type: "bot-removed", botId: input.id });
    });

  const updateSettings: BotServiceShape["updateSettings"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const current = yield* getSettings();
      const next: BotSettings = {
        recapMode: input.recapMode ?? current.recapMode,
        controlWithoutAsking: input.controlWithoutAsking ?? current.controlWithoutAsking,
        mergeProofEnabled: input.mergeProofEnabled ?? current.mergeProofEnabled,
        maxParallelTasks: input.maxParallelTasks ?? current.maxParallelTasks,
      };
      yield* repository
        .putSettings(next)
        .pipe(Effect.mapError(toServiceError("Could not save SynBot settings.")));
      yield* publish({ type: "settings-updated", settings: next });
      return next;
    });

  const snapshot: BotServiceShape["snapshot"] = () =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const bots = yield* listBots();
      const settings = yield* getSettings();
      const delegations = yield* repository
        .listRecentDelegations(RECENT_DELEGATIONS)
        .pipe(Effect.mapError(toServiceError("Could not load delegations.")));
      const cutoff = Date.now() - RECENT_TASK_MS;
      const tasks: Array<BotsSnapshot["tasks"][number]> = [];
      for (const bot of bots) {
        const items = (yield* listItems(bot.id))
          .filter(
            (item) =>
              !["completed", "failed", "cancelled"].includes(item.state) ||
              Date.parse(item.updatedAt) >= cutoff,
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, TASKS_PER_BOT);
        for (const item of items) tasks.push({ botId: bot.id, task: hubWorkItem(item) });
      }
      return { bots, settings, delegations: delegations.map(toDelegation), tasks };
    });

  // ── Callers and delegation ─────────────────────────────────────────

  const threadMessages = (threadId: ThreadId) =>
    snapshotQuery.getThreadDetailWithoutActivitiesById(threadId).pipe(
      Effect.map((detail) => (Option.isSome(detail) ? detail.value.messages : [])),
      Effect.orElseSucceed(() => [] as readonly OrchestrationMessage[]),
    );

  /** The delegation context of a turn, from the message that started it. */
  const callerFromMessage = (bot: Bot, turnId: string | null, pendingMessageId: string | null) =>
    Effect.gen(function* () {
      const base: BotCaller = {
        bot,
        turnId,
        delegationId: null,
        chain: [bot.id],
        depth: 0,
        humanRooted: false,
        sourceMessages: [],
      };
      if (!pendingMessageId) return base;
      if (pendingMessageId.startsWith(BOT_DELEGATION_MESSAGE_PREFIX)) {
        const delegation = yield* repository
          .getDelegationByMessage(pendingMessageId)
          .pipe(Effect.orElseSucceed(() => null));
        if (delegation) {
          return {
            ...base,
            delegationId: delegation.id,
            chain: delegation.chain,
            depth: delegation.depth,
            humanRooted: delegation.humanRooted,
            sourceMessages: delegation.sourceMessages,
          };
        }
        return base;
      }
      if (pendingMessageId.startsWith(BOT_REPORT_MESSAGE_PREFIX)) {
        const reported = yield* repository
          .listDelegationsByReportMessage(pendingMessageId)
          .pipe(Effect.orElseSucceed(() => [] as BotDelegationRecord[]));
        const sources = new Map<string, HubWorkSourceMessage>();
        for (const record of reported)
          for (const source of record.sourceMessages) sources.set(source.messageId, source);
        const parent = reported[0];
        return {
          ...base,
          chain: parent ? parent.chain.slice(0, -1) : base.chain,
          depth: parent ? Math.max(0, parent.depth - 1) : 0,
          sourceMessages: [...sources.values()],
        };
      }
      const messages = yield* threadMessages(bot.threadId);
      const message = messages.find((entry) => entry.id === pendingMessageId);
      if (message && isHumanMessage(message)) {
        return {
          ...base,
          humanRooted: true,
          sourceMessages: [
            {
              threadId: bot.threadId,
              messageId: message.id,
              turnId: message.turnId,
              text: message.text,
              attachments: [...(message.attachments ?? [])],
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            },
          ],
        };
      }
      // A Hub wake while this bot works on a delegation keeps that delegation's provenance.
      if (message?.dispatchOrigin === "automation") {
        const open = (yield* repository
          .listActiveDelegations()
          .pipe(Effect.orElseSucceed(() => [] as BotDelegationRecord[]))).find(
          (record) => record.toBotId === bot.id && record.settledAt === null,
        );
        if (open) {
          return {
            ...base,
            delegationId: open.id,
            chain: open.chain,
            depth: open.depth,
            sourceMessages: open.sourceMessages,
          };
        }
      }
      return base;
    });

  const botForThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (!isServerSynbotEnabled()) return null;
      const config = yield* projectAgentRepository
        .getConfigByCoordinatorThread(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectAgentConfig>()));
      if (Option.isNone(config)) return null;
      return yield* loadBot(config.value.projectId).pipe(Effect.orElseSucceed(() => null));
    });

  const resolveCaller: BotServiceShape["resolveCaller"] = (input) =>
    Effect.gen(function* () {
      const bot = yield* botForThread(input.threadId);
      if (!bot) return null;
      if (input.turnId === null) return yield* callerFromMessage(bot, null, null);
      const turn = yield* projectionTurns
        .getByTurnId({ threadId: input.threadId, turnId: TurnId.makeUnsafe(input.turnId) })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return yield* callerFromMessage(
        bot,
        input.turnId,
        Option.isSome(turn) ? turn.value.pendingMessageId : null,
      );
    });

  const formatContextForTurn: BotServiceShape["formatContextForTurn"] = (input) =>
    Effect.gen(function* () {
      const bot = yield* botForThread(input.threadId);
      if (!bot) return "";
      const caller = yield* callerFromMessage(bot, null, input.messageId);
      const bots = yield* listBots();
      const settings = yield* getSettings();
      const scopeProjectNames =
        bot.scope.projects === "all"
          ? []
          : (yield* snapshotQuery
              .getProjectShellsByIds(bot.scope.projects)
              .pipe(Effect.orElseSucceed(() => []))).map((project) => project.title);
      const names = new Map(bots.map((entry) => [entry.id, entry.name]));
      const roster = yield* Effect.forEach(bots, (entry) =>
        Effect.gen(function* () {
          const scopeLabel =
            entry.scope.projects === "all"
              ? describeBotScope(entry.scope, [])
              : describeBotScope(
                  entry.scope,
                  (yield* snapshotQuery
                    .getProjectShellsByIds(entry.scope.projects)
                    .pipe(Effect.orElseSucceed(() => []))).map((project) => project.title),
                );
          return {
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            role: entry.role,
            scopeLabel,
            busy: entry.status === "working",
            // SynBot reads every bot's memory to route well; bots see each other's roles only.
            memoryIndex:
              bot.kind === "main" && entry.id !== bot.id ? yield* readMemoryIndex(entry.id) : "",
          };
        }),
      );
      return renderBotContextSection({
        bot: {
          id: bot.id,
          kind: bot.kind,
          name: bot.name,
          role: bot.role,
          scope: bot.scope,
          scopeProjectNames,
          pinnedSkills: bot.pinnedSkills,
        },
        roster,
        delegation: {
          chainNames: caller.chain.slice(0, -1).map((id) => names.get(id) ?? "a removed bot"),
          depth: caller.depth,
          humanRooted: caller.humanRooted,
        },
        controlWithoutAsking: settings.controlWithoutAsking,
      });
    }).pipe(Effect.orElseSucceed(() => ""));

  const roster: BotServiceShape["roster"] = () => listBots();

  const dispatchDelegation = (record: BotDelegationRecord) =>
    Effect.gen(function* () {
      const from = yield* loadBot(record.fromBotId);
      yield* startTurn({
        threadId: record.toThreadId,
        commandId: `${record.messageId}:start`,
        messageId: record.messageId,
        text: renderDelegationMessage({
          delegationId: record.id,
          fromName: from?.name ?? "another bot",
          brief: record.brief,
          sourceMessages: record.sourceMessages,
        }),
      });
      const next: BotDelegationRecord = {
        ...record,
        state: "sent",
        startedAt: isoNow(),
        updatedAt: isoNow(),
      };
      yield* repository
        .saveDelegation(next)
        .pipe(Effect.mapError(toServiceError("Could not save the delegation.")));
      yield* publishDelegation(next);
      return next;
    });

  const delegate: BotServiceShape["delegate"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const { caller } = input;
      const target = yield* requireBot(input.targetBotId);
      if (target.id === caller.bot.id) {
        return yield* Effect.fail(
          fail("A bot cannot delegate to itself; start a task instead.", "invalid"),
        );
      }
      if (target.status === "paused") {
        return yield* Effect.fail(fail(`${target.name} is paused.`, "invalid"));
      }
      if (caller.chain.includes(target.id)) {
        return yield* Effect.fail(
          fail(
            `${target.name} is already in this delegation chain; finish the work here instead.`,
            "invalid",
          ),
        );
      }
      const depth = caller.depth + 1;
      if (depth > BOT_DELEGATION_MAX_DEPTH) {
        return yield* Effect.fail(
          fail(
            `Delegation chains stop at ${BOT_DELEGATION_MAX_DEPTH} bots; do this part yourself.`,
            "limit",
          ),
        );
      }
      if (caller.sourceMessages.length === 0) {
        return yield* Effect.fail(
          fail(
            "No user request stands behind this turn; ask the user before delegating.",
            "forbidden",
          ),
        );
      }
      const id = `d${stableGatewayDigest(
        {
          from: caller.bot.threadId,
          turn: caller.turnId,
          requestId: input.requestId,
          to: target.id,
        },
        24,
      )}`;
      const existing = yield* repository
        .getDelegation(id)
        .pipe(Effect.mapError(toServiceError("Could not load the delegation.")));
      if (existing) return toDelegation(existing);
      const siblings = yield* repository
        .listDelegationsByRequesterTurn({
          fromThreadId: caller.bot.threadId,
          fromTurnId: caller.turnId,
        })
        .pipe(Effect.mapError(toServiceError("Could not load delegations.")));
      if (caller.turnId !== null && siblings.length >= BOT_DELEGATIONS_PER_TURN) {
        return yield* Effect.fail(
          fail(`At most ${BOT_DELEGATIONS_PER_TURN} delegations per turn.`, "limit"),
        );
      }
      const now = isoNow();
      const parentRoot = caller.delegationId
        ? (yield* repository
            .getDelegation(caller.delegationId)
            .pipe(Effect.orElseSucceed(() => null)))?.rootId
        : undefined;
      const record: BotDelegationRecord = {
        id,
        requestId: `${caller.bot.threadId}:${caller.turnId ?? "none"}`,
        rootId: parentRoot ?? id,
        depth,
        chain: [...caller.chain, target.id],
        fromBotId: caller.bot.id,
        fromThreadId: caller.bot.threadId,
        fromTurnId: caller.turnId,
        toBotId: target.id,
        toThreadId: target.threadId,
        messageId: `${BOT_DELEGATION_MESSAGE_PREFIX}${id}`,
        brief: input.brief.trim().slice(0, 8_000),
        sourceMessages: caller.sourceMessages,
        humanRooted: caller.humanRooted,
        state: target.autonomy === "ask" ? "awaiting-start" : "sent",
        resultSummary: null,
        taskIds: [],
        reportedAt: null,
        reportMessageId: null,
        createdAt: now,
        startedAt: null,
        settledAt: null,
        updatedAt: now,
      };
      const inserted = yield* repository
        .insertDelegation(record)
        .pipe(Effect.mapError(toServiceError("Could not save the delegation.")));
      if (!inserted.inserted) return toDelegation(inserted.record);
      const notice: BotDelegationNotice = {
        delegationId: id,
        fromBotId: caller.bot.id,
        toBotId: target.id,
        brief: record.brief,
        createdAt: now,
      };
      yield* appendActivity({
        threadId: caller.bot.threadId,
        id: `synbot:delegation:${id}:from`,
        kind: BOT_DELEGATION_ACTIVITY_KIND,
        summary: `${target.name} is on it`,
        payload: notice,
      });
      yield* appendActivity({
        threadId: target.threadId,
        id: `synbot:delegation:${id}:to`,
        kind: BOT_DELEGATION_ACTIVITY_KIND,
        summary: `Message from ${caller.bot.name}`,
        payload: notice,
      });
      if (record.state === "awaiting-start") {
        yield* postCard({
          threadId: target.threadId,
          summary: `${caller.bot.name} asks ${target.name} to start`,
          card: {
            id: `synbot:card:start:${id}`,
            kind: "delegation-start",
            botId: target.id,
            title: `${caller.bot.name} asks ${target.name}: ${record.brief.slice(0, 300)}`,
            options: [
              { id: "start", label: "Start", tone: "primary" },
              { id: "not-now", label: "Not now", tone: "dismiss" },
            ],
            delegationId: id,
            createdAt: now,
          },
        });
        yield* publishDelegation(record);
        return toDelegation(record);
      }
      return toDelegation(yield* dispatchDelegation(record));
    });

  const listDelegationsFor: BotServiceShape["listDelegationsFor"] = (caller) =>
    repository.listRecentDelegations(RECENT_DELEGATIONS).pipe(
      Effect.map((records) =>
        records
          .filter(
            (record) => record.fromBotId === caller.bot.id || record.toBotId === caller.bot.id,
          )
          .map(toDelegation),
      ),
      Effect.mapError(toServiceError("Could not load delegations.")),
    );

  // ── Settlement and reports ─────────────────────────────────────────

  const workerShell = (item: HubWorkRecord) =>
    item.workerThreadId
      ? snapshotQuery.getThreadShellById(item.workerThreadId).pipe(
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        )
      : Effect.succeed(null);

  /** What a task did: its filed result, else its worker's last reply. */
  const taskOutcome = (item: HubWorkRecord) =>
    Effect.gen(function* () {
      if (item.resultSummary?.trim()) return item.resultSummary.trim();
      if (!item.workerThreadId) return null;
      const reply = (yield* threadMessages(item.workerThreadId)).findLast(
        (message) => message.role === "assistant" && message.text.trim().length > 0,
      );
      return reply ? reply.text.trim().slice(0, 1_200) : null;
    });

  const reportFor = (records: readonly BotDelegationRecord[]) =>
    Effect.gen(function* () {
      const entries: DelegationReportEntry[] = [];
      for (const record of records) {
        const bot = yield* loadBot(record.toBotId).pipe(Effect.orElseSucceed(() => null));
        const tasks = [];
        for (const taskId of record.taskIds) {
          const item = yield* hubWorkRepository.get(taskId).pipe(Effect.orElseSucceed(() => null));
          if (!item) continue;
          const shell = yield* workerShell(item);
          tasks.push({
            title: item.title,
            // An idle worker finished its turn; the Hub has not marked it accepted yet.
            state: item.state === "idle" ? "finished" : item.state,
            resultSummary: yield* taskOutcome(item),
            prUrl: shell?.lastKnownPr?.url ?? null,
            branch: shell?.branch ?? null,
            threadId: item.workerThreadId,
          });
        }
        entries.push({
          delegationId: record.id,
          botName: bot?.name ?? "A removed bot",
          state: record.state,
          resultSummary: record.resultSummary,
          tasks,
        });
      }
      return entries;
    });

  const deliverReport = (records: readonly BotDelegationRecord[]) =>
    Effect.gen(function* () {
      if (records.length === 0) return;
      const ids = records.map((record) => record.id).toSorted();
      const messageId = `${BOT_REPORT_MESSAGE_PREFIX}${stableGatewayDigest({ ids }, 24)}`;
      const requester = records[0]!;
      const now = isoNow();
      for (const record of records) {
        yield* repository.saveDelegation({
          ...record,
          reportedAt: now,
          reportMessageId: messageId,
          updatedAt: now,
        });
      }
      const fromBot = yield* loadBot(requester.fromBotId).pipe(Effect.orElseSucceed(() => null));
      const notice: BotReportNotice = {
        messageId,
        delegationIds: ids,
        entries: records.map((record) => ({
          delegationId: record.id,
          toBotId: record.toBotId,
          state: record.state,
          resultSummary: record.resultSummary,
        })),
        createdAt: now,
      };
      yield* appendActivity({
        threadId: requester.fromThreadId,
        id: `${messageId}:card`,
        kind: BOT_REPORT_ACTIVITY_KIND,
        summary:
          records.length === 1
            ? "Delegated work finished"
            : `${records.length} delegations finished`,
        payload: notice,
      }).pipe(Effect.catch(() => Effect.void));
      // A paused or removed requester keeps the report card but is not woken.
      if (!fromBot || fromBot.status === "paused") return;
      const entries = yield* reportFor(records);
      yield* startTurn({
        threadId: requester.fromThreadId,
        commandId: `${messageId}:start`,
        messageId,
        text: renderDelegationReport(entries),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("SynBot could not wake the requester with a report", {
            error: error.message,
          }),
        ),
      );
    });

  const settleOne = (record: BotDelegationRecord, nowMs: number) =>
    Effect.gen(function* () {
      if (record.state === "awaiting-start" || BOT_DELEGATION_TERMINAL_STATES.has(record.state))
        return record;
      const shell = yield* snapshotQuery
        .getThreadShellById(record.toThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
      if (Option.isNone(shell)) {
        const failed: BotDelegationRecord = {
          ...record,
          state: "failed",
          resultSummary: "The bot's thread no longer exists.",
          settledAt: isoNow(),
          updatedAt: isoNow(),
        };
        yield* repository.saveDelegation(failed);
        return failed;
      }
      const turns = yield* projectionTurns
        .listByThreadId({ threadId: record.toThreadId })
        .pipe(Effect.orElseSucceed(() => []));
      const messages = yield* threadMessages(record.toThreadId);
      const attributable = new Set(
        messages
          .filter((message) => message.dispatchOrigin === "automation")
          .map((message) => message.id as string),
      );
      const items = yield* listItems(record.toBotId);
      const result = evaluateDelegationSettlement({
        messageId: record.messageId,
        turns: turns.map((turn) => ({
          turnId: turn.turnId,
          pendingMessageId: turn.pendingMessageId,
          state: turn.state,
          requestedAt: turn.requestedAt,
          completedAt: turn.completedAt,
          assistantMessageId: turn.assistantMessageId,
        })),
        attributableMessageIds: attributable,
        items: items
          .filter((item) => item.sourceThreadId === record.toThreadId)
          .map((item) => ({
            id: item.id,
            state: item.state,
            delegationTurnId: item.delegationTurnId ?? null,
            updatedAt: item.updatedAt,
          })),
        sessionActiveTurnId: shell.value.session?.activeTurnId ?? null,
        nowMs,
      });
      const state: BotDelegationRecord["state"] =
        result.state === "settled" ? (result.outcome ?? "completed") : result.state;
      const taskIds = result.itemIds.length > 0 ? result.itemIds : record.taskIds;
      if (state === record.state && taskIds.join() === record.taskIds.join()) return record;
      const lastReply = result.lastAssistantMessageId
        ? (messages.find((message) => message.id === result.lastAssistantMessageId)?.text ?? null)
        : null;
      const settled = result.state === "settled";
      const next: BotDelegationRecord = {
        ...record,
        state,
        taskIds,
        resultSummary: settled
          ? summarizeDelegationResult({
              lastReply,
              taskSummaries: yield* Effect.forEach(
                items.filter((item) => taskIds.includes(item.id)),
                (item) =>
                  Effect.all([taskOutcome(item), workerShell(item)]).pipe(
                    Effect.map(
                      ([outcome, shell]) =>
                        `${item.title}${shell?.branch ? ` (branch ${shell.branch})` : ""}: ${outcome ?? item.state}`,
                    ),
                  ),
              ),
            })
          : record.resultSummary,
        settledAt: settled ? isoNow() : null,
        updatedAt: isoNow(),
      };
      yield* repository.saveDelegation(next);
      yield* publishDelegation(next);
      return next;
    });

  const evaluateDelegations: BotServiceShape["evaluateDelegations"] = (reason) =>
    settleLock
      .withPermits(1)(
        Effect.gen(function* () {
          if (!isServerSynbotEnabled()) return;
          const active = yield* repository.listActiveDelegations();
          if (active.length === 0) return;
          const nowMs = Date.now();
          const relevant = reason.threadId
            ? active.filter(
                (record) =>
                  record.toThreadId === reason.threadId || record.fromThreadId === reason.threadId,
              )
            : active;
          const updated = new Map<string, BotDelegationRecord>();
          for (const record of relevant) {
            const next = yield* settleOne(record, nowMs).pipe(
              Effect.catch(() => Effect.succeed(record)),
            );
            updated.set(next.id, next);
          }
          const settings = yield* getSettings().pipe(Effect.orElseSucceed(() => null));
          const all = active.map((record) => updated.get(record.id) ?? record);
          const owed = all.filter(
            (record) => record.settledAt !== null && record.reportedAt === null,
          );
          const groups = new Map<string, BotDelegationRecord[]>();
          for (const record of owed) {
            const key = settings?.recapMode === "task" ? record.id : record.requestId;
            groups.set(key, [...(groups.get(key) ?? []), record]);
          }
          for (const [key, records] of groups) {
            if (settings?.recapMode !== "task") {
              const siblings = yield* repository.listDelegationsByRequest(key);
              const fresh = siblings.map((sibling) => updated.get(sibling.id) ?? sibling);
              const allSettled = fresh.every((sibling) => sibling.settledAt !== null);
              // One recap per request; a failure is reported at once instead of waiting.
              const now = allSettled
                ? records
                : records.filter((record) => record.state === "failed");
              if (now.length > 0) yield* deliverReport(now);
              continue;
            }
            yield* deliverReport(records);
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("SynBot delegation evaluation failed", { cause: Cause.pretty(cause) }),
        ),
      );

  const cancelDelegation: BotServiceShape["cancelDelegation"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const record = yield* repository
        .getDelegation(input.delegationId)
        .pipe(Effect.mapError(toServiceError("Could not load the delegation.")));
      if (!record) return yield* Effect.fail(fail("Delegation was not found.", "not-found"));
      if (BOT_DELEGATION_TERMINAL_STATES.has(record.state)) return toDelegation(record);
      if (record.state !== "awaiting-start") {
        const shell = yield* snapshotQuery
          .getThreadShellById(record.toThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
        if (Option.isSome(shell) && shell.value.session?.activeTurnId) {
          yield* interruptThread(record.toThreadId, "cancel-delegation").pipe(
            Effect.catch(() => Effect.void),
          );
        }
        for (const taskId of record.taskIds) {
          const item = yield* hubWorkRepository.get(taskId).pipe(Effect.orElseSucceed(() => null));
          if (!item) continue;
          if (item.workerThreadId && ACTIVE_ITEM_STATES.has(item.state)) {
            yield* interruptThread(item.workerThreadId, "cancel-delegation").pipe(
              Effect.catch(() => Effect.void),
            );
          } else if (QUEUED_ITEM_STATES.has(item.state)) {
            yield* hubWork
              .cancel({ workItemId: item.id }, USER)
              .pipe(Effect.catch(() => Effect.void));
          }
        }
      }
      const now = isoNow();
      const next: BotDelegationRecord = {
        ...record,
        state: "cancelled",
        settledAt: now,
        // The user stopped it: nothing is reported back and nobody is woken.
        reportedAt: now,
        updatedAt: now,
      };
      yield* repository
        .saveDelegation(next)
        .pipe(Effect.mapError(toServiceError("Could not save the delegation.")));
      yield* resolveCardSilently(
        record.toThreadId,
        `synbot:card:start:${record.id}`,
        "not-now",
        "Not now",
      );
      yield* publishDelegation(next);
      return toDelegation(next);
    });

  // ── Cards ──────────────────────────────────────────────────────────

  const resolveCardSilently = (
    threadId: ThreadId,
    cardId: string,
    optionId: string,
    label: string,
  ) => {
    const resolution: BotCardResolution = { cardId, optionId, label, resolvedAt: isoNow() };
    return appendActivity({
      threadId,
      id: `${cardId}:resolved`,
      kind: BOT_CARD_RESOLVED_ACTIVITY_KIND,
      summary: label,
      payload: resolution,
    }).pipe(Effect.catch(() => Effect.void));
  };

  const findCard = (threadId: ThreadId, cardId: string) =>
    Effect.gen(function* () {
      const detail = yield* snapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.mapError(toServiceError("Could not load the thread.")));
      if (Option.isNone(detail))
        return yield* Effect.fail(fail("Thread was not found.", "not-found"));
      const activities = detail.value.activities;
      const resolved = activities.some(
        (activity) =>
          activity.kind === BOT_CARD_RESOLVED_ACTIVITY_KIND &&
          (activity.payload as { cardId?: unknown } | null)?.cardId === cardId,
      );
      const activity = activities.find(
        (entry) =>
          entry.kind === BOT_CARD_ACTIVITY_KIND &&
          (entry.payload as { id?: unknown } | null)?.id === cardId,
      );
      const card = activity ? decodeCard(activity.payload) : Option.none();
      if (Option.isNone(card)) return yield* Effect.fail(fail("Card was not found.", "not-found"));
      return { card: card.value, resolved };
    });

  const draftToBot = (draft: BotDraft, index: number, requestId: string) =>
    Effect.gen(function* () {
      const main = yield* repository.getMainProfile().pipe(Effect.orElseSucceed(() => null));
      const mainBot = main
        ? yield* loadBot(main.projectId).pipe(Effect.orElseSucceed(() => null))
        : null;
      const template = BOT_TEMPLATES.find(
        (entry) => entry.name.toLowerCase() === draft.name.toLowerCase(),
      );
      return yield* createBot({
        requestId: `${requestId}:${index}`,
        kind: "bot",
        name: draft.name,
        role: draft.role || template?.role || "",
        mascot: draft.mascot ?? template?.mascot ?? { shape: "circle", color: "#1a80fa" },
        instructions: draft.instructions ?? template?.instructions ?? "",
        scope: draft.scope,
        modelSelection: yield* defaultModel("economy", mainBot?.modelSelection),
        autonomy: "auto",
        pinnedSkills: [],
        pinned: false,
      });
    });

  const cardAction: BotServiceShape["cardAction"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const { card, resolved } = yield* findCard(input.threadId, input.cardId);
      if (resolved) return yield* Effect.fail(fail("This card was already answered.", "conflict"));
      const option = card.options.find((entry) => entry.id === input.optionId);
      if (!option) return yield* Effect.fail(fail("Unknown answer.", "invalid"));
      const createdBotIds: ProjectId[] = [];
      switch (card.kind) {
        case "bot-suggestions":
        case "bot-proposal": {
          const drafts = card.drafts ?? [];
          const indexes =
            option.id === "create:all"
              ? drafts.map((_, index) => index)
              : option.id.startsWith("create:")
                ? [Number(option.id.slice("create:".length))]
                : [];
          for (const index of indexes) {
            const draft = drafts[index];
            if (!draft) continue;
            const bot = yield* draftToBot(draft, index, `synbot-card:${card.id}`);
            createdBotIds.push(bot.id);
          }
          break;
        }
        case "delegation-start": {
          const record = card.delegationId
            ? yield* repository
                .getDelegation(card.delegationId)
                .pipe(Effect.orElseSucceed(() => null))
            : null;
          if (record && record.state === "awaiting-start") {
            if (option.id === "start") yield* dispatchDelegation(record);
            else yield* cancelDelegation({ delegationId: record.id });
          }
          break;
        }
        case "git-init": {
          if (option.id === "init" && card.projectPath) {
            yield* git
              .initRepo({ cwd: card.projectPath })
              .pipe(Effect.mapError(toServiceError("Could not create the repository.")));
            // An empty first commit gives worktrees a base without adding any file (secrets stay untracked).
            yield* git
              .execute({
                operation: "synbot.initialCommit",
                cwd: card.projectPath,
                args: ["commit", "--allow-empty", "-m", "Initial commit"],
              })
              .pipe(Effect.mapError(toServiceError("Could not make the first commit.")));
            yield* registerProject(card.projectPath);
          }
          break;
        }
      }
      yield* resolveCardSilently(input.threadId, card.id, option.id, option.label);
      return { cardId: card.id, optionId: option.id, createdBotIds };
    });

  // ── Suggestions, proposals and projects ────────────────────────────

  const scanProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* snapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.mapError(toServiceError("Could not load the project.")));
      if (Option.isNone(project))
        return yield* Effect.fail(fail("Project was not found.", "not-found"));
      const root = project.value.workspaceRoot;
      const directories = (dir: string) =>
        fileSystem.readDirectory(dir).pipe(
          Effect.flatMap((names) =>
            Effect.filter(names, (name) =>
              fileSystem.stat(nodePath.join(dir, name)).pipe(
                Effect.map((info) => info.type === "Directory"),
                Effect.orElseSucceed(() => false),
              ),
            ),
          ),
          Effect.orElseSucceed(() => [] as string[]),
        );
      const topFolders = yield* directories(root);
      const appsFolders = topFolders.includes("apps")
        ? yield* directories(nodePath.join(root, "apps"))
        : [];
      const hasGitHubWorkflows = yield* fileSystem
        .exists(nodePath.join(root, ".github", "workflows"))
        .pipe(Effect.orElseSucceed(() => false));
      const takenNames = (yield* listBots()).map((bot) => bot.name);
      return {
        project: project.value,
        scan: suggestBotDrafts({
          projectId,
          projectName: project.value.title,
          topFolders,
          appsFolders,
          hasGitHubWorkflows,
          takenNames,
        }),
      };
    });

  const suggest: BotServiceShape["suggest"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const { scan } = yield* scanProject(input.projectId);
      return { drafts: scan.drafts };
    });

  const postSuggestionCard = (threadId: ThreadId, botId: ProjectId, projectId: ProjectId) =>
    Effect.gen(function* () {
      const { scan } = yield* scanProject(projectId);
      const cardId = `synbot:card:suggest:${projectId}`;
      yield* postCard({
        threadId,
        summary: scan.message,
        card: {
          id: cardId,
          kind: "bot-suggestions",
          botId,
          title: scan.message,
          options: [
            ...scan.drafts.map((draft, index) => ({
              id: `create:${index}`,
              label: `Create ${draft.name}`,
              tone: index === 0 ? ("primary" as const) : ("normal" as const),
            })),
            ...(scan.drafts.length > 1
              ? [{ id: "create:all", label: "Create all", tone: "normal" as const }]
              : []),
            { id: "dismiss", label: "Not now", tone: "dismiss" as const },
          ],
          drafts: [...scan.drafts],
          createdAt: isoNow(),
        },
      });
      return { cardId, drafts: scan.drafts };
    });

  const suggestForCaller: BotServiceShape["suggestForCaller"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      return yield* postSuggestionCard(
        input.caller.bot.threadId,
        input.caller.bot.id,
        input.projectId,
      );
    });

  const propose: BotServiceShape["propose"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const cardId = `synbot:card:propose:${stableGatewayDigest({ bot: input.caller.bot.id, draft: input.draft }, 20)}`;
      yield* postCard({
        threadId: input.caller.bot.threadId,
        summary: `Save "${input.draft.name}" as a bot?`,
        card: {
          id: cardId,
          kind: "bot-proposal",
          botId: input.caller.bot.id,
          title: `Save "${input.draft.name}" as a bot?`,
          ...(input.reason ? { body: input.reason.slice(0, 4_000) } : {}),
          options: [
            { id: "create:0", label: "Create bot", tone: "primary" },
            { id: "dismiss", label: "Not now", tone: "dismiss" },
          ],
          drafts: [input.draft],
          createdAt: isoNow(),
        },
      });
      return { cardId };
    });

  const registerProject = (workspaceRoot: string) =>
    Effect.gen(function* () {
      const existing = yield* snapshotQuery
        .getActiveProjectByWorkspaceRoot(workspaceRoot)
        .pipe(Effect.mapError(toServiceError("Could not look up projects.")));
      if (Option.isSome(existing))
        return { status: "exists" as const, projectId: existing.value.id };
      const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
      yield* orchestrationEngine
        .dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(`synbot-add-project:${projectId}`),
          projectId,
          kind: "project",
          title: nodePath.basename(workspaceRoot) || workspaceRoot,
          workspaceRoot,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
          isPinned: false,
          createdAt: isoNow(),
        } as OrchestrationCommand)
        .pipe(Effect.mapError(toServiceError("Could not add the project.")));
      return { status: "added" as const, projectId };
    });

  const addProject: BotServiceShape["addProject"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const raw = input.path.trim();
      const expanded = raw.startsWith("~")
        ? nodePath.join(serverConfig.homeDir, raw.slice(1))
        : raw;
      if (!nodePath.isAbsolute(expanded)) {
        return yield* Effect.fail(
          fail("Pass an absolute folder path (or one starting with ~).", "invalid"),
        );
      }
      const workspaceRoot = nodePath.resolve(expanded);
      const info = yield* fileSystem
        .stat(workspaceRoot)
        .pipe(
          Effect.mapError(() => fail(`Folder "${workspaceRoot}" does not exist.`, "not-found")),
        );
      if (info.type !== "Directory")
        return yield* Effect.fail(fail(`"${workspaceRoot}" is not a folder.`, "invalid"));
      const existing = yield* snapshotQuery
        .getActiveProjectByWorkspaceRoot(workspaceRoot)
        .pipe(Effect.mapError(toServiceError("Could not look up projects.")));
      if (Option.isSome(existing))
        return { status: "exists" as const, projectId: existing.value.id };
      const context = yield* git
        .readBranchContext(workspaceRoot)
        .pipe(Effect.orElseSucceed(() => null));
      if (!context?.isRepo) {
        const cardId = `synbot:card:git-init:${stableGatewayDigest({ workspaceRoot }, 20)}`;
        yield* postCard({
          threadId: input.caller.bot.threadId,
          summary: "Make it a Git repository?",
          card: {
            id: cardId,
            kind: "git-init",
            botId: input.caller.bot.id,
            title: `${nodePath.basename(workspaceRoot)} is not a Git repository. Make it one and add it?`,
            body: "Tasks run in worktrees, which need Git. The first commit is empty: no file is added.",
            options: [
              { id: "init", label: "Make it a repository", tone: "primary" },
              { id: "dismiss", label: "Not now", tone: "dismiss" },
            ],
            projectPath: workspaceRoot,
            createdAt: isoNow(),
          },
        });
        return { status: "needs-git" as const, cardId };
      }
      return yield* registerProject(workspaceRoot);
    });

  const onProjectCreated: BotServiceShape["onProjectCreated"] = (projectId) =>
    Effect.gen(function* () {
      if (!isServerSynbotEnabled()) return;
      const project = yield* snapshotQuery.getProjectShellById(projectId);
      if (Option.isNone(project) || !isOrdinary(project.value)) return;
      const profiles = yield* repository.listProfiles();
      for (const profile of profiles) {
        if (profile.scope.projects === "all")
          yield* syncScopeLinks(profile.projectId, profile.scope);
      }
      const main = profiles.find((profile) => profile.kind === "main");
      if (!main) return;
      const config = yield* projectAgentRepository.getConfig(main.projectId);
      if (Option.isNone(config)) return;
      yield* postSuggestionCard(config.value.coordinatorThreadId, main.projectId, projectId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("SynBot could not process a new project", { cause: Cause.pretty(cause) }),
      ),
    );

  // ── Control over other chats ───────────────────────────────────────

  const fullControlFor: BotServiceShape["fullControlFor"] = (input) =>
    Effect.gen(function* () {
      if (!isServerSynbotEnabled()) return null;
      const settings = yield* getSettings();
      if (!settings.controlWithoutAsking) return null;
      const shell = yield* snapshotQuery
        .getThreadShellById(input.callerThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
      if (Option.isNone(shell)) return null;
      const turnId = shell.value.session?.activeTurnId ?? shell.value.latestTurn?.turnId ?? null;
      const caller = yield* resolveCaller({ threadId: input.callerThreadId, turnId });
      if (!caller || !caller.humanRooted) return null;
      return { botId: caller.bot.id, botName: caller.bot.name };
    });

  const noteControl: BotServiceShape["noteControl"] = (input) =>
    Effect.gen(function* () {
      if (!isServerSynbotEnabled() || input.callerThreadId === input.targetThreadId) return;
      const config = yield* projectAgentRepository.getConfigByCoordinatorThread(
        input.callerThreadId,
      );
      if (Option.isNone(config)) return;
      const profile = yield* repository.getProfile(config.value.projectId);
      if (!profile) return;
      // A bot steering its own task needs no label; the task card already says whose it is.
      const owned = yield* hubWorkRepository.findByWorker(input.targetThreadId);
      if (owned?.projectId === profile.projectId) return;
      const botName = config.value.coordinatorName;
      yield* appendActivity({
        threadId: input.targetThreadId,
        id: `synbot:control:${profile.projectId}:${input.targetThreadId}:${Date.now()}`,
        kind: BOT_CONTROL_ACTIVITY_KIND,
        summary: `From ${botName}`,
        payload: { botId: profile.projectId, botName, action: input.action, createdAt: isoNow() },
      });
    }).pipe(Effect.catch(() => Effect.void));

  const delegatedSources: BotServiceShape["delegatedSources"] = (messageId) =>
    Effect.gen(function* () {
      if (messageId.startsWith(BOT_DELEGATION_MESSAGE_PREFIX)) {
        const record = yield* repository
          .getDelegationByMessage(messageId)
          .pipe(Effect.mapError(toServiceError("Could not load the delegation.")));
        return record ? record.sourceMessages : null;
      }
      if (messageId.startsWith(BOT_REPORT_MESSAGE_PREFIX)) {
        const records = yield* repository
          .listDelegationsByReportMessage(messageId)
          .pipe(Effect.mapError(toServiceError("Could not load the report.")));
        if (records.length === 0) return null;
        const sources = new Map<string, HubWorkSourceMessage>();
        for (const record of records)
          for (const source of record.sourceMessages) sources.set(source.messageId, source);
        return [...sources.values()];
      }
      return null;
    });

  const isBotProject: BotServiceShape["isBotProject"] = (projectId) =>
    repository.getProfile(projectId).pipe(
      Effect.map((profile) => profile !== null),
      Effect.orElseSucceed(() => false),
    );

  // ── Merge proof ────────────────────────────────────────────────────

  const requirePullRequest = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const settings = yield* getSettings();
      if (!settings.mergeProofEnabled) {
        return yield* Effect.fail(
          fail("Turn on the merge proof in Settings → SynBot first.", "forbidden"),
        );
      }
      if (Option.isNone(pullRequests))
        return yield* Effect.fail(fail("Pull requests are unavailable.", "unavailable"));
      const shell = yield* snapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(toServiceError("Could not load the task.")));
      if (Option.isNone(shell)) return yield* Effect.fail(fail("Task was not found.", "not-found"));
      const pr = shell.value.lastKnownPr;
      const repositorySlug = pr ? repositoryFromPrUrl(pr.url) : null;
      if (!pr || !repositorySlug)
        return yield* Effect.fail(fail("This task has no pull request yet.", "invalid"));
      return {
        service: pullRequests.value,
        input: { projectId: shell.value.projectId, repository: repositorySlug, number: pr.number },
      };
    });

  const computeProof = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { service, input } = yield* requirePullRequest(threadId);
      const detail = yield* service
        .detail({ ...input, forceRefresh: true })
        .pipe(Effect.mapError(toServiceError("Could not read the pull request.", "unavailable")));
      const diff = yield* service
        .diff(input)
        .pipe(Effect.orElseSucceed(() => ({ patch: "", truncated: false })));
      return {
        service,
        input,
        detail,
        proof: evaluateMergeProof({ threadId, detail, patch: diff.patch, checkedAt: isoNow() }),
      };
    });

  const mergeProof: BotServiceShape["mergeProof"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(computeProof(input.threadId)),
      Effect.map(({ proof }) => proof),
    );

  const merge: BotServiceShape["merge"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const { service, input: prInput, detail, proof } = yield* computeProof(input.threadId);
      if (!proof.ready) {
        return {
          outcome: "refused" as const,
          message: "The proof is not green; Merge stays off.",
          proof,
        };
      }
      if (proof.headSha !== input.headSha) {
        return {
          outcome: "refused" as const,
          message: "The pull request changed since you looked. Check the new proof.",
          proof,
        };
      }
      const capabilities = detail.mergeCapabilities;
      const method =
        input.method ?? (capabilities.squash ? "squash" : capabilities.merge ? "merge" : "rebase");
      const result = yield* service
        .action({ ...prInput, action: "merge", mergeMethod: method })
        .pipe(Effect.mapError(toServiceError("GitHub refused the merge.", "conflict")));
      const after: BotMergeProof = {
        ...proof,
        state: result.mergeOutcome === "merged" ? "merged" : proof.state,
        ready: false,
      };
      return {
        outcome: result.mergeOutcome === "enqueued" ? ("enqueued" as const) : ("merged" as const),
        proof: after,
      };
    });

  const updateBranch: BotServiceShape["updateBranch"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const { service, input: prInput } = yield* requirePullRequest(input.threadId);
      yield* service
        .updateBranch(prInput)
        .pipe(Effect.mapError(toServiceError("GitHub could not update the branch.", "conflict")));
      return (yield* computeProof(input.threadId)).proof;
    });

  // ── Stop all ───────────────────────────────────────────────────────

  const stopAll: BotServiceShape["stopAll"] = () =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const interruptedThreadIds: ThreadId[] = [];
      const cancelledTaskIds: string[] = [];
      const cancelledDelegationIds: string[] = [];
      for (const record of yield* repository
        .listActiveDelegations()
        .pipe(Effect.mapError(toServiceError("Could not load delegations.")))) {
        if (record.settledAt !== null) continue;
        yield* cancelDelegation({ delegationId: record.id }).pipe(Effect.catch(() => Effect.void));
        cancelledDelegationIds.push(record.id);
      }
      for (const bot of yield* listBots()) {
        const shell = yield* snapshotQuery
          .getThreadShellById(bot.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
        if (Option.isSome(shell) && shell.value.session?.activeTurnId) {
          yield* interruptThread(bot.threadId, "stop-all").pipe(Effect.catch(() => Effect.void));
          interruptedThreadIds.push(bot.threadId);
        }
        for (const item of yield* listItems(bot.id)) {
          if (item.workerThreadId && ACTIVE_ITEM_STATES.has(item.state)) {
            yield* interruptThread(item.workerThreadId, "stop-all").pipe(
              Effect.catch(() => Effect.void),
            );
            interruptedThreadIds.push(item.workerThreadId);
          } else if (QUEUED_ITEM_STATES.has(item.state)) {
            yield* hubWork.cancel({ workItemId: item.id }, USER).pipe(
              Effect.tap(() => Effect.sync(() => cancelledTaskIds.push(item.id))),
              Effect.catch(() => Effect.void),
            );
          }
        }
      }
      return { interruptedThreadIds, cancelledTaskIds, cancelledDelegationIds };
    });

  // ── Stream ─────────────────────────────────────────────────────────

  const streamEvents: BotServiceShape["streamEvents"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireEnabled;
        const liveQueue = yield* Queue.bounded<BotStreamEvent, Cause.Done>(256);
        // Stream.fromPubSub does not deliver under this runtime; subscribe in the stream's scope.
        const subscription = yield* PubSub.subscribe(events);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runIntoQueue(liveQueue),
          Effect.forkScoped,
        );
        const initial = yield* snapshot();
        return Stream.concat(
          Stream.succeed({ type: "snapshot" as const, snapshot: initial }),
          Stream.fromQueue(liveQueue),
        );
      }),
    );

  // Hub task updates of bot Hubs become bot task events (and may change a bot's status).
  yield* projectAgent.streamWorkItemEvents().pipe(
    Stream.runForEach((event) =>
      isBotProject(event.projectId).pipe(
        Effect.flatMap((isBot) =>
          isBot
            ? publish({ type: "task-upserted", botId: event.projectId, task: event.workItem }).pipe(
                Effect.andThen(refreshBotStatus(event.projectId)),
              )
            : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );

  return {
    snapshot,
    ensureMain,
    create,
    update,
    remove,
    updateSettings,
    cardAction,
    suggest,
    cancelDelegation,
    mergeProof,
    merge,
    updateBranch,
    stopAll,
    streamEvents,
    resolveCaller,
    formatContextForTurn,
    roster,
    delegate,
    listDelegationsFor,
    propose,
    suggestForCaller,
    addProject,
    fullControlFor,
    noteControl,
    delegatedSources,
    isBotProject,
    evaluateDelegations,
    onProjectCreated,
    freshStart,
    refreshThread: (threadId: ThreadId) =>
      projectAgentRepository.getConfigByCoordinatorThread(threadId).pipe(
        Effect.flatMap((config) =>
          Option.isSome(config) ? refreshBotStatus(config.value.projectId) : Effect.void,
        ),
        Effect.catch(() => Effect.void),
      ),
  } satisfies BotServiceShape;
});

export const BotServiceLive = Layer.effect(BotService, make);
