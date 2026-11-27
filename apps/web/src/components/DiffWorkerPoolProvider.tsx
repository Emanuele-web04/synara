import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";

const DIFF_WORKER_POOL_MAX_SIZE = 2;
const DIFF_WORKER_POOL_AST_CACHE_SIZE = 120;
const DIFF_WORKER_POOL_IDLE_TERMINATE_MS = 15_000;

let activeDiffPoolConsumerCount = 0;
let idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;

function cancelScheduledPoolTermination(): void {
  if (idleTerminateTimer !== null) {
    clearTimeout(idleTerminateTimer);
    idleTerminateTimer = null;
  }
}

function schedulePoolTerminationIfIdle(): void {
  cancelScheduledPoolTermination();
  if (activeDiffPoolConsumerCount > 0) {
    return;
  }
  idleTerminateTimer = setTimeout(() => {
    idleTerminateTimer = null;
    if (activeDiffPoolConsumerCount === 0) {
      terminateWorkerPoolSingleton();
    }
  }, DIFF_WORKER_POOL_IDLE_TERMINATE_MS);
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    const current = workerPool.getDiffRenderOptions();
    if (current.theme === themeName) {
      return;
    }

    void workerPool
      .setRenderOptions({
        ...current,
        theme: themeName,
      })
      .catch(() => undefined);
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  const workerPoolSize = Math.min(DIFF_WORKER_POOL_MAX_SIZE, Math.max(1, Math.floor(cores / 4)));

  const [poolManager] = useState(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    cancelScheduledPoolTermination();
    return getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new DiffsWorker(),
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: DIFF_WORKER_POOL_AST_CACHE_SIZE,
      },
      highlighterOptions: {
        theme: diffThemeName,
        tokenizeMaxLineLength: 1_000,
      },
    });
  });

  useEffect(() => {
    if (!poolManager) {
      return;
    }
    cancelScheduledPoolTermination();
    activeDiffPoolConsumerCount += 1;
    return () => {
      activeDiffPoolConsumerCount = Math.max(0, activeDiffPoolConsumerCount - 1);
      schedulePoolTerminationIfIdle();
    };
  }, [poolManager]);

  return (
    <WorkerPoolContext.Provider value={poolManager}>
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContext.Provider>
  );
}
