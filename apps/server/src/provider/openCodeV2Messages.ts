import type {
  OpenCodeEvent,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionStructuredError,
  TokenUsageInfo,
  FormInfo,
} from "@opencode/client";
import type { AssistantMessage, Event, Message, Part, ToolPart } from "@opencode-ai/sdk/v2";
import { openCodeV2Permission, openCodeV2Question } from "./openCodeV2Mapping.ts";

export interface OpenCodeExecutionEvent {
  readonly id: string;
  readonly type: "synara.opencode.execution";
  readonly properties: {
    readonly sessionID: string;
    readonly outcome: "succeeded" | "failed" | "interrupted";
    readonly message?: string;
  };
}
export interface OpenCodeExecutionStartedEvent {
  readonly id: string;
  readonly type: "synara.opencode.execution.started";
  readonly properties: { readonly sessionID: string };
}
export type NormalizedOpenCodeEvent =
  | Event
  | OpenCodeExecutionEvent
  | OpenCodeExecutionStartedEvent;
export interface OpenCodeMessage {
  readonly info: Message;
  readonly parts: Part[];
}

const emptyTokens = (): TokenUsageInfo => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});
const errorMessage = (error: SessionStructuredError) => error.message;
const partId = (messageID: string, ordinal: number) => `${messageID}:part:${ordinal}`;

function assistantInfo(
  sessionID: string,
  message: SessionMessageAssistant,
  directory: string,
): AssistantMessage {
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    parentID: "",
    time: message.time,
    modelID: message.model.id,
    providerID: message.model.providerID,
    ...(message.model.variant ? { variant: message.model.variant } : {}),
    agent: message.agent,
    mode: message.agent,
    path: { cwd: directory, root: directory },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens(),
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.error
      ? { error: { name: "UnknownError" as const, data: { message: errorMessage(message.error) } } }
      : {}),
  };
}

function toolPart(
  sessionID: string,
  messageID: string,
  tool: SessionMessageAssistantTool,
): ToolPart {
  const state = tool.state;
  const input = typeof state.input === "object" ? { ...state.input } : {};
  if (tool.name === "subagent" && typeof input.agent === "string")
    input.subagent_type = input.agent;
  const common = {
    id: `${messageID}:tool:${tool.id}`,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: tool.id,
    tool: tool.name === "shell" ? "bash" : tool.name === "subagent" ? "task" : tool.name,
  };
  switch (state.status) {
    case "streaming":
      return { ...common, state: { status: "pending", input: {}, raw: state.input } };
    case "running":
      return {
        ...common,
        state: {
          status: "running",
          input,
          metadata: state.metadata ?? {},
          time: { start: tool.time.ran ?? tool.time.created },
        },
      };
    case "completed":
      return {
        ...common,
        state: {
          status: "completed",
          input,
          metadata: {
            ...state.metadata,
            ...(tool.name === "subagent" && state.metadata?.status === "running"
              ? { background: true }
              : {}),
          },
          title: typeof state.input.description === "string" ? state.input.description : tool.name,
          output: state.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .join("\n"),
          time: {
            start: tool.time.ran ?? tool.time.created,
            end: tool.time.completed ?? tool.time.created,
          },
          attachments: state.content.flatMap((item, index) =>
            item.type === "file"
              ? [
                  {
                    type: "file" as const,
                    id: `${common.id}:file:${index}`,
                    sessionID,
                    messageID,
                    mime: item.mime,
                    url: item.uri,
                  },
                ]
              : [],
          ),
        },
      };
    case "error":
      return {
        ...common,
        state: {
          status: "error",
          input,
          error: errorMessage(state.error),
          metadata: state.metadata ?? {},
          time: {
            start: tool.time.ran ?? tool.time.created,
            end: tool.time.completed ?? tool.time.created,
          },
        },
      };
  }
}

export function openCodeV2Message(
  sessionID: string,
  message: SessionMessageInfo,
  directory: string,
): OpenCodeMessage | undefined {
  if (message.type === "user")
    return {
      info: {
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent: "build",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        {
          id: partId(message.id, 0),
          sessionID,
          messageID: message.id,
          type: "text",
          text: message.text,
        },
        ...(message.files ?? []).map((file, index): Part => {
          const part: Extract<Part, { type: "file" }> = {
            id: `${message.id}:file:${index}`,
            sessionID,
            messageID: message.id,
            type: "file",
            mime: file.mime,
            url: `data:${file.mime};base64,${file.data}`,
          };
          if (file.name) part.filename = file.name;
          return part;
        }),
      ],
    };
  if (message.type !== "assistant") return undefined;
  return {
    info: assistantInfo(sessionID, message, directory),
    parts: message.content.flatMap((part, ordinal): Part[] => {
      if (part.type === "tool") return [toolPart(sessionID, message.id, part)];
      return [
        {
          id: partId(message.id, ordinal),
          sessionID,
          messageID: message.id,
          type: part.type,
          text: part.text,
          time: {
            start: message.time.created,
            ...(message.time.completed !== undefined ? { end: message.time.completed } : {}),
          },
        },
      ];
    }),
  };
}

/** State is subscription-owned and bounded; snapshots use identical item IDs after reconnect. */
export function createOpenCodeV2EventMapper(
  directory: string,
  resolveForm: (id: string) => FormInfo | undefined = () => undefined,
) {
  const messages = new Map<string, SessionMessageAssistant>();
  const outcomes = new Map<string, OpenCodeExecutionEvent>();
  function rememberOutcome(event: OpenCodeExecutionEvent) {
    outcomes.set(event.properties.sessionID, event);
    if (outcomes.size > 256) outcomes.delete(outcomes.keys().next().value!);
    return event;
  }
  function completedChild(part: Part): OpenCodeExecutionEvent[] {
    if (
      part.type !== "tool" ||
      part.tool !== "task" ||
      part.state.status !== "completed" ||
      part.state.metadata.background !== true
    )
      return [];
    const childID = part.state.metadata.sessionID;
    const outcome = typeof childID === "string" ? outcomes.get(childID) : undefined;
    // A child can finish before its parent publishes the background tool result.
    // Replay that terminal only after the adapter has registered the task.
    return outcome ? [outcome] : [];
  }
  function remember(message: SessionMessageAssistant) {
    messages.set(message.id, message);
    if (messages.size > 256) messages.delete(messages.keys().next().value!);
  }
  function changed(sessionID: string, message: SessionMessageAssistant): NormalizedOpenCodeEvent[] {
    remember(message);
    const snapshot = openCodeV2Message(sessionID, message, directory)!;
    return [
      { id: message.id, type: "message.updated", properties: { sessionID, info: snapshot.info } },
      ...snapshot.parts.map(
        (part): Event => ({
          id: `${message.id}:${part.id}`,
          type: "message.part.updated",
          properties: { sessionID, part, time: message.time.completed ?? message.time.created },
        }),
      ),
      ...snapshot.parts.flatMap(completedChild),
    ];
  }
  return (event: OpenCodeEvent): NormalizedOpenCodeEvent[] => {
    switch (event.type) {
      case "permission.asked":
        return [
          { id: event.id, type: "permission.asked", properties: openCodeV2Permission(event.data) },
        ];
      case "permission.replied":
        return [{ id: event.id, type: "permission.replied", properties: event.data }];
      case "form.created":
        return [
          { id: event.id, type: "question.asked", properties: openCodeV2Question(event.data.form) },
        ];
      case "form.replied": {
        const form = resolveForm(event.data.id);
        const answers =
          form?.fields.map((field) => {
            const value = event.data.answer[field.key];
            const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
            return values.map((entry) => {
              const option =
                "options" in field
                  ? field.options?.find((option) => option.value === entry)
                  : undefined;
              return option?.label ?? String(entry);
            });
          }) ?? [];
        return [
          {
            id: event.id,
            type: "question.replied",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id, answers },
          },
        ];
      }
      case "form.cancelled":
        return [
          {
            id: event.id,
            type: "question.rejected",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id },
          },
        ];
      case "session.execution.started":
        outcomes.delete(event.data.sessionID);
        return [
          {
            id: event.id,
            type: "synara.opencode.execution.started",
            properties: { sessionID: event.data.sessionID },
          },
        ];
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        return [
          rememberOutcome({
            id: event.id,
            type: "synara.opencode.execution",
            properties: {
              sessionID: event.data.sessionID,
              outcome:
                event.type === "session.execution.succeeded"
                  ? "succeeded"
                  : event.type === "session.execution.failed"
                    ? "failed"
                    : "interrupted",
              ...(event.type === "session.execution.failed"
                ? { message: errorMessage(event.data.error) }
                : {}),
            },
          }),
        ];
      }
      case "session.inbox.enqueued": {
        const item = event.data.item;
        if (item.type !== "synthetic") return [];
        const metadata = item.payload.metadata;
        if (metadata?.source !== "subagent" || typeof metadata.childID !== "string") return [];
        const outcome =
          metadata.state === "completed"
            ? "succeeded"
            : metadata.state === "error"
              ? "failed"
              : metadata.state === "cancelled"
                ? "interrupted"
                : undefined;
        if (!outcome) return [];
        return [
          rememberOutcome({
            id: event.id,
            type: "synara.opencode.execution",
            properties: { sessionID: metadata.childID, outcome },
          }),
        ];
      }
      case "session.retry.scheduled":
        return [
          {
            id: event.id,
            type: "session.status",
            properties: {
              sessionID: event.data.sessionID,
              status: {
                type: "retry",
                attempt: event.data.attempt,
                next: event.data.at,
                message: errorMessage(event.data.error),
              },
            },
          },
        ];
      case "session.compaction.ended":
        return [
          {
            id: event.id,
            type: "session.compacted",
            properties: { sessionID: event.data.sessionID },
          },
        ];
      case "session.compaction.failed":
        return [
          {
            id: event.id,
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: { name: "UnknownError", data: { message: errorMessage(event.data.error) } },
            },
          },
        ];
      case "session.step.started":
        return changed(event.data.sessionID, {
          id: event.data.assistantMessageID,
          type: "assistant",
          agent: event.data.agent,
          model: event.data.model,
          time: { created: event.data.started },
          content: [],
        });
      case "session.step.ended":
      case "session.step.failed": {
        const message = messages.get(event.data.assistantMessageID);
        if (!message) return [];
        return changed(event.data.sessionID, {
          ...message,
          time: { ...message.time, completed: event.created },
          tokens: event.data.tokens ?? emptyTokens(),
          cost: event.data.cost ?? 0,
          finish: event.type === "session.step.failed" ? "error" : event.data.finish,
          ...(event.type === "session.step.failed" ? { error: event.data.error } : {}),
        });
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        const { sessionID, assistantMessageID, ordinal } = event.data;
        let message = messages.get(assistantMessageID);
        if (!message) {
          message = {
            id: assistantMessageID,
            type: "assistant",
            agent: "build",
            model: { providerID: "", id: "" },
            time: { created: event.created },
            content: [],
          };
          remember(message);
        }
        const type = event.type.startsWith("session.reasoning.") ? "reasoning" : "text";
        const existing = message.content[ordinal];
        const text =
          "text" in event.data
            ? event.data.text
            : (existing && "text" in existing ? existing.text : "") +
              ("delta" in event.data ? event.data.delta : "");
        message.content[ordinal] = { type, text };
        // Emit only the changed part; replaying every earlier tool on each token
        // turns long responses into quadratic work.
        return [
          {
            id: event.id,
            type: "message.updated",
            properties: { sessionID, info: assistantInfo(sessionID, message, directory) },
          },
          {
            id: event.id,
            type: "message.part.updated",
            properties: {
              sessionID,
              time: event.created,
              part: {
                id: partId(assistantMessageID, ordinal),
                sessionID,
                messageID: assistantMessageID,
                type,
                text,
                time: {
                  start: message.time.created,
                  ...(event.type.endsWith(".ended") ? { end: event.created } : {}),
                },
              },
            },
          },
        ];
      }
      case "session.tool.input.started": {
        const message = messages.get(event.data.assistantMessageID);
        if (!message) return [];
        message.content.push({
          type: "tool",
          id: event.data.id,
          name: event.data.name,
          state: { status: "streaming", input: "" },
          time: { created: event.created },
        });
        return [];
      }
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        const message = messages.get(event.data.assistantMessageID);
        const tool = message?.content.find(
          (part): part is SessionMessageAssistantTool =>
            part.type === "tool" && part.id === event.data.id,
        );
        if (!tool) return [];
        const input = typeof tool.state.input === "object" ? tool.state.input : {};
        if (event.type === "session.tool.called") {
          tool.time.ran = event.created;
          tool.state = { status: "running", input: event.data.input, metadata: {} };
        } else if (event.type === "session.tool.progress") {
          tool.state = { status: "running", input, metadata: event.data.metadata };
        } else {
          tool.time.completed = event.created;
          tool.state =
            event.type === "session.tool.success"
              ? {
                  status: "completed",
                  input,
                  content: event.data.content.map((item) =>
                    item.type === "file" ? { ...item, name: item.name ?? null } : item,
                  ) as [
                    import("@opencode/client").ToolContent,
                    ...import("@opencode/client").ToolContent[],
                  ],
                  metadata: event.data.metadata ?? {},
                }
              : {
                  status: "error",
                  input,
                  error: event.data.error,
                  metadata: event.data.metadata ?? {},
                };
        }
        const part = toolPart(event.data.sessionID, event.data.assistantMessageID, tool);
        return [
          {
            id: event.id,
            type: "message.part.updated",
            properties: {
              sessionID: event.data.sessionID,
              time: event.created,
              part,
            },
          },
          ...completedChild(part),
        ];
      }
      default:
        return [];
    }
  };
}
