# Claude Code instructions

@AGENTS.md

[AGENTS.md](AGENTS.md) is the canonical repository policy for all coding agents; the import above loads it into every Claude Code session. Do not duplicate that policy here. Keep personal model preferences, pricing assumptions, and machine-specific delegation setup in operator configuration.

This file stays because Claude Code reads `AGENTS.md` on its own only from v2.1.277, and the Claude Agent SDK that Synara embeds still bundles an older version.
