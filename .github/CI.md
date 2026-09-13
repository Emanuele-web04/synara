# CI architecture

The required `Format, Lint, Typecheck, Test, Browser Test, Build` check aggregates
only. Planning and fast static checks start independently. The dependency-aware
plan selects typechecking, unit partitions, stable browser partitions, desktop,
Windows and migration lineage. Main and uncertain/foundational changes run all
validation. Runtime tests and typecheck results remain uncached.

Static/typecheck/core retain full workspace installation. Other product lanes
install root tools, CLI, desktop, scripts and their workspace dependency closure.
Frozen installation and lifecycle patches still execute. Windows no longer
restores the dependency archive that was slower than a cold install. Linux avoids
restoring Bun packages after an exact modules cache hit. Cache keys isolate native
dependencies by OS, architecture, Node version, profile, Electron mode and patches.

Cross-platform measurements, rejected alternatives and final verification are
tracked in issue #1184 and PR #1185. Temporary measurement helpers are not part of
the required job graph. Native release publication/signing policy is unchanged.
