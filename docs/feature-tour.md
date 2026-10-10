# Feature tour since 0.9.2

The post-startup tour introduces the largest user-facing changes merged after
`v0.9.2`. It is separate from the versioned release history: the current workspace
still reports 0.9.2, so waiting for a version change would hide these highlights.

## Curated highlights

| Slide       | Changes inspected                                                                                                                                         | Availability                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Workspace   | Rail and customization (#1353, #1364), open-thread tabs (#1383), window appearance (#1382, #1421), unified tabs and Hugeicons (#1513)                     | Stable and Beta                    |
| Agents      | Multiple provider accounts (#1165), account picker (#1402), guided sign-in and Stable OMP (#1459), per-account usage (#1474), same-thread handoff (#1494) | Stable and Beta                    |
| Code review | PRs and issues, list/detail layout and side chats (#1400), sorting (`155c99309`), agent handoff (#1441)                                                   | Stable and Beta                    |
| Teams       | Hubs and Library (#1378, #1390, #1490), Tasks with List/Kanban and delegation (#1368, #1379)                                                              | Hubs: Beta; Tasks: Stable and Beta |

Inbox is available in Stable and Beta; its to-do controls use Tasks in both apps.
Auto-fix CI is also available in both apps and remains opt-in.

Small fixes, internal refactors, and existing features with minor refinements are
omitted to keep this tour short. Provider/model availability remains determined by
the installed runtime and accounts; the illustrations do not initiate requests.

## Startup and replay

- Safari and AppSnap support probes finish before the tour mounts.
- Completing or skipping first-run onboarding acknowledges these highlights, so a new
  installation is not greeted with a second tour. Provisional startup auto-hiding and
  a manual welcome replay do not acknowledge them. Configured installations see the
  edition once, regardless of their previous application version.
- Onboarding, Beta welcome, project import, the announcement slot, and other open
  dialogs block the tour. A short quiet interval also waits for exit transitions.
- Confirming an announcement that opens a follow-on flow defers automatic display
  until another launch. The tour does not acknowledge itself when deferred.
- Completing, skipping, Escape, or backdrop dismissal records the installation's
  worktrees directory in `synara:feature-tour:since-0.9.2:v1`.
- Settings → Advanced → What's new since 0.9.2 offers **Replay feature tour**.
  A deliberate replay is allowed after a startup handoff, but waits for open dialogs.
- The tour uses `AnnouncementSheet`, the shared buttons, provider icons, Hugeicons,
  and UI typography tokens. Each slide is one small illustration, a title, a short
  pitch, and a few highlights; it embeds no live application surfaces.

Maintain content in `apps/web/src/featureTour/content.ts`. For another edition,
change the storage key alongside the copy. Do not advertise Beta-only features on
Stable or put unreleased highlights into an older release entry.
