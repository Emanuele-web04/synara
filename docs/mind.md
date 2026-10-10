# Project memory (Mind)

Mind stores short project facts in the server's SQLite database. The five gateway tools resolve the project from the caller's authenticated thread; an agent cannot choose a different project's ID. Mutations require an active turn. UI RPCs, including project profiles, require the authenticated owner.

Each project holds up to 500 memories of at most 500 characters. Recall returns at most eight ranked memories and an 800-character digest. Profiles are explicitly opted in. Recalled text is quoted data, not instructions, and digest text escapes opening angle brackets. Credential-pattern checks reject common secrets but are heuristic, not a guarantee that arbitrary sensitive text can be detected.

Confirmation reinforces weight and slows decay; only pinning prevents decay. A lazy sweep removes at most 100 eligible old, weak memories per project per run. Eligibility is rechecked inside the deletion transaction, preserving concurrent pins and confirmations. Cleanup failure cannot turn an already committed mutation into a failed response.

Writes, operation receipts, and audit records commit together. Audit and revision rows retain hashes and operation metadata, not historical memory text. Durable Mind tables deliberately do not cascade from projection tables: rebuilding the application projection must not erase memory or profiles. The five migrations append after the existing released lineage, currently at IDs 132–136.

The sidebar and rail expose Mind with shared list-cache counts. Search is full-text over memory text, not project names. Both the global list and search return bounded pages with the true total count. Storage failures remain errors rather than empty search results.

The scoring constants and some guidance are adapted from Da7-Tech/mind. ATTRIBUTION.md carries the complete MIT notice and is copied into packaged desktop resources. This includes the notice independently of the separate attribution PR.

Tests cover cross-project isolation, retries, atomic receipts, caps, digest boundaries, rejected secrets, projection rebuilds, concurrent pruning, FTS outages, owner admission, and navigation. Live provider behavior and signed macOS packaging require separate smoke testing; proactive recall is guidance, not a guarantee that every model will follow it.
