# Transcript recovery disclosure

Both images render the production `MessagesTimeline` component in Chromium at the same
1,000 × 260 viewport. The controlled lifecycle activity uses the long-thread regression's
160 historical messages plus its latest seed: 67 messages omitted and 88 retained
messages shortened by the unchanged replay budget.

- `before.png`: the existing recovery summary does not disclose those counts.
- `after.png`: the same row places the counts first, where they remain visible when
  the rest of the sentence is truncated.

This is component-level visual evidence with controlled activity data. It does not
exercise authenticated provider startup or native-session restoration. The separate
reactor regression verifies that a real SQLite-backed recovery activity records the
displayed counts after the matching provider turn completes.

The temporary capture fixture rendered the same production component for both states
and was removed after capture; no product layout, styling, or control changed.
