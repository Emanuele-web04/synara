import type { PermissionRequest, PermissionRuleset } from "@opencode-ai/sdk/v2";
import {
  v2Array,
  v2Data,
  v2Object,
  v2OptionalObject,
  v2String,
  v2Strings,
} from "./openCodeV2Json.ts";

const legacyPermission = (action: string): string =>
  action === "shell" ? "bash" : action === "subagent" ? "task" : action;

export function normalizeOpenCodeV2PermissionRules(value: unknown): PermissionRuleset {
  return v2Array(value ?? [], "permission rules").map((entry) => {
    const rule = v2Object(entry, "permission rule");
    const action = v2String(rule.effect, "permission rule.effect");
    if (action !== "allow" && action !== "deny" && action !== "ask")
      throw new Error("Invalid OpenCode v2 permission effect");
    return {
      permission: legacyPermission(v2String(rule.action, "permission action")),
      pattern: v2String(rule.resource, "permission resource"),
      action,
    };
  });
}

export function normalizeOpenCodeV2Permission(value: unknown): PermissionRequest {
  const request = v2Object(v2Data(value), "permission request");
  const source = v2OptionalObject(request.source);
  return {
    id: v2String(request.id, "permission.id"),
    sessionID: v2String(request.sessionID, "permission.sessionID"),
    permission: legacyPermission(v2String(request.action, "permission.action")),
    patterns: v2Strings(request.resources, "permission.resources"),
    always: v2Strings(request.save ?? [], "permission.save"),
    metadata: {
      ...v2OptionalObject(request.metadata),
      ...(request.message === undefined
        ? {}
        : { message: v2String(request.message, "permission.message") }),
    },
    ...(source.type === "tool"
      ? {
          tool: {
            messageID: v2String(source.messageID, "permission.source.messageID"),
            callID: v2String(source.id, "permission.source.id"),
          },
        }
      : {}),
  };
}

export function normalizeOpenCodeV2Permissions(value: unknown): PermissionRequest[] {
  return v2Array(value, "permissions").map(normalizeOpenCodeV2Permission);
}
