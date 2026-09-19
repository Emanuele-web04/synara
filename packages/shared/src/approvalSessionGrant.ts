// FILE: approvalSessionGrant.ts
// Purpose: The single definition of what "always allow for this session" grants,
// per approval kind. Server adapters and the web client must agree on it: the
// client shows the supervision state and the server enforces it, so a widening
// one of them does not know about is an un-supervised tool call.

import type { ProviderRequestKind } from "@synara/contracts";

/**
 * How far an `acceptForSession` ("Always allow this session") decision reaches.
 *
 * - `session-policy`: the decision widens the whole session. Every later
 *   request — commands and file changes the user has not seen yet included —
 *   is auto-allowed until the session ends. Only a prompt whose own kind
 *   already carries that blast radius may set it.
 * - `request-scoped`: the decision is remembered for the exact thing that was
 *   asked about and nothing else. The provider persists it on its own channel
 *   (Claude's permission suggestions, Codex's `_meta.persist: "session"`), so a
 *   different tool, command, or permission set prompts again.
 */
export type ApprovalSessionGrantScope = "session-policy" | "request-scoped";

/**
 * The switch is exhaustive on purpose: a new `ProviderRequestKind` fails to
 * compile here until its session-grant blast radius is stated.
 */
export function approvalSessionGrantScope(
  requestKind: ProviderRequestKind | undefined,
): ApprovalSessionGrantScope {
  switch (requestKind) {
    // A permission profile is granted for that exact permission set.
    case "permissions":
    // A tool grant names one tool. Widening it would silently un-supervise
    // command execution and file edits that were never shown to the user.
    case "tool":
      return "request-scoped";
    case "command":
    case "file-read":
    case "file-change":
      return "session-policy";
    // Approvals recorded before request kinds existed can only be command or
    // file prompts, which are exactly the session-policy kinds.
    case undefined:
      return "session-policy";
  }
}

export function approvalSessionGrantWidensSessionPolicy(
  requestKind: ProviderRequestKind | undefined,
): boolean {
  return approvalSessionGrantScope(requestKind) === "session-policy";
}
