import { createHash } from "node:crypto";

import { MessageId, type ProjectKind, type ThreadId } from "@synara/contracts";
import { isGroupContainerKind } from "@synara/shared/projectContainers";
import { isWorkspaceRootWithin } from "@synara/shared/threadWorkspace";

export function isGroupCoordinatorHostProject(input: {
  readonly kind: ProjectKind | undefined;
  readonly workspaceRoot: string;
  readonly groupsWorkspaceRoot: string;
  readonly studioWorkspaceRoot: string;
}): boolean {
  if (!isGroupContainerKind(input.kind)) {
    return false;
  }
  if (input.kind === "studio") {
    return isWorkspaceRootWithin(input.workspaceRoot, input.studioWorkspaceRoot);
  }
  return isWorkspaceRootWithin(input.workspaceRoot, input.groupsWorkspaceRoot);
}

export function coordinatorWelcomeDisplayName(input: {
  readonly userDisplayName?: string | null | undefined;
  readonly homeDir: string;
}): string {
  const fromInput = input.userDisplayName?.trim();
  if (fromInput && fromInput.length > 0) {
    return fromInput;
  }
  const basename = input.homeDir
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()
    ?.trim();
  return basename && basename.length > 0 ? basename : "there";
}

export function coordinatorWelcomeText(name: string): string {
  return `Hi ${name}, welcome to your new group. I coordinate the work here: ask for whatever you need, and I'll either answer you directly or start threads to work on things in parallel.\n\nThreads do the work on their own, and you can see their statuses in Focus. I'll keep an eye on what's running and post updates when something finishes or needs you. You can also ask me to change my instructions, add repositories, or send you scheduled updates.`;
}

export function coordinatorWelcomeMessageId(threadId: ThreadId): MessageId {
  const hash = createHash("sha1").update(`${threadId}:welcome`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return MessageId.makeUnsafe(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}
