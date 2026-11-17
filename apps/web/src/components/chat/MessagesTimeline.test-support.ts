export function makeTimelineBaseProps(nowIso: string | null = "2026-03-17T19:12:30.000Z") {
  return {
    hasMessages: true,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    ...(nowIso === null ? {} : { nowIso }),
    expandedWorkGroups: {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
  };
}
