# v0.8.4 retained query evidence

`latest-turn-query.json` preserves a local result from the September 10 investigation of the production latest-turn query, included through [PR #1115](https://github.com/Emanuele-web04/synara/pull/1115). It was recovered from `/private/tmp/synara-startup-query-benchmark.json` during release preparation; the values have not been edited or rerun.

The file records an in-memory synthetic Node SQLite fixture with 600 chats and 300,000 historical turns. Returned rows fall from 300,000 to 600 and recorded median operation time from 253.79 to 21.03 ms. The query change is present in `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` at source head `0eaf3831e246eea58d1fde6286cf6d97c9a51e2f`.

The artifact does not retain hardware, Node version, repetition count, timing dispersion or the complete harness. This is limited historical operation-level evidence, not a reproducible full release benchmark, app startup timing or a new measurement. Do not infer CPU, RAM, hardware GPU, battery or provider response improvements from it. Other v0.8.4 metrics link their own experiment reports directly from `CHANGELOG.md`.
