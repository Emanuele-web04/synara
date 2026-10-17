/** Notion provider state. Agent execution remains local and never implies remote completion. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  NotionChange,
  NotionConnection,
  NotionMapping,
  NotionReadInput,
  NotionWriteInput,
  TodoId,
  type NotionApi,
  type NotionObject,
  type NotionState,
  type NotionTodoReference,
  type Todo,
  type TodoStreamEvent,
  type TodoUpdateInput,
} from "@synara/contracts";
import {
  notionArray,
  notionCanonical,
  notionComparableValue,
  notionObject,
  notionPatchConflicts,
  notionPropertySnapshot,
  notionResourceId,
  notionString,
  notionTodoPatch,
  notionWritableValue,
  projectNotionTask,
  validateNotionMapping,
  validateNotionSprintPlan,
} from "@synara/shared/notion";
import { Schema } from "effect";
import { NotionClient, NotionFailure, readNotionJson } from "./client.ts";

const SECRET_LIMIT = 32 * 1024 * 1024;
const RECEIPT_AGE = 24 * 60 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const Credential = Schema.Struct({
  connection: NotionConnection,
  accessToken: Schema.String,
  brokerSession: Schema.String,
  brokerOrigin: Schema.String,
  botId: Schema.String,
});
const LocalTask = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  delegationBaseTurnId: Schema.NullOr(Schema.String),
  linkedAt: Schema.NullOr(Schema.String),
});
const TaskEntry = Schema.Struct({
  key: Schema.String,
  mappingId: Schema.String,
  page: Schema.Record(Schema.String, Schema.Unknown),
  local: LocalTask,
  updatedAt: Schema.String,
});
const ChangeEntry = Schema.Struct({
  input: NotionWriteInput,
  change: NotionChange,
  digest: Schema.String,
  attempted: Schema.Boolean,
  retryAt: Schema.Number,
  agentScope: Schema.optional(
    Schema.Struct({ mappingId: Schema.String, fingerprint: Schema.String }),
  ),
});
const Pending = Schema.Struct({
  id: Schema.String,
  verifier: Schema.String,
  expiresAt: Schema.String,
});
const Document = Schema.Struct({
  version: Schema.Literal(1),
  connections: Schema.Array(Credential).check(Schema.isMaxLength(20)),
  mappings: Schema.Array(NotionMapping).check(Schema.isMaxLength(50)),
  tasks: Schema.Array(TaskEntry).check(Schema.isMaxLength(10_000)),
  changes: Schema.Array(ChangeEntry).check(Schema.isMaxLength(2_000)),
  pending: Schema.Array(Pending).check(Schema.isMaxLength(20)),
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type CredentialValue = Mutable<typeof Credential.Type>;
type TaskValue = Mutable<typeof TaskEntry.Type>;
type ChangeValue = Mutable<typeof ChangeEntry.Type>;
export type NotionTask = Todo & { external: NotionTodoReference };
const noLink = (): typeof LocalTask.Type => ({
  threadId: null,
  delegationBaseTurnId: null,
  linkedAt: null,
});
const id = (value: string) => notionResourceId(value);
function asIso(value: unknown, fallback: string): string {
  const date = Date.parse(notionString(value));
  return Number.isFinite(date) ? new Date(date).toISOString() : fallback;
}
function sameResource(a: string, b: string): boolean {
  return a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();
}
export interface NotionRuntimeOptions {
  brokerOrigin: string | null;
  load: () => Promise<string | null>;
  save: (document: string) => Promise<void>;
  publish: (event: TodoStreamEvent) => void;
  fetch?: typeof fetch;
  now?: () => number;
  client?: (
    connectionId: string,
    options: ConstructorParameters<typeof NotionClient>[0],
  ) => NotionClient;
}
export class NotionRuntime {
  private readonly connections = new Map<string, CredentialValue>();
  private readonly mappings = new Map<string, NotionMapping>();
  private readonly tasks = new Map<string, TaskValue>();
  private readonly changes = new Map<string, ChangeValue>();
  private readonly pending = new Map<string, typeof Pending.Type>();
  private readonly clients = new Map<string, NotionClient>();
  private readonly revisions = new Map<string, number>();
  private readonly watermarks = new Map<string, { editedAt: string; fullAt: number }>();
  private epoch = 0;
  private revision = 0;
  private mutation: Promise<unknown> = Promise.resolve();
  private storageFailed = false;
  private initialized = false;
  private stopped = false;
  private syncPromise: Promise<void> | null = null;
  private lastSyncedAt: string | null = null;
  private syncError: string | null = null;
  private readonly signal = new AbortController();
  private readonly now: () => number;
  readonly brokerOrigin: string | null;
  constructor(private readonly options: NotionRuntimeOptions) {
    this.now = options.now ?? Date.now;
    if (options.brokerOrigin) {
      const url = new URL(options.brokerOrigin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error(
          "Configure an HTTPS Notion OAuth broker origin without a path or credentials.",
        );
      this.brokerOrigin = url.origin;
    } else this.brokerOrigin = null;
  }
  async init(): Promise<void> {
    if (this.initialized) throw new Error("Notion runtime already initialized.");
    const raw = await this.options.load();
    if (raw !== null) {
      if (Buffer.byteLength(raw) > SECRET_LIMIT)
        throw new Error("Notion storage exceeds its size limit.");
      let document: typeof Document.Type;
      try {
        document = Schema.decodeUnknownSync(Document)(JSON.parse(raw));
      } catch {
        throw new Error("Notion storage is invalid. Preserve the file and restore a valid backup.");
      }
      for (const value of document.connections) {
        if (
          this.connections.has(value.connection.id) ||
          value.connection.id !== `${id(value.connection.workspaceId)}:${id(value.botId)}`
        )
          throw new Error("Invalid Notion connection storage.");
        this.connections.set(value.connection.id, {
          ...value,
          connection: {
            ...value.connection,
            status:
              value.brokerOrigin === this.brokerOrigin ? value.connection.status : "needs-auth",
          },
        });
      }
      for (const value of document.mappings) {
        if (this.mappings.has(value.id) || !this.connections.has(value.connectionId))
          throw new Error("Invalid Notion mapping storage.");
        this.mappings.set(value.id, value);
      }
      for (const value of document.tasks) {
        const mapping = this.mappings.get(value.mappingId);
        if (
          !mapping ||
          this.tasks.has(value.key) ||
          value.key !== this.taskKey(mapping.connectionId, notionString(value.page.id))
        )
          throw new Error("Invalid Notion task storage.");
        if (this.connections.get(mapping.connectionId)?.connection.status === "connected")
          this.tasks.set(value.key, { ...value });
      }
      for (const value of document.changes) {
        if (
          this.changes.has(value.input.requestId) ||
          value.digest !== digest(notionCanonical(value.input)) ||
          value.change.id !== value.input.requestId ||
          value.change.connectionId !== value.input.connectionId ||
          !this.connections.has(value.input.connectionId) ||
          !Number.isFinite(value.retryAt)
        )
          throw new Error("Invalid Notion change storage.");
        if (this.connections.get(value.input.connectionId)?.connection.status === "connected")
          this.changes.set(value.input.requestId, {
            ...value,
            change:
              value.attempted && value.change.state === "pending"
                ? {
                    ...value.change,
                    state: "unknown",
                    message: "Delivery was interrupted. Inspect Notion before retrying.",
                  }
                : value.change,
          });
      }
      for (const value of document.pending)
        if (Date.parse(value.expiresAt) > this.now() && /^[A-Za-z\d_-]{43}$/.test(value.verifier))
          this.pending.set(value.id, value);
    }
    this.initialized = true;
  }
  private ready(): void {
    if (!this.initialized || this.stopped || this.storageFailed)
      throw new NotionFailure(
        "Notion is paused because its durable storage is unavailable.",
        "unavailable",
      );
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.mutation
      .catch(() => {})
      .then(() => {
        this.ready();
        return run();
      });
    this.mutation = operation.catch(() => {});
    return operation;
  }
  private async persist(): Promise<void> {
    this.ready();
    const serialized = JSON.stringify({
      version: 1,
      connections: [...this.connections.values()],
      mappings: [...this.mappings.values()],
      tasks: [...this.tasks.values()],
      changes: [...this.changes.values()],
      pending: [...this.pending.values()],
    });
    try {
      if (Buffer.byteLength(serialized) > SECRET_LIMIT) throw new Error("full");
      await this.options.save(serialized);
    } catch {
      this.storageFailed = true;
      this.syncError =
        "Notion is paused. Durable storage could not be updated. Restore storage before retrying.";
      throw new NotionFailure(this.syncError, "unavailable");
    }
  }
  state(): NotionState {
    return {
      configured: this.brokerOrigin !== null,
      connections: [...this.connections.values()].map((value) => value.connection),
      mappings: [...this.mappings.values()],
      changes: [...this.changes.values()]
        .filter((value) => value.change.state !== "synced")
        .map((value) => value.change),
      syncing: this.syncPromise !== null,
      lastSyncedAt: this.lastSyncedAt,
      syncError: this.syncError,
    };
  }
  private credential(connectionId: string): CredentialValue {
    this.ready();
    const value = this.connections.get(connectionId);
    if (
      !value ||
      value.connection.status !== "connected" ||
      value.brokerOrigin !== this.brokerOrigin
    )
      throw new NotionFailure("Reconnect this Notion workspace.", "unauthorized", 401);
    return value;
  }
  private async broker(path: string, input: NotionObject, bearer?: string): Promise<NotionObject> {
    this.ready();
    if (!this.brokerOrigin)
      throw new NotionFailure(
        "A hosted Notion OAuth broker has not been configured.",
        "unavailable",
      );
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.brokerOrigin}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([this.signal.signal, AbortSignal.timeout(20_000)]),
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(input),
      });
    } catch {
      throw new NotionFailure(
        "The OAuth broker did not confirm delivery. Retry with the same transaction or reconnect.",
        "network",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NotionFailure(
        response.status === 401 || response.status === 410
          ? "This Notion sign-in expired. Reconnect the workspace."
          : "The OAuth broker could not complete this operation.",
        response.status === 401 || response.status === 410 ? "unauthorized" : "unavailable",
        response.status,
      );
    }
    return readNotionJson(response, 65_536);
  }
  readonly connect: NotionApi["connect"] = () =>
    this.exclusive(async () => {
      for (const value of this.pending.values())
        if (Date.parse(value.expiresAt) <= this.now()) this.pending.delete(value.id);
      if (this.pending.size >= 20 || this.connections.size >= 20)
        throw new NotionFailure(
          "Finish or remove an existing connection before adding another.",
          "invalid",
        );
      const verifier = randomBytes(32).toString("base64url");
      const result = await this.broker("/transactions", { challenge: digest(verifier) });
      const transactionId = id(notionString(result.transactionId));
      const expiresAt = notionString(result.expiresAt);
      const authorizationUrl = notionString(result.authorizationUrl);
      const url = new URL(authorizationUrl);
      if (
        url.origin !== this.brokerOrigin ||
        url.pathname !== "/authorize" ||
        url.username ||
        url.password ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) > this.now() + 11 * 60_000
      )
        throw new NotionFailure("The OAuth broker returned an invalid transaction.", "invalid");
      this.pending.set(transactionId, { id: transactionId, verifier, expiresAt });
      await this.persist();
      return { transactionId, authorizationUrl, expiresAt };
    });
  readonly complete: NotionApi["complete"] = ({ transactionId }) =>
    this.exclusive(async () => {
      const transaction = this.pending.get(transactionId);
      if (!transaction || Date.parse(transaction.expiresAt) <= this.now())
        throw new NotionFailure("This Notion sign-in expired. Connect again.", "unauthorized");
      const result = await this.broker(`/transactions/${id(transactionId)}/redeem`, {
        verifier: transaction.verifier,
      });
      if (result.pending === true) return { pending: true, connection: null };
      const workspaceId = id(notionString(result.workspaceId));
      const botId = id(notionString(result.botId));
      const connectionId = `${workspaceId}:${botId}`;
      const accessToken = notionString(result.accessToken);
      const brokerSession = notionString(result.brokerSession);
      if (
        !accessToken ||
        accessToken.length > 4096 ||
        !/^[a-f\d-]{36}\.[A-Za-z\d_-]{43}$/i.test(brokerSession)
      )
        throw new NotionFailure("The OAuth broker returned an invalid authorization.", "invalid");
      const connection: typeof NotionConnection.Type = {
        id: connectionId,
        workspaceId,
        workspaceName: notionString(result.workspaceName),
        status: "connected",
        createdAt:
          this.connections.get(connectionId)?.connection.createdAt ??
          new Date(this.now()).toISOString(),
      };
      this.connections.set(connectionId, {
        connection,
        accessToken,
        brokerSession,
        botId,
        brokerOrigin: this.brokerOrigin!,
      });
      this.clients.delete(connectionId);
      this.epoch += 1;
      this.pending.delete(transactionId);
      await this.persist();
      return { pending: false, connection };
    });
  private purge(connectionId: string, resourceId?: string): void {
    this.epoch += 1;
    for (const [key, value] of this.tasks) {
      const mapping = this.mappings.get(value.mappingId);
      if (
        mapping?.connectionId !== connectionId ||
        (resourceId &&
          !sameResource(notionString(value.page.id), resourceId) &&
          !sameResource(mapping.dataSourceId, resourceId))
      )
        continue;
      this.tasks.delete(key);
      this.revisions.set(key, ++this.revision);
      this.options.publish({ type: "todo-deleted", todoId: TodoId.makeUnsafe(key) });
    }
    for (const [key, value] of this.changes)
      if (
        value.input.connectionId === connectionId &&
        (!resourceId || sameResource(value.input.id, resourceId))
      )
        this.changes.delete(key);
  }
  readonly disconnect: NotionApi["disconnect"] = ({ connectionId }) => {
    const credential = this.connections.get(connectionId);
    if (!credential) return Promise.resolve({ ok: true });
    // In-flight reads cannot repopulate caches after the user disconnects.
    credential.connection = { ...credential.connection, status: "disconnect-pending" };
    this.purge(connectionId);
    return this.exclusive(async () => {
      await this.persist();
      await this.broker("/sessions/revoke", {}, credential.brokerSession);
      for (const [key, mapping] of this.mappings)
        if (mapping.connectionId === connectionId) this.mappings.delete(key);
      this.connections.delete(connectionId);
      this.clients.delete(connectionId);
      await this.persist();
      return { ok: true };
    });
  };
  private client(connectionId: string): NotionClient {
    this.credential(connectionId);
    const existing = this.clients.get(connectionId);
    if (existing) return existing;
    const options = {
      accessToken: () => this.credential(connectionId).accessToken,
      fetch: this.options.fetch,
      refresh: async () => {
        const credential = this.credential(connectionId);
        try {
          const result = await this.broker(
            "/sessions/refresh",
            { accessTokenDigest: digest(credential.accessToken) },
            credential.brokerSession,
          );
          if (
            !notionString(result.accessToken) ||
            result.workspaceId !== credential.connection.workspaceId ||
            result.botId !== credential.botId ||
            this.connections.get(connectionId) !== credential ||
            credential.connection.status !== "connected"
          )
            throw new NotionFailure("Reconnect this Notion workspace.", "unauthorized", 401);
          credential.accessToken = notionString(result.accessToken);
          await this.persist();
        } catch (error) {
          if (error instanceof NotionFailure && error.code === "unauthorized") {
            credential.connection = { ...credential.connection, status: "needs-auth" };
            credential.accessToken = "";
            this.purge(connectionId);
            await this.persist();
          }
          throw error;
        }
      },
    };
    const client = this.options.client
      ? this.options.client(connectionId, options)
      : new NotionClient(options);
    this.clients.set(connectionId, client);
    return client;
  }
  readonly read: NotionApi["read"] = async (raw) => {
    const input = Schema.decodeUnknownSync(NotionReadInput)(raw);
    this.ready();
    if (Buffer.byteLength(JSON.stringify(input)) > 32_768)
      throw new NotionFailure("Narrow the Notion query.", "invalid");
    const epoch = this.epoch;
    try {
      const data = await this.client(input.connectionId).read(input, this.signal.signal);
      this.credential(input.connectionId);
      if (epoch !== this.epoch)
        throw new NotionFailure(
          "Notion access changed while this request was running. Retry the read.",
          "conflict",
        );
      return { data };
    } catch (error) {
      if (error instanceof NotionFailure && [401, 403, 404].includes(error.status)) {
        if (error.status === 401) {
          const credential = this.connections.get(input.connectionId);
          if (credential) {
            credential.connection = { ...credential.connection, status: "needs-auth" };
            credential.accessToken = "";
          }
        }
        this.purge(input.connectionId, error.status === 401 ? undefined : input.id);
        await this.persist();
      }
      throw error;
    }
  };
  readonly saveMapping: NotionApi["saveMapping"] = (raw) =>
    this.exclusive(async () => {
      const mapping = Schema.decodeUnknownSync(NotionMapping)(raw);
      this.credential(mapping.connectionId);
      const current = this.mappings.get(mapping.id);
      if (
        current &&
        (current.connectionId !== mapping.connectionId ||
          !sameResource(current.dataSourceId, mapping.dataSourceId))
      )
        throw new NotionFailure(
          "Create a new mapping to use a different workspace or data source.",
          "invalid",
        );
      if (!current && this.mappings.size >= 50)
        throw new NotionFailure("The Notion mapping limit has been reached.", "invalid");
      if (
        [...this.mappings.values()].some(
          (value) =>
            value.id !== mapping.id &&
            value.connectionId === mapping.connectionId &&
            sameResource(value.dataSourceId, mapping.dataSourceId),
        )
      )
        throw new NotionFailure("This data source is already mapped.", "invalid");
      const { data } = await this.read({
        connectionId: mapping.connectionId,
        kind: "dataSource",
        id: mapping.dataSourceId,
      });
      validateNotionMapping(mapping, data);
      if (mapping.sprintPlan) {
        const { data: sprintData } = await this.read({
          connectionId: mapping.connectionId,
          kind: "dataSource",
          id: mapping.sprintPlan.dataSourceId,
        });
        validateNotionSprintPlan(mapping, data, sprintData);
      }
      // Agent writes remain separately capability-gated and require a per-call owner approval.
      this.mappings.set(mapping.id, mapping);
      this.watermarks.delete(mapping.id);
      this.epoch += 1;
      if (!mapping.enabled) this.purge(mapping.connectionId, mapping.dataSourceId);
      await this.persist();
      return { ok: true };
    });
  readonly deleteMapping: NotionApi["deleteMapping"] = ({ mappingId }) =>
    this.exclusive(async () => {
      const mapping = this.mappings.get(mappingId);
      if (mapping) {
        this.purge(mapping.connectionId, mapping.dataSourceId);
        this.mappings.delete(mappingId);
        this.watermarks.delete(mappingId);
        await this.persist();
      }
      return { ok: true };
    });
  private taskKey(connectionId: string, pageId: string): string {
    return `notion:${connectionId}:${id(pageId)}`;
  }
  private project(entry: TaskValue): NotionTask | null {
    const mapping = this.mappings.get(entry.mappingId);
    const connection = mapping ? this.connections.get(mapping.connectionId)?.connection : undefined;
    if (!mapping?.enabled || connection?.status !== "connected") return null;
    let page = entry.page;
    const outstanding = [...this.changes.values()].find(
      (value) =>
        value.input.connectionId === mapping.connectionId &&
        sameResource(value.input.id, notionString(page.id)) &&
        value.change.state !== "synced",
    );
    if (outstanding?.input.kind === "updatePage") {
      const properties = Object.fromEntries(
        Object.entries(notionObject(page.properties)).map(([name, raw]) => {
          const property = notionObject(raw);
          const change = notionObject(outstanding.input.changes[notionString(property.id)]);
          return [name, Object.keys(change).length ? { ...property, ...change } : property];
        }),
      );
      page = { ...page, properties };
    }
    const projection = projectNotionTask(page, mapping, connection.workspaceName);
    const stamp = asIso(page.last_edited_time, entry.updatedAt);
    return {
      id: TodoId.makeUnsafe(entry.key),
      title: projection.title.slice(0, 500),
      notes: projection.notes.slice(0, 10_000),
      priority: projection.priority,
      projectId: mapping.projectId,
      dueDate: projection.dueDate,
      threadId: entry.local.threadId as Todo["threadId"],
      delegationBaseTurnId: entry.local.delegationBaseTurnId as Todo["delegationBaseTurnId"],
      linkedAt: entry.local.linkedAt,
      completedAt: projection.completed ? stamp : null,
      createdAt: asIso(page.created_time, entry.updatedAt),
      updatedAt: entry.updatedAt,
      external: {
        ...projection.external,
        syncState: outstanding?.change.state ?? "synced",
        syncMessage: outstanding?.change.message ?? null,
        writableFields: projection.external.writableFields.filter(
          (field) =>
            !(
              (field === "title" && projection.title.length > 500) ||
              (field === "notes" && projection.notes.length > 10_000)
            ),
        ),
      },
    };
  }
  listTodos(): NotionTask[] {
    return [...this.tasks.values()].flatMap((entry) => {
      const todo = this.project(entry);
      return todo ? [todo] : [];
    });
  }
  private publish(entry: TaskValue): void {
    const todo = this.project(entry);
    if (todo) this.options.publish({ type: "todo-upserted", todo });
  }
  private stamp(previous: string): string {
    return new Date(Math.max(this.now(), Date.parse(previous) + 1 || 0)).toISOString();
  }
  async updateTodo(input: TodoUpdateInput): Promise<NotionTask> {
    return this.exclusive(async () => {
      const entry = this.tasks.get(input.id);
      const current = entry ? this.project(entry) : null;
      if (!entry || !current)
        throw new NotionFailure("This Notion task is unavailable.", "missing");
      if (input.expectedThreadId !== undefined && input.expectedThreadId !== current.threadId)
        throw new NotionFailure("This task was delegated elsewhere.", "conflict");
      if (input.projectId !== undefined && input.projectId !== current.projectId)
        throw new NotionFailure(
          "Change the delegation project in the Notion mapping settings.",
          "invalid",
        );
      const mapping = this.mappings.get(entry.mappingId)!;
      const fields = notionTodoPatch(entry.page, mapping, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.completed !== undefined ? { completed: input.completed } : {}),
      });
      if (Object.keys(fields).length)
        await this.writeUnlocked({
          requestId: randomUUID(),
          createdAt: new Date(this.now()).toISOString(),
          connectionId: mapping.connectionId,
          kind: "updatePage",
          id: notionString(entry.page.id),
          base: notionPropertySnapshot(entry.page.properties, Object.keys(fields)),
          changes: fields,
        });
      if (input.threadId !== undefined)
        entry.local = {
          threadId: input.threadId,
          delegationBaseTurnId: input.delegationBaseTurnId ?? null,
          linkedAt: input.threadId ? new Date(this.now()).toISOString() : null,
        };
      entry.updatedAt = this.stamp(entry.updatedAt);
      await this.persist();
      this.publish(entry);
      return this.project(entry)!;
    });
  }
  async deleteTodo(todoId: string): Promise<void> {
    const entry = this.tasks.get(todoId);
    const mapping = entry ? this.mappings.get(entry.mappingId) : undefined;
    if (!entry || !mapping) return;
    await this.write({
      requestId: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      connectionId: mapping.connectionId,
      kind: "archivePage",
      id: notionString(entry.page.id),
      base: { in_trash: entry.page.in_trash === true },
      changes: { in_trash: true },
    });
  }
  private async refreshTasks(mapping: NotionMapping): Promise<void> {
    const epoch = this.epoch;
    const revision = this.revision;
    const mark = this.watermarks.get(mapping.id);
    const full = !mark || this.now() - mark.fullAt >= 15 * 60_000;
    const results: NotionObject[] = [];
    for await (const page of this.client(mapping.connectionId).pages(
      {
        connectionId: mapping.connectionId,
        kind: "query",
        id: mapping.dataSourceId,
        ...(full
          ? {}
          : {
              filter: {
                timestamp: "last_edited_time",
                last_edited_time: {
                  on_or_after: new Date(Date.parse(mark.editedAt) - 5_000).toISOString(),
                },
              },
            }),
      },
      this.signal.signal,
    )) {
      if (
        page.object !== "page" ||
        !sameResource(
          notionString(notionObject(page.parent).data_source_id),
          mapping.dataSourceId,
        ) ||
        !page.properties
      )
        throw new NotionFailure(
          "Notion returned an incomplete task page. Existing tasks were retained.",
          "unavailable",
        );
      if (results.length >= 5_000)
        throw new NotionFailure(
          "This data source exceeds the bounded task cache. Existing tasks were retained.",
          "invalid",
        );
      results.push(page);
    }
    await this.exclusive(async () => {
      if (this.epoch !== epoch || this.mappings.get(mapping.id) !== mapping) return;
      this.credential(mapping.connectionId);
      const seen = new Set<string>();
      const changed: TaskValue[] = [];
      const removed: string[] = [];
      const candidates = new Map(this.tasks);
      let latest = mark?.editedAt ?? "1970-01-01T00:00:00.000Z";
      for (const page of results) {
        const key = this.taskKey(mapping.connectionId, notionString(page.id));
        seen.add(key);
        latest = [latest, asIso(page.last_edited_time, latest)].sort().at(-1)!;
        if ((this.revisions.get(key) ?? 0) > revision) continue;
        const previous = candidates.get(key);
        if (
          previous &&
          Date.parse(notionString(previous.page.last_edited_time)) >
            Date.parse(notionString(page.last_edited_time))
        )
          continue;
        if (page.in_trash === true || page.archived === true) {
          candidates.delete(key);
          removed.push(key);
          continue;
        }
        const reopened =
          previous &&
          projectNotionTask(previous.page, mapping, "").completed &&
          !projectNotionTask(page, mapping, "").completed;
        const next: TaskValue = {
          key,
          mappingId: mapping.id,
          page,
          local: reopened ? noLink() : (previous?.local ?? noLink()),
          updatedAt: this.stamp(previous?.updatedAt ?? "1970-01-01T00:00:00.000Z"),
        };
        candidates.set(key, next);
        changed.push(next);
      }
      if (full)
        for (const [key, entry] of candidates)
          if (
            entry.mappingId === mapping.id &&
            !seen.has(key) &&
            (this.revisions.get(key) ?? 0) <= revision &&
            ![...this.changes.values()].some(
              (value) =>
                value.input.connectionId === mapping.connectionId &&
                sameResource(value.input.id, notionString(entry.page.id)) &&
                value.change.state !== "synced",
            )
          ) {
            candidates.delete(key);
            removed.push(key);
          }
      if (candidates.size > 10_000)
        throw new NotionFailure(
          "The bounded Notion task cache is full. Narrow the connected sources.",
          "invalid",
        );
      this.tasks.clear();
      for (const [key, value] of candidates) this.tasks.set(key, value);
      await this.persist();
      this.watermarks.set(mapping.id, {
        editedAt: latest,
        fullAt: full ? this.now() : mark.fullAt,
      });
      for (const key of removed)
        this.options.publish({ type: "todo-deleted", todoId: TodoId.makeUnsafe(key) });
      for (const entry of changed) this.publish(entry);
    });
  }
  async synchronize(): Promise<void> {
    this.ready();
    if (this.syncPromise) return this.syncPromise;
    const work = async () => {
      this.syncError = null;
      for (const mapping of this.mappings.values()) {
        if (
          !mapping.enabled ||
          this.connections.get(mapping.connectionId)?.connection.status !== "connected"
        )
          continue;
        try {
          await this.refreshTasks(mapping);
        } catch (error) {
          if (error instanceof NotionFailure && [401, 403, 404].includes(error.status))
            await this.exclusive(async () => {
              this.purge(
                mapping.connectionId,
                error.status === 401 ? undefined : mapping.dataSourceId,
              );
              await this.persist();
            });
          this.syncError =
            error instanceof NotionFailure
              ? error.message
              : "Notion synchronization failed. Existing changes are retained.";
        }
      }
      for (const entry of this.changes.values())
        if (entry.change.state === "pending" && !entry.attempted && entry.retryAt <= this.now())
          await this.exclusive(() => this.deliver(entry));
      this.lastSyncedAt = new Date(this.now()).toISOString();
    };
    this.syncPromise = work().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }
  readonly sync: NotionApi["sync"] = async () => {
    await this.synchronize();
    return this.state();
  };
  readonly write: NotionApi["write"] = (input) => this.exclusive(() => this.writeUnlocked(input));
  async writeAgent(
    input: NotionWriteInput,
    agentScope: { mappingId: string; fingerprint: string },
    guard: () => Promise<void>,
  ) {
    return this.exclusive(async () => {
      await guard();
      this.assertAgentScope(agentScope, input.connectionId);
      return this.writeUnlocked(input, agentScope, guard);
    });
  }
  private assertAgentScope(
    scope: { mappingId: string; fingerprint: string },
    connectionId: string,
  ): void {
    const mapping = this.mappings.get(scope.mappingId);
    if (
      !mapping ||
      mapping.connectionId !== connectionId ||
      !mapping.enabled ||
      mapping.agentAccess !== "write" ||
      digest(notionCanonical(mapping)) !== scope.fingerprint
    )
      throw new NotionFailure(
        "Notion agent permission changed. A fresh approved request is required.",
        "forbidden",
        403,
      );
    this.credential(connectionId);
  }
  private async writeUnlocked(
    raw: NotionWriteInput,
    agentScope?: { mappingId: string; fingerprint: string },
    guard?: () => Promise<void>,
  ): Promise<Awaited<ReturnType<NotionApi["write"]>>> {
    const input = Schema.decodeUnknownSync(NotionWriteInput)(raw);
    this.credential(input.connectionId);
    const date = Date.parse(input.createdAt);
    if (
      !Number.isFinite(date) ||
      this.now() - date > RECEIPT_AGE ||
      date > this.now() + 5 * 60_000 ||
      Buffer.byteLength(JSON.stringify(input)) > 480_000
    )
      throw new NotionFailure(
        "The change is expired or too large. Review and submit a new change.",
        "invalid",
      );
    const hash = digest(notionCanonical(input));
    const prior = this.changes.get(input.requestId);
    if (prior) {
      if (prior.digest !== hash)
        throw new NotionFailure(
          "This request ID was already used for a different change.",
          "conflict",
        );
      return { change: prior.change, data: null };
    }
    if (
      [...this.changes.values()].some(
        (value) =>
          value.input.connectionId === input.connectionId &&
          sameResource(value.input.id, input.id) &&
          value.change.state !== "synced",
      )
    )
      throw new NotionFailure(
        "Resolve the existing pending change for this resource first.",
        "conflict",
      );
    for (const [key, entry] of this.changes)
      if (
        entry.change.state === "synced" &&
        this.now() - Date.parse(entry.input.createdAt) > RECEIPT_AGE
      )
        this.changes.delete(key);
    if (this.changes.size >= 2_000)
      throw new NotionFailure("Review pending Notion changes before submitting more.", "invalid");
    const entry: ChangeValue = {
      input: structuredClone(input),
      digest: hash,
      attempted: false,
      retryAt: 0,
      ...(agentScope ? { agentScope } : {}),
      change: {
        id: input.requestId,
        connectionId: input.connectionId,
        resourceId: input.id,
        kind: input.kind,
        state: "pending",
        message: null,
        createdAt: input.createdAt,
        base: input.base,
        changes: input.changes,
        remote: null,
      },
    };
    this.changes.set(input.requestId, entry);
    await this.persist();
    const data = await this.deliver(entry, guard);
    return { change: entry.change, data };
  }
  private async plan(input: NotionWriteInput): Promise<{
    path: string;
    method: "POST" | "PATCH";
    body: NotionObject;
    current: NotionObject | null;
    desired: NotionObject;
  }> {
    const resourceId = id(input.id);
    const { changes } = input;
    const keys = Object.keys(changes);
    if (!keys.length) throw new NotionFailure("The change is empty.", "invalid");
    if (input.kind === "updatePage") {
      const { data: page } = await this.read({
        connectionId: input.connectionId,
        kind: "page",
        id: resourceId,
      });
      for (const key of keys) {
        const property = Object.values(notionObject(page.properties))
          .map(notionObject)
          .find((value) => value.id === key);
        const type = notionString(property?.type);
        const patch = notionObject(changes[key]);
        if (
          !property ||
          property.has_more === true ||
          (type === "people" && notionArray(property.people).length >= 25) ||
          ![
            "title",
            "rich_text",
            "number",
            "select",
            "status",
            "multi_select",
            "date",
            "people",
            "relation",
            "checkbox",
            "url",
            "email",
            "phone_number",
          ].includes(type) ||
          Object.keys(patch).length !== 1 ||
          !(type in patch) ||
          !(key in input.base)
        )
          throw new NotionFailure(
            "This property is read-only, incomplete, or missing its original value.",
            "invalid",
          );
      }
      return {
        path: `/v1/pages/${resourceId}`,
        method: "PATCH",
        body: { properties: notionWritableValue(changes) },
        current: notionPropertySnapshot(page.properties, keys),
        desired: notionComparableValue(changes) as NotionObject,
      };
    }
    if (input.kind === "archivePage") {
      if (
        keys.length !== 1 ||
        changes.in_trash !== true ||
        typeof input.base.in_trash !== "boolean"
      )
        throw new NotionFailure("Archiving requires an explicit reviewed change.", "invalid");
      const { data } = await this.read({
        connectionId: input.connectionId,
        kind: "page",
        id: resourceId,
      });
      return {
        path: `/v1/pages/${resourceId}`,
        method: "PATCH",
        body: { in_trash: true },
        current: { in_trash: data.in_trash === true },
        desired: changes,
      };
    }
    if (input.kind === "updateBlock") {
      const { data } = await this.read({
        connectionId: input.connectionId,
        kind: "block",
        id: resourceId,
      });
      const type = notionString(data.type);
      const allowed = [
        "paragraph",
        "heading_1",
        "heading_2",
        "heading_3",
        "bulleted_list_item",
        "numbered_list_item",
        "to_do",
        "toggle",
        "quote",
        "callout",
        "code",
        "table_row",
      ];
      if (
        !allowed.includes(type) ||
        keys.some(
          (key) =>
            !["rich_text", "checked", "language", "caption", "cells", "icon", "color"].includes(
              key,
            ) || !(key in input.base),
        )
      )
        throw new NotionFailure("This block or field is read-only in Synara.", "invalid");
      const payload = notionObject(data[type]);
      return {
        path: `/v1/blocks/${resourceId}`,
        method: "PATCH",
        body: { [type]: notionWritableValue(changes) },
        current: notionComparableValue(
          Object.fromEntries(keys.map((key) => [key, payload[key]])),
        ) as NotionObject,
        desired: notionComparableValue(changes) as NotionObject,
      };
    }
    if (input.kind === "createPage") {
      if (keys.length !== 1 || !changes.properties || Array.isArray(changes.properties))
        throw new NotionFailure("Create a record using data-source properties only.", "invalid");
      const { data } = await this.read({
        connectionId: input.connectionId,
        kind: "dataSource",
        id: resourceId,
      });
      for (const [key, raw] of Object.entries(notionObject(changes.properties))) {
        const property = Object.values(notionObject(data.properties))
          .map(notionObject)
          .find((value) => value.id === key);
        const patch = notionObject(raw);
        const type = notionString(property?.type);
        if (
          !property ||
          [
            "formula",
            "rollup",
            "created_time",
            "created_by",
            "last_edited_time",
            "last_edited_by",
            "unique_id",
            "button",
          ].includes(type) ||
          Object.keys(patch).length !== 1 ||
          !(type in patch)
        )
          throw new NotionFailure(
            "The record does not match the actual data-source schema.",
            "invalid",
          );
      }
      return {
        path: "/v1/pages",
        method: "POST",
        body: {
          parent: { type: "data_source_id", data_source_id: resourceId },
          properties: notionWritableValue(changes.properties),
        },
        current: null,
        desired: changes,
      };
    }
    if (input.kind === "appendBlocks") {
      if (
        keys.some((key) => !["children", "after"].includes(key)) ||
        !Array.isArray(changes.children) ||
        changes.children.length < 1 ||
        changes.children.length > 100
      )
        throw new NotionFailure("Append between one and 100 supported blocks.", "invalid");
      for (const raw of changes.children) {
        const block = notionObject(raw);
        const type = notionString(block.type);
        if (
          ![
            "paragraph",
            "heading_1",
            "heading_2",
            "heading_3",
            "bulleted_list_item",
            "numbered_list_item",
            "to_do",
            "toggle",
            "quote",
            "callout",
            "code",
            "divider",
            "table",
            "image",
            "file",
            "bookmark",
            "link_to_page",
          ].includes(type) ||
          !block[type] ||
          Object.keys(block).some((key) => !["object", "type", type].includes(key))
        )
          throw new NotionFailure("This block cannot be created by this editor.", "invalid");
      }
      await this.read({ connectionId: input.connectionId, kind: "block", id: resourceId });
      let after: string | undefined;
      if (changes.after !== undefined) {
        after = id(notionString(changes.after));
        const { data: sibling } = await this.read({
          connectionId: input.connectionId,
          kind: "block",
          id: after,
        });
        const parent = notionObject(sibling.parent);
        if (
          sibling.archived === true ||
          sibling.in_trash === true ||
          !sameResource(notionString(parent.page_id || parent.block_id), resourceId)
        )
          throw new NotionFailure(
            "The insertion anchor is no longer in this parent. Refresh the document.",
            "conflict",
          );
      }
      return {
        path: `/v1/blocks/${resourceId}/children`,
        method: "PATCH",
        body: { children: notionWritableValue(changes.children), ...(after ? { after } : {}) },
        current: null,
        desired: changes,
      };
    }
    if (
      keys.some((key) => !["rich_text", "discussion_id"].includes(key)) ||
      !Array.isArray(changes.rich_text) ||
      changes.rich_text.length < 1 ||
      changes.rich_text.length > 100
    )
      throw new NotionFailure("A comment requires supported rich text.", "invalid");
    await this.read({ connectionId: input.connectionId, kind: "page", id: resourceId });
    let discussionId: string | undefined;
    if (changes.discussion_id !== undefined) {
      discussionId = id(notionString(changes.discussion_id));
      let found = false;
      for await (const comment of this.client(input.connectionId).pages(
        { connectionId: input.connectionId, kind: "comments", id: resourceId, pageSize: 100 },
        this.signal.signal,
      )) {
        if (sameResource(notionString(comment.discussion_id), discussionId)) {
          found = true;
          break;
        }
      }
      if (!found)
        throw new NotionFailure("The discussion is not accessible on this page.", "forbidden", 403);
    }
    return {
      path: "/v1/comments",
      method: "POST",
      body: {
        ...(discussionId ? { discussion_id: discussionId } : { parent: { page_id: resourceId } }),
        rich_text: notionWritableValue(changes.rich_text),
      },
      current: null,
      desired: changes,
    };
  }
  private async deliver(
    entry: ChangeValue,
    guard?: () => Promise<void>,
  ): Promise<NotionObject | null> {
    if (entry.change.state === "synced") return null;
    try {
      if (entry.agentScope) {
        if (!guard)
          throw new NotionFailure(
            "Agent changes are not retried automatically. Request a fresh per-call approval.",
            "forbidden",
            403,
          );
        this.assertAgentScope(entry.agentScope, entry.input.connectionId);
      }
      const plan = await this.plan(entry.input);
      const base = notionComparableValue(entry.input.base) as NotionObject;
      if (plan.current && notionCanonical(plan.current) === notionCanonical(plan.desired)) {
        entry.change = { ...entry.change, state: "synced", message: null, remote: plan.current };
        await this.persist();
        return null;
      }
      if (entry.attempted) {
        entry.change = {
          ...entry.change,
          state: "unknown",
          message: "The previous delivery is uncertain. Inspect Notion before an explicit retry.",
          remote: plan.current,
        };
        await this.persist();
        return null;
      }
      if (plan.current && notionPatchConflicts(base, plan.current, plan.desired).length) {
        entry.change = {
          ...entry.change,
          state: "conflict",
          message: "These fields changed in Notion. Review both versions before retrying.",
          remote: plan.current,
        };
        await this.persist();
        return null;
      }
      if (guard) await guard();
      if (entry.agentScope) this.assertAgentScope(entry.agentScope, entry.input.connectionId);
      entry.attempted = true;
      entry.change = {
        ...entry.change,
        state: "unknown",
        message: "Waiting for Notion to confirm delivery.",
      };
      await this.persist();
      const data = await this.client(entry.input.connectionId).request(plan.path, {
        method: plan.method,
        body: plan.body,
        signal: this.signal.signal,
        ...(guard
          ? {
              beforeSend: async () => {
                await guard();
                if (entry.agentScope)
                  this.assertAgentScope(entry.agentScope, entry.input.connectionId);
              },
            }
          : {}),
      });
      this.credential(entry.input.connectionId);
      if (this.changes.get(entry.input.requestId) !== entry) return null;
      entry.change = { ...entry.change, state: "synced", message: null, remote: null };
      await this.persist();
      if (data.object === "page") {
        const key = this.taskKey(entry.input.connectionId, notionString(data.id));
        const existing = this.tasks.get(key);
        this.revisions.set(key, ++this.revision);
        if (existing) {
          if (data.in_trash === true || data.archived === true) {
            this.tasks.delete(key);
            this.options.publish({ type: "todo-deleted", todoId: TodoId.makeUnsafe(key) });
          } else {
            existing.page = data;
            existing.updatedAt = this.stamp(existing.updatedAt);
            this.publish(existing);
          }
          await this.persist();
        }
      }
      return data;
    } catch (error) {
      if (this.storageFailed) throw error;
      if (this.changes.get(entry.input.requestId) !== entry || entry.change.state === "synced")
        return null;
      const failure =
        error instanceof NotionFailure
          ? error
          : new NotionFailure("Notion refused the change. Review the source schema.", "invalid");
      const pending =
        (!entry.attempted && ["network", "unavailable", "rate-limited"].includes(failure.code)) ||
        failure.code === "rate-limited";
      if (failure.code === "rate-limited") entry.attempted = false;
      entry.retryAt = this.now() + Math.max(30_000, failure.retryAfterMs);
      entry.change = {
        ...entry.change,
        state: pending
          ? "pending"
          : entry.attempted && failure.code === "unknown-outcome"
            ? "unknown"
            : "error",
        message: failure.message,
      };
      await this.persist();
      return null;
    } finally {
      const key = this.taskKey(entry.input.connectionId, entry.input.id);
      const task = this.tasks.get(key);
      if (task && !this.storageFailed) {
        task.updatedAt = this.stamp(task.updatedAt);
        this.publish(task);
      }
    }
  }
  readonly resolve: NotionApi["resolve"] = ({ changeId, resolution }) =>
    this.exclusive(async () => {
      const entry = this.changes.get(changeId);
      if (!entry || entry.change.state === "synced") return { ok: true };
      this.credential(entry.input.connectionId);
      if (resolution === "remote") {
        entry.change = {
          ...entry.change,
          state: "synced",
          message: "Local proposal discarded. No remote rollback was performed.",
          remote: null,
        };
        await this.persist();
        return { ok: true };
      }
      if (!["updatePage", "updateBlock", "archivePage"].includes(entry.input.kind))
        throw new NotionFailure(
          "This create or append may already have happened. Inspect Notion and submit a new intentional action instead of replaying it.",
          "conflict",
        );
      const plan = await this.plan(entry.input);
      if (
        !plan.current ||
        !entry.change.remote ||
        notionCanonical(entry.change.remote) !== notionCanonical(plan.current)
      ) {
        entry.change = {
          ...entry.change,
          state: "conflict",
          remote: plan.current,
          message:
            "Notion changed again. Review this latest version before confirming another retry.",
        };
        await this.persist();
        return { ok: false };
      }
      // Keep the original request digest as its receipt identity. Rebase only the delivery plan.
      entry.input = { ...entry.input, base: plan.current };
      entry.digest = digest(notionCanonical(entry.input));
      entry.attempted = false;
      entry.change = { ...entry.change, base: plan.current, state: "pending", message: null };
      await this.persist();
      await this.deliver(entry);
      return { ok: entry.change.state === "synced" };
    });
  async dispose(): Promise<void> {
    this.stopped = true;
    this.signal.abort();
    await Promise.allSettled([this.mutation, this.syncPromise ?? Promise.resolve()]);
  }
}
