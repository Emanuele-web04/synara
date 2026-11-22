// Long threads whose SHAPE mirrors real long agent threads: message and activity counts
// and payload byte sizes follow aggregate statistics of real data homes, while every word
// of content is synthetic. Used by seed-home.ts (shape `realisticThreads`, or
// `BENCH_SEED_MODE=append-realistic` to add them to an already seeded home).
//
// Unlike the generic seeded threads, assistant messages carry a turn id (they are written
// through thread.message.assistant.delta/complete, as a live turn writes them), tool
// payloads range from 0.2 to ~16 KB, and roughly one context-window.updated follows each
// tool call. That is what makes finished turns collapse and the detail snapshot heavy.
//
// The generator is deterministic and isolated from seed-home.ts's own random sequence,
// so adding these threads never changes the generic threads.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";

type Dispatch = (command: Record<string, unknown>) => Promise<unknown>;

export const REALISTIC_THREAD_IDS = {
  agentHeavy: "real-thread-agent-heavy",
  agentMid: "real-thread-agent-mid",
  prose: "real-thread-prose",
} as const;

let randomState = 0x1eaf5eed;
function random(): number {
  randomState |= 0;
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)]!;
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

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
const WORDS =
  "state derive update handler batch settle retry queue socket render layout measure cache window anchor scroll thread message activity turn snapshot cursor replay reducer selector effect schema decode projection sequence".split(
    " ",
  );
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const CODE_LINES = [
  "export function nextDelay(attempt: number, base = 500, cap = 8_000): number {",
  "  const exponential = Math.min(cap, base * 2 ** attempt);",
  "  return Math.round(exponential / 2 + (exponential / 2) * Math.random());",
  "}",
  "const settled = await Promise.allSettled(pending.map((job) => job.run()));",
  "if (!state.snapshotSequenceById.has(threadId)) return bufferEvent(event);",
  "for (const row of rows) { if (row.kind === 'message') ids.add(row.message.id); }",
  "  ✓ src/queue/retry.test.ts (7 tests) 12ms",
  "src/transport/reconnect.ts:21:  const delay = nextDelay(attempt);",
  "@@ -41,7 +41,9 @@ export function reconcile(previous, next) {",
];

function textOfLength(target: number, lines: ReadonlyArray<string>): string {
  const out: string[] = [];
  let length = 0;
  let n = 1;
  while (length < target) {
    const line = `${n}\t${pick(lines)} // ${sentence(3)}`;
    out.push(line);
    length += line.length + 1;
    n += 1;
  }
  return out.join("\n");
}

/** Long-tailed sizes: most payloads are below the average, a few approach the stored cap. */
function sizeAround(avg: number, max = 15_500): number {
  const r = random();
  const value =
    r < 0.6
      ? avg * (0.15 + random() * 0.6)
      : r < 0.92
        ? avg * (0.8 + random() * 1.4)
        : avg * (2.5 + random() * 2);
  return Math.max(120, Math.min(max, Math.round(value)));
}

function narration(): string {
  const forms = [
    `Now checking how \`${pick(FILES)}\` handles the ${sentence(2)} path.`,
    `The ${sentence(2)} is derived on every event, so I'll trace it through \`${pick(FILES)}\` before changing anything.`,
    `That confirms it: ${sentence(6)}. Running the focused tests next.`,
    `Two things to fix here:\n\n- ${sentence(7)}\n- ${sentence(6)}\n\nStarting with the first.`,
  ];
  return pick(forms);
}

function finalAnswer(): string {
  const parts = [
    `## Result\n\n${sentence(18)}. The behaviour comes from how the state is derived on each update rather than from the handler itself; see \`${pick(FILES)}\` and [the reducer](${pick(FILES)}).`,
    `### What changed\n\n- **${sentence(2)}**: ${sentence(12)}.\n- **${sentence(2)}**: ${sentence(10)}.\n- \`${pick(FILES)}\` now ${sentence(8)}.\n  - nested: ${sentence(6)}\n  - nested: ${sentence(5)}`,
    "```ts\n" + Array.from({ length: between(8, 40) }, () => pick(CODE_LINES)).join("\n") + "\n```",
    `| Case | Before | After | Notes |\n| --- | --- | --- | --- |\n` +
      Array.from(
        { length: between(3, 9) },
        () =>
          `| ${sentence(2)} | ${between(10, 900)} ms | ${between(5, 400)} ms | ${sentence(4)} |`,
      ).join("\n"),
    `### Verification\n\n1. \`bun run test --filter ${pick(WORDS)}\` passes (${between(4, 60)} tests).\n2. ${sentence(9)}.\n3. ${sentence(7)}.\n\n> ${sentence(14)}`,
    "```bash\n" +
      Array.from(
        { length: between(3, 12) },
        () => `bun run ${pick(WORDS)} --filter ${pick(WORDS)}`,
      ).join("\n") +
      "\n```",
    `${sentence(30)}.\n\n${sentence(24)}.`,
    "```diff\n" +
      Array.from(
        { length: between(6, 24) },
        () => `${pick(["+", "-", " "])} ${pick(CODE_LINES)}`,
      ).join("\n") +
      "\n```",
  ];
  const count = between(3, parts.length);
  return parts.slice(0, count).join("\n\n");
}

interface Activity {
  id: EventId;
  tone: "tool" | "info";
  kind: string;
  summary: string;
  payload: unknown;
  turnId: TurnId;
  sequence: number;
  createdAt: string;
}
let activitySequence = 5_000_000;
type Op = { at: number } & (
  | { kind: "activity"; activity: Activity }
  | { kind: "assistant"; messageId: MessageId; text: string; turnId: TurnId }
  | { kind: "user"; messageId: MessageId; text: string }
);

const iso = (ms: number) => new Date(ms).toISOString();

function toolCall(threadKey: string, turnId: TurnId, callIndex: number, at: number): Activity[] {
  const r = random();
  const family =
    r < 0.62 ? "bash" : r < 0.78 ? "mcp" : r < 0.88 ? "edit" : r < 0.97 ? "read" : "search";
  const file = `/workspaces/proj-01/${pick(FILES)}`;
  const callId = `toolu_real_${threadKey}_${callIndex}`;
  // Byte-size targets per tool family: updated / completed averages from real threads.
  const spec =
    family === "bash"
      ? {
          itemType: "command_execution",
          title: "Command run",
          toolName: "Bash",
          input: {
            command: `bun run test --filter ${pick(WORDS)} && grep -rn "${pick(WORDS)}" src | head -${between(5, 80)}`,
            description: sentence(4),
          } as Record<string, unknown>,
          updated: 2493,
          completed: 4131,
        }
      : family === "mcp"
        ? {
            itemType: "mcp_tool_call",
            title: "MCP tool call",
            toolName: `mcp__server__${pick(WORDS)}_${pick(WORDS)}`,
            input: { query: sentence(5), limit: between(1, 50) } as Record<string, unknown>,
            updated: 948,
            completed: 1581,
          }
        : family === "edit"
          ? {
              itemType: "file_change",
              title: "File change",
              toolName: "Edit",
              input: {
                file_path: file,
                old_string: textOfLength(sizeAround(900, 5000), CODE_LINES),
                new_string: textOfLength(sizeAround(1100, 5000), CODE_LINES),
              } as Record<string, unknown>,
              updated: 3472,
              completed: 5953,
            }
          : family === "read"
            ? {
                itemType: "dynamic_tool_call",
                title: "Tool call",
                toolName: "Read",
                input: { file_path: file } as Record<string, unknown>,
                updated: 1334,
                completed: 2577,
              }
            : {
                itemType: "web_search",
                title: "Web search",
                toolName: "WebSearch",
                input: { query: sentence(6) } as Record<string, unknown>,
                updated: 2130,
                completed: 3835,
              };
  const detail =
    family === "bash"
      ? `Bash: ${String(spec.input.command)}`
      : `${spec.toolName}: ${JSON.stringify(spec.input).slice(0, 160)}`;
  const base = { toolCallId: callId, callId, toolName: spec.toolName };
  const inputBytes = JSON.stringify(spec.input).length;
  const out: Activity[] = [];
  let step = 0;
  const push = (tone: "tool" | "info", kind: string, summary: string, payload: unknown) => {
    out.push({
      id: EventId.makeUnsafe(`real-act-${threadKey}-${callIndex}-${step}`),
      tone,
      kind,
      summary,
      payload,
      turnId,
      sequence: (activitySequence += 1),
      createdAt: iso(at + step * 300),
    });
    step += 1;
  };
  push("tool", "tool.started", `${spec.title} started`, {
    itemType: spec.itemType,
    status: "inProgress",
    title: spec.title,
    detail: `${spec.toolName}: {}`,
    data: { ...base, input: {} },
  });
  const updates = family === "bash" ? between(1, 2) : family === "mcp" ? between(1, 3) : 1;
  for (let index = 0; index < updates; index += 1) {
    const partial = textOfLength(
      Math.max(0, sizeAround(spec.updated) - inputBytes - 300),
      CODE_LINES,
    );
    push("tool", "tool.updated", spec.title, {
      itemType: spec.itemType,
      status: "inProgress",
      title: spec.title,
      detail,
      data: {
        ...base,
        input: spec.input,
        ...(partial.length > 0 && family !== "edit" ? { rawOutput: { output: partial } } : {}),
      },
    });
  }
  const output = textOfLength(
    Math.max(40, Math.round((sizeAround(spec.completed) - inputBytes - 400) / 2)),
    CODE_LINES,
  );
  push("tool", "tool.completed", spec.title, {
    itemType: spec.itemType,
    status: "completed",
    title: spec.title,
    detail,
    data: {
      ...base,
      input: spec.input,
      result: { tool_use_id: callId, type: "tool_result", content: output, is_error: false },
      rawOutput: { output },
    },
  });
  // Real threads carry roughly one context-window update per tool call.
  if (random() < 0.9) {
    push("info", "context-window.updated", "Context window updated", {
      usedTokens: between(20_000, 180_000),
      maxTokens: 200_000,
      totalTokens: between(20_000, 180_000),
      inputTokens: between(1, 400),
      cachedInputTokens: between(10_000, 170_000),
      outputTokens: between(50, 4000),
      lastUsedTokens: between(20_000, 180_000),
      compactsAutomatically: true,
    });
  }
  return out;
}

function buildAgentThread(
  threadKey: string,
  turns: number,
  toolCallsPerTurn: [number, number],
  startMs: number,
): Op[] {
  const ops: Op[] = [];
  let at = startMs;
  let callIndex = 0;
  let messageIndex = 0;
  const messageId = () =>
    MessageId.makeUnsafe(`real-msg-${threadKey}-${String((messageIndex += 1)).padStart(5, "0")}`);
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = TurnId.makeUnsafe(`real-turn-${threadKey}-${turn}`);
    ops.push({
      kind: "user",
      at,
      messageId: messageId(),
      text: `${sentence(between(8, 40))}?${random() < 0.2 ? `\n\n\`\`\`\n${textOfLength(between(200, 900), CODE_LINES)}\n\`\`\`` : ""}`,
    });
    at += 2_000;
    ops.push({
      kind: "activity",
      at,
      activity: {
        id: EventId.makeUnsafe(`real-act-${threadKey}-turn-${turn}-start`),
        tone: "info",
        kind: "turn.started",
        summary: "Turn started",
        payload: { model: "claude-sonnet-5", provider: "claudeAgent" },
        turnId,
        sequence: (activitySequence += 1),
        createdAt: iso(at),
      },
    });
    const calls = between(toolCallsPerTurn[0], toolCallsPerTurn[1]);
    for (let call = 0; call < calls; call += 1) {
      at += 1_500;
      if (call === 0 || random() < 0.13) {
        ops.push({ kind: "assistant", at, messageId: messageId(), text: narration(), turnId });
        at += 800;
      }
      for (const activity of toolCall(threadKey, turnId, (callIndex += 1), at)) {
        ops.push({ kind: "activity", at: Date.parse(activity.createdAt), activity });
      }
      at += 2_500;
    }
    at += 1_500;
    ops.push({ kind: "assistant", at, messageId: messageId(), text: finalAnswer(), turnId });
    at += 1_000;
    ops.push({
      kind: "activity",
      at,
      activity: {
        id: EventId.makeUnsafe(`real-act-${threadKey}-turn-${turn}-end`),
        tone: "info",
        kind: "turn.completed",
        summary: "Turn completed",
        payload: {
          state: "completed",
          provider: "claudeAgent",
          tokenAccountingVersion: 1,
          mainLoopTokens: between(48_000, 138_000),
          claudeResultObserved: true,
        },
        turnId,
        sequence: (activitySequence += 1),
        createdAt: iso(at),
      },
    });
    at += 60_000;
  }
  return ops;
}

function buildProseThread(threadKey: string, exchanges: number, startMs: number): Op[] {
  const ops: Op[] = [];
  let at = startMs;
  for (let index = 0; index < exchanges; index += 1) {
    const turnId = TurnId.makeUnsafe(`real-turn-${threadKey}-${index}`);
    ops.push({
      kind: "user",
      at,
      messageId: MessageId.makeUnsafe(
        `real-msg-${threadKey}-${String(index * 2).padStart(5, "0")}`,
      ),
      text: `${sentence(between(10, 60))}?`,
    });
    at += 20_000;
    ops.push({
      kind: "assistant",
      at,
      messageId: MessageId.makeUnsafe(
        `real-msg-${threadKey}-${String(index * 2 + 1).padStart(5, "0")}`,
      ),
      text: [finalAnswer(), finalAnswer()].slice(0, between(1, 2)).join("\n\n"),
      turnId,
    });
    at += 40_000;
  }
  return ops;
}

export interface RealisticThreadManifest {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly messages: number;
  readonly activities: number;
  readonly messageKb: number;
  readonly activityKb: number;
}

/** Writes the three realistic threads into `projectId` through the orchestration engine. */
export async function seedRealisticThreads(
  dispatch: Dispatch,
  projectId: ProjectId,
): Promise<RealisticThreadManifest[]> {
  const baseTime = Date.parse("2026-11-16T08:00:00.000Z");
  const plans: Array<{ key: string; title: string; ops: Op[] }> = [
    // ~36 turns x ~40 tool calls: about 1,400 tool calls, 5,000+ activity rows and ~190
    // assistant messages. More activities than the 2,000-row detail window.
    {
      key: "agent-heavy",
      title: "Bench real-shape agent heavy",
      ops: buildAgentThread("agent-heavy", 36, [18, 60], baseTime),
    },
    // A mid-size agent thread whose activities all fit the detail window.
    {
      key: "agent-mid",
      title: "Bench real-shape agent mid",
      ops: buildAgentThread("agent-mid", 12, [10, 40], baseTime + 3_600_000),
    },
    // Prose and code heavy, no tools: 150 exchanges of long markdown answers.
    {
      key: "prose",
      title: "Bench real-shape prose",
      ops: buildProseThread("prose", 150, baseTime + 7_200_000),
    },
  ];
  const manifest: RealisticThreadManifest[] = [];
  for (const plan of plans) {
    const threadId = ThreadId.makeUnsafe(`real-thread-${plan.key}`);
    await dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(`real-cmd-thread-${plan.key}`),
      threadId,
      projectId,
      title: plan.title,
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: iso(plan.ops[0]!.at - 1000),
    });
    let messages = 0;
    let activities = 0;
    let activityBytes = 0;
    let messageBytes = 0;
    for (const [index, op] of plan.ops.entries()) {
      const createdAt = iso(op.at);
      if (op.kind === "user") {
        await dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(`real-cmd-${plan.key}-${index}`),
          threadId,
          messages: [
            {
              messageId: op.messageId,
              role: "user",
              text: op.text,
              createdAt,
              updatedAt: createdAt,
            },
          ],
          createdAt,
        });
        messages += 1;
        messageBytes += op.text.length;
      } else if (op.kind === "assistant") {
        await dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe(`real-cmd-${plan.key}-${index}-d`),
          threadId,
          messageId: op.messageId,
          delta: op.text,
          turnId: op.turnId,
          createdAt,
        });
        await dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe(`real-cmd-${plan.key}-${index}-c`),
          threadId,
          messageId: op.messageId,
          turnId: op.turnId,
          createdAt,
        });
        messages += 1;
        messageBytes += op.text.length;
      } else {
        await dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`real-cmd-${op.activity.id}`),
          threadId,
          activity: op.activity,
          createdAt: op.activity.createdAt,
        });
        activities += 1;
        activityBytes += JSON.stringify(op.activity.payload).length;
      }
    }
    manifest.push({
      threadId,
      projectId,
      title: plan.title,
      messages,
      activities,
      messageKb: Math.round(messageBytes / 1024),
      activityKb: Math.round(activityBytes / 1024),
    });
    console.error(`seeded ${plan.key}: ${messages} messages, ${activities} activities`);
  }
  return manifest;
}
