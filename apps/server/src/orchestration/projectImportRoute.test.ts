import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderStartOptions,
  SpaceId,
  ThreadId,
  type ImportProjectInput,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectImportProvider,
  type ProviderForkThreadResult,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectImportOrigin,
  ProjectImportRepository,
} from "../persistence/projectImportRepository";
import type { NativeProjectImportCatalog } from "../provider/projectImportTypes";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ReadProjectImportHistoryInput } from "./projectImportHistory";
import { makeProjectImportHandlers } from "./projectImportRoute";

const CREATED_AT = "2026-09-01T10:00:00.000Z";
const UPDATED_AT = "2026-09-02T10:00:00.000Z";
const temporaryDirectories: string[] = [];
type NativeImportInput = Parameters<NonNullable<ProviderServiceShape["importExternalThread"]>>[0];

async function workspace() {
  const temporary = await mkdtemp(path.join(tmpdir(), "synara-project-import-route-"));
  temporaryDirectories.push(temporary);
  const directory = await realpath(temporary);
  const root = path.join(directory, "workspace");
  await mkdir(root);
  return { directory, root };
}

function existingProject(workspaceRoot: string): OrchestrationProject {
  return {
    id: ProjectId.makeUnsafe("existing-project"),
    kind: "project",
    title: "My existing project",
    workspaceRoot,
    defaultModelSelection: { provider: "codex", model: "saved-model" },
    scripts: [],
    isPinned: true,
    spaceId: SpaceId.makeUnsafe("existing-space"),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    deletedAt: null,
  };
}

function nativeCatalog(root: string, provider: ProjectImportProvider): NativeProjectImportCatalog {
  return {
    sourceHome: path.join(path.dirname(root), `${provider}-home`),
    projects: [{ id: `native-${provider}`, title: "Native project", roots: [root] }],
    sessions: [
      {
        id: `${provider}-original`,
        title: `${provider} conversation`,
        cwd: root,
        projectId: `native-${provider}`,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        archived: false,
      },
    ],
  };
}

function harness(input: {
  root: string;
  projects?: OrchestrationProject[];
  providers?: ProjectImportProvider[];
  disabled?: ProjectImportProvider;
  paths?: {
    codexBinaryPath?: string;
    codexHomePath?: string;
    claudeBinaryPath?: string;
  };
}) {
  const providers = input.providers ?? ["codex"];
  const projects = [...(input.projects ?? [])];
  const threads: { id: ThreadId; projectId: ProjectId; deletedAt: string | null }[] = [];
  const commands: OrchestrationCommand[] = [];
  const appliedCommandIds = new Set<string>();
  const importedMessages = new Map<ThreadId, ReadonlyArray<ThreadHandoffImportedMessage>>();
  const origins = new Map<string, ProjectImportOrigin>();
  const bindings: {
    threadId: ThreadId;
    projectId: ProjectId;
    provider: string;
    cursor: string | null;
  }[] = [];
  const catalogs = new Map(
    providers.map((provider) => [provider, nativeCatalog(input.root, provider)]),
  );
  const complete = vi.fn(
    (sourceKey: string): Effect.Effect<void, unknown> =>
      Effect.sync(() => {
        const origin = origins.get(sourceKey);
        if (!origin) throw new Error("Origin was not reserved");
        origins.set(sourceKey, { ...origin, status: "completed" });
      }),
  );
  const repository = {
    list: () => Effect.sync(() => [...origins.values()]),
    find: (key: string) => Effect.sync(() => origins.get(key)),
    reserve: (origin: ProjectImportOrigin, replacingThreadId?: ThreadId) =>
      Effect.sync(() => {
        const current = origins.get(origin.sourceKey);
        if (current && current.threadId !== replacingThreadId) return undefined;
        origins.set(origin.sourceKey, origin);
        return origin;
      }),
    complete,
    listNativeBindings: () => Effect.sync(() => bindings),
  } as unknown as ProjectImportRepository;
  const importExternalThread = vi.fn(
    (nativeInput: NativeImportInput): Effect.Effect<ProviderForkThreadResult, unknown> =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(ProviderStartOptions)(nativeInput.providerOptions);
        return {
          threadId: nativeInput.threadId,
          resumeCursor:
            nativeInput.provider === "codex"
              ? { threadId: `${nativeInput.externalThreadId}-copy` }
              : { resume: `${nativeInput.externalThreadId}-copy` },
        };
      }),
  );
  const stopRuntimeSession = vi.fn(
    (_input: { threadId: ThreadId }): Effect.Effect<void, unknown> => Effect.void,
  );
  const readHistory = vi.fn(
    (
      historyInput: ReadProjectImportHistoryInput,
    ): Effect.Effect<ReadonlyArray<ThreadHandoffImportedMessage>, unknown> =>
      Effect.succeed([
        {
          messageId: MessageId.makeUnsafe(`import:${historyInput.threadId}:first`),
          role: "user",
          text: "Imported fixture message",
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ]),
  );
  const engine = {
    getReadModel: () => Effect.succeed({ projects, threads } as unknown as OrchestrationReadModel),
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        if (appliedCommandIds.has(command.commandId)) return { sequence: commands.length };
        appliedCommandIds.add(command.commandId);
        if (command.type === "project.create")
          projects.push({
            ...existingProject(command.workspaceRoot),
            id: command.projectId,
            title: command.title,
            defaultModelSelection: command.defaultModelSelection ?? null,
            isPinned: false,
            spaceId: command.spaceId ?? null,
          });
        if (command.type === "thread.create")
          threads.push({ id: command.threadId, projectId: command.projectId, deletedAt: null });
        if (command.type === "thread.messages.import") {
          importedMessages.set(command.threadId, [
            ...(importedMessages.get(command.threadId) ?? []),
            ...command.messages,
          ]);
        }
        return { sequence: commands.length };
      }),
  } as unknown as OrchestrationEngineShape;
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        enabled: input.disabled !== "codex",
        binaryPath:
          input.paths?.codexBinaryPath ?? DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath,
        homePath: input.paths?.codexHomePath ?? DEFAULT_SERVER_SETTINGS.providers.codex.homePath,
      },
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        enabled: input.disabled !== "claudeAgent",
        binaryPath:
          input.paths?.claudeBinaryPath ?? DEFAULT_SERVER_SETTINGS.providers.claudeAgent.binaryPath,
      },
    },
  };
  const handlers = makeProjectImportHandlers({
    repository,
    orchestrationEngine: engine,
    providerService: {
      importExternalThread,
      stopRuntimeSession,
    } as unknown as ProviderServiceShape,
    providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
    serverSettings: { getSettings: Effect.succeed(settings) } as unknown as ServerSettingsShape,
    discover: async (provider) => catalogs.get(provider)!,
    readHistory,
  });
  const preview = () => Effect.runPromise(handlers.listProjectImports({ providers }));
  const request = async (
    provider: ProjectImportProvider = providers[0]!,
  ): Promise<ImportProjectInput> => {
    const catalog = await preview();
    const project = catalog.projects.find((entry) =>
      entry.threads.some((thread) => thread.provider === provider),
    );
    if (!project) throw new Error("Missing fixture project");
    return {
      projectKey: project.key,
      threadKey: project.threads.find((entry) => entry.provider === provider)!.key,
    };
  };
  return {
    ...handlers,
    preview,
    request,
    projects,
    threads,
    commands,
    origins,
    bindings,
    importedMessages,
    importExternalThread,
    stopRuntimeSession,
    readHistory,
    complete,
    catalogs,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project import routes", () => {
  it.each([
    {
      name: "empty Codex overrides",
      provider: "codex" as const,
      paths: { codexBinaryPath: "", codexHomePath: "" },
      expected: { codex: {} },
    },
    {
      name: "whitespace Codex overrides",
      provider: "codex" as const,
      paths: { codexBinaryPath: "  \t", codexHomePath: " \n " },
      expected: { codex: {} },
    },
    {
      name: "configured Codex executable with default home",
      provider: "codex" as const,
      paths: { codexBinaryPath: "codex" },
      expected: { codex: { binaryPath: "codex" } },
    },
    {
      name: "trimmed Codex overrides",
      provider: "codex" as const,
      paths: { codexBinaryPath: " /custom/bin/codex ", codexHomePath: " /custom/codex-home " },
      expected: { codex: { binaryPath: "/custom/bin/codex", homePath: "/custom/codex-home" } },
    },
    {
      name: "empty Claude executable",
      provider: "claudeAgent" as const,
      paths: { claudeBinaryPath: "" },
      expected: { claudeAgent: {} },
    },
    {
      name: "whitespace Claude executable",
      provider: "claudeAgent" as const,
      paths: { claudeBinaryPath: " \t " },
      expected: { claudeAgent: {} },
    },
    {
      name: "trimmed Claude executable",
      provider: "claudeAgent" as const,
      paths: { claudeBinaryPath: " /custom/bin/claude " },
      expected: { claudeAgent: { binaryPath: "/custom/bin/claude" } },
    },
  ])("passes $name through native copy and history", async ({ provider, paths, expected }) => {
    const { root } = await workspace();
    const test = harness({ root, providers: [provider], paths });
    const result = await Effect.runPromise(test.importProject(await test.request(provider)));

    expect(result.status).toBe("imported");
    expect(test.importExternalThread.mock.calls[0]?.[0].providerOptions).toEqual(expected);
    expect(test.readHistory.mock.calls[0]?.[0].providerOptions).toEqual(expected);
  });

  it("links a physical folder through its alias without copying or creating filesystem entries", async () => {
    const { directory, root } = await workspace();
    await writeFile(path.join(root, "existing.txt"), "unchanged source");
    const alias = path.join(directory, "alias");
    await symlink(root, alias, "dir");
    const test = harness({ root: alias });
    const request = await test.request();
    const before = await readdir(directory, { recursive: true });

    const result = await Effect.runPromise(test.importProject({ ...request, threadKey: null }));

    expect(result.status).toBe("project-linked");
    expect(test.projects).toHaveLength(1);
    expect(test.projects[0]?.workspaceRoot).toBe(root);
    expect(await readdir(directory, { recursive: true })).toEqual(before);
    expect(await readFile(path.join(root, "existing.txt"), "utf8")).toBe("unchanged source");
    expect(test.importExternalThread).not.toHaveBeenCalled();
  });

  it("adds Codex and Claude conversations to the existing project without replacing its metadata", async () => {
    const { root } = await workspace();
    const project = existingProject(root);
    const test = harness({ root, projects: [project], providers: ["codex", "claudeAgent"] });
    const codex = await test.request("codex");
    const claude = await test.request("claudeAgent");

    const first = await Effect.runPromise(test.importProject(codex));
    const second = await Effect.runPromise(test.importProject(claude));

    expect(first.projectId).toBe(project.id);
    expect(second.projectId).toBe(project.id);
    expect(test.projects).toEqual([project]);
    expect(test.threads).toHaveLength(2);
    expect(test.commands.some((command) => command.type.startsWith("project."))).toBe(false);
    expect(test.importExternalThread.mock.calls[0]?.[0].modelSelection).toEqual(
      project.defaultModelSelection,
    );
    expect(test.importExternalThread.mock.calls[1]?.[0].modelSelection.provider).toBe(
      "claudeAgent",
    );
    expect(test.commands.filter((command) => command.type === "thread.create")).toEqual([
      expect.objectContaining({ runtimeMode: "approval-required" }),
      expect.objectContaining({ runtimeMode: "approval-required" }),
    ]);
    expect(test.importExternalThread.mock.calls.map(([input]) => input.runtimeMode)).toEqual([
      "approval-required",
      "approval-required",
    ]);
    expect(test.readHistory.mock.calls.map(([value]) => value.nativeId)).toEqual([
      "codex-original-copy",
      "claudeAgent-original-copy",
    ]);
    expect(test.readHistory.mock.calls[1]?.[0].sourceCwd).toBe(root);
    expect(test.stopRuntimeSession).toHaveBeenCalledTimes(2);
  });

  it("skips a completed source on repeated requests and marks it present in the next preview", async () => {
    const { root } = await workspace();
    const test = harness({ root });
    const request = await test.request();
    const first = await Effect.runPromise(test.importProject(request));

    const second = await Effect.runPromise(test.importProject(request));

    expect(second).toEqual({ ...first, status: "already-present" });
    expect(test.importExternalThread).toHaveBeenCalledTimes(1);
    expect(test.threads).toHaveLength(1);
    expect((await test.preview()).projects[0]?.threads[0]?.alreadyImported).toBe(true);
  });

  it.each(["codex", "claudeAgent"] as const)(
    "reimports a deleted %s conversation with fresh command identities and history",
    async (provider) => {
      const { root } = await workspace();
      const test = harness({ root, providers: [provider] });
      const catalog = test.catalogs.get(provider)!;
      test.catalogs.set(provider, {
        ...catalog,
        sessions: [{ ...catalog.sessions[0]!, archived: true }],
      });
      const request = await test.request();
      const first = await Effect.runPromise(test.importProject(request));
      test.threads[0]!.deletedAt = UPDATED_AT;

      expect((await test.preview()).projects[0]?.threads[0]?.alreadyImported).toBe(false);
      const second = await Effect.runPromise(test.importProject(request));

      expect(second.status).toBe("imported");
      expect(second.threadId).not.toBe(first.threadId);
      expect(second.projectId).toBe(first.projectId);
      expect(test.threads.filter((thread) => thread.deletedAt === null)).toHaveLength(1);
      expect(test.importedMessages.get(second.threadId!)).toHaveLength(1);
      expect(test.importExternalThread).toHaveBeenCalledTimes(2);
      for (const type of ["thread.create", "thread.messages.import", "thread.archive"]) {
        const commands = test.commands.filter((command) => command.type === type);
        expect(commands).toHaveLength(2);
        expect(commands[0]?.commandId).not.toBe(commands[1]?.commandId);
      }
      expect([...test.origins.values()]).toMatchObject([
        { threadId: second.threadId, status: "completed" },
      ]);
      expect((await test.preview()).projects[0]?.threads[0]?.alreadyImported).toBe(true);
      await expect(Effect.runPromise(test.importProject(request))).resolves.toEqual({
        ...second,
        status: "already-present",
      });
    },
  );

  it("restarts a deleted pending copy, then reuses its replacement when another retry is needed", async () => {
    const { root } = await workspace();
    const test = harness({ root });
    const request = await test.request();
    test.readHistory.mockReturnValueOnce(Effect.fail(new Error("history unavailable")));
    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "history unavailable",
    );
    const deletedThreadId = test.threads[0]!.id;
    test.threads[0]!.deletedAt = UPDATED_AT;

    test.complete.mockReturnValueOnce(Effect.fail(new Error("ledger unavailable")));
    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "ledger unavailable",
    );
    const replacement = [...test.origins.values()][0]!;
    expect(replacement.threadId).not.toBe(deletedThreadId);
    expect(replacement.status).toBe("pending");
    const result = await Effect.runPromise(test.importProject(request));

    expect(result.threadId).toBe(replacement.threadId);
    expect(test.threads.filter((thread) => thread.deletedAt === null)).toHaveLength(1);
    expect(test.importedMessages.get(result.threadId!)).toHaveLength(1);
    expect(test.importExternalThread.mock.calls.map(([input]) => input.threadId)).toEqual([
      deletedThreadId,
      replacement.threadId,
      replacement.threadId,
    ]);
  });

  it.each(["pending", "completed"] as const)(
    "recreates a removed project for a %s import",
    async (status) => {
      const { root } = await workspace();
      const test = harness({ root });
      const request = await test.request();
      if (status === "pending")
        test.readHistory.mockReturnValueOnce(Effect.fail(new Error("history unavailable")));
      await Effect.runPromise(Effect.result(test.importProject(request)));
      const previous = [...test.origins.values()][0]!;
      test.projects[0] = { ...test.projects[0]!, deletedAt: UPDATED_AT };

      expect((await test.preview()).projects[0]?.threads[0]?.alreadyImported).toBe(false);
      const result = await Effect.runPromise(test.importProject(request));

      expect(result.status).toBe("imported");
      expect(result.projectId).not.toBe(previous.projectId);
      expect(result.threadId).not.toBe(previous.threadId);
      expect(test.projects.filter((project) => project.deletedAt === null)).toHaveLength(1);
      expect(test.importedMessages.get(result.threadId!)).toHaveLength(1);
    },
  );

  it("recovers a completed import whose destination is missing", async () => {
    const { root } = await workspace();
    const test = harness({ root });
    const request = await test.request();
    const first = await Effect.runPromise(test.importProject(request));
    test.threads.splice(0);

    expect((await test.preview()).projects[0]?.threads[0]?.alreadyImported).toBe(false);
    const second = await Effect.runPromise(test.importProject(request));

    expect(second.threadId).not.toBe(first.threadId);
    expect(test.threads).toHaveLength(1);
    expect(test.importedMessages.get(second.threadId!)).toHaveLength(1);
  });

  it("retains a reservation interrupted before its thread was created", async () => {
    const { root } = await workspace();
    const project = existingProject(root);
    const test = harness({ root, projects: [project] });
    const request = await test.request();
    const threadId = ThreadId.makeUnsafe("reserved-before-crash");
    test.origins.set(request.threadKey!, {
      sourceKey: request.threadKey!,
      provider: "codex",
      sourceHome: test.catalogs.get("codex")!.sourceHome,
      externalId: "codex-original",
      projectId: project.id,
      threadId,
      status: "pending",
      createdAt: CREATED_AT,
    });

    const result = await Effect.runPromise(test.importProject(request));

    expect(result.threadId).toBe(threadId);
    expect(test.threads).toHaveLength(1);
    expect(test.importedMessages.get(threadId)).toHaveLength(1);
  });

  it("rechecks physical folder identity when an aliased destination appears after preview", async () => {
    const { directory, root } = await workspace();
    const alias = path.join(directory, "saved-project-alias");
    await symlink(root, alias, "dir");
    const test = harness({ root });
    const request = await test.request();
    const project = existingProject(alias);
    test.projects.push(project);

    const result = await Effect.runPromise(test.importProject(request));

    expect(result.projectId).toBe(project.id);
    expect(test.projects).toEqual([project]);
    expect(test.commands.some((command) => command.type === "project.create")).toBe(false);
  });

  it("skips a native session already owned by Synara even without an import origin", async () => {
    const { root } = await workspace();
    const project = existingProject(root);
    const test = harness({ root, projects: [project] });
    const threadId = ThreadId.makeUnsafe("original-synara-thread");
    test.threads.push({ id: threadId, projectId: project.id, deletedAt: null });
    test.bindings.push({
      threadId,
      projectId: project.id,
      provider: "codex",
      cursor: JSON.stringify({ threadId: "codex-original" }),
    });
    const request = await test.request();

    const result = await Effect.runPromise(test.importProject(request));

    expect(result).toEqual({ projectId: project.id, threadId, status: "already-present" });
    expect(test.commands).toEqual([]);
    expect(test.importExternalThread).not.toHaveBeenCalled();
    expect(test.origins.size).toBe(0);
  });

  it("ignores a stale native binding belonging to a deleted conversation", async () => {
    const { root } = await workspace();
    const project = existingProject(root);
    const test = harness({ root, projects: [project] });
    const threadId = ThreadId.makeUnsafe("deleted-native-thread");
    test.threads.push({ id: threadId, projectId: project.id, deletedAt: UPDATED_AT });
    test.bindings.push({
      threadId,
      projectId: project.id,
      provider: "codex",
      cursor: JSON.stringify({ threadId: "codex-original" }),
    });
    const request = await test.request();

    expect((await test.preview()).projects[0]?.threads[0]?.alreadyImported).toBe(false);
    const result = await Effect.runPromise(test.importProject(request));

    expect(result.status).toBe("imported");
    expect(result.threadId).not.toBe(threadId);
    expect(test.importedMessages.get(result.threadId!)).toHaveLength(1);
  });

  it("keeps a pending import attached to its original destination when retrying", async () => {
    const { directory, root } = await workspace();
    const replacement = path.join(directory, "replacement");
    await mkdir(replacement);
    const test = harness({ root });
    const request = await test.request();
    test.readHistory.mockImplementationOnce(() => Effect.fail(new Error("read failed")));
    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow("read failed");

    await expect(
      Effect.runPromise(test.importProject({ ...request, workspaceRoot: replacement })),
    ).rejects.toThrow("keeps its original destination");
    expect(test.importExternalThread).toHaveBeenCalledTimes(1);
    expect(test.projects[0]?.workspaceRoot).toBe(root);
    expect(test.threads).toHaveLength(1);

    await expect(Effect.runPromise(test.importProject(request))).resolves.toMatchObject({
      status: "imported",
    });
  });

  it("retains a failed history reservation, releases the runtime, and retries the same destination", async () => {
    const { root } = await workspace();
    const test = harness({ root, paths: { codexBinaryPath: " ", codexHomePath: " \t " } });
    const request = await test.request();
    test.readHistory.mockImplementationOnce(() => Effect.fail(new Error("history unavailable")));

    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "history unavailable",
    );
    const pending = [...test.origins.values()][0]!;
    expect(pending.status).toBe("pending");
    expect(test.stopRuntimeSession).toHaveBeenCalledWith({ threadId: pending.threadId });
    expect(test.importedMessages.size).toBe(0);

    const result = await Effect.runPromise(test.importProject(request));

    expect(result.threadId).toBe(pending.threadId);
    expect(test.projects).toHaveLength(1);
    expect(test.threads).toHaveLength(1);
    expect(test.commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
    expect(test.importExternalThread.mock.calls.map(([value]) => value.threadId)).toEqual([
      pending.threadId,
      pending.threadId,
    ]);
    expect(test.importedMessages.get(pending.threadId)).toHaveLength(1);
    expect(test.origins.get(pending.sourceKey)?.status).toBe("completed");
  });

  it("replays deterministic message commands without duplication after ledger completion fails", async () => {
    const { root } = await workspace();
    const test = harness({ root });
    const request = await test.request();
    test.complete.mockImplementationOnce(() => Effect.fail(new Error("ledger unavailable")));

    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "ledger unavailable",
    );
    const pending = [...test.origins.values()][0]!;
    expect(test.importedMessages.get(pending.threadId)).toHaveLength(1);
    await Effect.runPromise(test.importProject(request));

    const messages = test.commands.filter((command) => command.type === "thread.messages.import");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.commandId).toBe(messages[1]?.commandId);
    expect(test.importedMessages.get(pending.threadId)).toHaveLength(1);
    expect(test.origins.get(pending.sourceKey)?.status).toBe("completed");
  });

  it("releases the native runtime when copying fails before history is read", async () => {
    const { root } = await workspace();
    const test = harness({ root });
    const request = await test.request();
    test.importExternalThread.mockImplementationOnce(() =>
      Effect.fail(new Error("native fork failed")),
    );

    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "native fork failed",
    );

    expect(test.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(test.readHistory).not.toHaveBeenCalled();
    expect([...test.origins.values()][0]?.status).toBe("pending");
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("rejects a provider result that still points to the original native session", async () => {
    const { root } = await workspace();
    const test = harness({ root, providers: ["claudeAgent"] });
    const request = await test.request();
    test.importExternalThread.mockImplementationOnce((value) =>
      Effect.succeed({
        threadId: value.threadId,
        resumeCursor: { resume: value.externalThreadId },
      }),
    );

    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "independent conversation copy",
    );

    expect(test.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(test.readHistory).not.toHaveBeenCalled();
    expect([...test.origins.values()][0]?.status).toBe("pending");
  });

  it("preserves a missing source folder without creating it or inventing a runtime cwd", async () => {
    const { directory } = await workspace();
    const missingRoot = path.join(directory, "removed-project");
    const test = harness({ root: missingRoot });
    const request = await test.request();
    expect((await test.preview()).projects[0]?.directoryExists).toBe(false);

    const result = await Effect.runPromise(test.importProject(request));

    expect(result.status).toBe("imported");
    expect(test.projects[0]?.workspaceRoot).toBe(missingRoot);
    expect(test.importExternalThread.mock.calls[0]?.[0]).toMatchObject({ sourceCwd: missingRoot });
    expect(test.importExternalThread.mock.calls[0]?.[0]).not.toHaveProperty("cwd");
    await expect(access(missingRoot)).rejects.toThrow();
  });

  it.each(["codex"] as const)(
    "preserves a %s monorepo conversation's existing worktree cwd after runtime restart",
    async (provider) => {
      const { directory, root } = await workspace();
      const projectRoot = path.join(root, "apps", "api");
      const worktree = path.join(directory, "external-worktree");
      const sourceCwd = path.join(worktree, "apps", "api", "src");
      const gitDirectory = path.join(root, ".git", "worktrees", "imported");
      await mkdir(gitDirectory, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await mkdir(sourceCwd, { recursive: true });
      await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
      const project = existingProject(projectRoot);
      const test = harness({ root: projectRoot, providers: [provider], projects: [project] });
      const catalog = nativeCatalog(projectRoot, provider);
      test.catalogs.set(provider, {
        ...catalog,
        sessions: [{ ...catalog.sessions[0]!, cwd: sourceCwd }],
      });

      const result = await Effect.runPromise(test.importProject(await test.request()));

      expect(result.projectId).toBe(project.id);
      const created = test.commands.find((command) => command.type === "thread.create")!;
      expect(created).toMatchObject({
        envMode: "worktree",
        worktreePath: worktree,
        workingDirectory: sourceCwd,
      });
      expect(test.importExternalThread.mock.calls[0]?.[0]).toMatchObject({
        sourceCwd,
        cwd: sourceCwd,
      });
      expect(resolveThreadWorkspaceCwd({ projectCwd: projectRoot, ...created })).toBe(sourceCwd);
    },
  );

  it("uses an explicitly relinked folder instead of retaining the old worktree cwd", async () => {
    const { directory, root } = await workspace();
    const worktree = path.join(directory, "old-worktree");
    const replacement = path.join(directory, "replacement");
    const gitDirectory = path.join(root, ".git", "worktrees", "imported");
    await mkdir(gitDirectory, { recursive: true });
    await mkdir(worktree);
    await mkdir(replacement);
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
    const test = harness({ root });
    const catalog = nativeCatalog(root, "codex");
    test.catalogs.set("codex", {
      ...catalog,
      sessions: [{ ...catalog.sessions[0]!, cwd: worktree }],
    });

    await Effect.runPromise(
      test.importProject({ ...(await test.request()), workspaceRoot: replacement }),
    );

    const created = test.commands.find((command) => command.type === "thread.create")!;
    expect(created).toMatchObject({ envMode: "local", worktreePath: null });
    expect(created.workingDirectory).toBeUndefined();
    expect(test.importExternalThread.mock.calls[0]?.[0]).toMatchObject({
      sourceCwd: worktree,
      cwd: replacement,
    });
  });

  it("rejects a nonexistent replacement folder before creating a project or reserving a source", async () => {
    const { directory, root } = await workspace();
    const test = harness({ root });
    const request = await test.request();

    await expect(
      Effect.runPromise(
        test.importProject({
          ...request,
          workspaceRoot: path.join(directory, "missing-replacement"),
        }),
      ),
    ).rejects.toThrow("does not exist");

    expect(test.commands).toEqual([]);
    expect(test.origins.size).toBe(0);
    expect(test.importExternalThread).not.toHaveBeenCalled();
  });

  it("refuses a disabled provider before creating or importing anything", async () => {
    const { root } = await workspace();
    const test = harness({ root, disabled: "codex" });
    const request = await test.request();

    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "disabled in Settings",
    );

    expect(test.commands).toEqual([]);
    expect(test.origins.size).toBe(0);
    expect(test.importExternalThread).not.toHaveBeenCalled();
  });

  it("does not mark an import complete when native cleanup fails", async () => {
    const { root } = await workspace();
    const test = harness({ root });
    const request = await test.request();
    test.stopRuntimeSession.mockImplementationOnce(() =>
      Effect.fail(new Error("cleanup unproven")),
    );

    await expect(Effect.runPromise(test.importProject(request))).rejects.toThrow(
      "cleanup unproven",
    );

    expect([...test.origins.values()][0]?.status).toBe("pending");
    expect(test.complete).not.toHaveBeenCalled();
  });
});
