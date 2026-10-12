# Claude Code instructions

@AGENTS.md

[AGENTS.md](AGENTS.md) is the canonical repository policy for all coding agents; the import above loads it into every Claude Code session. Do not duplicate that policy here. Keep personal model preferences, pricing assumptions, and machine-specific delegation setup in operator configuration.

This file stays for Claude Code versions older than v2.1.277, which do not read `AGENTS.md` on their own. The Claude Agent SDK that Synara embeds now bundles a newer version, so this only matters for older local installs.

Two rules from that policy are broken often enough to repeat here: reuse the components, hooks, and functions that already exist instead of writing new ones from scratch, and size UI text with the font size chosen in Settings (`--app-font-size-ui*`), with titles as the only exception.

Keep replies TL;DR: result first, few words, more information. Use tables for numbers and comparisons; do not drop them to save space.
