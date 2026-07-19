export interface RecoverableCreationPlanEntry {
  readonly workspaceRoot: string;
  readonly environment: "local" | "worktree";
  readonly newBranch: string | null;
  readonly plannedWorktreePath: string | null;
  readonly ownershipPreflightPassed: boolean;
  readonly worktreeOwnership: {
    readonly operationId: string;
    readonly path: string;
    readonly branch: string;
    readonly recordedAt: string;
  } | null;
  readonly ids: {
    readonly threadId: string;
    readonly compensateCommandId: string;
  };
}

function parsePlanArray(planJson: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(planJson);
  if (!Array.isArray(parsed)) {
    throw new Error("Stored gateway creation plan is not an array.");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Stored gateway creation plan entry ${index} is invalid.`);
    }
    return entry as Record<string, unknown>;
  });
}

export function parseRecoverableCreationPlan(
  planJson: string,
  operationId: string,
): ReadonlyArray<RecoverableCreationPlanEntry> {
  return parsePlanArray(planJson).map((value, index) => {
    const ids = value.ids;
    if (!ids || typeof ids !== "object") {
      throw new Error(`Stored gateway creation plan entry ${index} has no deterministic ids.`);
    }
    const idRecord = ids as Record<string, unknown>;
    if (
      typeof value.workspaceRoot !== "string" ||
      (value.environment !== "local" && value.environment !== "worktree") ||
      (value.newBranch !== null && typeof value.newBranch !== "string") ||
      (value.plannedWorktreePath !== null && typeof value.plannedWorktreePath !== "string") ||
      typeof idRecord.threadId !== "string" ||
      typeof idRecord.compensateCommandId !== "string"
    ) {
      throw new Error(`Stored gateway creation plan entry ${index} is incomplete.`);
    }
    const rawOwnership = value.worktreeOwnership;
    const ownership =
      rawOwnership && typeof rawOwnership === "object"
        ? (rawOwnership as Record<string, unknown>)
        : null;
    const worktreeOwnership =
      ownership?.operationId === operationId &&
      typeof ownership.path === "string" &&
      typeof ownership.branch === "string" &&
      typeof ownership.recordedAt === "string" &&
      ownership.path === value.plannedWorktreePath &&
      ownership.branch === value.newBranch
        ? {
            operationId,
            path: ownership.path,
            branch: ownership.branch,
            recordedAt: ownership.recordedAt,
          }
        : null;
    return {
      workspaceRoot: value.workspaceRoot,
      environment: value.environment,
      newBranch: value.newBranch,
      plannedWorktreePath: value.plannedWorktreePath,
      // Older in-progress rows predate explicit ownership proof. They remain
      // decodable, but recovery never treats their preflight as proof that a
      // currently registered resource belongs to the operation.
      ownershipPreflightPassed: value.ownershipPreflightPassed === true,
      worktreeOwnership,
      ids: {
        threadId: idRecord.threadId,
        compensateCommandId: idRecord.compensateCommandId,
      },
    };
  });
}

export function recordCreatedWorktreeInPlan(input: {
  readonly planJson: string;
  readonly operationId: string;
  readonly index: number;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly recordedAt: string;
}): string {
  const plan = parsePlanArray(input.planJson);
  const entry = plan[input.index];
  if (!entry) {
    throw new Error(`Gateway creation plan has no entry ${input.index}.`);
  }
  if (
    entry.environment !== "worktree" ||
    entry.workspaceRoot !== input.workspaceRoot ||
    entry.plannedWorktreePath !== input.path ||
    entry.newBranch !== input.branch ||
    entry.ownershipPreflightPassed !== true
  ) {
    throw new Error(
      `Gateway creation plan entry ${input.index} does not match the created worktree.`,
    );
  }
  entry.worktreeOwnership = {
    operationId: input.operationId,
    path: input.path,
    branch: input.branch,
    recordedAt: input.recordedAt,
  };
  return JSON.stringify(plan);
}

export function redactCreationPlanForPurgedCaller(input: {
  readonly planJson: string;
  readonly operationId: string;
}): string {
  return JSON.stringify(
    parseRecoverableCreationPlan(input.planJson, input.operationId).map((entry) => ({
      workspaceRoot: entry.workspaceRoot,
      environment: entry.environment,
      newBranch: entry.newBranch,
      plannedWorktreePath: entry.plannedWorktreePath,
      ownershipPreflightPassed: entry.ownershipPreflightPassed,
      worktreeOwnership: entry.worktreeOwnership,
      ids: entry.ids,
    })),
  );
}
