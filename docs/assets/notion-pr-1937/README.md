# Notion integration — PR #1937 visual evidence

**29 real Chromium screenshots**, checked into the PR branch for durable review: 10 new Tasks-discovery captures and 19 earlier Notion-record/view captures. Each image is an actual Synara React component rendered with deterministic fixture data and the Synara design system. These are **not AI-generated**, live Notion OAuth proof, complete app E2E proof, or production screenshots.

See [`manifest.json`](manifest.json) for source workflow run IDs, original screenshot names, revisions, byte counts and Git blob hashes. PNG bytes are preserved exactly from the verified Actions archives.

## Latest Tasks workflow (10 images)

New capture: [run 38877198693](https://github.com/Emanuele-web04/synara/actions/runs/38877198693), Chromium 151.0.7922.34. Before revision `9fc733a`; After revision `d5ea733`. All three pairs use matching themes/viewports/fixture tasks.

| Surface | Before | After |
| --- | --- | --- |
| Tasks · dark | ![Tasks · dark before](current/before-tasks-dark.png) | ![Tasks · dark after](current/after-tasks-dark.png) |
| Tasks · light | ![Tasks · light before](current/before-tasks-light.png) | ![Tasks · light after](current/after-tasks-light.png) |
| Tasks · narrow (390 px) | ![Tasks · narrow (390 px) before](current/before-tasks-narrow.png) | ![Tasks · narrow (390 px) after](current/after-tasks-narrow.png) |

### Further verified Tasks interactions

- **Filter controls**

![Task source, project, status and assignee filters](current/after-task-filters.png)

- **The selected imported task remains open after filtering its row out of the list**

![Filter and selected Notion task](current/after-filtered-open-task.png)

- **Connected workspace picker, accessible without returning to Settings**

![Connected Notion workspace picker](current/after-connected-workspace.png)

- **Mapped database opened through the existing workspace browser**

![Mapped Notion database in Synara](current/after-mapped-database.png)

## Earlier Notion records, planning and documentation (19 images)

Capture: [run 38804921325](https://github.com/Emanuele-web04/synara/actions/runs/38804921325). Before `ac2d3c1`; After product-file revision `7fb4a36`. These images represent their earlier code revisions, **not** a second run against the final Tasks branch.

| Surface | Before | After |
| --- | --- | --- |
| Database table | ![Database table before](previous/before-table.png) | ![Database table after](previous/after-table.png) |
| Status board | ![Status board before](previous/before-board.png) | ![Status board after](previous/after-board.png) |
| Calendar | ![Calendar before](previous/before-calendar.png) | ![Calendar after](previous/after-calendar.png) |
| Timeline | ![Timeline before](previous/before-timeline.png) | ![Timeline after](previous/after-timeline.png) |
| Sprint planning | ![Sprint planning before](previous/before-sprints.png) | ![Sprint planning after](previous/after-sprints.png) |
| Mapping controls | ![Mapping controls before](previous/before-mapping.png) | ![Mapping controls after](previous/after-mapping.png) |
| Settings | ![Settings before](previous/before-settings.png) | ![Settings after](previous/after-settings.png) |
| Wiki page | ![Wiki page before](previous/before-wiki.png) | ![Wiki page after](previous/after-wiki.png) |
| Rich-text editor | ![Rich-text editor before](previous/before-rich-text-editor.png) | ![Rich-text editor after](previous/after-rich-text-editor.png) |

The two mapping-control PNGs are byte-identical in the source archive (same blob SHA); both originals are retained for completeness. Do not interpret that pair as visual proof of change.

### Additional date-property editor capture

![Notion date property editor after](previous/after-date-property-editor.png)

## Verification boundary

- Current run passed 64 focused web/server checks, clean tracked source, repository formatting, Chromium interactions, 390-pixel overflow checks, and light/dark browser-render checks. The earlier run's checks apply only to its recorded revision.
- Historical and current screenshots are captured with fixture transport; no live Notion user data or OAuth credentials are included.
- See [the PR description](https://github.com/Emanuele-web04/synara/pull/1937) for unverified live integration, remaining acceptance items, and CI limitations.
