import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { ExternalHistoryLinkRecord } from "../persistence/Services/ExternalHistory.ts";
import { planExternalHistorySync } from "./externalHistorySync.ts";

const PROJECT_ID = ProjectId.makeUnsafe("prj-1");
const THREAD_ID = ThreadId.makeUnsafe("thr-1");

const link = (overrides: Partial<ExternalHistoryLinkRecord> = {}): ExternalHistoryLinkRecord => ({
  linkId: "ehl-1",
  sourceId: "devin-local",
  externalSessionId: "sess-1",
  threadId: THREAD_ID,
  sourceRevision: "1700000000",
  committedMessageCursor: "12",
  historyStatus: "complete",
  nativeResumeDescriptor: null,
  upstreamMetadata: null,
  userOverrideFlags: null,
  suppressedAt: null,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

const shell = (status: "idle" | "running" | "stopped" = "idle") =>
  ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    session: { status },
  }) as never;

describe("planExternalHistorySync", () => {
  it("skips tombstoned links", () => {
    expect(
      planExternalHistorySync({
        link: link({ suppressedAt: "2025-01-02T00:00:00Z" }),
        threadShell: shell(),
        matchedProjectId: null,
        sessionRevision: "1700000001",
      }),
    ).toEqual({ kind: "skip", reason: "suppressed" });
  });

  it("tombstones a link whose thread was deleted", () => {
    expect(
      planExternalHistorySync({
        link: link(),
        threadShell: null,
        matchedProjectId: null,
        sessionRevision: null,
      }),
    ).toEqual({ kind: "tombstone" });
  });

  it("pauses incremental sync while the thread session is running", () => {
    expect(
      planExternalHistorySync({
        link: link(),
        threadShell: shell("running"),
        matchedProjectId: null,
        sessionRevision: "1700000001",
      }),
    ).toEqual({ kind: "skip", reason: "busy" });
  });

  it("skips unchanged sessions so repeated scans produce no dispatch", () => {
    expect(
      planExternalHistorySync({
        link: link(),
        threadShell: shell(),
        matchedProjectId: null,
        sessionRevision: "1700000000",
      }),
    ).toEqual({ kind: "skip", reason: "unchanged" });
  });

  it("incrementally syncs a linked session whose revision advanced", () => {
    expect(
      planExternalHistorySync({
        link: link(),
        threadShell: shell("stopped"),
        matchedProjectId: null,
        sessionRevision: "1700000001",
      }),
    ).toEqual({ kind: "incremental", projectId: PROJECT_ID });
  });

  it("imports a new session into the project matching its workspace", () => {
    expect(
      planExternalHistorySync({
        link: null,
        threadShell: null,
        matchedProjectId: PROJECT_ID,
        sessionRevision: null,
      }),
    ).toEqual({ kind: "import", projectId: PROJECT_ID });
  });

  it("inboxes a new session with no matching project", () => {
    expect(
      planExternalHistorySync({
        link: null,
        threadShell: null,
        matchedProjectId: null,
        sessionRevision: null,
      }),
    ).toEqual({ kind: "inbox" });
  });

  it("retries matching for an inbox link once a project appears", () => {
    expect(
      planExternalHistorySync({
        link: link({ threadId: null, historyStatus: "pending" }),
        threadShell: null,
        matchedProjectId: PROJECT_ID,
        sessionRevision: null,
      }),
    ).toEqual({ kind: "import", projectId: PROJECT_ID });
  });
});
