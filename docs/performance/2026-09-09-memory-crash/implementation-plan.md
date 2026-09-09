# Safe performance implementation

- [x] Preserve reproducible real-engine baseline, environment and source hashes.
- [x] Replace growing assistant-text writes with lossless durable chunks; verify readers, migration, completion, replay, restart and deletion.
- [x] Restore full adapter history and isolate returned snapshots; preserve Pi tool deduplication.
- [x] Evaluate additional lossless OpenCode dedup-memory reduction with paired evidence.
- [x] Independently audit implementation and run focused regressions.
- [x] Repeat identical workloads and run the authorized final format/lint/type checks once.
- [x] Report measured improvements and remaining risks, including unclean process-owner death and unmeasured whole-app RAM.

Success requires preserved text/history and reproducible improvement on the production engine path. No whole-app memory or crash-resolution claim will be inferred from a mechanism benchmark. Crash cleanup changes require proven ownership; no PID-only reaper or content truncation is acceptable.
