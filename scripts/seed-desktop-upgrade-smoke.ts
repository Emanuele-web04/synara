#!/usr/bin/env -S bunx --bun=false tsx
// FILE: seed-desktop-upgrade-smoke.ts
// Purpose: Creates an isolated pre-workspace Synara profile for packaged desktop upgrade checks.
// Layer: Release/test support
// Depends on: Server migrations through 053, a temporary Git repository, and a real image asset.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../apps/server/src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../apps/server/src/persistence/NodeSqliteClient.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function resolveBaseDir(): string {
  const requested = process.argv[2]?.trim();
  if (!requested) {
    return mkdtempSync(join(tmpdir(), "synara-desktop-upgrade-smoke-"));
  }

  const baseDir = resolve(requested);
  mkdirSync(baseDir, { recursive: true });
  if (readdirSync(baseDir).length > 0) {
    throw new Error(`Refusing to seed non-empty directory: ${baseDir}`);
  }
  return baseDir;
}

function runGit(args: ReadonlyArray<string>, cwd?: string): string {
  return execFileSync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const baseDir = resolveBaseDir();
const stateDir = join(baseDir, "userdata");
const attachmentsDir = join(stateDir, "attachments");
const repository = join(baseDir, "legacy-repository");
const existingWorktree = join(baseDir, "legacy-worktree");
const dbPath = join(stateDir, "state.sqlite");

mkdirSync(attachmentsDir, { recursive: true });
mkdirSync(repository, { recursive: true });
runGit(["init", "-b", "main"], repository);
runGit(["config", "user.email", "upgrade-smoke@synara.local"], repository);
runGit(["config", "user.name", "Synara Upgrade Smoke"], repository);
execFileSync("touch", [join(repository, "README.md")]);
runGit(["add", "README.md"], repository);
runGit(["commit", "-m", "Seed legacy upgrade fixture"], repository);
runGit(["worktree", "add", "-b", "feature/legacy-upgrade", existingWorktree], repository);

const canonicalRepository = realpathSync(repository);
const canonicalWorktree = realpathSync(existingWorktree);
const repositoryHead = runGit(["rev-parse", "HEAD"], repository);
const attachmentId = "legacy-thread-11111111-1111-4111-8111-111111111111";
const attachmentPath = join(attachmentsDir, `${attachmentId}.png`);
copyFileSync(join(repoRoot, "assets/prod/black-macos-1024.png"), attachmentPath);
const attachmentSizeBytes = statSync(attachmentPath).size;

const createdAt = "2026-07-15T20:00:00.000Z";
const modelSelection = JSON.stringify({ provider: "codex", model: "gpt-5.5" });
const imageAttachments = JSON.stringify([
  {
    type: "image",
    id: attachmentId,
    name: "legacy-synara-image.png",
    mimeType: "image/png",
    sizeBytes: attachmentSizeBytes,
  },
]);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 53 });

  yield* sql`
    INSERT INTO projection_projects (
      project_id, kind, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      'legacy-upgrade-project', 'project', 'Legacy Upgrade Fixture', ${canonicalRepository},
      ${modelSelection}, '[]', ${createdAt}, ${createdAt}, NULL
    )
  `;

  const insertThread = (
    threadId: string,
    title: string,
    branch: string,
    worktreePath: string | null,
    archivedAt: string | null = null,
  ) => sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, branch, worktree_path,
      created_at, updated_at, archived_at, deleted_at
    ) VALUES (
      ${threadId}, 'legacy-upgrade-project', ${title}, ${modelSelection}, ${branch},
      ${worktreePath}, ${createdAt}, ${createdAt}, ${archivedAt}, NULL
    )
  `;

  yield* insertThread("legacy-thread-image", "Upgrade smoke — image conversation", "main", null);
  yield* insertThread(
    "legacy-thread-rich-text",
    "Upgrade smoke — formatted conversation",
    "main",
    null,
  );
  yield* insertThread(
    "legacy-thread-worktree",
    "Existing worktree conversation",
    "feature/legacy-upgrade",
    canonicalWorktree,
  );
  yield* insertThread(
    "legacy-thread-archived",
    "Archived legacy conversation",
    "main",
    null,
    createdAt,
  );

  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
      created_at, updated_at
    ) VALUES (
      'legacy-message-image', 'legacy-thread-image', NULL, 'user',
      'This image and conversation must survive the desktop upgrade.', 0,
      ${imageAttachments}, ${createdAt}, ${createdAt}
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
      created_at, updated_at
    ) VALUES (
      'legacy-message-rich-text', 'legacy-thread-rich-text', NULL, 'assistant',
      ${"## Preserved formatting\n\n- Existing Markdown remains readable.\n- [Synara link](https://github.com/Emanuele-web04/synara) remains clickable.\n\n```ts\nconst upgraded = true;\n```"},
      0, '[]', ${createdAt}, ${createdAt}
    )
  `;
});

await Effect.runPromise(
  Effect.scoped(seed.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })))),
);

console.log(
  JSON.stringify(
    {
      baseDir,
      dbPath,
      repository: canonicalRepository,
      existingWorktree: canonicalWorktree,
      repositoryHead,
      attachmentPath,
      migration: 53,
    },
    null,
    2,
  ),
);
