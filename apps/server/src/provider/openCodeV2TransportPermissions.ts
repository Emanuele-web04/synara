import type { PermissionRequest, PermissionRuleset } from "@opencode-ai/sdk/v2";
import { normalizeOpenCodeV2Session } from "./openCodeV2Data.ts";
import {
  requestOpenCodeV2,
  sessionPath,
  type OpenCodeV2HttpContext,
} from "./openCodeV2TransportHttp.ts";

export function openCodeV2PermissionRules(rules?: PermissionRuleset) {
  return rules?.map((rule) => ({
    action:
      rule.permission === "bash"
        ? "shell"
        : rule.permission === "task"
          ? "subagent"
          : rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }));
}

export interface OpenCodeV2SessionPermissionState {
  readonly rules: Map<string, PermissionRuleset>;
  readonly grants: Map<string, PermissionRuleset>;
}

export function isPlanRules(rules: PermissionRuleset): boolean {
  return rules.some(
    (rule) => rule.permission === "*" && rule.pattern === "*" && rule.action === "deny",
  );
}

export async function grantOpenCodeV2SessionPermission(
  http: OpenCodeV2HttpContext,
  state: OpenCodeV2SessionPermissionState,
  request: PermissionRequest,
  signal?: AbortSignal | null,
  directory?: string,
): Promise<void> {
  let base = state.rules.get(request.sessionID);
  if (!base) {
    base =
      normalizeOpenCodeV2Session(
        await requestOpenCodeV2(
          http,
          sessionPath(request.sessionID),
          "GET",
          undefined,
          signal,
          directory,
        ),
      ).permission ?? [];
    state.rules.set(request.sessionID, base);
  }
  if (isPlanRules(base))
    throw new Error("OpenCode v2 cannot grant session permissions while Plan rules are active.");
  const patterns = request.always.length > 0 ? request.always : request.patterns;
  if (patterns.length === 0)
    throw new Error(
      "OpenCode v2 permission request has no explicit resources to approve for the session.",
    );
  const prior = state.grants.get(request.sessionID) ?? [];
  const next = [
    ...prior,
    ...patterns.map((pattern) => ({
      permission: request.permission,
      pattern,
      action: "allow" as const,
    })),
  ];
  await requestOpenCodeV2(
    http,
    sessionPath(request.sessionID),
    "PATCH",
    { permissions: openCodeV2PermissionRules([...base, ...next]) },
    signal,
    directory,
  );
  state.grants.set(request.sessionID, next);
}
