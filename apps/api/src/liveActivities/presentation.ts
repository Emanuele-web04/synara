import type { LiveActivityHostSnapshot } from "@synara/contracts";

type HostTurn = LiveActivityHostSnapshot["turns"][number];
export type LiveActivityConversation = {
  id: string;
  state: HostTurn["state"];
  startedAt?: number;
  usageLimitResetAt?: number;
};
const swiftEpoch = 978307200;
const ongoingStates = new Set<HostTurn["state"]>([
  "running",
  "needsApproval",
  "needsInput",
  "usageLimit",
  "resuming",
]);

function widgetConversation(item: LiveActivityConversation) {
  const waiting = item.state === "usageLimit" || item.state === "resuming";
  return {
    id: item.id,
    title: "Synara task",
    detail: "Synara",
    state: {
      running: "Running",
      needsApproval: "Approval needed",
      needsInput: "Reply needed",
      ready: "Ready",
      failed: "Failed",
      stopped: "Out of date",
      usageLimit: "Usage limit",
      resuming: "Resuming on computer",
    }[item.state],
    ...(!waiting && item.startedAt !== undefined
      ? { runningStartedAt: Math.max(0, item.startedAt - swiftEpoch) }
      : {}),
    ...(item.state === "usageLimit" && item.usageLimitResetAt !== undefined
      ? { usageLimitResetAt: Math.max(0, item.usageLimitResetAt - swiftEpoch) }
      : {}),
  };
}

// ActivityKit decodes Swift Date values relative to 2001, unlike host Unix timestamps.
export function liveActivityContent(conversations: readonly LiveActivityConversation[]) {
  const running = conversations.filter((item) => ongoingStates.has(item.state));
  const completed = conversations.filter((item) => item.state === "ready");
  return {
    ongoing: running.length > 0,
    content: {
      runningConversations: running.slice(0, 3).map(widgetConversation),
      completedConversations: completed
        .slice(0, Math.max(0, 3 - running.length))
        .map(widgetConversation),
      failedConversations: conversations
        .filter((item) => item.state === "failed")
        .slice(0, Math.max(0, 3 - running.length - completed.length))
        .map(widgetConversation),
    },
  };
}
