# Real native transcript regression

A production UI run against OpenCode 1.19.0 and `opencode/mimo-v2.6-flash-free` revealed duplicated assistant text in Synara while the native provider SQLite transcript contained the correct answer. The checked-in `opencode-native-late-role-trace.json` contains the actual seven native wire events from the synthetic empty-repository run. Assistant role metadata arrived after both text deltas and the final cumulative snapshot.

The regression replay failed with `NATIVE_PARALLEL_OKATIVE_PARALLEL_OK` before the fix. Buffering the known snapshot baseline and reconciling it with the cumulative snapshot prevents the duplicate while preserving intentional repeats. This replay is a supplemental deterministic regression test; it does not substitute for native acceptance.

The repaired production UI was then exercised with three actual native sessions plus a fourth comparison session. All four turns completed. Each attempt's Synara SQLite answer exactly matched its native OpenCode SQLite answer: `NATIVE_PARALLEL_OK`. Keeping one attempt archived the two siblings while preserving the source and all three branches/worktrees. The complete browser captures and report are on PR #1811 in `docs/verification/parallel-run-native-three-*`.
