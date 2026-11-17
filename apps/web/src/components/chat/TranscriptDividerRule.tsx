// FILE: TranscriptDividerRule.tsx
// Purpose: The hairline on either side of a transcript boundary label (fork source,
// provider handoff, usage-limit pause), so every boundary shares one rule.
// Layer: Chat transcript UI

export function TranscriptDividerRule() {
  return <span aria-hidden className="h-px min-w-0 flex-1 bg-[color:var(--color-border-light)]" />;
}
