import { summarizeComputerAuditArgs } from "../computer/computerAuditLog.ts";

/** Show an action's shape on a durable approval card without persisting input payloads. */
export function computerApprovalDisplayArgs(args: Record<string, unknown>): string {
  const summary = summarizeComputerAuditArgs(args);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(summary).filter(
        ([key]) =>
          ![
            "text",
            "value",
            "prompt_text",
            "headers",
            "authorization",
            "cookie",
            "password",
            "token",
            "secret",
          ].includes(key.toLowerCase()),
      ),
    ),
  );
}
