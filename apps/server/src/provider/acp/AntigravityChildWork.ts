// Reads bounded, provider-owned Antigravity child records for a single ACP session.
// A parent descriptor and a matching child launch receipt both establish ownership.
// @effect-diagnostics nodeBuiltinImport:off -- no-follow opens and lstat verify profile ownership.
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePlatformHomeDirectory } from "@synara/shared/platformEnvironment";
import { Effect } from "effect";
import { ACP_SUBAGENT_TOOL_KIND } from "./AcpAdapterSupport.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const NATIVE_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const MAX_DIRECTORY_ENTRIES = 128;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_RECORDS = 256;
const sessionMetadataSegments = (id: string) => [
  "antigravity-cli",
  "brain",
  id,
  ".system_generated",
];

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export interface AntigravityChildWork {
  readonly threadId: string;
  readonly role?: string;
  readonly prompt?: string;
  readonly latestUpdate?: string;
  readonly status?: "stopped";
  readonly atWork: boolean;
}

interface AntigravityChildSnapshot {
  readonly children: ReadonlyMap<string, ReadonlyArray<AntigravityChildWork>>;
  readonly waking: boolean;
}

const SUBAGENT_TOOL_NAME = /^(?:start|invoke)_subagent$/u;
const LEGACY_SUBAGENT_TITLE = /^(?:Run(?:ning)? )?(?:start|invoke)_subagent\??$/u;

/** Projects native launches onto the existing collab activity shape. */
export function asAntigravitySubagentCall(
  toolCall: AcpToolCallState,
  previous?: AcpToolCallState,
): AcpToolCallState | undefined {
  const rawInput = record(toolCall.data.rawInput);
  const nativeName = rawInput?._toolName;
  if (
    toolCall.metadata?.is_mcp_tool_call === true ||
    (typeof nativeName === "string"
      ? !SUBAGENT_TOOL_NAME.test(nativeName)
      : !previous && !LEGACY_SUBAGENT_TITLE.test(toolCall.title ?? ""))
  ) {
    return undefined;
  }
  const entries = Array.isArray(rawInput?.Subagents) ? rawInput.Subagents.slice(0, 32) : [rawInput];
  const roles: string[] = [];
  const prompts: string[] = [];
  for (const entry of entries) {
    const input = record(entry);
    const role = typeof input?.Role === "string" ? input.Role.trim().slice(0, 256) : "";
    const prompt = typeof input?.Prompt === "string" ? input.Prompt.trim().slice(0, 4_000) : "";
    if (role) roles.push(role);
    if (prompt) prompts.push(entries.length > 1 && role ? `${role}\n${prompt}` : prompt);
  }
  const prompt = prompts.length > 0 ? prompts.join("\n\n").slice(0, 8_000) : previous?.data.prompt;
  const title = roles.length > 0 ? roles.join(", ") : previous?.title;
  return {
    ...toolCall,
    kind: ACP_SUBAGENT_TOOL_KIND,
    ...(title ? { title } : {}),
    ...(toolCall.status !== "failed" && typeof prompt === "string" ? { detail: prompt } : {}),
    data: {
      ...toolCall.data,
      kind: ACP_SUBAGENT_TOOL_KIND,
      tool: "task",
      ...(typeof prompt === "string" ? { prompt } : {}),
    },
  };
}

export function resolveAntigravityProfile(cwd: string, environment: NodeJS.ProcessEnv): string {
  // Synara leaves --gemini-dir and --app-data-dir at their native defaults.
  // Agy 1.5 ignores GEMINI_HOME on this launch path.
  return resolve(cwd, resolvePlatformHomeDirectory(environment), ".gemini");
}

// Require every managed component to be at its own literal path, including links within the profile.
async function managedPath(root: string, segments: ReadonlyArray<string>, directory: boolean) {
  let path = root;
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === "." || segment === ".." || /[\\/:]/u.test(segment))
      throw new Error("Invalid profile path");
    path = join(path, segment);
    const info = await lstat(path);
    if (directory || index < segments.length - 1 ? !info.isDirectory() : !info.isFile()) {
      throw new Error("Linked or invalid profile path");
    }
  }
  if ((await realpath(path)) !== path) throw new Error("Invalid profile path");
  return path;
}

/** Reads a snapshot of detached children and accepts only exact, unambiguous launch receipt IDs. */
export function readAntigravityChildWork(input: {
  readonly profile: string;
  readonly sessionId: string;
  readonly toolCallIds: ReadonlySet<string>;
}): Effect.Effect<AntigravityChildSnapshot | undefined> {
  if (!NATIVE_ID.test(input.sessionId) || input.toolCallIds.size === 0) {
    return Effect.succeed({ children: new Map(), waking: false });
  }
  return Effect.tryPromise(async (signal) => {
    if (!(await lstat(input.profile)).isDirectory()) return undefined;
    const root = await realpath(input.profile);
    let bytesLeft = MAX_SCAN_BYTES;
    let recordsLeft = MAX_SCAN_RECORDS;
    const names = async (segments: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
      const path = await managedPath(root, segments, true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!path) return [];
      const entries: string[] = [];
      let count = 0;
      for await (const entry of await opendir(path)) {
        signal.throwIfAborted();
        if (++count > MAX_DIRECTORY_ENTRIES) throw new Error("Profile directory limit exceeded");
        if (entry.name.endsWith(".json")) entries.push(entry.name);
      }
      return entries.toSorted();
    };
    const read = async (segments: ReadonlyArray<string>) => {
      signal.throwIfAborted();
      if (--recordsLeft < 0 || bytesLeft <= 0) throw new Error("Profile scan limit exceeded");
      const path = await managedPath(root, segments, false);
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = await handle.stat();
        const current = await lstat(path);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !current.isFile() ||
          stat.ino !== current.ino ||
          stat.dev !== current.dev ||
          (await realpath(path)) !== path ||
          stat.size > Math.min(bytesLeft, MAX_RECORD_BYTES)
        ) {
          throw new Error("Invalid profile record");
        }
        const contents = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
        if (bytesRead > stat.size) throw new Error("Profile record changed");
        bytesLeft -= bytesRead;
        return {
          data: record(JSON.parse(contents.toString("utf8", 0, bytesRead))),
          modifiedAt: stat.mtimeMs,
        };
      } finally {
        await handle.close();
      }
    };
    const descriptors = [...sessionMetadataSegments(input.sessionId), "subagents"];
    const children = new Map<string, AntigravityChildWork[]>();
    const childNames = (await names(descriptors)).filter((name) =>
      NATIVE_ID.test(name.slice(0, -5)),
    );
    if (childNames.length === 0) return { children, waking: false };
    const parentInbox = [...sessionMetadataSegments(input.sessionId), "messages"];
    const parentMessages = await names(parentInbox);
    const readReceipts = parentMessages.includes("read.json")
      ? (await read([...parentInbox, "read.json"])).data
      : undefined;
    const reported = new Map<string, { readonly text: string; readonly modifiedAt: number }>();
    const wakeSenders = new Set<string>();
    for (const name of parentMessages) {
      if (name === "read.json") continue;
      const { data: message, modifiedAt } = await read([...parentInbox, name]);
      if (typeof message?.sender !== "string") continue;
      if ((reported.get(message.sender)?.modifiedAt ?? -Infinity) < modifiedAt) {
        const text =
          typeof message.content === "string" ? message.content.trim().slice(0, 2_000) : "";
        reported.set(message.sender, { text, modifiedAt });
      }
      if (
        message.priority === "MESSAGE_PRIORITY_HIGH" &&
        readReceipts?.[name.slice(0, -5)] !== true &&
        (typeof message.id !== "string" || readReceipts?.[message.id] !== true)
      ) {
        wakeSenders.add(message.sender);
      }
    }
    let waking = false;
    for (const name of childNames) {
      const threadId = name.slice(0, -5);
      if (threadId === input.sessionId) continue;
      const { data: descriptor } = await read([...descriptors, name]);
      if (
        !descriptor ||
        (descriptor.conversationId !== undefined && descriptor.conversationId !== threadId)
      )
        continue;
      const inbox = [...sessionMetadataSegments(threadId), "messages"];
      const receipts = new Map<string, Record<string, unknown>>();
      for (const messageName of await names(inbox)) {
        if (messageName === "read.json") continue;
        const { data: message } = await read([...inbox, messageName]);
        if (message?.sender !== input.sessionId) continue;
        const tool = record(record(message.sourceMetadata)?.tool);
        if (tool?.conversationId !== undefined && tool.conversationId !== input.sessionId) continue;
        const call = record(tool?.toolCall);
        if (
          (call?.name !== "start_subagent" && call?.name !== "invoke_subagent") ||
          typeof call.id !== "string"
        )
          continue;
        receipts.set(call.id, message);
      }
      if (receipts.size !== 1) continue;
      const receipt = [...receipts.entries()][0];
      if (!receipt || !input.toolCallIds.has(receipt[0])) continue;
      if (wakeSenders.has(threadId)) waking = true;
      const role = record(descriptor.subagentDescriptor)?.role;
      const prompt = receipt[1].content;
      const stopped = descriptor.state === "SUBAGENT_STATE_KILLED";
      const latestUpdate = reported.get(threadId)?.text;
      const child: AntigravityChildWork = {
        threadId,
        ...(typeof role === "string" && role.trim() ? { role: role.trim().slice(0, 256) } : {}),
        ...(typeof prompt === "string" && prompt.trim()
          ? { prompt: prompt.trim().slice(0, 4_000) }
          : {}),
        ...(stopped ? { status: "stopped" as const } : {}),
        ...(latestUpdate ? { latestUpdate } : {}),
        // A report can mean done or waiting for guidance; don't infer a terminal status.
        atWork: descriptor.state === "SUBAGENT_STATE_ALIVE" && !reported.has(threadId),
      };
      const siblings = children.get(receipt[0]) ?? [];
      siblings.push(child);
      children.set(receipt[0], siblings);
    }
    return { children, waking };
  }).pipe(Effect.orElseSucceed(() => undefined));
}
