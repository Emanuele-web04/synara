/**
 * ExecutionRuntimeReconciler - Service tag for the execution-runtime
 * reconciliation reactor.
 *
 * Remote execution runtimes introduce partial failure the local path never had:
 * an instance can be created but its event never appended, an event appended but
 * the provider call failed, the server can crash after a create, a destroy can
 * time out, or the DB and provider can diverge in either direction. The
 * reconciler resolves each deterministically by listing the instances the DB
 * still believes are live, probing each against its provider through the
 * provider-agnostic `ExecutionRuntimeService` seam (capability flags, never a
 * concrete provider id), and converging persisted state: mark lost/failed,
 * retry pending destroy, and enforce TTL/idle policies.
 *
 * It is forked into the server scope like the other reactors (`effectServer.ts`)
 * and runs one sweep on startup plus on a schedule.
 *
 * @module ExecutionRuntimeReconciler
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ExecutionRuntimeReconcileSummary {
  readonly examined: number;
  readonly markedLost: number;
  readonly retriedDestroy: number;
  readonly expired: number;
}

export interface ExecutionRuntimeReconcilerShape {
  /**
   * Run a single reconciliation sweep and return what it did. Exposed so tests
   * and an on-demand caller can drive one deterministic pass without the timer.
   */
  readonly reconcileOnce: () => Effect.Effect<ExecutionRuntimeReconcileSummary>;
  /** Fork the startup sweep + scheduled sweeps into the current scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ExecutionRuntimeReconciler extends ServiceMap.Service<
  ExecutionRuntimeReconciler,
  ExecutionRuntimeReconcilerShape
>()("t3/executionRuntime/Services/ExecutionRuntimeReconciler") {}
