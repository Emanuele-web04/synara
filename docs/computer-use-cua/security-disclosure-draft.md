# Security disclosure policy — DRAFT

Status: draft for the proposed open computer-use package. Not yet adopted. The
reporting channel and the named owner are placeholders; both must be decided
before this file ships (see `open-decisions-sheet.md`, and the spec's rule that
a monitored channel with a named owner is a release blocker). If the open
package gets its own repository, this file should land there as `SECURITY.md`.

## Scope

This policy covers the open computer-use package: the driver patch, the host
protocol, the tool layer, and the docs listed in `open-package-file-list.md`.
Synara product code is out of scope and keeps its own reporting path.

The highest severity class for this package is a consent-bypass bug: any code
path that delivers synthetic input, captures the screen, or enumerates windows
without the macOS Accessibility or Screen Recording consent the user granted, or
that hides agent activity from the user. Also in scope: approval-gate bypasses,
targeting failures that deliver input to a window other than the approved one,
and cleanup-acknowledgement failures that let a driver generation act after its
turn ended.

## Where to report

- Report privately to: **TODO — reporting channel not yet chosen.** Candidate
  channels are a GitHub private security advisory on the package repository or a
  monitored security mailbox. This field is unverified until an owner picks one.
- Do not open a public issue for a suspected consent-bypass bug.
- Include the pinned driver version, the native revision, the host OS version,
  and a minimal reproduction. Do not include credentials or personal data.

## Fix-first policy

The fix ships before the disclosure. Sequence:

1. Triage and confirm within a stated window. **TODO — set the window when the
   channel is staffed.** Unverified until then.
2. Develop the fix privately.
3. Ship the fix in a released package version.
4. Publish the disclosure after the fix ships, crediting the reporter unless
   they ask otherwise.

If the bug is a consent-bypass class bug, the release notes name the class
plainly. The package never documents, scripts, or ships a workaround that routes
around Accessibility or Screen Recording consent. Protected system prompts stay
free of synthetic input.

## What reporters can expect

- Acknowledgement of the report. **TODO — timeline placeholder, unverified.**
- A fix-first timeline with a disclosure date agreed after the fix ships.
- No legal action against good-faith research that stays within consent and
  privacy bounds: no accessing other users' data, no persistent presence, no
  disruption.

## Known limits to restate in the disclosure

The local capability is a boundary against accidental authority inheritance,
not a sandbox against same-user malware with access to the host's memory or
filesystem (`docs/computer-use-cua/README.md:54`). Reports about threats outside
that boundary are still welcome, but the disclosure should say which boundary
applied.
