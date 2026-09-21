import { Effect, Schema, ServiceMap } from "effect";

export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /** pause reading (backpressure); no-op if unsupported */
  pause(): void;
  /** resume after a pause; no-op if unsupported */
  resume(): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export interface PtyAdapterShape {
  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError>;
}

export class PtyAdapter extends ServiceMap.Service<PtyAdapter, PtyAdapterShape>()(
  "synara/terminal/Services/PTY/PtyAdapter",
) {}
