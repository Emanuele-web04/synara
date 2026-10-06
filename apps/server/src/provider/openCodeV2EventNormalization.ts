// Protocol mappings informed by Zeron (MIT, Copyright 2026 Wing).
// See opencode-v2-notice.txt for the retained license notice.
import type { OpenCodeEvent } from "./openCodeClient";
import { UnsupportedOpenCodeV2FormError } from "./openCodeV2Forms.ts";
import {
  normalizeOpenCodeV2Form,
  normalizeOpenCodeV2FormReply,
  normalizeOpenCodeV2Permission,
} from "./openCodeV2Data";
import { normalizeOpenCodeV2Tokens } from "./openCodeV2Session";
import {
  event,
  object,
  string,
  v2Error,
  v2MessageId,
  v2PartId,
  v2TextPart,
  v2ToolKey,
  v2ToolPart,
  v2ShellEvent,
  type V2ToolState,
} from "./openCodeV2EventParts";

/** One normalizer belongs to one client, retaining tool metadata across bus reconnects. */
export function createOpenCodeV2EventNormalizer(): (frame: unknown) => OpenCodeEvent[] {
  const tools = new Map<string, V2ToolState>();
  const models = new Map<string, Record<string, unknown>>();
  const forms = new Map<string, unknown>();
  return (frame) => {
    // Effect's SSE encoding can wrap an encoded JSON event in an SSE object.
    if (typeof frame === "string") frame = JSON.parse(frame);
    let value = object(frame);
    if (value?.event !== undefined && value.type === undefined) {
      const nested = typeof value.data === "string" ? JSON.parse(value.data) : value.data;
      value = object(nested);
    }
    const kind = string(value?.type);
    const data = object(value?.data);
    if (!kind || !data) return [];
    if (kind === "form.created" || kind === "session.form.created") {
      let form;
      try {
        form = normalizeOpenCodeV2Form(data.form ?? data);
      } catch (error) {
        if (!(error instanceof UnsupportedOpenCodeV2FormError)) throw error;
        return [
          event("question.unsupported", {
            sessionID: error.sessionID,
            requestID: error.requestID,
            message: error.message,
          }),
        ];
      }
      forms.set(form.id, data.form ?? data);
      if (forms.size > 4096) throw new Error("Too many pending OpenCode v2 forms.");
      return [event("question.asked", { ...form })];
    }
    const sessionID = string(data.sessionID) ?? string(object(data.form)?.sessionID);
    if (!sessionID) return [];
    const properties = { ...data, sessionID, timestamp: data.timestamp ?? value?.created };
    const messageID = v2MessageId(properties);
    if (kind.startsWith("session.execution.") && kind !== "session.execution.started") {
      for (const key of tools.keys()) {
        if (JSON.parse(key)[0] === sessionID) tools.delete(key);
      }
      models.delete(sessionID);
    }
    switch (kind) {
      case "session.execution.started":
        return [event("session.status", { sessionID, status: { type: "busy" } })];
      case "session.execution.succeeded":
        return [event("session.idle", { sessionID })];
      case "session.execution.interrupted":
        return data.reason === "shutdown" ? [] : [event("session.interrupted", { sessionID })];
      case "session.execution.failed":
        return [event("session.error", { sessionID, error: v2Error(data.error) })];
      case "session.step.failed": {
        const error = v2Error(data.error);
        return error.name === "aborted"
          ? []
          : [
              event("session.warning", {
                sessionID,
                message: error.data.message,
                detail: data.error,
              }),
            ];
      }
      case "session.retry.scheduled":
        return [
          event("session.status", {
            sessionID,
            status: {
              type: "retry",
              attempt: data.attempt,
              next: data.at,
              message: v2Error(data.error).data.message,
            },
          }),
        ];
      case "session.step.started":
        if (!messageID) return [];
        if (object(data.model)) models.set(sessionID, object(data.model)!);
        if (models.size > 4096) models.clear();
        return [
          event("message.updated", {
            sessionID,
            info: { sessionID, id: messageID, role: "assistant" },
          }),
        ];
      case "session.step.ended": {
        if (!messageID) return [];
        const model = models.get(sessionID);
        // Step finish does not settle execution: a subsequent tool/retry step may follow.
        return [
          event("message.updated", {
            sessionID,
            info: {
              sessionID,
              id: messageID,
              role: "assistant",
              tokens: normalizeOpenCodeV2Tokens(data.tokens),
              cost: data.cost,
              ...(model ? { providerID: model.providerID, modelID: model.id } : {}),
            },
          }),
        ];
      }
      case "session.text.started":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.ended": {
        if (!messageID) return [];
        const partKind = kind.startsWith("session.reasoning.") ? "reasoning" : "text";
        return [v2TextPart(properties, partKind, kind.endsWith(".ended"))];
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        if (!messageID || typeof data.delta !== "string") return [];
        const partKind = kind === "session.reasoning.delta" ? "reasoning" : "text";
        return [
          event("message.part.delta", {
            sessionID,
            messageID,
            partID: v2PartId(properties, partKind),
            field: "text",
            delta: data.delta,
          }),
        ];
      }
      case "session.tool.input.started":
      case "session.tool.input.ended":
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed":
      case "session.tool.error": {
        if (!messageID || (!string(data.id) && !string(data.callID))) return [];
        const key = v2ToolKey(properties);
        const previous = tools.get(key);
        const tool: V2ToolState = {
          name: string(data.name) ?? string(data.tool) ?? previous?.name ?? "tool",
          input: object(data.input) ?? previous?.input ?? {},
          start:
            previous?.start ??
            (typeof properties.timestamp === "number" ? properties.timestamp : 0),
        };
        const status = kind.endsWith(".success")
          ? "completed"
          : kind.endsWith(".error") || kind.endsWith(".failed")
            ? "error"
            : kind.includes(".input.")
              ? "pending"
              : "running";
        if (status === "completed" || status === "error") tools.delete(key);
        else {
          tools.set(key, tool);
          if (tools.size > 4096) throw new Error("Too many pending OpenCode v2 tool calls.");
        }
        return [v2ToolPart(properties, tool, status)];
      }
      case "permission.asked":
        return [event("permission.asked", { ...normalizeOpenCodeV2Permission(properties) })];
      case "permission.replied":
        return [
          event(kind, {
            ...properties,
            requestID: data.requestID ?? data.id,
            reply: data.decision ?? data.reply,
          }),
        ];
      case "form.replied":
      case "session.form.replied": {
        const requestID = string(data.formID) ?? string(data.id) ?? string(object(data.form)?.id);
        if (!requestID) return [];
        const form = forms.get(requestID);
        forms.delete(requestID);
        return [
          event("question.replied", {
            sessionID,
            requestID,
            answers: form ? normalizeOpenCodeV2FormReply(form, data.answer) : [],
          }),
        ];
      }
      case "form.cancelled":
      case "session.form.cancelled": {
        const requestID = string(data.formID) ?? string(data.id) ?? string(object(data.form)?.id);
        if (!requestID) return [];
        forms.delete(requestID);
        return [event("question.rejected", { sessionID, requestID })];
      }
      case "session.compaction.ended":
        return [event("session.compacted", { sessionID })];
      case "session.shell.started":
      case "session.shell.ended":
        return v2ShellEvent(kind, properties);
      case "session.created":
      case "session.updated":
      case "session.deleted":
        // These wire events do not contain a complete legacy Session.Info.
        // Session/child reconciliation reads authoritative HTTP snapshots.
        return [];
      case "session.status":
      case "session.compacted":
      case "todo.updated":
        return [event(kind, properties)];
      default:
        return [];
    }
  };
}
