# Find connected Notion work in Tasks

The existing Tasks list displays imported Notion work beside local Synara tasks. A source line shows the remote status, assignees and non-synced state. Agent progress remains separate from the Notion workflow status.

## Filter the list

Open **Filter tasks** to combine source, Synara project, Notion status and Notion assignee filters. **Clear filters** returns to the full list. Project choices refer to local Synara projects; they do not imply a remote Notion project relation.

Status identifiers are scoped to the connection and data source. Assignee identifiers are scoped to the connection. Matching display names do not merge identities, and the integration does not infer an "Assigned to me" identity. Filters operate on the currently synchronized Tasks collection, not every record in the remote workspace.

Filtering changes the list projection, not task ownership or the selected task card. An open task remains selected when it no longer matches the filters. New synchronization events are evaluated using the same filters. Filter choices last for the mounted Tasks view and are not persisted as saved Notion views.

## Open the connected workspace

Use **Notion workspace** in the Tasks heading to open existing mapped database views and sprint planning. A project filter limits the launcher to enabled mappings associated with that Synara project. Without a project filter, **Browse shared pages** opens the existing workspace title search.

Close the task card before using this launcher. Task-specific page and property controls remain available inside the existing card. Disconnected workspaces require reconnection in Settings. The launcher does not grant access; the existing server authorization and write-approval boundaries remain authoritative.

## Verification and limitations

The `Notion Tasks evidence` workflow runs the actual React components and design-system CSS in Chromium with deterministic transport fixtures. The before revision is pinned in `apps/web/scripts/notion-tasks-evidence.mjs`; the after revision and executed checks are recorded in the artifact. Fixture screenshots are not a live Notion workspace, a complete application end-to-end run, or proof of OAuth success.

Run the capture from a dependency-installed checkout with the pinned browser installed:

```sh
node apps/web/scripts/notion-tasks-evidence.mjs
```

The fixture never sends writes to Notion. Production deployment, token lifecycle, multi-user concurrency and packaged platform journeys still require the acceptance described in [Notion integration](notion-integration.md). Global search-palette integration, document full-text indexing and named document hierarchy navigation are not supplied by the Tasks launcher.
