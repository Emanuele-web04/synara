import {
  ORCHESTRATION_WS_METHODS,
  WsRpcGroup,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const wsUrl = process.env.HERMES_E2E_WS_URL ?? "ws://127.0.0.1:58090/ws";
const makeRpcClient = RpcClient.make(WsRpcGroup);

function makeProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}

console.log("[e2e] connecting", wsUrl);
const runtime = ManagedRuntime.make(makeProtocolLayer(wsUrl));
const clientScope = runtime.runSync(Scope.make());
const client = await runtime.runPromise(Scope.provide(clientScope)(makeRpcClient));
console.log("[e2e] rpc client ready");

const snapshot = await runtime.runPromise(
  client["orchestration.getSnapshot"]({}).pipe(Effect.timeout("15 seconds")),
);
console.log("[e2e] projects", snapshot.projects.length);
const project = snapshot.projects[0];
if (!project) throw new Error("No project in snapshot");

const eventsQueue = await runtime.runPromise(Queue.unbounded<unknown>());
const subscribeMethod = client["orchestration.subscribeDomainEvents"];
if (!subscribeMethod) throw new Error("Missing orchestration.subscribeDomainEvents RPC");

void runtime.runPromise(
  subscribeMethod({}).pipe(Stream.runForEach((event) => Queue.offer(eventsQueue, event))),
);

const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
const now = new Date().toISOString();
await runtime.runPromise(
  client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId,
    projectId: project.id,
    title: "Hermes E2E",
    modelSelection: { provider: "hermes", model: "deepseek-v4-flash" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  }),
);
console.log("[e2e] thread.create", threadId);

await runtime.runPromise(
  client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: "Reply with exactly: HERMES_E2E_OK",
      attachments: [],
    },
    modelSelection: { provider: "hermes", model: "deepseek-v4-flash" },
    providerOptions: { hermes: { binaryPath: "hermes" } },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  }),
);
console.log("[e2e] thread.turn.start dispatched");

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const event = await runtime
    .runPromise(Queue.take(eventsQueue).pipe(Effect.timeout("3 seconds")))
    .catch(() => null);
  if (!event || typeof event !== "object" || !("type" in event)) continue;
  const type = (event as { type: string }).type;
  console.log("[e2e]", type);
  if (type === "thread.message.assistant.complete") {
    console.log("[e2e] PASS", JSON.stringify(event).slice(0, 800));
    await runtime.runPromise(Scope.close(clientScope, Exit.void));
    runtime.dispose();
    process.exit(0);
  }
  if (
    type === "thread.message-sent" &&
    (event as { payload?: { role?: string; text?: string } }).payload?.role === "assistant" &&
    String((event as { payload?: { text?: string } }).payload?.text ?? "").includes("HERMES_E2E_OK")
  ) {
    console.log("[e2e] PASS assistant message-sent", JSON.stringify(event).slice(0, 800));
    await runtime.runPromise(Scope.close(clientScope, Exit.void));
    runtime.dispose();
    process.exit(0);
  }
  if (type === "thread.turn.failed") {
    console.error("[e2e] FAIL", JSON.stringify(event));
    process.exit(1);
  }
}

console.error("[e2e] FAIL timed out");
process.exit(1);
