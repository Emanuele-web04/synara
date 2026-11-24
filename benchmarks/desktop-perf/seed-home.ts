// Fills an isolated Synara data home through the server's own orchestration engine
// (decider -> event store -> projection pipeline), so the rows are the ones the app
// itself writes. The harness copies this file into `<build>/apps/server/.bench/` and
// runs it with Bun, which is why the server imports are relative to that location.
//
//   BENCH_SEED_HOME=<home> BENCH_SEED_WORKSPACES=<dir> [BENCH_SEED_SHAPE=<json>] bun .bench/seed-home.ts
//
// `realisticThreads: true` in the shape also writes the long threads of
// seed-realistic-threads.ts; `BENCH_SEED_MODE=append-realistic` writes only those into a
// home that is already seeded (the generic threads stay byte-for-byte the same).
//
// The app must not be running on that home. Output is deterministic for a given shape.
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { seedRealisticThreads } from "./seed-realistic-threads.ts";

interface SeedShape {
  readonly projects: number;
  /** Messages per thread for the named large threads, largest first. */
  readonly largeThreads: ReadonlyArray<number>;
  readonly smallThreads: number;
  readonly smallThreadMessages: number;
  /** Tool calls per assistant message; each writes started, updated and completed rows. */
  readonly toolCallsPerAssistantMessage: number;
  /** Adds the long threads of seed-realistic-threads.ts to the first project. */
  readonly realisticThreads?: boolean;
}

const DEFAULT_SHAPE: SeedShape = {
  projects: 12,
  largeThreads: [1400, 666, 300, 300, 120, 120, 120, 120, 120, 120],
  smallThreads: 290,
  smallThreadMessages: 38,
  toolCallsPerAssistantMessage: 2,
};

const home = resolve(process.env.BENCH_SEED_HOME ?? "");
const workspaces = resolve(process.env.BENCH_SEED_WORKSPACES ?? "");
const shape: SeedShape = { ...DEFAULT_SHAPE, ...JSON.parse(process.env.BENCH_SEED_SHAPE ?? "{}") };
if (!process.env.BENCH_SEED_HOME || !process.env.BENCH_SEED_WORKSPACES) {
  throw new Error("BENCH_SEED_HOME and BENCH_SEED_WORKSPACES are required");
}
for (const name of [".synara", ".synara-beta", ".synara-dev", ".synara-canary", ".synara-remote"]) {
  const real = resolve(homedir(), name);
  if (home === real || home.startsWith(real + sep)) {
    throw new Error(`Refusing to seed a real Synara data home: ${home}`);
  }
}

// Deterministic generator so every seeded home holds the same threads.
let randomState = 0x5eed1234;
function random(): number {
  randomState |= 0;
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)]!;

const TOPICS = [
  "the reconnect backoff in the websocket transport",
  "the sidebar thread list ordering",
  "the migration that adds a pinned flag",
  "the flaky scroll-follow test",
  "the checkout form validation",
  "the image upload size limit",
  "the settings page layout on small windows",
  "the CSV export for invoices",
  "the retry policy of the job queue",
  "the dark theme contrast of secondary text",
  "the search index rebuild command",
  "the rate limiter for the public API",
];
const FILES = [
  "src/transport/reconnect.ts",
  "src/components/Sidebar.tsx",
  "src/server/migrations/042_pinned.ts",
  "src/hooks/useScrollFollow.ts",
  "src/forms/checkout.ts",
  "src/upload/limits.ts",
  "src/routes/settings.tsx",
  "src/export/csv.ts",
  "src/queue/retry.ts",
  "src/theme/tokens.css",
];

function userPrompt(index: number): string {
  const topic = pick(TOPICS);
  const forms = [
    `Can you look at ${topic}? It behaves differently after the last change and I am not sure why.`,
    `Please fix ${topic}. Keep the change small and add a test that fails before the fix.`,
    `Explain how ${topic} works today, then propose the smallest change that makes it predictable.`,
    `Follow-up ${index}: the previous attempt on ${topic} still fails in CI. Here is the output:\n\n\`\`\`\nFAIL  ${pick(FILES)}\n  expected 3 retries, received 4\n\`\`\``,
  ];
  return pick(forms);
}

function assistantAnswer(): string {
  const file = pick(FILES);
  const other = pick(FILES);
  const parts = [
    `I looked at ${pick(TOPICS)} and traced it through \`${file}\`. The behaviour comes from how the state is derived on each update rather than from the handler itself.`,
    `## What I found\n\n- The value is recomputed on every event, so two quick updates can observe different inputs.\n- \`${other}\` reads the same field without waiting for the write to settle.\n- The existing test only covers the single-update path.`,
    "```ts\nexport function nextDelay(attempt: number, base = 500, cap = 8_000): number {\n  const exponential = Math.min(cap, base * 2 ** attempt);\n  return Math.round(exponential / 2 + (exponential / 2) * Math.random());\n}\n\nexport function shouldRetry(attempt: number, error: unknown): boolean {\n  if (attempt >= 5) return false;\n  return error instanceof TransientError;\n}\n```",
    `| Case | Before | After |\n| --- | --- | --- |\n| Single update | correct | correct |\n| Two updates within 50 ms | stale value | correct |\n| Update during reconnect | dropped | queued |`,
    `## Change\n\n1. Derive the value once per batch in \`${file}\`.\n2. Make \`${other}\` read the settled value.\n3. Add a test for two updates in the same tick.\n\nI ran the focused tests and they pass. The full suite was not run.`,
  ];
  const count = 2 + Math.floor(random() * 4);
  return parts.slice(0, count).join("\n\n");
}

// Activity rows copy what one real Claude turn writes (checked against a real turn in an
// isolated home): turn.started, then tool.started / tool.updated / tool.completed per
// tool call with the provider's payload fields, then turn.completed.
interface SeedActivity {
  readonly id: EventId;
  readonly tone: "tool" | "info";
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly createdAt: string;
}

let activitySequence = 0;
function turnActivities(
  threadKey: string,
  messageIndex: number,
  startMs: number,
  toolCalls: number,
  iso: (offsetMs: number) => string,
): ReadonlyArray<SeedActivity> {
  const turnId = TurnId.makeUnsafe(`seed-turn-${threadKey}-${messageIndex}`);
  const activities: SeedActivity[] = [];
  let step = 0;
  const push = (tone: "tool" | "info", kind: string, summary: string, payload: unknown) => {
    activities.push({
      id: EventId.makeUnsafe(`seed-act-${threadKey}-${messageIndex}-${step}`),
      tone,
      kind,
      summary,
      payload,
      turnId,
      sequence: (activitySequence += 1),
      createdAt: iso(startMs + step * 400),
    });
    step += 1;
  };
  push("info", "turn.started", "Turn started", {
    model: "claude-sonnet-5",
    provider: "claudeAgent",
  });
  for (let index = 0; index < toolCalls; index += 1) {
    const file = `${workspaces}/proj-01/${pick(FILES)}`;
    const callId = `toolu_seed_${threadKey}_${messageIndex}_${index}`;
    const variant = pick(["read", "command", "search", "edit"] as const);
    const tool =
      variant === "read"
        ? {
            itemType: "dynamic_tool_call",
            title: "Tool call",
            toolName: "Read",
            input: { file_path: file } as Record<string, unknown>,
            detail: `Read: ${JSON.stringify({ file_path: file })}`,
            output:
              "1\texport function nextDelay(attempt: number, base = 500, cap = 8_000): number {\n2\t  const exponential = Math.min(cap, base * 2 ** attempt);\n3\t  return Math.round(exponential / 2 + (exponential / 2) * Math.random());\n4\t}\n",
          }
        : variant === "command"
          ? {
              itemType: "command_execution",
              title: "Command run",
              toolName: "Bash",
              input: {
                command: "bun run test --filter retry",
                description: "Run the focused tests",
              } as Record<string, unknown>,
              detail: "Bash: bun run test --filter retry",
              output:
                " RUN  v4.1.10\n\n ✓ src/queue/retry.test.ts (7 tests) 12ms\n ✓ src/transport/reconnect.test.ts (5 tests) 9ms\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)\n   Duration  1.42s\n",
            }
          : variant === "search"
            ? {
                itemType: "command_execution",
                title: "Command run",
                toolName: "Bash",
                input: {
                  command: 'grep -rn "nextDelay" src',
                  description: "Find callers",
                } as Record<string, unknown>,
                detail: 'Bash: grep -rn "nextDelay" src',
                output:
                  "src/queue/retry.ts:4:export function nextDelay(attempt: number, base = 500, cap = 8_000): number {\nsrc/transport/reconnect.ts:21:  const delay = nextDelay(attempt);\n",
              }
            : {
                itemType: "file_change",
                title: "File change",
                toolName: "Edit",
                input: {
                  file_path: file,
                  old_string: "const exponential = base * attempt;",
                  new_string: "const exponential = Math.min(cap, base * 2 ** attempt);",
                } as Record<string, unknown>,
                detail: `Edit: ${JSON.stringify({ file_path: file }).slice(0, 120)}...`,
                output: `The file ${file} has been updated successfully.`,
              };
    const base = { toolCallId: callId, callId, toolName: tool.toolName };
    push("tool", "tool.started", `${tool.title} started`, {
      itemType: tool.itemType,
      status: "inProgress",
      title: tool.title,
      detail: `${tool.toolName}: {}`,
      data: { ...base, input: {} },
    });
    push("tool", "tool.updated", tool.title, {
      itemType: tool.itemType,
      status: "inProgress",
      title: tool.title,
      detail: tool.detail,
      data: { ...base, input: tool.input },
    });
    push("tool", "tool.completed", tool.title, {
      itemType: tool.itemType,
      status: "completed",
      title: tool.title,
      detail: tool.detail,
      data: {
        ...base,
        input: tool.input,
        result: { tool_use_id: callId, type: "tool_result", content: tool.output, is_error: false },
        rawOutput: { output: tool.output },
      },
    });
  }
  push("info", "turn.completed", "Turn completed", {
    state: "completed",
    provider: "claudeAgent",
    tokenAccountingVersion: 1,
    mainLoopTokens: 48_000 + Math.floor(random() * 90_000),
    claudeResultObserved: true,
  });
  return activities;
}

const layer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(
    OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provide(ServerSettingsService.layerTest())),
  ),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(makeSqlitePersistenceLive(resolve(home, "userdata/state.sqlite"))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
  Layer.provideMerge(NodeServices.layer),
);
const runtime = ManagedRuntime.make(layer);
const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
const dispatch = (command: Record<string, unknown>) =>
  runtime.runPromise(engine.dispatch(command as never));

const startedAt = Date.now();
const firstProjectId = ProjectId.makeUnsafe("seed-project-01");

if (process.env.BENCH_SEED_MODE === "append-realistic") {
  const manifest = await seedRealisticThreads(dispatch, firstProjectId);
  await runtime.dispose();
  console.log(
    JSON.stringify({
      threads: manifest.length,
      messages: manifest.reduce((sum, thread) => sum + thread.messages, 0),
      activities: manifest.reduce((sum, thread) => sum + thread.activities, 0),
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      manifest,
    }),
  );
  process.exit(0);
}

const baseTime = Date.parse("2026-09-15T08:00:00.000Z");
const iso = (offsetMs: number) => new Date(baseTime + offsetMs).toISOString();
const DAY = 86_400_000;

const projectIds: ProjectId[] = [];
for (let index = 0; index < shape.projects; index += 1) {
  const number = String(index + 1).padStart(2, "0");
  const projectId = ProjectId.makeUnsafe(`seed-project-${number}`);
  projectIds.push(projectId);
  await dispatch({
    type: "project.create",
    commandId: CommandId.makeUnsafe(`seed-cmd-project-${number}`),
    projectId,
    title: `proj-${number}`,
    workspaceRoot: resolve(workspaces, `proj-${number}`),
    defaultModelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
    createdAt: iso(index * 60_000),
  });
}

const threadPlan: Array<{ key: string; title: string; messages: number }> = [
  ...shape.largeThreads.map((messages, index) => ({
    key: `large-${String(index + 1).padStart(2, "0")}`,
    title: `Bench large ${String(index + 1).padStart(2, "0")} (${messages} messages)`,
    messages,
  })),
  ...Array.from({ length: shape.smallThreads }, (_, index) => ({
    key: `small-${String(index + 1).padStart(3, "0")}`,
    title: `Bench small ${String(index + 1).padStart(3, "0")}`,
    messages: shape.smallThreadMessages,
  })),
];

let messageTotal = 0;
let activityTotal = 0;
const manifest: Array<{
  threadId: string;
  projectId: string;
  title: string;
  messages: number;
  activities: number;
}> = [];
for (const [threadIndex, plan] of threadPlan.entries()) {
  const threadId = ThreadId.makeUnsafe(`seed-thread-${plan.key}`);
  const projectId = projectIds[threadIndex % projectIds.length]!;
  // Large threads are the most recent, then the first 24 small threads (two per project,
  // so the sidebar's first page shows them); the other small threads spread over 56 days.
  const smallIndex = threadIndex - shape.largeThreads.length;
  const threadStart = plan.key.startsWith("large")
    ? 58 * DAY + threadIndex * 3_600_000
    : smallIndex < 24
      ? 57 * DAY + smallIndex * 600_000
      : Math.floor(random() * 56 * DAY);
  await dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`seed-cmd-thread-${plan.key}`),
    threadId,
    projectId,
    title: plan.title,
    modelSelection:
      threadIndex % 2 === 0
        ? { provider: "claudeAgent", model: "claude-sonnet-5" }
        : { provider: "codex", model: "gpt-6-astra" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: iso(threadStart),
  });
  let threadActivities = 0;
  const BATCH = 50;
  for (let offset = 0; offset < plan.messages; offset += BATCH) {
    const messages = [];
    const activities = [];
    for (let index = offset; index < Math.min(plan.messages, offset + BATCH); index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const createdAt = iso(threadStart + index * 45_000);
      if (role === "assistant") {
        activities.push(
          ...turnActivities(
            plan.key,
            index,
            threadStart + index * 45_000 - 30_000,
            shape.toolCallsPerAssistantMessage,
            iso,
          ),
        );
      }
      messages.push({
        messageId: MessageId.makeUnsafe(`seed-msg-${plan.key}-${String(index).padStart(5, "0")}`),
        role,
        text: role === "user" ? userPrompt(index) : assistantAnswer(),
        createdAt,
        updatedAt: createdAt,
      });
    }
    await dispatch({
      type: "thread.messages.import",
      commandId: CommandId.makeUnsafe(`seed-cmd-import-${plan.key}-${offset}`),
      threadId,
      messages,
      createdAt: messages.at(-1)!.createdAt,
    });
    for (const activity of activities) {
      await dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`seed-cmd-${activity.id}`),
        threadId,
        activity,
        createdAt: activity.createdAt,
      });
    }
    threadActivities += activities.length;
  }
  messageTotal += plan.messages;
  activityTotal += threadActivities;
  manifest.push({
    threadId,
    projectId,
    title: plan.title,
    messages: plan.messages,
    activities: threadActivities,
  });
  if (threadIndex % 25 === 0) {
    console.error(
      `seeded ${threadIndex + 1}/${threadPlan.length} threads, ${messageTotal} messages`,
    );
  }
}

if (shape.realisticThreads) {
  for (const thread of await seedRealisticThreads(dispatch, firstProjectId)) {
    messageTotal += thread.messages;
    activityTotal += thread.activities;
    manifest.push(thread);
  }
}

await runtime.dispose();
console.log(
  JSON.stringify({
    projects: projectIds.length,
    threads: manifest.length,
    messages: messageTotal,
    activities: activityTotal,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    manifest,
  }),
);
